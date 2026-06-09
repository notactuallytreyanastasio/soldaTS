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

interface BotEntry {
  readonly index: number;
  readonly brain: BotState;
}

export interface GameOptions {
  /** Deterministic RNG seed for the world. */
  seed?: number;
  /** Spawn points (world coords); player takes [0], bots cycle the rest. */
  spawns?: readonly { x: number; y: number }[];
  /** Number of bots to spawn (default 3). */
  botCount?: number;
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

  private accumulator = 0;
  private readonly spawns: readonly { x: number; y: number }[];
  private readonly bots: BotEntry[] = [];
  private readonly graph: WaypointGraph;
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

    this.spawns = opts.spawns ?? [{ x: 0, y: 0 }];
    // No waypoints in the sandbox arena → an empty graph. Bots still perceive,
    // aim and fire at the nearest enemy; navigation is a no-op (they hold ground).
    this.graph = buildWaypoints({ waypoints: [] });
    this.gun = getGun(WeaponIndex.AK74, false);

    // Player.
    this.spawnSprite(this.playerIndex, this.spawnFor(0));

    // Bots.
    const botCount = opts.botCount ?? 3;
    for (let b = 0; b < botCount; b++) {
      const index = this.playerIndex + 1 + b;
      this.spawnSprite(index, this.spawnFor(index));
      this.bots.push({ index, brain: createBotState({ accuracy: 9 }) });
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
    s.deadMeat = false;
    s.dummy = false;
    s.selWeapon = WeaponIndex.AK74;
    s.jetsCount = 250;
    s.jetsCountReal = 250;
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
    this.nextFireTick[index] = 0;
    this.respawnIn[index] = 0;
    this.ammo[index] = MAG_SIZE;
    this.reloadUntil[index] = 0;
    this.sprayHeat[index] = 0;
  }

  /** Local player's rounds left (for the HUD). */
  playerAmmo(): number {
    return this.ammo[this.playerIndex] ?? 0;
  }

  /** Whether the local player is mid-reload (for the HUD). */
  playerReloading(): boolean {
    return this.world.mainTickCounter < (this.reloadUntil[this.playerIndex] ?? 0);
  }

  magSize(): number {
    return MAG_SIZE;
  }

  loadMap(source: PolyMapSource): void {
    const polyMap: PolyMap = buildPolyMap(source);
    this.world.map = polyMap;
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
      updateBot(this.world, bot.index, bot.brain, this.graph);
    }

    // Firing: anyone holding fire whose weapon is off cooldown spawns a bullet.
    const clock = this.world.mainTickCounter;
    this.tryFire(this.playerIndex, clock);
    for (const bot of this.bots) this.tryFire(bot.index, clock);

    // Physics + bullets + things.
    stepWorld(this.world);

    // Death / respawn upkeep.
    this.respawnUpkeep();
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
    this.onSound?.('fire', px, py);
  }

  /** Start respawn timers for the freshly dead; respawn when they elapse. */
  private respawnUpkeep(): void {
    const all = [this.playerIndex, ...this.bots.map((b) => b.index)];
    for (const index of all) {
      const s = this.world.sprites[index];
      if (s === undefined) continue;
      if (s.deadMeat || s.health <= 0) {
        if ((this.respawnIn[index] ?? 0) === 0) {
          this.respawnIn[index] = RESPAWN_TICKS;
          const dp = this.world.spriteParts;
          this.onSound?.('death', dp?.posX[index] ?? 0, dp?.posY[index] ?? 0);
          s.deadMeat = true;
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
