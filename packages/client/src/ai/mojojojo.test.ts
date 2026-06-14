// "mojojojo" engine (mojojojo.ts) — the fifth student: BUTTSTEIN's v3 senses
// (exact threat data, own spray heat) with an outcome-weighted fire head and
// a stage-2 evolution seam. Tests pin the weight-independent invariants
// (thresholds, aim magnitude, empty-mag rule, roam, guards), the memory
// protocol's guaranteed gap identity, and — against the committed weight
// set — that the heat sense and the bullet threat actually reach the policy.

import { describe, it, expect } from 'vitest';
import type { World } from '@soldat/sim';
import type { BotEngineContext } from './engine';
import {
  createMojojojoEngine,
  createMojojojoEngineWithWeights,
  MOJOJOJO_DEFAULTS,
  MOJOJOJO_SHIPPED_NET,
} from './mojojojo';
import { FEATURE_DIM_V3 } from './neuralFeaturesV3';

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

interface StubBullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  owner: number;
  active?: boolean;
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

function makeWorld(bots: StubBot[], tick = 100, bullets: StubBullet[] = []): World {
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
  const bArr: unknown[] = [{ active: false, owner: 0, num: 0 }];
  const bposX = [0];
  const bposY = [0];
  const bvelX = [0];
  const bvelY = [0];
  for (const bl of bullets) {
    const num = bposX.length;
    bArr.push({ active: bl.active ?? true, owner: bl.owner, num });
    bposX.push(bl.x);
    bposY.push(bl.y);
    bvelX.push(bl.vx);
    bvelY.push(bl.vy);
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
    bullets: bArr,
    mainTickCounter: tick,
    spriteParts: { posX, posY, velocityX, velocityY },
    bulletParts: { posX: bposX, posY: bposY, velocityX: bvelX, velocityY: bvelY },
    rng,
  } as unknown as World;
}

function makeCtx(
  world: World,
  over: Partial<
    Pick<BotEngineContext, 'ammoOf' | 'reloadingOf' | 'weaponOf' | 'sprayHeatOf'>
  > = {},
): BotEngineContext {
  return {
    world,
    graph: { nodes: [], edges: [] },
    spawns: [{ x: 1000, y: 0 }],
    spectate: true,
    ammoOf: () => 30,
    reloadingOf: () => false,
    magSize: 30,
    weaponOf: () => 'AK74',
    sprayHeatOf: () => 0,
    ...over,
  } as unknown as BotEngineContext;
}

const controlOf = (world: World, i: number): StubControl =>
  (world.sprites[i] as unknown as { control: StubControl }).control;
const snap = (world: World, i: number): string =>
  JSON.stringify(controlOf(world, i));
const setTick = (world: World, t: number): void => {
  (world as unknown as { mainTickCounter: number }).mainTickCounter = t;
};

const DUEL: StubBot[] = [
  { x: 0, y: 0 },
  { x: 200, y: -50 },
];

describe('createMojojojoEngine', () => {
  it("returns id 'mojojojo' with the seed-probed FIRE_THRESH 0.3 default", () => {
    const engine = createMojojojoEngine();
    expect(engine.id).toBe('mojojojo');
    expect(engine.tweaks).toEqual(MOJOJOJO_DEFAULTS);
    expect(engine.tweaks.FIRE_THRESH).toBe(0.3);
  });

  it('runs against the 48-float v3 contract', () => {
    expect(FEATURE_DIM_V3).toBe(48);
    expect(MOJOJOJO_SHIPPED_NET.dims[0]).toBe(FEATURE_DIM_V3);
  });
});

