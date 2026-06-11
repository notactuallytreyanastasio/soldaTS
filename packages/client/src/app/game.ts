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
// Slot 2 is the Barrett M82A1 (same contract): the one-hit-kill, slow-cycling,
// map-distance sniper rifle — reachable via the 'rifle' wildcard or the
// player's swap key, and exactly as inert as the SPAS when unused.
//
// Slot 3 is the M79 rocket launcher (contract M79 row): a slow arcing rocket
// that detonates on impact — direct hit kills, the blast AoE hits everyone
// near it including the shooter (rocket jumping). 'rocket' wildcard.
//
// Slot 4 is the Ricochet Carbine (new contract row derived from the Ruger 77):
// PLAIN rounds that BOUNCE off walls/floors/platforms up to four times at 75%
// energy per bounce (sim ricochetOffMap). 'ricochet' wildcard.
//
// Slot 5 is the Chainsaw (contract row, KNIFE style): a melee stream — every
// other tick a short-lived 8 px/tick blade bullet that dies after one update
// (MELEE_TIMEOUT 1), giving a ~25-40 px reach and contact kills (8 * 50 *
// chest = 400 vs 150 hp), fed by a 200-round fuel tank. 'chainsaw' wildcard.
//
// All off-slots are equally inert when unused: no rng draw, no sim effect,
// byte-identical default matches.
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
/** Slot 2: the Barrett M82A1 (wildcard carriers / player swap). */
export const SLOT_BARRETT = 2;
/** Slot 3: the M79 rocket launcher (wildcard carriers / player swap). */
export const SLOT_ROCKET = 3;
/** Slot 4: the Ricochet Carbine (wildcard carriers / player swap). */
export const SLOT_RICOCHET = 4;
/** Slot 5: the Chainsaw (wildcard carriers / player swap). */
export const SLOT_CHAINSAW = 5;
/** Pellets per SPAS-12 trigger pull. PORT: the Pascal fire path spawns one
 *  bullet per pellet — 6 pellets per shell. */
export const SPAS_PELLETS = 6;
/** Kill-feed / HUD weapon labels per slot (kept terse: `Killer [SPAS12] Victim`). */
export const WEAPON_LABELS: readonly [string, string, string, string, string, string] = [
  'AK74',
  'SPAS12',
  'BARRETT',
  'ROCKET',
  'RICOCHET',
  'CHAINSAW',
];
/** All slots, in swap-cycle order (Tab/B walks this ring). */
const SLOTS = [
  SLOT_AK,
  SLOT_SPAS,
  SLOT_BARRETT,
  SLOT_ROCKET,
  SLOT_RICOCHET,
  SLOT_CHAINSAW,
] as const;
type Slot = (typeof SLOTS)[number];
/** Contract WeaponIndex per slot (sprite.selWeapon mirrors the active slot). */
const SLOT_WEAPON_INDEX: readonly [number, number, number, number, number, number] = [
  WeaponIndex.AK74,
  WeaponIndex.SPAS12,
  WeaponIndex.BARRETT,
  WeaponIndex.M79,
  WeaponIndex.RICOCHET,
  WeaponIndex.CHAINSAW,
];

// Barrett gameplay overrides (the SPEC: one-hit-kill, SLOW, map-distance).
// The pure contract-ratio scaling that derives the SPAS would give the Barrett
// a mag of round(10*30/35) = 9 and a reload of round(70*95/165) = 40 ticks
// (0.67 s) — neither is the "tiny mag, punishing reload" the spec demands, so
// these two stats are explicit gameplay overrides (still scaled by the match
// variant's AK ratio so tuned variants move the Barrett in step):
/** Barrett magazine at stock tuning (contract ammo 10 → 3: the spec's small mag). */
const BARRETT_MAG_STOCK = 3;
/** Barrett reload at stock tuning: 210 ticks = 3.5 s — the spec's ~3-4 s feel. */
const BARRETT_RELOAD_STOCK = 210;

