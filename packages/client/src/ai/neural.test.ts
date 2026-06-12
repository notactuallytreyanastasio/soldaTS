// "neural" engine (neural.ts): the NeuralPolicy forward pass (tanh hiddens,
// raw outputs, per-brain buffers), the shipped weight-set shape, and the
// brain's decision plumbing driven through createNeuralEngineWithWeights with
// CRAFTED weight sets — bias-only single-layer nets make every head's logit
// exact, so thresholding, aim normalization, contact filtering and the
// empty-mag rule are all assertable without depending on trained weights.

import { describe, it, expect } from 'vitest';
import type { World } from '@soldat/sim';
import type { BotEngineContext } from './engine';
import {
  createNeuralEngine,
  createNeuralEngineWithWeights,
  NEURAL_DEFAULTS,
  NEURAL_SHIPPED_NET,
  NeuralPolicy,
  type NeuralNet,
} from './neural';
import { FEATURE_DIM, OUTPUT_DIM } from './neuralFeatures';

// --- Stub world ------------------------------------------------------------
// Minimal hand-rolled World: only the fields the brain reads. Index 0 of the
// sprite array is the sentinel, bots occupy 1..n (matching the sim layout).

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
  const sprites: unknown[] = [{ active: false }]; // sentinel
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

/** Single affine layer (no hidden, raw output): with zero weights every
 *  output logit IS its bias — heads become exactly controllable. */
function biasNet(biases: number[]): NeuralNet {
  return {
    dims: [FEATURE_DIM, OUTPUT_DIM],
    weights: [new Array(FEATURE_DIM * OUTPUT_DIM).fill(0)],
    biases: [biases],
  };
}

// Button order: left, right, up, down, fire, jetpack, reload, aimX, aimY.
const ALL_ON = biasNet([5, 5, 5, 5, 5, 5, 5, 3, 4]);
const ALL_OFF = biasNet([-5, -5, -5, -5, -5, -5, -5, 3, 4]);

// --- NeuralPolicy ------------------------------------------------------------

