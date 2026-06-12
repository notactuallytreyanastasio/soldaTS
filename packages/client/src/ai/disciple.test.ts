// "disciple" engine (disciple.ts) — the single-teacher clone with 24-bin
// softmax aim. The shipped weights are opaque, so these tests assert
// weight-independent invariants: threshold semantics (sigmoid ∈ (0,1) makes
// thresholds 0/1 decisive), the aim decode's magnitude contract, the
// empty-mag rule, the roam fallback, guard clauses and determinism.

import { describe, it, expect } from 'vitest';
import type { World } from '@soldat/sim';
import type { BotEngineContext } from './engine';
import { createDiscipleEngine, DISCIPLE_DEFAULTS } from './disciple';

// --- Stub world (minimal hand-rolled World; sentinel at index 0) -------------

interface StubBot {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  team?: number;
  health?: number;
  alpha?: number;
  holdedThing?: number;
  active?: boolean;
  deadMeat?: boolean;
  jetsCount?: number;
  onGround?: boolean;
}

interface StubControl {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  fire: boolean;
  jetpack: boolean;
  reload: boolean;
  mouseAimX: number;
  mouseAimY: number;
}

function makeControl(): StubControl {
  return {
    left: false,
    right: false,
    up: false,
    down: false,
    fire: false,
    jetpack: false,
    reload: false,
    mouseAimX: 0,
    mouseAimY: 0,
  };
}

function makeWorld(bots: StubBot[], tick = 100): World {
  const sprites: unknown[] = [{ active: false }];
  const posX = [0];
  const posY = [0];
  const velocityX = [0];
  const velocityY = [0];
  for (const b of bots) {
    sprites.push({
      active: b.active ?? true,
      deadMeat: b.deadMeat ?? false,
      team: b.team ?? 0,
      health: b.health ?? 150,
      alpha: b.alpha ?? 255,
      holdedThing: b.holdedThing ?? 0,
      jetsCount: b.jetsCount ?? 700,
      onGround: b.onGround ?? true,
      control: makeControl(),
    });
    posX.push(b.x ?? 0);
    posY.push(b.y ?? 0);
    velocityX.push(b.vx ?? 0);
    velocityY.push(b.vy ?? 0);
  }
  let seed = 42 >>> 0; // deterministic LCG for roamTick's rng
  const rng = {
    next(): number {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    },
    nextInt(n: number): number {
      return Math.floor(this.next() * n);
    },
  };
  return {
    sprites,
    bullets: [{ active: false, owner: 0, num: 0 }],
    mainTickCounter: tick,
    spriteParts: { posX, posY, velocityX, velocityY },
    bulletParts: null,
    rng,
  } as unknown as World;
}

function makeCtx(
  world: World,
  over: Partial<Pick<BotEngineContext, 'ammoOf' | 'reloadingOf'>> = {},
): BotEngineContext {
  return {
    world,
    graph: { nodes: [], edges: [] },
    spawns: [{ x: 1000, y: 0 }],
    spectate: true,
    ammoOf: () => 30,
    reloadingOf: () => false,
    magSize: 30,
    ...over,
  } as unknown as BotEngineContext;
}

const controlOf = (world: World, i: number): StubControl =>
  (world.sprites[i] as unknown as { control: StubControl }).control;

// A standard engagement: bot 1 at the origin, one enemy up-right.
const DUEL: StubBot[] = [
  { x: 0, y: 0 },
  { x: 200, y: -50 },
];

describe('createDiscipleEngine', () => {
  it("returns id 'disciple' with the resolved defaults and a strategy line", () => {
    const engine = createDiscipleEngine();
    expect(engine.id).toBe('disciple');
    expect(engine.strategy.length).toBeGreaterThan(0);
    expect(engine.tweaks).toEqual(DISCIPLE_DEFAULTS);
  });
});

describe('DiscipleBrain — threshold semantics', () => {
  it('thresholds of 0 turn every button on (sigmoid > 0 always)', () => {
    const world = makeWorld(DUEL);
    createDiscipleEngine({
      FIRE_THRESH: 0,
      MOVE_THRESH: 0,
      UPDOWN_THRESH: 0,
      JET_THRESH: 0,
      RELOAD_THRESH: 0,
    })
      .createBrain()
      .tick(1, makeCtx(world));
    const c = controlOf(world, 1);
    expect([c.left, c.right, c.up, c.down, c.fire, c.jetpack, c.reload]).toEqual([
      true, true, true, true, true, true, true,
    ]);
  });

  it('thresholds of 1 turn every button off (sigmoid < 1 always)', () => {
    const world = makeWorld(DUEL);
    createDiscipleEngine({
      FIRE_THRESH: 1,
      MOVE_THRESH: 1,
      UPDOWN_THRESH: 1,
      JET_THRESH: 1,
      RELOAD_THRESH: 1,
    })
      .createBrain()
      .tick(1, makeCtx(world));
    const c = controlOf(world, 1);
    expect([c.left, c.right, c.up, c.down, c.fire, c.jetpack, c.reload]).toEqual([
      false, false, false, false, false, false, false,
    ]);
  });
});

