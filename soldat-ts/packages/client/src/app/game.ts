// The client-side game: owns a sim World, spawns the local player + bots, runs
// the fixed-timestep simulation, and layers the bits the sim spine leaves out
// for a playable sandbox: bot AI, weapon firing (control.fire -> bullets), and
// death/respawn. Rendering is separate (EntityRenderer reads world + framePercent).
//
// PORT: ClientGame.pas GameLoop accumulator (fixed 60 Hz sim, interpolated render)
// + the ServerLoop per-tick bot/weapon/respawn maintenance the entity spine omits.

import {
  createWorld,
  initSimWorld,
  stepWorld,
  buildPolyMap,
  vec2,
  POS_STAND,
  spawnBullet,
  getGun,
  WeaponIndex,
  buildWaypoints,
  type World,
  type PolyMap,
  type WaypointGraph,
  type PmsWaypoint,
  type Gun,
} from '@soldat/sim';
import {
  createEngine,
  type BotBrain,
  type BotEngine,
  type BotEngineContext,
} from '../ai';

type PolyMapSource = Parameters<typeof buildPolyMap>[0];

const TICK_HZ = 60;
const TICK_DT = 1 / TICK_HZ;
const MAX_TICKS_PER_FRAME = 8;

/** Muzzle stand-off so a fresh bullet doesn't instantly collide with the shooter. */
const MUZZLE_OFFSET = 14;

// --- Per-match tuning (goal node 157) ----------------------------------------
// The gun + jet + respawn numbers are PER-INSTANCE now: tournament games run
// named gameplay variants (tournament.ts VARIANTS) by overriding a subset of
// these. DEFAULT_TUNING is the stock game — a Game built without `tuning` is
// byte-for-byte the old constants.
export interface GameTuning {
  fireInterval: number; // ticks between shots
  magSize: number; // rounds per magazine
  reloadTicks: number; // reload duration
  spreadBase: number; // rad, standing-tap spread
  spreadHeatPerShot: number; // bloom added per sustained shot
  jetFuelMax: number; // ticks of burn
  jetRegenPerTick: number; // ground refuel rate
  jetAirRegenPerTick: number; // coasting trickle refuel
  respawnTicks: number; // dead-to-respawn delay
}

// --- The guns ---------------------------------------------------------------
// Everyone defaults to the automatic rifle (slot 0) — the game balances around
// it: spray control (accuracy blooms as you hold fire), quick reactions (fast
// but not instant TTK + dodgeable projectiles), and terrain protection
// (bullets are blocked by geometry; reloading forces you behind cover).
//
// Slot 1 is the SPAS-12 (shared weapon contract, guns.ts) — reachable only via
// the opt-in 'shotgun' wildcard (one bot per team) or the player's weapon-swap
// key. With the wildcard off and the player never swapping, slot 1 is inert:
// no rng draw, no sim effect, byte-identical default matches.
//
// --- Rocket boots ------------------------------------------------------------
// This is a VERY vertical game (decision node 94): flying around is the point.
// A big tank plus on-ground regen means jets gate ENGAGEMENTS (you can't hover
// forever in a duel) without gating MOVEMENT (you're never stranded walking).
// The thrust direction itself is tuned in @soldat/sim (JET_THRUST/JET_AIR_DRIFT).
export const DEFAULT_TUNING: Readonly<GameTuning> = {
  fireInterval: 6, // ticks between shots (~10/s auto)
  magSize: 30, // rounds per magazine
  reloadTicks: 95, // ~1.6 s reload — be behind cover
  spreadBase: 0.015, // rad — a standing tap is near-pinpoint
  spreadHeatPerShot: 0.012, // bloom added per sustained shot
  jetFuelMax: 700, // ticks of burn (~11.7 s of continuous thrust)
  jetRegenPerTick: 3, // refuel rate on the ground (empty→full ~3.9 s)
  // Coasting in the air trickles fuel back at 1/tick — exactly the burn rate,
  // so a 50% thrust duty cycle hovers forever but climbing still spends the
  // tank. This is what makes sustained aerial dogfights possible (goal 124).
  jetAirRegenPerTick: 1,
  respawnTicks: 180, // dead-to-respawn delay (~3 s)
};

/** Kept for compatibility (legacy importers). Equals DEFAULT_TUNING.jetFuelMax. */
export const JET_FUEL_MAX = DEFAULT_TUNING.jetFuelMax;

// --- Weapon slots ------------------------------------------------------------
/** Slot 0: the default rifle every sprite starts with. */
export const SLOT_AK = 0;
/** Slot 1: the SPAS-12 (wildcard carriers / player swap). */
export const SLOT_SPAS = 1;
/** Pellets per SPAS-12 trigger pull. PORT: the Pascal fire path spawns one
 *  bullet per pellet — 6 pellets per shell. */
export const SPAS_PELLETS = 6;
/** Kill-feed / HUD weapon labels per slot (kept terse: `Killer [SPAS12] Victim`). */
export const WEAPON_LABELS: readonly [string, string] = ['AK74', 'SPAS12'];

/** Per-slot effective numbers derived from GameTuning + the weapon contract. */
interface SlotTuning {
  fireInterval: number;
  magSize: number;
  reloadTicks: number;
  spreadBase: number; // rad — per-shot (per-pellet for the SPAS) angle jitter
}