// Rocket / Ricochet / Chainsaw stock anchors (the Barrett precedent: where the
// pure AK-ratio scaling would betray the gun's spec, the stat is an explicit
// stock-anchored value, still scaled by the variant's own AK ratio so tuned
// matches move every gun in step).
/** Rocket reload at stock tuning: the contract's punishing 178 ticks (~3 s)
 *  kept VERBATIM (the AK-ratio would compress it to 102). */
const ROCKET_RELOAD_STOCK = 178;
/** Ricochet magazine at stock tuning: the contract's 6 (AK-ratio gives 5). */
const RICOCHET_MAG_STOCK = 6;
/** Ricochet reload at stock tuning: 120 ticks (2 s) — medium, between the
 *  AK's 95 and the Barrett's 210 (the contract's Ruger-derived 78 scaled by
 *  the AK ratio would be a 45-tick blink — too forgiving for a bouncer). */
const RICOCHET_RELOAD_STOCK = 120;
/** Chainsaw cadence/fuel/reload at stock tuning: the contract row VERBATIM
 *  (fireInterval 2 / ammo 200 / reload 110) — "the contract as-is". The
 *  AK-ratio would distort all three (1 / 171 / 63). */
const CHAINSAW_FIRE_INTERVAL_STOCK = 2;
const CHAINSAW_MAG_STOCK = 200;
const CHAINSAW_RELOAD_STOCK = 110;

/** Per-slot effective numbers derived from GameTuning + the weapon contract. */
interface SlotTuning {
  fireInterval: number;
  magSize: number;
  reloadTicks: number;
  spreadBase: number; // rad — per-shot (per-pellet for the SPAS) angle jitter
}

/** One SlotTuning per slot, indexed by SLOT_*. */
type SlotTunings = readonly [
  SlotTuning,
  SlotTuning,
  SlotTuning,
  SlotTuning,
  SlotTuning,
  SlotTuning,
];

/** One contract Gun per slot, indexed by SLOT_*. */
type SlotGuns = readonly [Gun, Gun, Gun, Gun, Gun, Gun];

/** Per-slot mutable state arrays (indexed by SLOT_*, then sprite index). */
type PerSlot<T> = [T, T, T, T, T, T];
const perSlotArrays = (): PerSlot<number[]> => [[], [], [], [], [], []];

/** Wildcard name → the slot it arms (unknown / undefined = stock loadouts). */
const WILDCARD_SLOT: Readonly<Record<string, Slot>> = {
  shotgun: SLOT_SPAS,
  rifle: SLOT_BARRETT,
  rocket: SLOT_ROCKET,
  ricochet: SLOT_RICOCHET,
  chainsaw: SLOT_CHAINSAW,
};

