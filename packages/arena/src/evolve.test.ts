// Evolution-strategies core tests (action node 347): the update math is
// where a silent sign error would burn hours of compute — prove rank shaping
// is centered, antithetic bookkeeping is symmetric, the mean moves TOWARD
// the better perturbation, checkpoints round-trip exactly, and injected
// candidate weights actually reach the brain (different weights → different
// outputs/controls, and the registry seam carries a candidate through a
// real runMatch).

import { describe, it, expect } from 'vitest';
import {
  NEURAL_SHIPPED_NET,
  NeuralPolicy,
  createNeuralEngineWithWeights,
  type NeuralNet,
} from '@soldat/client/headless';
import {
  CHECKPOINT_SCHEMA,
  esUpdate,
  flattenNet,
  makeCheckpoint,
  mulberry32,
  paramCount,
  parseCheckpoint,
  rankShape,
  registerNeuralNet,
  rms,
  samplePerturbations,
  unflattenNet,
} from './evolve';
import { runMatch } from './runner';

const DIMS = NEURAL_SHIPPED_NET.dims;

describe('rank shaping', () => {
  it('centers utilities (sum ~0) with best=+0.5 and worst=-0.5', () => {
    const u = rankShape([3, -7, 10, 0]);
    expect(u.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 12);
    expect(u[2]).toBeCloseTo(0.5); // best fitness
    expect(u[1]).toBeCloseTo(-0.5); // worst fitness
    expect(Math.max(...u)).toBeLessThanOrEqual(0.5);
    expect(Math.min(...u)).toBeGreaterThanOrEqual(-0.5);
  });

  it('is scale-free: one blowout fitness cannot dominate', () => {
    expect(rankShape([1, 2, 3])).toEqual(rankShape([1, 2, 3000]));
  });
});

describe('esUpdate (antithetic pairs)', () => {
  const rng = mulberry32(7);
  const dim = 50;

  it('moves the mean toward the better-scoring side of each pair', () => {
    const eps = samplePerturbations(mulberry32(1), dim, 1);
    const mean = new Float64Array(dim);
    const up = esUpdate(mean, eps, [1], [-1], { lr: 1 });
    // +eps side won → step is positively aligned with eps.
    let dot = 0;
    for (let k = 0; k < dim; k++) dot += up[k]! * eps[0]![k]!;
    expect(dot).toBeGreaterThan(0);
    const down = esUpdate(mean, eps, [-1], [1], { lr: 1 });
    let dot2 = 0;
    for (let k = 0; k < dim; k++) dot2 += down[k]! * eps[0]![k]!;
    expect(dot2).toBeLessThan(0);
  });

  it('negates exactly when every pair swaps + and − fitness', () => {
    const eps = samplePerturbations(rng, dim, 4);
    const mean = new Float64Array(dim).fill(0.1);
    const fp = [4, -2, 7, 0];
    const fm = [1, 3, -5, 2];
    const a = esUpdate(mean, eps, fp, fm, { lr: 0.5 });
    const b = esUpdate(mean, eps, fm, fp, { lr: 0.5 });
    for (let k = 0; k < dim; k++) {
      expect(a[k]! - 0.1).toBeCloseTo(-(b[k]! - 0.1), 10);
    }
  });

  it('does not mutate the input mean and applies decay toward the anchor', () => {
    const eps = samplePerturbations(rng, dim, 2);
    const mean = new Float64Array(dim).fill(1);
    const anchor = new Float64Array(dim).fill(3);
    const next = esUpdate(mean, eps, [0, 0], [0, 0], { lr: 0, decay: 0.5, anchor });
    expect(mean[0]).toBe(1); // input untouched
    expect(next[0]).toBeCloseTo(2); // pulled halfway toward the anchor, not 0
  });

  it('sampled perturbations are roughly unit gaussians', () => {
    const eps = samplePerturbations(mulberry32(42), 2000, 1)[0]!;
    let sum = 0;
    let sq = 0;
    for (const v of eps) {
      sum += v;
      sq += v * v;
    }
    expect(sum / eps.length).toBeCloseTo(0, 0);
    expect(Math.sqrt(sq / eps.length)).toBeCloseTo(1, 0);
  });
});