describe('MojojojoBrain — invariants', () => {
  it('thresholds of 0 turn every button on; thresholds of 1 turn every button off', () => {
    const on = makeWorld(DUEL);
    createMojojojoEngine({
      FIRE_THRESH: 0,
      MOVE_THRESH: 0,
      UPDOWN_THRESH: 0,
      JET_THRESH: 0,
      RELOAD_THRESH: 0,
    })
      .createBrain()
      .tick(1, makeCtx(on));
    const cOn = controlOf(on, 1);
    expect([cOn.left, cOn.right, cOn.up, cOn.down, cOn.fire, cOn.jetpack, cOn.reload]).toEqual(
      [true, true, true, true, true, true, true],
    );

    const off = makeWorld(DUEL);
    createMojojojoEngine({
      FIRE_THRESH: 1,
      MOVE_THRESH: 1,
      UPDOWN_THRESH: 1,
      JET_THRESH: 1,
      RELOAD_THRESH: 1,
    })
      .createBrain()
      .tick(1, makeCtx(off));
    const cOff = controlOf(off, 1);
    expect([
      cOff.left, cOff.right, cOff.up, cOff.down, cOff.fire, cOff.jetpack, cOff.reload,
    ]).toEqual([false, false, false, false, false, false, false]);
  });

  it('engaged aim has magnitude AIM_DIST (within rounding) and rescales with the tweak', () => {
    const world = makeWorld(DUEL);
    createMojojojoEngine().createBrain().tick(1, makeCtx(world));
    const c = controlOf(world, 1);
    expect(Math.hypot(c.mouseAimX, c.mouseAimY)).toBeGreaterThan(299);
    expect(Math.hypot(c.mouseAimX, c.mouseAimY)).toBeLessThan(301);

    const scaled = makeWorld(DUEL);
    createMojojojoEngine({ AIM_DIST: 100 }).createBrain().tick(1, makeCtx(scaled));
    const cs = controlOf(scaled, 1);
    expect(Math.hypot(cs.mouseAimX, cs.mouseAimY)).toBeGreaterThan(99);
    expect(Math.hypot(cs.mouseAimX, cs.mouseAimY)).toBeLessThan(101);
  });

  it('an empty mag forces reload; an in-progress reload does not double-trigger', () => {
    const world = makeWorld(DUEL);
    createMojojojoEngine({ RELOAD_THRESH: 1 })
      .createBrain()
      .tick(1, makeCtx(world, { ammoOf: () => 0 }));
    expect(controlOf(world, 1).reload).toBe(true);

    const busy = makeWorld(DUEL);
    createMojojojoEngine({ RELOAD_THRESH: 1 })
      .createBrain()
      .tick(1, makeCtx(busy, { ammoOf: () => 0, reloadingOf: () => true }));
    expect(controlOf(busy, 1).reload).toBe(false);
  });

  it('no enemies → roam fallback (walks toward spawn, never aims)', () => {
    const world = makeWorld([{ x: 0 }]);
    createMojojojoEngine().createBrain().tick(1, makeCtx(world));
    const c = controlOf(world, 1);
    expect(c.right).toBe(true);
    expect(c.fire).toBe(false);
    expect(c.mouseAimX).toBe(0);
  });

  it('returns before touching controls when spriteParts is null', () => {
    const world = makeWorld(DUEL);
    (world as unknown as { spriteParts: null }).spriteParts = null;
    const c = controlOf(world, 1);
    c.fire = true;
    createMojojojoEngine().createBrain().tick(1, makeCtx(world));
    expect(c.fire).toBe(true);
  });

  it('is deterministic: identical worlds and brains produce identical controls', () => {
    const run = (): string => {
      const world = makeWorld(DUEL, 100, [{ x: -150, y: 0, vx: 15, vy: 0, owner: 2 }]);
      createMojojojoEngine().createBrain().tick(1, makeCtx(world));
      return snap(world, 1);
    };
    expect(run()).toBe(run());
  });
});

describe('MojojojoBrain — the v3 spray-heat sense', () => {
  const engage = (
    over: Partial<Pick<BotEngineContext, 'sprayHeatOf'>> = {},
  ): string => {
    const world = makeWorld(DUEL);
    createMojojojoEngine().createBrain().tick(1, makeCtx(world, over));
    return snap(world, 1);
  };

  it('a hot barrel changes the decision (committed weights)', () => {
    expect(engage({ sprayHeatOf: () => 0.16 })).not.toBe(
      engage({ sprayHeatOf: () => 0 }),
    );
  });

  it('a missing sprayHeatOf is treated as cool (0): identical to heat 0', () => {
    const world = makeWorld(DUEL);
    const ctx = makeCtx(world);
    (ctx as unknown as { sprayHeatOf?: unknown }).sprayHeatOf = undefined;
    createMojojojoEngine().createBrain().tick(1, ctx);
    expect(snap(world, 1)).toBe(engage({ sprayHeatOf: () => 0 }));
  });
});

describe('MojojojoBrain — memory and threat (the buttstein spine)', () => {
  it('a tick GAP resets history: gapped brain equals a fresh brain at the same tick', () => {
    const w1 = makeWorld(DUEL, 100);
    const brain = createMojojojoEngine().createBrain();
    brain.tick(1, makeCtx(w1));
    setTick(w1, 103);
    brain.tick(1, makeCtx(w1));

    const w2 = makeWorld(DUEL, 103);
    createMojojojoEngine().createBrain().tick(1, makeCtx(w2));

    expect(snap(w1, 1)).toBe(snap(w2, 1));
  });

  it('CONSECUTIVE ticks feed real history: outputs diverge from a fresh brain (committed weights)', () => {
    const w1 = makeWorld(DUEL, 100);
    const brain = createMojojojoEngine().createBrain();
    brain.tick(1, makeCtx(w1));
    setTick(w1, 101);
    brain.tick(1, makeCtx(w1));

    const w2 = makeWorld(DUEL, 101);
    createMojojojoEngine().createBrain().tick(1, makeCtx(w2));

    expect(snap(w1, 1)).not.toBe(snap(w2, 1));
  });

  it('an incoming enemy bullet changes the decision; its own bullet never does', () => {
    const engage = (bullets: StubBullet[]): string => {
      const world = makeWorld(DUEL, 100, bullets);
      createMojojojoEngine().createBrain().tick(1, makeCtx(world));
      return snap(world, 1);
    };
    const calm = engage([]);
    expect(engage([{ x: -150, y: 0, vx: 15, vy: 0, owner: 2 }])).not.toBe(calm);
    expect(engage([{ x: -150, y: 0, vx: 15, vy: 0, owner: 1 }])).toBe(calm);
  });
});

describe('the stage-2 evolution seam', () => {
  it('injected weights drive the SAME brain under an alternate id', () => {
    const world = makeWorld(DUEL);
    const engine = createMojojojoEngineWithWeights('mojojojo-cand', MOJOJOJO_SHIPPED_NET);
    engine.createBrain().tick(1, makeCtx(world));
    const shipped = makeWorld(DUEL);
    createMojojojoEngine().createBrain().tick(1, makeCtx(shipped));
    // Identical weights + identical world ⇒ identical controls.
    expect(snap(world, 1)).toBe(snap(shipped, 1));
  });
});