/**
 * Derive all weapon slots' numbers from the match tuning.
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
 *
 * Slot 2 (Barrett M82A1) uses the same ratio approach for its CADENCE —
 * fireInterval 225 → 225*6/10 = 135 ticks (2.25 s between shots, the
 * contract's punishing cycle) — but two explicit gameplay overrides where the
 * ratio would betray the spec (see BARRETT_MAG_STOCK / BARRETT_RELOAD_STOCK):
 * a 3-round magazine and a 210-tick (3.5 s) reload, each still scaled by the
 * variant's own AK ratio. bulletSpread 0 → spreadBase 0: a laser.
 *
 * ONE-HIT-KILL MATH (why the contract hitMultiply 4.45 is kept as-is):
 *   damage = |bulletVelocity| * hitMultiply * modifierChest   (damage.ts)
 *          = 55 * 4.45 * 1.0 = 244.75  vs  STARTHEALTH 150 → dead (63% margin).
 *   Minimum hitMultiply for a torso OHK at muzzle speed: 150/55 ≈ 2.73 — the
 *   contract's 4.45 clears it, and stays lethal down to |v| ≈ 33.8 px/tick.
 *   Distance is handled in the sim, not here: Barrett rounds are EXEMPT from
 *   the 500/900 px hitMultiply halving (DEGRADATION_EXEMPT_NUMS, bullet.ts),
 *   so 4.45 holds at any range and the OHK survives a cross-map shot.
 *
 * Slot 3 (M79 rocket) keeps the contract's 1-round magazine and scales its
 * cadence by the AK ratio; the 178-tick reload is a stock-anchored value
 * (ROCKET_RELOAD_STOCK — the contract number verbatim at stock).
 * ROCKET KILL MATH: a direct hit is 10.7 * 1550 * chest ≈ 16,585 vs 150 hp —
 * guaranteed; the blast AoE handles everyone else (sim explodeBullet:
 * 250 epicentre damage, linear falloff over 64 px, owner at 0.5).
 *
 * Slot 4 (Ricochet Carbine) scales cadence from its Ruger-derived contract
 * row (45 → 27 ticks stock); mag 6 and reload 120 are stock-anchored
 * (RICOCHET_MAG_STOCK / RICOCHET_RELOAD_STOCK — see their docs).
 *
 * Slot 5 (Chainsaw) is the contract row verbatim at stock — fireInterval 2,
 * fuel 200, reload 110 — via stock anchors (CHAINSAW_*_STOCK).
 */
