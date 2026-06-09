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
  createBotState,
  updateBot,
  buildWaypoints,
  type World,
  type PolyMap,
  type WaypointGraph,
  type PmsWaypoint,
  type BotState,
  type Gun,
} from '@soldat/sim';

type PolyMapSource = Parameters<typeof buildPolyMap>[0];

const TICK_HZ = 60;
const TICK_DT = 1 / TICK_HZ;
const MAX_TICKS_PER_FRAME = 8;

/** Ticks a dead sprite waits before respawning (~3 s). */
const RESPAWN_TICKS = 180;
/** Muzzle stand-off so a fresh bullet doesn't instantly collide with the shooter. */
const MUZZLE_OFFSET = 14;

// --- The ONE gun -----------------------------------------------------------
// Everyone shares a single automatic rifle. The whole game balances around it:
// spray control (accuracy blooms as you hold fire), quick reactions (fast but
// not instant TTK + dodgeable projectiles), and terrain protection (bullets are
// blocked by geometry; reloading forces you behind cover). Tune here.
const FIRE_INTERVAL = 6; // ticks between shots (~10/s auto)
const MAG_SIZE = 30; // rounds per magazine
const RELOAD_TICKS = 95; // ~1.6 s reload — be behind cover
const SPREAD_BASE = 0.015; // rad — a standing tap is near-pinpoint
const SPREAD_HEAT_PER_SHOT = 0.012; // bloom added per sustained shot
const SPREAD_HEAT_MAX = 0.16; // max bloom from spraying
const SPREAD_HEAT_DECAY = 0.05; // bloom recovered per tick when not firing
const SPREAD_MOVE = 0.06; // extra spread while moving fast (stand still to be accurate)
const MOVE_SPREAD_SPEED = 3; // |vx| above which the move penalty applies

// --- Rocket boots ------------------------------------------------------------
// This is a VERY vertical game (decision node 94): flying around is the point.
// A big tank plus on-ground regen means jets gate ENGAGEMENTS (you can't hover
// forever in a duel) without gating MOVEMENT (you're never stranded walking).
// The thrust direction itself is tuned in @soldat/sim (JET_THRUST/JET_AIR_DRIFT).
export const JET_FUEL_MAX = 700; // ticks of burn (~11.7 s of continuous thrust)
const JET_REGEN_PER_TICK = 3; // refuel rate on the ground (empty→full ~3.9 s)
// Coasting in the air trickles fuel back at 1/tick — exactly the burn rate, so
// a 50% thrust duty cycle hovers forever but climbing still spends the tank.
// This is what makes sustained aerial dogfights possible (goal node 124).
const JET_AIR_REGEN_PER_TICK = 1;

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

// --- Spectate-only wander tuning ---------------------------------------------
// With no visible target and no waypoint graph, updateBot leaves a bot's
// controls fully cleared — it stands perfectly still forever. In spectate mode
// (where nobody is around to come find it) bots instead FLY toward a randomly
// chosen spawn pad. Spawn points are the roam goals on purpose: they sit on
// reachable interior platforms, so wanderers never march into a wall corner
// and pogo there (the original x-only roam did exactly that — user-reported).
const ROAM_REACHED = 40; // px — close enough (horizontally) to the goal pad
const ROAM_MIN_TICKS = 120; // re-roll the goal every 120–240 ticks (2–4 s)
const ROAM_VAR_TICKS = 120;
const ROAM_JET_ABOVE = 60; // fly when the goal is this much higher (y smaller)
const STUCK_SPEED = 0.3; // |vx| below this counts as "not moving"
const STUCK_TRIGGER = 45; // ticks of not moving before a jump/jet pulse
const STUCK_PULSE = 20; // ticks the up/jet pulse is held
const STUCK_JET_MIN_FUEL = 100; // only burn jets when the tank has a reserve

interface BotEntry {
  readonly index: number;
  readonly brain: BotState;
  // Spectate-only wander state (unused in normal play).
  roamX: number;
  roamY: number;
  retargetAtTick: number;
  stuckTicks: number;
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