/**
 * Derive both weapon slots' numbers from the match tuning.
 *
 * Slot 0 (AK) uses the tuning fields VERBATIM — a default match is
 * byte-for-byte the single-gun game.
 *
 * Slot 1 (SPAS-12) is scaled from the shared weapon contract the same way
 * DEFAULT_TUNING rebalanced the AK74: the stock 6/30/95 relate to the AK's
 * contract 10/35/165 as ratios 6/10, 30/35, 95/165 — so each SPAS stat is
 * contractStat * (tunedAkStat / contractAkStat), which both preserves the
 * AK:SPAS contract ratios and lets gameplay variants tune the SPAS in step:
 *   fireInterval 32 → 19, magSize 7 → 6, reloadTicks 175 → 101 (stock).
 * The contract's bulletSpread is a velocity perturbation (±0.8 on speed 14);
 * as the angular half-fan this game's spread model needs, that is
 * atan(bulletSpread / bulletSpeed) ≈ 0.057 rad per pellet.
 */
function deriveSlotTuning(tuning: GameTuning, ak: Gun, spas: Gun): [SlotTuning, SlotTuning] {
  const scale = (spasStat: number, akStat: number, tunedAk: number): number =>
    Math.max(1, Math.round((spasStat * tunedAk) / akStat));
  return [
    {
      fireInterval: tuning.fireInterval,
      magSize: tuning.magSize,
      reloadTicks: tuning.reloadTicks,
      spreadBase: tuning.spreadBase,
    },
    {
      fireInterval: scale(spas.fireInterval, ak.fireInterval, tuning.fireInterval),
      magSize: scale(spas.ammo, ak.ammo, tuning.magSize),
      reloadTicks: scale(spas.reloadTime, ak.reloadTime, tuning.reloadTicks),
      spreadBase: Math.atan(spas.bulletSpread / spas.bulletSpeed),
    },
  ];
}

// Spread shape that is NOT part of the per-match tuning surface (the variants
// tweak base accuracy and bloom-per-shot; the cap/decay/move-penalty define
// what spray-control FEELS like and stay global).
const SPREAD_HEAT_MAX = 0.16; // max bloom from spraying
const SPREAD_HEAT_DECAY = 0.05; // bloom recovered per tick when not firing
const SPREAD_MOVE = 0.06; // extra spread while moving fast (stand still to be accurate)
const MOVE_SPREAD_SPEED = 3; // |vx| above which the move penalty applies

// --- Aim assist (player only — bots would become aimbots) -------------------
// LIGHT magnetism (goal node 102): keyboard aim is coarse, so shots already
// pointed near a target get bent the last few degrees onto it. The cone is
// small enough that aim still has to be earned, the bend is under the
// half-spread of a short burst, and spread/spray-bloom applies AFTER the bend
// so the assist never cancels the spray-control dynamic.
export const ASSIST_CONE = 0.16; // rad (~9°) — only assist near-misses
export const ASSIST_MAX_BEND = 0.05; // rad (~2.9°) — the "light" in light assist
export const ASSIST_RANGE = 700; // px — no cross-map magnetism

/**
 * Bend a unit aim vector toward the angularly-closest target within the
 * assist cone and range. Pure (exported for tests); returns the input aim
 * when no target qualifies.
 */
export function applyAimAssist(
  ax: number,
  ay: number,
  ox: number,
  oy: number,
  targets: readonly { x: number; y: number }[],
): { x: number; y: number } {
  const aimAng = Math.atan2(ay, ax);
  let bestOff = Infinity;
  for (const t of targets) {
    const dx = t.x - ox;
    const dy = t.y - oy;
    const dist = Math.hypot(dx, dy);
    if (dist < 1 || dist > ASSIST_RANGE) continue;
    // Angular offset wrapped into (-PI, PI].
    let off = Math.atan2(dy, dx) - aimAng;
    if (off <= -Math.PI) off += 2 * Math.PI;
    else if (off > Math.PI) off -= 2 * Math.PI;
    if (Math.abs(off) > ASSIST_CONE) continue;
    if (Math.abs(off) < Math.abs(bestOff)) bestOff = off;
  }
  if (!Number.isFinite(bestOff)) return { x: ax, y: ay };
  const bent =
    aimAng + Math.sign(bestOff) * Math.min(Math.abs(bestOff), ASSIST_MAX_BEND);
  return { x: Math.cos(bent), y: Math.sin(bent) };
}

interface BotEntry {
  readonly index: number;
  /** The bot's brain, behind the engine adapter (decision node 136).
   *  Mutable: setEngine() hot-swaps brains mid-match. */
  brain: BotBrain;
}

export interface GameOptions {
  /** Deterministic RNG seed for the world. */
  seed?: number;
  /** Spawn points (world coords); player takes [0], bots cycle the rest. */
  spawns?: readonly { x: number; y: number }[];
  /** Number of bots to spawn (default 3). */
  botCount?: number;
  /**
   * Spectate mode: the local player sprite is never spawned (slot 1 stays
   * inactive — invisible to bot perception, bullets, and the renderer) and the
   * bots get spectate-only sustainment (real-waypoint navigation, wander
   * fallback, corrected aim) so a bot-vs-bot match runs indefinitely with zero
   * input. Default false; normal play is completely unaffected.
   */
  spectate?: boolean;
  /**
   * Bot-AI engine id ('classic' | 'pilot' | any registered engine). Unknown
   * ids fall back to classic. Default 'classic'. (`| undefined` so callers
   * can pass a parsed-from-URL value under exactOptionalPropertyTypes.)
   */
  aiEngine?: string | undefined;
  /**
   * Team dynamics (goal node 154): red (1) vs blue (2). Defaults to ON when
   * the match is mixed-engine (teams follow engine groups — engine warfare)
   * and OFF otherwise (FFA). Uniform matches with teams alternate bots.
   */
  teams?: boolean | undefined;
  /** Partial overrides of DEFAULT_TUNING — per-match gameplay variant. */
  tuning?: Partial<GameTuning> | undefined;
  /** Round length in sim ticks; 0/undefined = endless. Only enforced when teamsEnabled. */
  roundTicks?: number | undefined;
  /** Per-engine tweak overrides, keyed by engine id; applied when engines are
   *  instantiated (mixed matches: each side's tweaks tracked separately). */
  engineTweaks?: Record<string, Record<string, number>> | undefined;
  /**
   * Opt-in wildcard ('shotgun'): exactly one bot per team (one bot total in
   * FFA) carries the SPAS-12, picked deterministically from the match seed
   * via world.rng. Absent/undefined = stock loadouts, zero rng consumed.
   */
  wildcard?: string | undefined;
}

