// The client-side game: owns a sim World, spawns the local player, and runs a
// fixed-timestep simulation loop decoupled from rendering.
//
// PORT: ClientGame.pas GameLoop accumulator. OpenSoldat advances the simulation
// at a fixed 60 Hz (DEFAULT_GAMETICK) while rendering as fast as the display
// allows, carrying a fractional "frame percent" so render interpolates between
// the previous and current simulated tick (GameRendering.pas TimeElapsed /
// fraction). We mirror that here: tick() accumulates real elapsed time and runs
// stepWorld once per fixed slice; framePercent exposes the leftover fraction.

import {
  createWorld,
  initSimWorld,
  stepWorld,
  buildPolyMap,
  vec2,
  POS_STAND,
  type World,
  type PolyMap,
} from '@soldat/sim';

/** Structural map input accepted by buildPolyMap (subset of a parsed PmsMap). */
type PolyMapSource = Parameters<typeof buildPolyMap>[0];

/** Fixed simulation step. PORT: 60 Hz game tick (DEFAULT_GAMETICK = 1/60 s). */
const TICK_HZ = 60;
const TICK_DT = 1 / TICK_HZ; // seconds per simulated tick

/**
 * Guard against the "spiral of death": after a long pause (tab backgrounded)
 * never try to catch up more than this many ticks in one frame. PORT: the
 * engine caps how far the accumulator can run before it gives up catching up.
 */
const MAX_TICKS_PER_FRAME = 8;

export interface GameOptions {
  /** Deterministic RNG seed for the world. Omit to leave rng untouched. */
  seed?: number;
  /** Player spawn position in world coordinates. Defaults to (0, 0). */
  spawn?: { x: number; y: number };
}

/**
 * Owns the simulation. Construct, optionally {@link loadMap}, then drive with
 * {@link tick} each animation frame. Read {@link world}, {@link playerIndex}
 * and {@link framePercent} for rendering.
 */
export class Game {
  /** The live simulation world. */
  readonly world: World;

  /** 1-based sprite index of the local player. */
  readonly playerIndex: number;

  /**
   * Interpolation fraction in [0, 1): how far the render time sits between the
   * last completed tick and the next one. Renderers lerp prev→current by this.
   */
  framePercent = 0;

  /** Real-time accumulator (seconds) carried between {@link tick} calls. */
  private accumulator = 0;

  constructor(opts: GameOptions = {}) {
    // --- Build + configure the world (particle systems, rng). ---------------
    this.world = createWorld();
    if (opts.seed !== undefined) {
      initSimWorld(this.world, { seed: opts.seed });
    } else {
      initSimWorld(this.world);
    }

    // --- Spawn the local player as sprite #1 with a COM particle. -----------
    // CreateSprite uses particle mass 1 (Sprites.pas:323): OneOverMass = 1, and
    // the COM particle index equals the sprite num (here 1). We place it at the
    // requested spawn point with zero initial velocity.
    this.playerIndex = 1;
    const spawn = opts.spawn ?? { x: 0, y: 0 };
    const parts = this.world.spriteParts;
    if (parts === null) {
      throw new Error('Game: spriteParts not initialized (initSimWorld failed)');
    }
    parts.createPart(vec2(spawn.x, spawn.y), vec2(0, 0), 1, this.playerIndex);

    const player = this.world.sprites[this.playerIndex];
    if (player === undefined) {
      throw new Error('Game: player sprite slot missing');
    }
    player.active = true;
    player.num = this.playerIndex;
    player.style = 1;
    player.position = POS_STAND;
    player.direction = 1;
    player.health = 150; // PORT: STARTHEALTH (Sprites.pas) — full health on spawn.
    player.visible = 1;
    // Jet fuel — Soldat seeds JetsCount from Map.StartJet at spawn. The synthetic
    // dev map has none, so give a usable default ("rocket boots" work offline).
    player.jetsCount = 250;
    player.jetsCountReal = 250;
  }

  /**
   * Build the sim collision map from a parsed .PMS-shaped source and attach it
   * to the world so stepWorld uses the PolyMap collision path. Without this the
   * world free-falls (no floor) per StepOptions defaults.
   */
  loadMap(source: PolyMapSource): void {
    const polyMap: PolyMap = buildPolyMap(source);
    this.world.map = polyMap;
  }

  /**
   * Advance the simulation by `dtSeconds` of real time, running zero or more
   * fixed 60 Hz ticks. Rendering is NOT done here — it reads framePercent after.
   *
   * PORT: ClientGame.pas GameLoop — accumulate real elapsed time, run UpdateFrame
   * once per fixed slice, keep the remainder as the interpolation fraction.
   */
  tick(dtSeconds: number): void {
    // Clamp absurd dt (e.g. first frame, or returning from a backgrounded tab)
    // so we never request a huge catch-up burst.
    const dt = dtSeconds > 0 && dtSeconds < 1 ? dtSeconds : TICK_DT;
    this.accumulator += dt;

    let ticks = 0;
    while (this.accumulator >= TICK_DT && ticks < MAX_TICKS_PER_FRAME) {
      stepWorld(this.world);
      this.accumulator -= TICK_DT;
      ticks += 1;
    }

    // If we hit the catch-up cap, drop the backlog rather than spiral.
    if (this.accumulator > TICK_DT) {
      this.accumulator = 0;
    }

    // Fraction of the next tick already elapsed → render interpolation factor.
    this.framePercent = this.accumulator / TICK_DT;
  }
}