describe('flatten/unflatten + checkpoints', () => {
  it('round-trips the shipped net exactly', () => {
    const flat = flattenNet(NEURAL_SHIPPED_NET);
    expect(flat.length).toBe(paramCount(DIMS));
    const back = unflattenNet(DIMS, flat);
    expect(back.dims).toEqual([...DIMS]);
    expect(back.weights).toEqual(NEURAL_SHIPPED_NET.weights.map((w) => [...w]));
    expect(back.biases).toEqual(NEURAL_SHIPPED_NET.biases.map((b) => [...b]));
    expect(rms(flat)).toBeGreaterThan(0);
  });

  it('checkpoint JSON round-trips mean, pool, and metadata', () => {
    const mean = flattenNet(NEURAL_SHIPPED_NET);
    const past = [{ gen: 10, flat: Float64Array.from(mean, (v) => v * 0.5) }];
    const ckpt = makeCheckpoint(20, DIMS, mean, past, -12.5, -3.25);
    const parsed = parseCheckpoint(JSON.stringify(ckpt));
    expect(parsed.schema).toBe(CHECKPOINT_SCHEMA);
    expect(parsed.gen).toBe(20);
    expect(parsed.mean).toEqual([...mean]);
    expect(parsed.pastSelves).toEqual([{ gen: 10, flat: [...past[0]!.flat] }]);
    expect(parsed.meanFitness).toBe(-12.5);
    expect(parsed.bestFitness).toBe(-3.25);
  });

  it('rejects size mismatches and unknown schemas', () => {
    expect(() => unflattenNet(DIMS, [1, 2, 3])).toThrow(/params/);
    expect(() => parseCheckpoint('{"schema":"nope/9"}')).toThrow(/schema/);
  });
});

describe('weight injection reaches the brain', () => {
  // A fixed mid-fight feature vector (FEATURE_DIM 25, bias last).
  const features = [
    0.3, -0.2, 0.8, 0.9, 0.5, 0, 1, 1, 0.4, -0.1, 0.42, 0.2, -0.3, 0.7, 1,
    -0.6, 0.5, 0.78, -0.2, 0.1, 0.5, 1, 0.2, 0.1, 1,
  ];

  function withBumpedFireBias(delta: number): NeuralNet {
    const biases = NEURAL_SHIPPED_NET.biases.map((b) => [...b]);
    const out = biases[biases.length - 1]!;
    out[4] = (out[4] ?? 0) + delta; // output head 4 = fire logit
    return { dims: DIMS, weights: NEURAL_SHIPPED_NET.weights, biases };
  }

  it('two different weight vectors produce different outputs and controls', () => {
    const base = new NeuralPolicy(NEURAL_SHIPPED_NET).run(features);
    const up = new NeuralPolicy(withBumpedFireBias(50)).run(features);
    const down = new NeuralPolicy(withBumpedFireBias(-50)).run(features);
    expect(up[4]).not.toBeCloseTo(base[4]!, 6);
    // Thresholded at 0.5 (NEURAL_DEFAULTS.FIRE_THRESH), the fire CONTROL flips.
    const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
    expect(sigmoid(up[4]!) > 0.5).toBe(true);
    expect(sigmoid(down[4]!) > 0.5).toBe(false);
  });

  it('default policy equals the shipped net explicitly', () => {
    const a = new NeuralPolicy().run(features);
    const b = new NeuralPolicy(NEURAL_SHIPPED_NET).run(features);
    expect([...a]).toEqual([...b]);
  });

  it('carries a registered candidate through a real runMatch', () => {
    const engine = createNeuralEngineWithWeights('neural-cand-test', withBumpedFireBias(2));
    expect(engine.id).toBe('neural-cand-test');
    registerNeuralNet('neural-cand-test', withBumpedFireBias(2));
    const result = runMatch({
      seed: 3,
      teams: [{ engine: 'neural-cand-test' }, { engine: 'classic' }],
      botCount: 4,
      roundTicks: 600,
    });
    expect(result.round).not.toBeNull();
    expect(result.bots.some((b) => b.engine === 'neural-cand-test')).toBe(true);
  });
});