// --- Timed rounds (goal node 157) -------------------------------------------
// A team match ends after `roundTicks` SIM ticks (10 minutes = 36000 at 60 Hz
// — counted on world.mainTickCounter, never wall clock). The winner is the
// team with more kills; a tie falls back to total dominance; a double tie is
// a draw. Once decided the Game FREEZES (tick() no-ops) so every consumer —
// renderer, HUD, leaderboard, telemetry dump — keeps serving the final state.

export interface RoundResult {
  overAtTick: number;
  /** 1 red, 2 blue, 0 draw. */
  winnerTeam: number;
  /** Engine driving the winning team ('' on draw). */
  winnerEngine: string;
  redKills: number;
  blueKills: number;
  redDom: number; // sum over red of kills - 0.5*deaths
  blueDom: number;
}

/** Decide the round: kill totals, tie → total dominance, tie → draw (team 0). */
export function decideRoundWinner(
  rows: readonly { team: number; kills: number; deaths: number }[],
  overAtTick: number,
): Omit<RoundResult, 'winnerEngine'> {
  let redKills = 0;
  let blueKills = 0;
  let redDom = 0;
  let blueDom = 0;
  for (const r of rows) {
    const dom = r.kills - 0.5 * r.deaths;
    if (r.team === 1) {
      redKills += r.kills;
      redDom += dom;
    } else if (r.team === 2) {
      blueKills += r.kills;
      blueDom += dom;
    }
  }
  const winnerTeam =
    redKills > blueKills
      ? 1
      : blueKills > redKills
        ? 2
        : redDom > blueDom
          ? 1
          : blueDom > redDom
            ? 2
            : 0;
  return { overAtTick, winnerTeam, redKills, blueKills, redDom, blueDom };
}

/** A renderable view of a bullet (matches fx.BulletView). */
export interface BulletRenderView {
  x: number;
  y: number;
  vx: number;
  vy: number;
  style: number;
}

/** Sound event hook: (event, worldX, worldY). Set by the client to play sfx. */
export type GameSoundHook = (
  event: 'fire' | 'reloadStart' | 'death',
  x: number,
  y: number,
) => void;

export class Game {
  readonly world: World;
  readonly playerIndex = 1;
  framePercent = 0;

  /** Optional sound hook — invoked on fire / reload / death (world coords). */
  onSound: GameSoundHook | null = null;

  /**
   * Optional kill hook — invoked exactly once per death, on the tick the death
   * is first observed (the respawn timer arms). `killer` is the owner of the
   * last bullet that damaged the victim (Sprite.lastHitBy); 0 = no attribution.
   */
  onKill: ((killer: number, victim: number) => void) | null = null;

  /** Optional shot hook — invoked for every bullet spawned (telemetry). */
  onShot: ((shooter: number) => void) | null = null;

  /**
   * Replay/training hook (goal node 170) — fires once per sim tick
   * immediately after every living brain has written its control and BEFORE
   * firing/physics run, so a recorder reads exactly the observation the
   * brains acted on plus the action they chose. `tick` is
   * world.mainTickCounter at decision time.
   */
  onBrainsTicked: ((tick: number) => void) | null = null;