  private accumulator = 0;
  private readonly spectate: boolean;
  private readonly spawns: readonly { x: number; y: number }[];
  private readonly bots: BotEntry[] = [];
  /** Bot navigation graph; rebuilt from real map waypoints in spectate mode. */
  private graph: WaypointGraph;
  private readonly gun: Gun;
  /** Per-sprite next-fire tick (world.mainTickCounter clock). */
  private readonly nextFireTick: number[] = [];
  /** Per-sprite respawn countdown (ticks); 0 = alive. */
  private readonly respawnIn: number[] = [];
  /** Per-sprite rounds left in the magazine. */
  private readonly ammo: number[] = [];
  /** Per-sprite tick the current reload completes (0 = not reloading). */
  private readonly reloadUntil: number[] = [];
  /** Per-sprite spray bloom (radians) — grows while firing, decays at rest. */
  private readonly sprayHeat: number[] = [];

  constructor(opts: GameOptions = {}) {
    this.world = createWorld();
    initSimWorld(this.world, opts.seed !== undefined ? { seed: opts.seed } : undefined);

    this.spectate = opts.spectate ?? false;
    this.spawns = opts.spawns ?? [{ x: 0, y: 0 }];
    // No waypoints in the sandbox arena → an empty graph. Bots still perceive,
    // aim and fire at the nearest enemy; navigation is a no-op (they hold
    // ground — spectate mode layers a wander fallback over this, see simTick).
    this.graph = buildWaypoints({ waypoints: [] });
    this.gun = getGun(WeaponIndex.AK74, false);

    // Player. In spectate mode slot 1 is never spawned: an inactive sprite is
    // skipped by bot perception (findTarget), bullet collision, and the
    // renderer, so the human is truly absent rather than a dormant target.
    if (!this.spectate) {
      this.spawnSprite(this.playerIndex, this.spawnFor(0));
    }

    // Bots.
    const botCount = opts.botCount ?? 3;
    for (let b = 0; b < botCount; b++) {
      const index = this.playerIndex + 1 + b;
      this.spawnSprite(index, this.spawnFor(index));
      this.bots.push({
        index,
        brain: createBotState({ accuracy: 9 }),
        roamX: this.spawnFor(index).x,
        roamY: this.spawnFor(index).y,
        retargetAtTick: 0,
        stuckTicks: 0,
      });
    }
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
    s.selWeapon = WeaponIndex.AK74;
    s.jetsCount = JET_FUEL_MAX;
    s.jetsCountReal = JET_FUEL_MAX;
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
    this.nextFireTick[index] = 0;
    this.respawnIn[index] = 0;
    this.ammo[index] = MAG_SIZE;
    this.reloadUntil[index] = 0;
    this.sprayHeat[index] = 0;
  }

  /** Rounds left in `index`'s magazine (for the HUD). */
  ammoOf(index: number): number {
    return this.ammo[index] ?? 0;
  }

  /** Whether sprite `index` is mid-reload (for the HUD). */
  reloadingOf(index: number): boolean {
    return this.world.mainTickCounter < (this.reloadUntil[index] ?? 0);
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
    return MAG_SIZE;
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
    // Bots think (sets their control: movement aim + fire).
    for (const bot of this.bots) {
      const s = this.world.sprites[bot.index];
      if (s === undefined || s.deadMeat) continue;
      const aimXBefore = s.control.mouseAimX;
      const aimYBefore = s.control.mouseAimY;
      updateBot(this.world, bot.index, bot.brain, this.graph);
      if (this.spectate) {
        this.botSustainment(bot, s, aimXBefore, aimYBefore);
      }
    }

    // Firing: anyone holding fire whose weapon is off cooldown spawns a bullet.
    const clock = this.world.mainTickCounter;
    this.tryFire(this.playerIndex, clock);
    for (const bot of this.bots) this.tryFire(bot.index, clock);

    // Physics + bullets + things.
    stepWorld(this.world);

    // Jet refuel: burner off regenerates fuel — fast on the ground, a trickle
    // while coasting in the air (player and bots alike).
    for (const s of this.world.sprites) {
      if (s.deadMeat || !s.active) continue;
      if (!s.control.jetpack && s.jetsCount < JET_FUEL_MAX) {
        const regen = s.onGround ? JET_REGEN_PER_TICK : JET_AIR_REGEN_PER_TICK;
        s.jetsCount = Math.min(s.jetsCount + regen, JET_FUEL_MAX);
      }
    }

    // Death / respawn upkeep.
    this.respawnUpkeep();
  }