function deriveSlotTuning(tuning: GameTuning, guns: SlotGuns): SlotTunings {
  const [ak, spas, barrett, rocket, ricochet] = guns;
  const scale = (stat: number, akStat: number, tunedAk: number): number =>
    Math.max(1, Math.round((stat * tunedAk) / akStat));
  /** Angular spread from the contract's velocity-perturbation spread model. */
  const angular = (gun: Gun): number => Math.atan(gun.bulletSpread / gun.bulletSpeed);
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
      spreadBase: angular(spas),
    },
    {
      fireInterval: scale(barrett.fireInterval, ak.fireInterval, tuning.fireInterval),
      // Gameplay overrides anchored at stock (NOT contract ratios — see doc).
      magSize: scale(BARRETT_MAG_STOCK, DEFAULT_TUNING.magSize, tuning.magSize),
      reloadTicks: scale(BARRETT_RELOAD_STOCK, DEFAULT_TUNING.reloadTicks, tuning.reloadTicks),
      spreadBase: angular(barrett), // 0 — a laser
    },
    {
      fireInterval: scale(rocket.fireInterval, ak.fireInterval, tuning.fireInterval),
      magSize: rocket.ammo, // the contract's single round — never scaled up
      reloadTicks: scale(ROCKET_RELOAD_STOCK, DEFAULT_TUNING.reloadTicks, tuning.reloadTicks),
      spreadBase: angular(rocket), // 0 — aim is the skill
    },
    {
      fireInterval: scale(ricochet.fireInterval, ak.fireInterval, tuning.fireInterval),
      magSize: scale(RICOCHET_MAG_STOCK, DEFAULT_TUNING.magSize, tuning.magSize),
      reloadTicks: scale(RICOCHET_RELOAD_STOCK, DEFAULT_TUNING.reloadTicks, tuning.reloadTicks),
      spreadBase: angular(ricochet), // 0 — bank shots want precision
    },
    {
      fireInterval: scale(
        CHAINSAW_FIRE_INTERVAL_STOCK,
        DEFAULT_TUNING.fireInterval,
        tuning.fireInterval,
      ),
      magSize: scale(CHAINSAW_MAG_STOCK, DEFAULT_TUNING.magSize, tuning.magSize),
      reloadTicks: scale(CHAINSAW_RELOAD_STOCK, DEFAULT_TUNING.reloadTicks, tuning.reloadTicks),
      spreadBase: 0, // a blade has no spread
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
   * Number of HUMAN-controlled sprites (goal node 450 — true multiplayer).
   * Default 1 (the classic local player at slot 1). With 2+, sprites at
   * playerIndex..playerIndex+humanCount-1 are all brainless human slots: the
   * caller writes their `control` each tick (locally from the keyboard, or
   * server-side from network input frames). Humans alternate teams red/blue
   * when `teams` is on. Bots start after the last human slot. Ignored in
   * spectate mode (no human sprites at all).
   */
  humanCount?: number | undefined;
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
   * Opt-in wildcard ('shotgun' | 'rifle' | 'rocket' | 'ricochet' |
   * 'chainsaw'): exactly one bot per team (one bot total in FFA) carries the
   * wildcard weapon — SPAS-12 / Barrett / M79 rocket launcher / Ricochet
   * Carbine / Chainsaw respectively — picked deterministically from the match
   * seed via world.rng. Absent/undefined = stock loadouts, zero rng consumed.
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
  /**
   * All human sprite indices (playerIndex..playerIndex+humanCount-1). The
   * default single-player game is exactly [playerIndex]; spectate is [].
   */
  readonly humanIndices: readonly number[];
  /** Same set, for the per-shot aim-assist gate (humans only, never bots). */
  private readonly humanSet: ReadonlySet<number>;
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
  /** The guns from the shared weapon contract, indexed by SLOT_*:
   *  [AK74, SPAS12, BARRETT, M79 rocket, RICOCHET, CHAINSAW]. */
  private readonly guns: SlotGuns;
  /** Per-slot effective fire/mag/reload/spread numbers (see deriveSlotTuning). */
  private readonly slotTuning: SlotTunings;
  /** Per-sprite active weapon slot (SLOT_AK everywhere by default). */
  private readonly weaponSlot: number[] = [];
  /** Per-sprite previous changeWeapon flag — swap on the rising edge only. */
  private readonly prevChangeWeapon: boolean[] = [];
  /** Wildcard carriers: sprite index → armed slot (survives respawn). */
  private readonly carrierSlot = new Map<number, Slot>();
  /** The active wildcard ('shotgun' | 'rifle' | 'rocket' | 'ricochet' |
   *  'chainsaw') or undefined (stock loadouts). */
  readonly wildcard: string | undefined;
  /** Per-slot per-sprite next-fire tick (world.mainTickCounter clock). */
  private readonly nextFireTick: PerSlot<number[]> = perSlotArrays();
  /** Per-sprite respawn countdown (ticks); 0 = alive. */
  private readonly respawnIn: number[] = [];
  /** Per-slot per-sprite rounds left in the magazine. */
  private readonly ammo: PerSlot<number[]> = perSlotArrays();
  /** Per-slot per-sprite tick the current reload completes (0 = not reloading). */
  private readonly reloadUntil: PerSlot<number[]> = perSlotArrays();
  /** Per-slot per-sprite spray bloom (radians) — grows firing, decays at rest. */
  private readonly sprayHeat: PerSlot<number[]> = perSlotArrays();
  /** Per-sprite Barrett charge progress (ticks of fire held while ready);
   *  the shot fires once this reaches the contract startUpTime (19). Releasing
   *  fire mid-charge cancels (reset to 0); swap and respawn also reset. */
  private readonly barrettCharge: number[] = [];
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
    this.guns = [
      getGun(WeaponIndex.AK74, false),
      getGun(WeaponIndex.SPAS12, false),
      getGun(WeaponIndex.BARRETT, false),
      getGun(WeaponIndex.M79, false),
      getGun(WeaponIndex.RICOCHET, false),
      getGun(WeaponIndex.CHAINSAW, false),
    ];
    this.slotTuning = deriveSlotTuning(this.tuning, this.guns);
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
      weaponOf: (i: number): string => this.weaponNameOf(i),
    };

    // Engines/teams resolve FIRST (humans need their team assignment when
    // teams are on). Neither consumes world.rng, so spawn order — and replay
    // byte-identity — is untouched.
    this.engineTweaks = opts.engineTweaks ?? {};
    this.engines = Game.resolveEngines(opts.aiEngine, this.engineTweaks);
    this.teamsEnabled = opts.teams ?? this.engineGroups().length > 1;

    // Humans (goal node 450). In spectate mode NO human slot is ever spawned:
    // an inactive sprite is skipped by bot perception (findTarget), bullet
    // collision, and the renderer, so the human is truly absent rather than a
    // dormant target. With humanCount 2+ (online 1v1), humans alternate teams
    // red/blue when teams are on; the classic single human stays teamless.
    const humanCount = this.spectate ? 0 : Math.max(1, opts.humanCount ?? 1);
    const humans: number[] = [];
    for (let h = 0; h < humanCount; h++) {
      const index = this.playerIndex + h;
      humans.push(index);
      if (this.teamsEnabled && humanCount >= 2) {
        this.botTeam.set(index, (h % 2) + 1);
      }
      this.spawnSprite(index, this.spawnFor(h));
    }
    this.humanIndices = humans;
    this.humanSet = new Set(humans);

    // Bots. `aiEngine` may be one id ('pilot') or a comma list
    // ('classic,pilot') — a list splits the bots round-robin into a MIXED
    // match where the engines fight each other in the same arena. Bots start
    // after the last human slot (spectate keeps the historical base of 2 so
    // every recorded match replays byte-identically).
    const botBase = this.playerIndex + Math.max(humanCount, 1);
    const botCount = opts.botCount ?? 3;
    for (let b = 0; b < botCount; b++) {
      const index = botBase + b;
      const engine = this.engineForSlot(b);
      this.botEngine.set(index, engine.id);
      if (this.teamsEnabled) this.botTeam.set(index, this.teamFor(b, engine.id));
      this.spawnSprite(index, this.spawnFor(index));
      this.bots.push({ index, brain: engine.createBrain() });
    }

    // Weapon wildcard ('shotgun' → SPAS-12, 'rifle' → Barrett, 'rocket' →
    // M79, 'ricochet' → Ricochet Carbine, 'chainsaw' → Chainsaw): ONE carrier
    // per team (one total in FFA), picked from the match seed through
    // world.rng — the only randomness source — so the same seed always arms
    // the same bot. The rng draw ORDER is identical for every wildcard (one
    // nextInt per pool), so a given seed arms the same carrier indices
    // whichever weapon rides the wildcard. Skipped entirely (no rng draw)
    // when the wildcard is off: default matches stay byte-identical.
    const armedSlot: Slot | undefined = WILDCARD_SLOT[this.wildcard ?? ''];
    if (armedSlot !== undefined && this.bots.length > 0) {
      const pools: number[][] = this.teamsEnabled
        ? [1, 2].map((team) =>
            this.bots.filter((b) => this.teamOf(b.index) === team).map((b) => b.index),
          )
        : [this.bots.map((b) => b.index)];
      for (const pool of pools) {
        if (pool.length === 0) continue;
        const pick = pool[this.world.rng.nextInt(pool.length)];
        if (pick === undefined) continue;
        this.carrierSlot.set(pick, armedSlot);
        this.weaponSlot[pick] = armedSlot;
        const sp = this.world.sprites[pick];
        if (sp !== undefined) sp.selWeapon = SLOT_WEAPON_INDEX[armedSlot];
      }
    }
  }

  /** Wildcard weapon carriers (ascending sprite index; empty when off). */
  wildcardCarriers(): readonly number[] {
    return [...this.carrierSlot.keys()].sort((a, b) => a - b);
  }

  /** Kill-feed/HUD label of `index`'s weapon ('AK74' | 'SPAS12' | 'BARRETT'
   *  | 'ROCKET' | 'RICOCHET' | 'CHAINSAW'). */
  weaponNameOf(index: number): string {
    return WEAPON_LABELS[this.slotOf(index)];
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
    // Wildcard carriers respawn with their armed weapon; everyone else
    // (player included) respawns on the default rifle.
    const slot = this.carrierSlot.get(index) ?? SLOT_AK;
    this.weaponSlot[index] = slot;
    this.prevChangeWeapon[index] = false;
    s.selWeapon = SLOT_WEAPON_INDEX[slot];
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
    // ALL weapon slots come back full — a respawn is a fresh loadout.
    for (const sl of SLOTS) {
      this.nextFireTick[sl][index] = 0;
      this.ammo[sl][index] = this.slotTuning[sl].magSize;
      this.reloadUntil[sl][index] = 0;
      this.sprayHeat[sl][index] = 0;
    }
    this.barrettCharge[index] = 0;
  }

  /** `index`'s active weapon slot (SLOT_AK .. SLOT_CHAINSAW). */
  private slotOf(index: number): Slot {
    const slot = this.weaponSlot[index];
    return (SLOTS as readonly number[]).includes(slot ?? -1) ? (slot as Slot) : SLOT_AK;
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
    for (const human of this.humanIndices) this.weaponSwapUpkeep(human);
    for (const bot of this.bots) this.weaponSwapUpkeep(bot.index);

    // Firing: anyone holding fire whose weapon is off cooldown spawns a bullet.
    for (const human of this.humanIndices) this.tryFire(human, clock);
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
   * Swap `index`'s weapon on the rising edge of control.changeWeapon, cycling
   * AK74 → SPAS12 → BARRETT → ROCKET → RICOCHET → CHAINSAW → AK74 (shotgun-era
   * precedent: the player may
   * always cycle to every slot regardless of the match's wildcard — bots
   * never raise the flag, so only carriers ever fire the off-slots). Each
   * slot keeps its OWN ammo/cooldown/heat; a swap is never a free reload, and
   * swapping away mid-reload CANCELS that reload (classic Soldat feel) — and
   * cancels any Barrett charge in progress.
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
    this.barrettCharge[index] = 0;
    const next = SLOTS[(cur + 1) % SLOTS.length]!;
    this.weaponSlot[index] = next;
    s.selWeapon = SLOT_WEAPON_INDEX[next];
  }

  /**
   * Per-tick weapon upkeep for one sprite: handle reload, spray-heat decay, and
   * fire (with spread) when fire is held, off cooldown, and loaded. The AK
   * spawns one bullet; the SPAS-12 spawns SPAS_PELLETS bullets, each with its
   * own world.rng spread draw (the Pascal rule: one spawn per pellet). The
   * Barrett adds the contract's startUpTime charge: a ready trigger pull must
   * be HELD for startUpTime (19) ticks before the round leaves the barrel —
   * releasing fire mid-charge cancels and a fresh pull starts from zero.
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
      // Not firing → spray bloom recovers, and a mid-charge Barrett CANCELS.
      this.barrettCharge[index] = 0;
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

    // Barrett charge-up (contract startUpTime 19): the trigger must be HELD
    // for startUpTime ticks while the gun is otherwise ready (loaded, off
    // cooldown, not reloading) before the shot fires. The counter only runs
    // here — past every gate above — so cooldown/reload don't pre-charge the
    // NEXT shot, and the !fire branch resets it (release = cancel).
    if (slot === SLOT_BARRETT) {
      const charge = this.barrettCharge[index] ?? 0;
      if (charge < gun.startUpTime) {
        this.barrettCharge[index] = charge + 1;
        return;
      }
      this.barrettCharge[index] = 0;
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

    // Aim assist: HUMAN shots near a live enemy bend the last few degrees
    // onto it (humans ONLY — assisted bots are aimbots; in online 1v1 both
    // humans get it, so the magnetism stays symmetric). Applied before
    // spread so spray bloom still punishes held fire.
    if (this.humanSet.has(index)) {
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
    // In spectate mode no human slot is ever spawned and they MUST stay out
    // of this list: a never-spawned sprite has health 0, which the freshly-
    // dead check below reads as a death — it would "respawn" the player ~3 s
    // in. humanIndices is already [] in spectate.
    const all = [...this.humanIndices, ...this.bots.map((b) => b.index)];
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