  private accumulator = 0;
  private readonly spectate: boolean;
  private readonly spawns: readonly { x: number; y: number }[];
  private readonly bots: BotEntry[] = [];
  /** Bot navigation graph; rebuilt from real map waypoints in spectate mode. */
  private graph: WaypointGraph;
  /** The two guns from the shared weapon contract: [AK74, SPAS12]. */
  private readonly guns: readonly [Gun, Gun];
  /** Per-slot effective fire/mag/reload/spread numbers (see deriveSlotTuning). */
  private readonly slotTuning: readonly [SlotTuning, SlotTuning];
  /** Per-sprite active weapon slot (SLOT_AK everywhere by default). */
  private readonly weaponSlot: number[] = [];
  /** Per-sprite previous changeWeapon flag — swap on the rising edge only. */
  private readonly prevChangeWeapon: boolean[] = [];
  /** Sprite indices armed with the SPAS-12 by the wildcard (survives respawn). */
  private readonly spasCarriers = new Set<number>();
  /** The active wildcard ('shotgun') or undefined (stock loadouts). */
  readonly wildcard: string | undefined;
  /** Per-slot per-sprite next-fire tick (world.mainTickCounter clock). */
  private readonly nextFireTick: [number[], number[]] = [[], []];
  /** Per-sprite respawn countdown (ticks); 0 = alive. */
  private readonly respawnIn: number[] = [];
  /** Per-slot per-sprite rounds left in the magazine. */
  private readonly ammo: [number[], number[]] = [[], []];
  /** Per-slot per-sprite tick the current reload completes (0 = not reloading). */
  private readonly reloadUntil: [number[], number[]] = [[], []];
  /** Per-slot per-sprite spray bloom (radians) — grows firing, decays at rest. */
  private readonly sprayHeat: [number[], number[]] = [[], []];
  /** Context handed to every bot brain (graph resolves live via getter). */
  private readonly engineCtx: BotEngineContext;
  /**
   * Active bot-AI engines (hot-swappable via setEngine). One = a uniform
   * match; several = a MIXED match with bots split round-robin and the
   * scoreboard counting kills per engine (goal node 148).
   */
  private engines: BotEngine[];
  /** Per-engine tweak overrides (engine id → knob overrides), frozen for the
   *  match: setEngine hot-swaps preserve them so provenance stays accurate. */
  private readonly engineTweaks: Record<string, Record<string, number>>;
  /** Per-bot engine id (mixed matches assign round-robin). */
  private readonly botEngine = new Map<number, string>();
  /** Per-sprite team (1 red / 2 blue); empty in FFA. Survives respawns. */
  private readonly botTeam = new Map<number, number>();
  /** Whether this match runs red-vs-blue teams. */
  readonly teamsEnabled: boolean;
  /** Effective gameplay numbers: DEFAULT_TUNING + the match's variant overrides. */
  readonly tuning: GameTuning;
  /** Round length in sim ticks (0 = endless; only enforced with teams on). */
  private readonly roundTicks: number;
  /** Per-sprite attributed kill / death tallies (round-winner bookkeeping). */
  private readonly killsBy = new Map<number, number>();
  private readonly deathsBy = new Map<number, number>();
  /** Set once when the timed round ends; tick() freezes from then on. */
  private _roundResult: RoundResult | null = null;

  constructor(opts: GameOptions = {}) {
    // Tuning FIRST: engineCtx below captures magSize from it.
    this.tuning = { ...DEFAULT_TUNING, ...(opts.tuning ?? {}) };
    this.roundTicks = opts.roundTicks ?? 0;

    this.world = createWorld();
    initSimWorld(this.world, opts.seed !== undefined ? { seed: opts.seed } : undefined);

    this.spectate = opts.spectate ?? false;
    this.spawns = opts.spawns ?? [{ x: 0, y: 0 }];
    // No waypoints in the sandbox arena → an empty graph. Bots still perceive,
    // aim and fire at the nearest enemy; navigation is a no-op (they hold
    // ground — engines layer their own fallbacks, see ../ai/).
    this.graph = buildWaypoints({ waypoints: [] });
    this.guns = [getGun(WeaponIndex.AK74, false), getGun(WeaponIndex.SPAS12, false)];
    this.slotTuning = deriveSlotTuning(this.tuning, this.guns[SLOT_AK], this.guns[SLOT_SPAS]);
    this.wildcard = opts.wildcard;

    // The brain context: a narrow window onto the world plus the client-owned
    // weapon state. `graph` is a getter because loadMap may rebuild it.
    const self = this;
    this.engineCtx = {
      world: this.world,
      get graph(): WaypointGraph {
        return self.graph;
      },
      spawns: this.spawns,
      spectate: this.spectate,
      ammoOf: (i: number): number => this.ammoOf(i),
      reloadingOf: (i: number): boolean => this.reloadingOf(i),
      magSize: this.tuning.magSize,
    };

    // Player. In spectate mode slot 1 is never spawned: an inactive sprite is
    // skipped by bot perception (findTarget), bullet collision, and the
    // renderer, so the human is truly absent rather than a dormant target.
    if (!this.spectate) {
      this.spawnSprite(this.playerIndex, this.spawnFor(0));
    }

    // Bots. `aiEngine` may be one id ('pilot') or a comma list
    // ('classic,pilot') — a list splits the bots round-robin into a MIXED
    // match where the engines fight each other in the same arena.
    this.engineTweaks = opts.engineTweaks ?? {};
    this.engines = Game.resolveEngines(opts.aiEngine, this.engineTweaks);
    this.teamsEnabled = opts.teams ?? this.engineGroups().length > 1;
    const botCount = opts.botCount ?? 3;
    for (let b = 0; b < botCount; b++) {
      const index = this.playerIndex + 1 + b;
      const engine = this.engineForSlot(b);
      this.botEngine.set(index, engine.id);
      if (this.teamsEnabled) this.botTeam.set(index, this.teamFor(b, engine.id));
      this.spawnSprite(index, this.spawnFor(index));
      this.bots.push({ index, brain: engine.createBrain() });
    }

    // Shotgun wildcard: ONE carrier per team (one total in FFA), picked from
    // the match seed through world.rng — the only randomness source — so the
    // same seed always arms the same bot. Skipped entirely (no rng draw) when
    // the wildcard is off: default matches stay byte-identical.
    if (this.wildcard === 'shotgun' && this.bots.length > 0) {
      const pools: number[][] = this.teamsEnabled
        ? [1, 2].map((team) =>
            this.bots.filter((b) => this.teamOf(b.index) === team).map((b) => b.index),
          )
        : [this.bots.map((b) => b.index)];
      for (const pool of pools) {
        if (pool.length === 0) continue;
        const pick = pool[this.world.rng.nextInt(pool.length)];
        if (pick === undefined) continue;
        this.spasCarriers.add(pick);
        this.weaponSlot[pick] = SLOT_SPAS;
        const sp = this.world.sprites[pick];
        if (sp !== undefined) sp.selWeapon = WeaponIndex.SPAS12;
      }
    }
  }