  /**
   * Spectate-only per-tick bot upkeep, run right after updateBot:
   *
   * (a) AIM FIX — the ported AI (simpleDecision / navigateWaypoints) writes
   * ABSOLUTE world coords into control.mouseAimX/Y (the Pascal convention),
   * but this client's tryFire and the renderer treat mouseAim as a RELATIVE
   * direction vector from the shooter. Convert when the AI wrote an aim this
   * tick (an unconverted value left in place is already relative from a prior
   * tick — freeControls intentionally keeps the last aim).
   *
   * (b) WANDER — with no visible target and no usable waypoint graph the AI
   * leaves every control cleared and the bot freezes. Fly toward a
   * periodically re-rolled spawn-pad goal (world.rng — never Math.random, the
   * sim must stay deterministic), jetting when the goal is above; when stuck
   * against geometry, pulse jump/jets AND pick a new destination.
   */
  private botSustainment(
    bot: BotEntry,
    s: World['sprites'][number],
    aimXBefore: number,
    aimYBefore: number,
  ): void {
    const parts = this.world.spriteParts;
    if (parts === null) return;
    const px = parts.posX[bot.index] ?? 0;
    const py = parts.posY[bot.index] ?? 0;

    // (a) Absolute → relative aim. targetNum > 0 guarantees simpleDecision
    // wrote both aim fields (even if the value happens to match); otherwise a
    // changed aim means navigateWaypoints faced a waypoint.
    const wroteAim =
      bot.brain.targetNum > 0 ||
      s.control.mouseAimX !== aimXBefore ||
      s.control.mouseAimY !== aimYBefore;
    if (wroteAim) {
      s.control.mouseAimX = Math.round(s.control.mouseAimX - px);
      s.control.mouseAimY = Math.round(s.control.mouseAimY - py);
    }

    // (b) Wander when the AI produced no intent at all this tick (no target →
    // no fire; empty/unreachable graph → no movement).
    const idle =
      !s.control.fire && !s.control.left && !s.control.right && !s.control.up;
    if (!idle) {
      bot.stuckTicks = 0;
      return;
    }

    const clock = this.world.mainTickCounter;
    const arrived = Math.abs(px - bot.roamX) <= ROAM_REACHED;
    if (clock >= bot.retargetAtTick || arrived) {
      // Roam goal = a random spawn pad: always interior, always reachable.
      const goal =
        this.spawns[this.world.rng.nextInt(Math.max(1, this.spawns.length))];
      bot.roamX = goal?.x ?? 0;
      bot.roamY = goal?.y ?? 0;
      bot.retargetAtTick =
        clock + ROAM_MIN_TICKS + Math.floor(this.world.rng.next() * ROAM_VAR_TICKS);
    }
    if (px < bot.roamX - ROAM_REACHED) s.control.right = true;
    else if (px > bot.roamX + ROAM_REACHED) s.control.left = true;
    // FLY to elevated goals: this is the aerial game — wanderers cross the
    // arena through the air, not by pacing the floor under their target pad.
    if (bot.roamY < py - ROAM_JET_ABOVE && s.jetsCount > STUCK_JET_MIN_FUEL) {
      s.control.jetpack = true;
    }

    // Stuck against a wall/ledge → pulse jump+jet AND re-roll the goal so the
    // bot leaves instead of grinding the same corner forever.
    const vx = parts.velocityX[bot.index] ?? 0;
    if ((s.control.left || s.control.right) && Math.abs(vx) < STUCK_SPEED) {
      bot.stuckTicks += 1;
    } else {
      bot.stuckTicks = 0;
    }
    if (bot.stuckTicks > STUCK_TRIGGER) {
      s.control.up = true;
      s.control.jetpack = s.jetsCount > STUCK_JET_MIN_FUEL;
      if (bot.stuckTicks > STUCK_TRIGGER + STUCK_PULSE) {
        bot.stuckTicks = 0;
        bot.retargetAtTick = 0; // force a new destination next tick
      }
    }
  }