describe('NeuralPolicy forward pass', () => {
  it('produces the output layer dimension', () => {
    const policy = new NeuralPolicy({
      dims: [2, 3, 4],
      weights: [new Array(6).fill(0), new Array(12).fill(0)],
      biases: [new Array(3).fill(0), new Array(4).fill(0)],
    });
    expect(policy.run([1, 2])).toHaveLength(4);
  });

  it('applies tanh to hidden layers but leaves the output raw', () => {
    // 1 input → 1 hidden (w=1, b=0) → 1 output (w=1, b=0):
    // out = hidden = tanh(x), NOT tanh(tanh(x)).
    const policy = new NeuralPolicy({
      dims: [1, 1, 1],
      weights: [[1], [1]],
      biases: [[0], [0]],
    });
    expect(policy.run([2])[0]).toBeCloseTo(Math.tanh(2), 12);
  });

  it('a single-layer net is a plain affine map (output can exceed 1)', () => {
    const policy = new NeuralPolicy({
      dims: [2, 2],
      weights: [[1, 2, -3, 0.5]], // row-major [fanOut × fanIn]
      biases: [[10, -1]],
    });
    const out = policy.run([4, 5]);
    expect(out[0]).toBeCloseTo(1 * 4 + 2 * 5 + 10, 12); // 24 — no squash
    expect(out[1]).toBeCloseTo(-3 * 4 + 0.5 * 5 - 1, 12); // -10.5
  });

  it('an all-zero net outputs the biases exactly', () => {
    const out = new NeuralPolicy(biasNet([1, 2, 3, 4, 5, 6, 7, 8, 9])).run(
      new Array(FEATURE_DIM).fill(0.5),
    );
    expect([...out]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('defaults to the shipped net and yields finite OUTPUT_DIM logits', () => {
    const out = new NeuralPolicy().run(new Array(FEATURE_DIM).fill(0));
    expect(out).toHaveLength(OUTPUT_DIM);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('NEURAL_SHIPPED_NET shape', () => {
  it('input is FEATURE_DIM, output is OUTPUT_DIM', () => {
    expect(NEURAL_SHIPPED_NET.dims[0]).toBe(FEATURE_DIM);
    expect(NEURAL_SHIPPED_NET.dims[NEURAL_SHIPPED_NET.dims.length - 1]).toBe(
      OUTPUT_DIM,
    );
  });

  it('every layer has fanIn×fanOut weights and fanOut biases', () => {
    const { dims, weights, biases } = NEURAL_SHIPPED_NET;
    expect(weights).toHaveLength(dims.length - 1);
    expect(biases).toHaveLength(dims.length - 1);
    for (let l = 0; l < dims.length - 1; l++) {
      expect(weights[l]).toHaveLength((dims[l] ?? 0) * (dims[l + 1] ?? 0));
      expect(biases[l]).toHaveLength(dims[l + 1] ?? 0);
    }
  });
});

// --- Engine factories --------------------------------------------------------

describe('engine factories', () => {
  it("createNeuralEngine returns id 'neural' with the resolved defaults and a strategy line", () => {
    const engine = createNeuralEngine();
    expect(engine.id).toBe('neural');
    expect(engine.strategy.length).toBeGreaterThan(0);
    expect(engine.tweaks).toEqual(NEURAL_DEFAULTS);
    expect(engine.createBrain()).toBeDefined();
  });

  it('createNeuralEngineWithWeights takes an alternate id, net and tweaks (the evolution seam)', () => {
    const engine = createNeuralEngineWithWeights('neural-cand', ALL_ON, {
      FIRE_THRESH: 0.9,
    });
    expect(engine.id).toBe('neural-cand');
    expect(engine.tweaks.FIRE_THRESH).toBe(0.9);
    expect(engine.tweaks.AIM_DIST).toBe(NEURAL_DEFAULTS.AIM_DIST);
  });
});

// --- Brain decisions through crafted nets -------------------------------------

describe('NeuralBrain decisions (crafted bias-only nets)', () => {
  it('high logits switch every button on; aim is the normalized head × AIM_DIST', () => {
    const world = makeWorld([{ x: 0, y: 0 }, { x: 200, y: 0 }]);
    const brain = createNeuralEngineWithWeights('t', ALL_ON).createBrain();
    brain.tick(1, makeCtx(world));
    const c = controlOf(world, 1);
    expect([c.left, c.right, c.up, c.down, c.fire, c.jetpack, c.reload]).toEqual([
      true, true, true, true, true, true, true,
    ]);
    // aim head (3, 4) → unit (0.6, 0.8) × 300.
    expect(c.mouseAimX).toBe(180);
    expect(c.mouseAimY).toBe(240);
  });

  it('low logits leave every button off', () => {
    const world = makeWorld([{ x: 0 }, { x: 200 }]);
    const brain = createNeuralEngineWithWeights('t', ALL_OFF).createBrain();
    brain.tick(1, makeCtx(world));
    const c = controlOf(world, 1);
    expect([c.left, c.right, c.up, c.down, c.fire, c.jetpack, c.reload]).toEqual([
      false, false, false, false, false, false, false,
    ]);
  });

  it('a near-zero aim head leaves mouseAim untouched (hypot < 1e-6 guard)', () => {
    const world = makeWorld([{ x: 0 }, { x: 200 }]);
    const c = controlOf(world, 1);
    c.mouseAimX = 77;
    c.mouseAimY = -33;
    const net = biasNet([5, 5, 5, 5, 5, 5, 5, 0, 0]); // zero aim vector
    createNeuralEngineWithWeights('t', net).createBrain().tick(1, makeCtx(world));
    expect(c.mouseAimX).toBe(77);
    expect(c.mouseAimY).toBe(-33);
  });

  it('AIM_DIST tweak rescales the aim offset', () => {
    const world = makeWorld([{ x: 0 }, { x: 200 }]);
    const brain = createNeuralEngineWithWeights('t', ALL_ON, {
      AIM_DIST: 100,
    }).createBrain();
    brain.tick(1, makeCtx(world));
    expect(controlOf(world, 1).mouseAimX).toBe(60);
    expect(controlOf(world, 1).mouseAimY).toBe(80);
  });

  it('an empty mag forces reload even when the net says no', () => {
    const world = makeWorld([{ x: 0 }, { x: 200 }]);
    const brain = createNeuralEngineWithWeights('t', ALL_OFF).createBrain();
    brain.tick(1, makeCtx(world, { ammoOf: () => 0 }));
    expect(controlOf(world, 1).reload).toBe(true);
  });

  it('does NOT force reload when a reload is already in progress', () => {
    const world = makeWorld([{ x: 0 }, { x: 200 }]);
    const brain = createNeuralEngineWithWeights('t', ALL_OFF).createBrain();
    brain.tick(1, makeCtx(world, { ammoOf: () => 0, reloadingOf: () => true }));
    expect(controlOf(world, 1).reload).toBe(false);
  });

  it('resets stale button state before deciding', () => {
    const world = makeWorld([{ x: 0 }, { x: 200 }]);
    const c = controlOf(world, 1);
    c.fire = true;
    c.left = true;
    createNeuralEngineWithWeights('t', ALL_OFF).createBrain().tick(1, makeCtx(world));
    expect(c.fire).toBe(false);
    expect(c.left).toBe(false);
  });

  it('returns before touching controls when spriteParts is null', () => {
    const world = makeWorld([{ x: 0 }, { x: 200 }]);
    (world as unknown as { spriteParts: null }).spriteParts = null;
    const c = controlOf(world, 1);
    c.fire = true;
    createNeuralEngineWithWeights('t', ALL_ON).createBrain().tick(1, makeCtx(world));
    expect(c.fire).toBe(true); // early return — not even the reset ran
  });
});

describe('NeuralBrain contact filtering', () => {
  const tickWith = (others: StubBot[]): StubControl => {
    const world = makeWorld([{ x: 0, y: 0 }, ...others]);
    createNeuralEngineWithWeights('t', ALL_ON).createBrain().tick(1, makeCtx(world));
    return controlOf(world, 1);
  };

  it('an active enemy engages (fire head fires under the ALL_ON net)', () => {
    expect(tickWith([{ x: 200 }]).fire).toBe(true);
  });

  it('no other bots → roam fallback: no fire, walks toward the spawn', () => {
    const c = tickWith([]);
    expect(c.fire).toBe(false);
    expect(c.right).toBe(true); // spawn at x=1000, bot at 0
  });

  it('dead, inactive and spawn-protected ghosts do not count as enemies', () => {
    expect(tickWith([{ x: 200, deadMeat: true }]).fire).toBe(false);
    expect(tickWith([{ x: 200, active: false }]).fire).toBe(false);
    expect(tickWith([{ x: 200, alpha: 128, holdedThing: 0 }]).fire).toBe(false);
  });

  it('a translucent carrier (holdedThing != 0) DOES count — flag carriers stay targetable', () => {
    expect(tickWith([{ x: 200, alpha: 128, holdedThing: 3 }]).fire).toBe(true);
  });

  it('in team play a same-team bot is a teammate, not an enemy', () => {
    const world = makeWorld([
      { x: 0, team: 1 },
      { x: 200, team: 1 },
    ]);
    createNeuralEngineWithWeights('t', ALL_ON).createBrain().tick(1, makeCtx(world));
    expect(controlOf(world, 1).fire).toBe(false); // teammate only → roam

    const ffa = makeWorld([
      { x: 0, team: 0 },
      { x: 200, team: 0 },
    ]);
    createNeuralEngineWithWeights('t', ALL_ON).createBrain().tick(1, makeCtx(ffa));
    expect(controlOf(ffa, 1).fire).toBe(true); // FFA: everyone is an enemy
  });
});