  /** Wildcard SPAS-12 carriers (ascending sprite index; empty when off). */
  wildcardCarriers(): readonly number[] {
    return [...this.spasCarriers].sort((a, b) => a - b);
  }

  /** Kill-feed/HUD label of `index`'s current weapon ('AK74' | 'SPAS12'). */
  weaponNameOf(index: number): string {
    return WEAPON_LABELS[this.weaponSlot[index] === SLOT_SPAS ? SLOT_SPAS : SLOT_AK];
  }

  /**
   * Engine for bot slot `b`. In TEAM matches each team is ENTIRELY one mode
   * (user correction on node 157): slots alternate between the first two
   * engine GROUPS — an even red/blue split no matter how lopsided the roster
   * list is (an evolved 5:1 roster would otherwise produce 1v5 teams that
   * read as "everyone is on pilot"). FFA keeps the roster's own proportions.
   */
  private engineForSlot(b: number): BotEngine {
    const groups = this.engineGroups();
    if (this.teamsEnabled && groups.length >= 2) {
      const id = groups[b % 2]!;
      return this.engines.find((e) => e.id === id) ?? this.engines[0]!;
    }
    return this.engines[b % this.engines.length]!;
  }

  /**
   * Team for bot slot `b`: in mixed matches teams FOLLOW the engines (engine
   * warfare — red is group 0, blue group 1); uniform matches alternate.
   */
  private teamFor(b: number, engineId: string): number {
    const groups = this.engineGroups();
    if (groups.length > 1) {
      return (groups.indexOf(engineId) % 2) + 1;
    }
    return (b % 2) + 1;
  }

  /** Team of sprite `index` (0 = FFA / no team). */
  teamOf(index: number): number {
    return this.botTeam.get(index) ?? 0;
  }

  /** Parse 'a' or 'a,b,...' into engine instances (unknown ids → classic),
   *  threading each id's tweak overrides into its factory. */
  private static resolveEngines(
    spec: string | undefined,
    tweaks: Record<string, Record<string, number>>,
  ): BotEngine[] {
    const ids = (spec ?? 'classic')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return (ids.length > 0 ? ids : ['classic']).map((id) => createEngine(id, tweaks[id]));
  }

  /** RESOLVED full config of engine `id` in this match (undefined if not in play). */
  resolvedTweaks(id: string): Readonly<Record<string, number>> | undefined {
    return this.engines.find((e) => e.id === id)?.tweaks;
  }

  /** Active engine id(s) — mixed matches join with '+' (telemetry-compact). */
  get aiEngineId(): string {
    return this.engineGroups().join('+');
  }

  /** Strategy line of the active engine, or a mixed-match banner line. */
  get aiStrategy(): string {
    const groups = this.engineGroups();
    if (groups.length === 1) return this.engines[0]!.strategy;
    return 'MIXED MATCH — engines share the arena; the score is engine vs engine';
  }

  /** Distinct engine ids in play, in assignment order. */
  engineGroups(): readonly string[] {
    return [...new Set(this.engines.map((e) => e.id))];
  }

  /** Engine id driving sprite `index` ('' for the human player slot). */
  engineOf(index: number): string {
    return this.botEngine.get(index) ?? '';
  }

  /**
   * HOT-SWAP the bot-AI engine(s) mid-match: accepts one id or a comma list
   * (mixed). Every bot gets a fresh brain on the next tick; sprites, scores,
   * fuel, and ammo carry over untouched — only the thinking changes.
   */
  setEngine(spec: string): void {
    // Hot-swap PRESERVES the match's tweaks — provenance survives the E key.
    this.engines = Game.resolveEngines(spec, this.engineTweaks);
    this.bots.forEach((bot, b) => {
      const engine = this.engineForSlot(b);
      this.botEngine.set(bot.index, engine.id);
      if (this.teamsEnabled) {
        const team = this.teamFor(b, engine.id);
        this.botTeam.set(bot.index, team);
        const s = this.world.sprites[bot.index];
        if (s !== undefined) s.team = team;
      }
      bot.brain = engine.createBrain();
    });
  }

  /** Spawn point for a sprite index, cycling the configured list. */
  private spawnFor(index: number): { x: number; y: number } {
    const s = this.spawns[index % this.spawns.length] ?? this.spawns[0] ?? { x: 0, y: 0 };
    return { x: s.x, y: s.y };
  }