  /**
   * Per-tick weapon upkeep for one sprite: handle reload, spray-heat decay, and
   * fire a bullet (with spread) when fire is held, off cooldown, and loaded.
   */
  private tryFire(index: number, clock: number): void {
    const s = this.world.sprites[index];
    const parts = this.world.spriteParts;
    if (s === undefined || parts === null) return;

    const reloadingUntil = this.reloadUntil[index] ?? 0;
    const reloading = clock < reloadingUntil;
    if (reloading) {
      // Reload completes exactly at reloadUntil.
      if (clock === reloadingUntil - 1) {
        this.ammo[index] = MAG_SIZE;
      }
    }
    if (s.deadMeat || !s.active) return;

    // Manual reload (R) when not full and not already reloading.
    if (s.control.reload && !reloading && (this.ammo[index] ?? 0) < MAG_SIZE) {
      this.reloadUntil[index] = clock + RELOAD_TICKS;
      this.onSound?.('reloadStart', parts.posX[index] ?? 0, parts.posY[index] ?? 0);
      return;
    }

    if (!s.control.fire) {
      // Not firing → spray bloom recovers.
      this.sprayHeat[index] = Math.max(0, (this.sprayHeat[index] ?? 0) - SPREAD_HEAT_DECAY);
      return;
    }
    if (reloading) return;
    if (clock < (this.nextFireTick[index] ?? 0)) return;

    // Empty magazine → auto-reload.
    if ((this.ammo[index] ?? 0) <= 0) {
      this.reloadUntil[index] = clock + RELOAD_TICKS;
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

    // Spread = base + spray bloom + a movement penalty (stand still to be precise).
    const vx = parts.velocityX[index] ?? 0;
    const moving = Math.abs(vx) > MOVE_SPREAD_SPEED ? SPREAD_MOVE : 0;
    const spread = SPREAD_BASE + (this.sprayHeat[index] ?? 0) + moving;
    const jitter = (this.world.rng.next() * 2 - 1) * spread;
    const ang = Math.atan2(ay, ax) + jitter;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);

    const speed = this.gun.bulletSpeed;
    const px = (parts.posX[index] ?? 0) + dx * MUZZLE_OFFSET;
    const py = (parts.posY[index] ?? 0) + dy * MUZZLE_OFFSET;
    spawnBullet(this.world, {
      pos: vec2(px, py),
      velocity: vec2(dx * speed, dy * speed),
      owner: index,
      hitMultiply: this.gun.hitMultiply,
      gun: this.gun,
    });

    s.direction = dx >= 0 ? 1 : -1;
    this.ammo[index] = (this.ammo[index] ?? 0) - 1;
    this.sprayHeat[index] = Math.min(SPREAD_HEAT_MAX, (this.sprayHeat[index] ?? 0) + SPREAD_HEAT_PER_SHOT);
    this.nextFireTick[index] = clock + FIRE_INTERVAL;
    this.onShot?.(index);
    this.onSound?.('fire', px, py);
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
          this.respawnIn[index] = RESPAWN_TICKS;
          const dp = this.world.spriteParts;
          this.onSound?.('death', dp?.posX[index] ?? 0, dp?.posY[index] ?? 0);
          s.deadMeat = true;
          // The one-shot death edge (gated by respawnIn === 0): report the
          // kill with the last-hit attribution the sim recorded.
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
