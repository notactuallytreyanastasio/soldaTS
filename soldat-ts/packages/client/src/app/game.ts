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

export class Game {
  readonly world: World;
  readonly playerIndex = 1;
  framePercent = 0;

  private accumulator = 0;
  private readonly spawns: readonly { x: number; y: number }[];
  private readonly bots: BotEntry[] = [];
  private readonly graph: WaypointGraph;
  private readonly gun: Gun;
  /** Per-sprite next-fire tick (world.mainTickCounter clock). */
  private readonly nextFireTick: number[] = [];
  /** Per-sprite respawn countdown (ticks); 0 = alive. */
  private readonly respawnIn: number[] = [];

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

  /** Spawn a bullet for `index` if it is holding fire and off cooldown. */
  private tryFire(index: number, clock: number): void {
    const s = this.world.sprites[index];
    const parts = this.world.spriteParts;
    if (s === undefined || parts === null || s.deadMeat || !s.active) return;
    if (!s.control.fire) return;
    if (clock < (this.nextFireTick[index] ?? 0)) return;

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
    const speed = this.gun.bulletSpeed;
    const px = (parts.posX[index] ?? 0) + ax * MUZZLE_OFFSET;
    const py = (parts.posY[index] ?? 0) + ay * MUZZLE_OFFSET;
    spawnBullet(this.world, {
      pos: vec2(px, py),
      velocity: vec2(ax * speed, ay * speed),
      owner: index,
      hitMultiply: this.gun.hitMultiply,
      gun: this.gun,
    });
    s.direction = ax >= 0 ? 1 : -1;
    this.nextFireTick[index] = clock + Math.max(1, this.gun.fireInterval);
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