  /** Activate (or respawn) a sprite at `spawn` with a fresh COM particle. */
  private spawnSprite(index: number, spawn: { x: number; y: number }): void {
    const parts = this.world.spriteParts;
    if (parts === null) {
      throw new Error('Game: spriteParts not initialized');
    }
    parts.createPart(vec2(spawn.x, spawn.y), vec2(0, 0), 1, index);

    const s = this.world.sprites[index];
    if (s === undefined) {
      throw new Error(`Game: sprite slot ${index} missing`);
    }
    s.active = true;
    s.num = index;
    s.style = 1;
    s.position = POS_STAND;
    s.direction = 1;
    s.health = 150; // STARTHEALTH
    s.visible = 1;
    // Spectate-only: opaque sprites. Bot perception (findTarget) skips any
    // sprite whose alpha is not 255 ("invisible sprites aren't seen"), and
    // NOTHING in the sim ever raises alpha from emptySprite's 0 — so without
    // this, bots never acquire ANY target and a bot-vs-bot match never fires
    // a shot. Gated on spectate to keep normal play byte-for-byte unchanged
    // (where, NOTE, bots are currently pacifists for exactly this reason —
    // promoting `s.alpha = 255` to both modes is the one-line fix).
    if (this.spectate) {
      s.alpha = 255;
    }
    s.deadMeat = false;
    s.dummy = false;
    // Wildcard carriers respawn with the SPAS; everyone else (player included)
    // respawns on the default rifle.
    this.weaponSlot[index] = this.spasCarriers.has(index) ? SLOT_SPAS : SLOT_AK;
    this.prevChangeWeapon[index] = false;
    s.selWeapon =
      this.weaponSlot[index] === SLOT_SPAS ? WeaponIndex.SPAS12 : WeaponIndex.AK74;
    s.jetsCount = this.tuning.jetFuelMax;
    s.jetsCountReal = this.tuning.jetFuelMax;
    s.jumpTicksLeft = 0;
    s.control = {
      left: false,
      right: false,
      up: false,
      down: false,
      fire: false,
      jetpack: false,
      throwNade: false,
      changeWeapon: false,
      throwWeapon: false,
      reload: false,
      prone: false,
      flagThrow: false,
      mouseAimX: index === this.playerIndex ? 100 : -100,
      mouseAimY: 0,
      mouseDist: 0,
    };
    // Fresh life — stale attribution must not credit a long-gone shooter.
    s.lastHitBy = 0;
    // Team persists across respawns (0 = FFA).
    s.team = this.botTeam.get(index) ?? 0;
    this.respawnIn[index] = 0;
    // BOTH weapon slots come back full — a respawn is a fresh loadout.
    for (const slot of [SLOT_AK, SLOT_SPAS] as const) {
      this.nextFireTick[slot][index] = 0;
      this.ammo[slot][index] = this.slotTuning[slot].magSize;
      this.reloadUntil[slot][index] = 0;
      this.sprayHeat[slot][index] = 0;
    }
  }

  /** `index`'s active weapon slot (SLOT_AK | SLOT_SPAS). */
  private slotOf(index: number): 0 | 1 {
    return this.weaponSlot[index] === SLOT_SPAS ? SLOT_SPAS : SLOT_AK;
  }

  /** Rounds left in `index`'s CURRENT weapon's magazine (for the HUD). */
  ammoOf(index: number): number {
    return this.ammo[this.slotOf(index)][index] ?? 0;
  }

  /** Whether sprite `index`'s current weapon is mid-reload (for the HUD). */
  reloadingOf(index: number): boolean {
    return this.world.mainTickCounter < (this.reloadUntil[this.slotOf(index)][index] ?? 0);
  }

  /** Local player's rounds left (for the HUD). */
  playerAmmo(): number {
    return this.ammoOf(this.playerIndex);
  }

  /** Whether the local player is mid-reload (for the HUD). */
  playerReloading(): boolean {
    return this.reloadingOf(this.playerIndex);
  }

  /** Sprite indices of the bots (for spectator cameras / scoreboards). */
  botIndices(): readonly number[] {
    return this.bots.map((b) => b.index);
  }

  magSize(): number {
    return this.tuning.magSize;
  }

  /** Attributed kills by sprite `index` (round-winner bookkeeping). */
  killsOf(index: number): number {
    return this.killsBy.get(index) ?? 0;
  }

  /** Deaths of sprite `index` (round-winner bookkeeping). */
  deathsOf(index: number): number {
    return this.deathsBy.get(index) ?? 0;
  }

  /** The round verdict once the timed round has ended (null while running). */
  get roundResult(): RoundResult | null {
    return this._roundResult;
  }

  loadMap(source: PolyMapSource & { waypoints?: PmsWaypoint[] }): void {
    const polyMap: PolyMap = buildPolyMap(source);
    this.world.map = polyMap;
    // Spectate-only: adopt the map's real bot waypoints so targetless bots
    // patrol the level instead of holding ground. Gated on spectate so
    // normal-mode bot behaviour is unchanged.
    if (this.spectate && source.waypoints !== undefined && source.waypoints.length > 0) {
      this.graph = buildWaypoints({ waypoints: source.waypoints });
    }
  }

  /** Bullets to render this frame (active, with velocity). */
  bulletViews(): BulletRenderView[] {
    const out: BulletRenderView[] = [];
    const bp = this.world.bulletParts;
    if (bp === null) return out;
    for (let i = 1; i < this.world.bullets.length; i++) {
      const b = this.world.bullets[i];
      if (b === undefined || !b.active) continue;
      out.push({
        x: bp.posX[i] ?? 0,
        y: bp.posY[i] ?? 0,
        vx: bp.velocityX[i] ?? 0,
        vy: bp.velocityY[i] ?? 0,
        style: 0xfff070,
      });
    }
    return out;
  }

  tick(dtSeconds: number): void {
    // Round over → the match is FROZEN. Gated here (not in the rAF loop) so
    // the director camera, HUD, leaderboard, winner banner, and telemetry
    // dump() all keep rendering/serving the final state — and so the freeze
    // is unit-testable headlessly with no DOM.
    if (this._roundResult !== null) {
      this.accumulator = 0;
      this.framePercent = 0;
      return;
    }
    const dt = dtSeconds > 0 && dtSeconds < 1 ? dtSeconds : TICK_DT;
    this.accumulator += dt;

    let ran = 0;
    while (this.accumulator >= TICK_DT && ran < MAX_TICKS_PER_FRAME) {
      this.simTick();
      this.accumulator -= TICK_DT;
      ran += 1;
    }
    if (this.accumulator > TICK_DT) this.accumulator = 0;
    this.framePercent = this.accumulator / TICK_DT;
  }