describe('DiscipleBrain — aim decode', () => {
  it('engaged aim has magnitude AIM_DIST (within integer rounding)', () => {
    const world = makeWorld(DUEL);
    createDiscipleEngine().createBrain().tick(1, makeCtx(world));
    const c = controlOf(world, 1);
    expect(Math.hypot(c.mouseAimX, c.mouseAimY)).toBeGreaterThan(299);
    expect(Math.hypot(c.mouseAimX, c.mouseAimY)).toBeLessThan(301);
    expect(Number.isInteger(c.mouseAimX)).toBe(true);
    expect(Number.isInteger(c.mouseAimY)).toBe(true);
  });

  it('AIM_DIST tweak rescales the aim offset', () => {
    const world = makeWorld(DUEL);
    createDiscipleEngine({ AIM_DIST: 100 }).createBrain().tick(1, makeCtx(world));
    const c = controlOf(world, 1);
    expect(Math.hypot(c.mouseAimX, c.mouseAimY)).toBeGreaterThan(99);
    expect(Math.hypot(c.mouseAimX, c.mouseAimY)).toBeLessThan(101);
  });

  it('TEMP <= 1e-3 is clamped — no NaN/zero-division at the sharp limit', () => {
    const world = makeWorld(DUEL);
    createDiscipleEngine({ TEMP: 0 }).createBrain().tick(1, makeCtx(world));
    const c = controlOf(world, 1);
    expect(Number.isFinite(c.mouseAimX)).toBe(true);
    expect(Number.isFinite(c.mouseAimY)).toBe(true);
    expect(Math.hypot(c.mouseAimX, c.mouseAimY)).toBeGreaterThan(299);
  });

  it('a very flat distribution (huge TEMP) still yields a valid aim', () => {
    const world = makeWorld(DUEL);
    createDiscipleEngine({ TEMP: 1e9 }).createBrain().tick(1, makeCtx(world));
    const c = controlOf(world, 1);
    expect(Math.hypot(c.mouseAimX, c.mouseAimY)).toBeGreaterThan(299);
    expect(Math.hypot(c.mouseAimX, c.mouseAimY)).toBeLessThan(301);
  });

  it('TEMP extremes stay within the winning bin: sharp and flat decodes are within one bin (≤ 30°) of each other', () => {
    const angles: number[] = [];
    for (const TEMP of [1e-9, 1, 1e9]) {
      const world = makeWorld(DUEL);
      createDiscipleEngine({ TEMP }).createBrain().tick(1, makeCtx(world));
      const c = controlOf(world, 1);
      angles.push(Math.atan2(c.mouseAimY, c.mouseAimX));
    }
    for (const a of angles) {
      let d = Math.abs(a - (angles[0] ?? 0)) % (2 * Math.PI);
      if (d > Math.PI) d = 2 * Math.PI - d;
      // base bin center ± lean (max half a bin each way) → ≤ 2 × 15°.
      expect(d).toBeLessThanOrEqual((2 * Math.PI) / 12 + 1e-2);
    }
  });
});

describe('DiscipleBrain — rules and guards', () => {
  it('an empty mag forces reload even when the policy head says no', () => {
    const world = makeWorld(DUEL);
    createDiscipleEngine({ RELOAD_THRESH: 1 })
      .createBrain()
      .tick(1, makeCtx(world, { ammoOf: () => 0 }));
    expect(controlOf(world, 1).reload).toBe(true);
  });

  it('does not force reload while a reload is already in progress', () => {
    const world = makeWorld(DUEL);
    createDiscipleEngine({ RELOAD_THRESH: 1 })
      .createBrain()
      .tick(1, makeCtx(world, { ammoOf: () => 0, reloadingOf: () => true }));
    expect(controlOf(world, 1).reload).toBe(false);
  });

  it('no enemies → roam fallback: walks toward the spawn, never aims', () => {
    const world = makeWorld([{ x: 0 }]);
    createDiscipleEngine().createBrain().tick(1, makeCtx(world));
    const c = controlOf(world, 1);
    expect(c.right).toBe(true); // spawn at x=1000
    expect(c.fire).toBe(false);
    expect(c.mouseAimX).toBe(0); // roam never touches the aim
    expect(c.mouseAimY).toBe(0);
  });

  it('spawn-protected ghosts and same-team bots are not enemies (roam instead)', () => {
    const ghost = makeWorld([{ x: 0 }, { x: 200, alpha: 128, holdedThing: 0 }]);
    createDiscipleEngine().createBrain().tick(1, makeCtx(ghost));
    expect(controlOf(ghost, 1).mouseAimX).toBe(0); // roamed, never aimed

    const teams = makeWorld([
      { x: 0, team: 1 },
      { x: 200, team: 1 },
    ]);
    createDiscipleEngine().createBrain().tick(1, makeCtx(teams));
    expect(controlOf(teams, 1).mouseAimX).toBe(0);
  });

  it('returns before touching controls when spriteParts is null', () => {
    const world = makeWorld(DUEL);
    (world as unknown as { spriteParts: null }).spriteParts = null;
    const c = controlOf(world, 1);
    c.fire = true;
    createDiscipleEngine().createBrain().tick(1, makeCtx(world));
    expect(c.fire).toBe(true); // early return — not even the reset ran
  });

  it('resets stale button state before deciding', () => {
    const world = makeWorld(DUEL);
    const c = controlOf(world, 1);
    c.up = true;
    c.jetpack = true;
    createDiscipleEngine({ UPDOWN_THRESH: 1, JET_THRESH: 1 })
      .createBrain()
      .tick(1, makeCtx(world));
    expect(c.up).toBe(false);
    expect(c.jetpack).toBe(false);
  });

  it('is deterministic: two brains in identical worlds produce identical controls', () => {
    const run = (): string => {
      const world = makeWorld(DUEL);
      createDiscipleEngine().createBrain().tick(1, makeCtx(world));
      return JSON.stringify(controlOf(world, 1));
    };
    expect(run()).toBe(run());
  });
});