  /** One fixed 60 Hz tick: bot AI -> firing -> physics -> respawn upkeep. */
  private simTick(): void {
    // Bots think (each brain writes its bot's control: movement, aim, fire).
    for (const bot of this.bots) {
      const s = this.world.sprites[bot.index];
      if (s === undefined || s.deadMeat) continue;
      bot.brain.tick(bot.index, this.engineCtx);
    }

    // Replay seam: brains have thought, nothing has moved yet — a recorder
    // sampling here gets (observation, chosen action) pairs.
    this.onBrainsTicked?.(this.world.mainTickCounter);

    // Weapon swap (rising edge of control.changeWeapon, before firing). Bots
    // never raise the flag, so this is player-only in practice — and a pure
    // function of controls, so spectate/headless determinism is untouched.
    const clock = this.world.mainTickCounter;
    this.weaponSwapUpkeep(this.playerIndex);
    for (const bot of this.bots) this.weaponSwapUpkeep(bot.index);

    // Firing: anyone holding fire whose weapon is off cooldown spawns a bullet.
    this.tryFire(this.playerIndex, clock);
    for (const bot of this.bots) this.tryFire(bot.index, clock);

    // Physics + bullets + things.
    stepWorld(this.world);

    // Jet refuel: burner off regenerates fuel — fast on the ground, a trickle
    // while coasting in the air (player and bots alike).
    for (const s of this.world.sprites) {
      if (s.deadMeat || !s.active) continue;
      if (!s.control.jetpack && s.jetsCount < this.tuning.jetFuelMax) {
        const regen = s.onGround
          ? this.tuning.jetRegenPerTick
          : this.tuning.jetAirRegenPerTick;
        s.jetsCount = Math.min(s.jetsCount + regen, this.tuning.jetFuelMax);
      }
    }

    // Death / respawn upkeep.
    this.respawnUpkeep();

    // Timed round (goal node 157): once the sim clock crosses roundTicks the
    // verdict is computed ONCE from the per-bot tallies and the game freezes
    // (tick() gates on _roundResult). Teams-off / roundTicks 0 = endless.
    if (
      this._roundResult === null &&
      this.teamsEnabled &&
      this.roundTicks > 0 &&
      this.world.mainTickCounter >= this.roundTicks
    ) {
      const rows = this.bots.map((b) => ({
        team: this.teamOf(b.index),
        kills: this.killsOf(b.index),
        deaths: this.deathsOf(b.index),
      }));
      const base = decideRoundWinner(rows, this.world.mainTickCounter);
      // Teams follow engine groups (teamFor), so any member of the winning
      // team names the engine that won the round.
      const winnerBot = this.bots.find((b) => this.teamOf(b.index) === base.winnerTeam);
      this._roundResult = {
        ...base,
        winnerEngine: base.winnerTeam === 0 ? '' : this.engineOf(winnerBot?.index ?? -1),
      };
    }
  }

  /**
   * Swap `index`'s weapon on the rising edge of control.changeWeapon. Each
   * slot keeps its OWN ammo/cooldown/heat; a swap is never a free reload, and
   * swapping away mid-reload CANCELS that reload (classic Soldat feel).
   */
  private weaponSwapUpkeep(index: number): void {
    const s = this.world.sprites[index];
    if (s === undefined || !s.active || s.deadMeat) return;
    const held = s.control.changeWeapon;
    const was = this.prevChangeWeapon[index] ?? false;
    this.prevChangeWeapon[index] = held;
    if (!held || was) return;
    const cur = this.slotOf(index);
    if (this.world.mainTickCounter < (this.reloadUntil[cur][index] ?? 0)) {
      this.reloadUntil[cur][index] = 0;
    }
    const next = cur === SLOT_AK ? SLOT_SPAS : SLOT_AK;
    this.weaponSlot[index] = next;
    s.selWeapon = next === SLOT_SPAS ? WeaponIndex.SPAS12 : WeaponIndex.AK74;
  }

  /**
   * Per-tick weapon upkeep for one sprite: handle reload, spray-heat decay, and
   * fire (with spread) when fire is held, off cooldown, and loaded. The AK
   * spawns one bullet; the SPAS-12 spawns SPAS_PELLETS bullets, each with its
   * own world.rng spread draw (the Pascal rule: one spawn per pellet).
   */
  private tryFire(index: number, clock: number): void {
    const s = this.world.sprites[index];
    const parts = this.world.spriteParts;
    if (s === undefined || parts === null) return;

    const slot = this.slotOf(index);
    const gun = this.guns[slot];
    const st = this.slotTuning[slot];

    const reloadingUntil = this.reloadUntil[slot][index] ?? 0;
    const reloading = clock < reloadingUntil;
    if (reloading) {
      // Reload completes exactly at reloadUntil.
      if (clock === reloadingUntil - 1) {
        this.ammo[slot][index] = st.magSize;
      }
    }
    if (s.deadMeat || !s.active) return;

    // Manual reload (R) when not full and not already reloading.
    if (s.control.reload && !reloading && (this.ammo[slot][index] ?? 0) < st.magSize) {
      this.reloadUntil[slot][index] = clock + st.reloadTicks;
      this.onSound?.('reloadStart', parts.posX[index] ?? 0, parts.posY[index] ?? 0);
      return;
    }

    if (!s.control.fire) {
      // Not firing → spray bloom recovers.
      this.sprayHeat[slot][index] = Math.max(
        0,
        (this.sprayHeat[slot][index] ?? 0) - SPREAD_HEAT_DECAY,
      );
      return;
    }
    if (reloading) return;
    if (clock < (this.nextFireTick[slot][index] ?? 0)) return;

    // Empty magazine → auto-reload.
    if ((this.ammo[slot][index] ?? 0) <= 0) {
      this.reloadUntil[slot][index] = clock + st.reloadTicks;
      this.onSound?.('reloadStart', parts.posX[index] ?? 0, parts.posY[index] ?? 0);
      return;
    }

    // Aim direction (unit), from the relative aim vector.
    let ax = s.control.mouseAimX;
    let ay = s.control.mouseAimY;
    const len = Math.hypot(ax, ay);
    if (len < 1e-3) {
      ax = s.direction >= 0 ? 1 : -1;
      ay = 0;
    } else {
      ax /= len;
      ay /= len;
    }

    // Aim assist: player shots near a live enemy bend the last few degrees
    // onto it (player ONLY — assisted bots are aimbots). Applied before
    // spread so spray bloom still punishes held fire.
    if (index === this.playerIndex) {
      const targets: { x: number; y: number }[] = [];
      for (const other of this.world.sprites) {
        if (!other.active || other.deadMeat || other.num === index) continue;
        targets.push({
          x: parts.posX[other.num] ?? 0,
          y: parts.posY[other.num] ?? 0,
        });
      }
      const bent = applyAimAssist(
        ax,
        ay,
        parts.posX[index] ?? 0,
        parts.posY[index] ?? 0,
        targets,
      );
      ax = bent.x;
      ay = bent.y;
    }

    // Spread = base + spray bloom + a movement penalty (stand still to be
    // precise). The SPAS draws a FRESH jitter per pellet — that IS the fan.
    const vx = parts.velocityX[index] ?? 0;
    const moving = Math.abs(vx) > MOVE_SPREAD_SPEED ? SPREAD_MOVE : 0;
    const spread = st.spreadBase + (this.sprayHeat[slot][index] ?? 0) + moving;
    const baseAng = Math.atan2(ay, ax);
    const speed = gun.bulletSpeed;
    const pellets = slot === SLOT_SPAS ? SPAS_PELLETS : 1;
    let faceDx = 0;
    let soundX = parts.posX[index] ?? 0;
    let soundY = parts.posY[index] ?? 0;
    for (let p = 0; p < pellets; p++) {
      const jitter = (this.world.rng.next() * 2 - 1) * spread;
      const ang = baseAng + jitter;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      const px = (parts.posX[index] ?? 0) + dx * MUZZLE_OFFSET;
      const py = (parts.posY[index] ?? 0) + dy * MUZZLE_OFFSET;
      if (p === 0) {
        faceDx = dx;
        soundX = px;
        soundY = py;
      }
      spawnBullet(this.world, {
        pos: vec2(px, py),
        velocity: vec2(dx * speed, dy * speed),
        owner: index,
        hitMultiply: gun.hitMultiply,
        gun,
      });
    }

    s.direction = faceDx >= 0 ? 1 : -1;
    // One trigger pull = one round of ammo, one heat increment, one shot/sound
    // event — pellets are not separate shots.
    this.ammo[slot][index] = (this.ammo[slot][index] ?? 0) - 1;
    this.sprayHeat[slot][index] = Math.min(
      SPREAD_HEAT_MAX,
      (this.sprayHeat[slot][index] ?? 0) + this.tuning.spreadHeatPerShot,
    );
    this.nextFireTick[slot][index] = clock + st.fireInterval;
    this.onShot?.(index);
    this.onSound?.('fire', soundX, soundY);
  }

  /** Start respawn timers for the freshly dead; respawn when they elapse. */
  private respawnUpkeep(): void {
    // In spectate mode the player slot is never spawned and MUST stay out of
    // this list: a never-spawned sprite has health 0, which the freshly-dead
    // check below reads as a death — it would "respawn" the player ~3 s in.
    const all = this.spectate
      ? this.bots.map((b) => b.index)
      : [this.playerIndex, ...this.bots.map((b) => b.index)];
    for (const index of all) {
      const s = this.world.sprites[index];
      if (s === undefined) continue;
      if (s.deadMeat || s.health <= 0) {
        if ((this.respawnIn[index] ?? 0) === 0) {
          this.respawnIn[index] = this.tuning.respawnTicks;
          const dp = this.world.spriteParts;
          this.onSound?.('death', dp?.posX[index] ?? 0, dp?.posY[index] ?? 0);
          s.deadMeat = true;
          // The one-shot death edge (gated by respawnIn === 0): tally for the
          // round verdict, then report the kill with the last-hit attribution
          // the sim recorded (suicides/unattributed deaths credit nobody).
          this.deathsBy.set(index, (this.deathsBy.get(index) ?? 0) + 1);
          if (s.lastHitBy > 0 && s.lastHitBy !== index) {
            this.killsBy.set(s.lastHitBy, (this.killsBy.get(s.lastHitBy) ?? 0) + 1);
          }
          this.onKill?.(s.lastHitBy, index);
          // freeze control while dead
          s.control = { ...s.control, left: false, right: false, up: false, fire: false, jetpack: false };
        } else {
          this.respawnIn[index] = (this.respawnIn[index] ?? 0) - 1;
          if ((this.respawnIn[index] ?? 0) <= 0) {
            this.spawnSprite(index, this.spawnFor(index + this.world.mainTickCounter));
          }
        }
      }
    }
  }
}
