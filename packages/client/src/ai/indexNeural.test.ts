// Registry bootstrap + re-exports (ai/index.ts) for the LEARNED engines:
// importing the index must register neural/disciple/prodigy/buttstein, and
// the evolution + replay-recorder seams (NEURAL_SHIPPED_NET,
// createNeuralEngineWithWeights, nearestBulletThreat, nearestThreatBullet)
// must be re-exported and functional. The hand-written engines' registry
// coverage lives in engine.test.ts.

import { describe, it, expect } from 'vitest';
import {
  createEngine,
  engineIds,
  NEURAL_SHIPPED_NET,
  MOJOJOJO_SHIPPED_NET,
  createNeuralEngineWithWeights,
  createMojojojoEngineWithWeights,
  nearestBulletThreat,
  nearestThreatBullet,
  type RelativeBullet,
} from './index';
import { FEATURE_DIM, OUTPUT_DIM } from './neuralFeatures';
import { FEATURE_DIM_V3 } from './neuralFeaturesV3';

describe('registry bootstrap — learned engines', () => {
  it('registers all five students', () => {
    for (const id of ['neural', 'disciple', 'prodigy', 'buttstein', 'mojojojo']) {
      expect(engineIds()).toContain(id);
    }
  });

  it('createEngine resolves each learned id to its own engine', () => {
    expect(createEngine('neural').id).toBe('neural');
    expect(createEngine('disciple').id).toBe('disciple');
    expect(createEngine('prodigy').id).toBe('prodigy');
    expect(createEngine('buttstein').id).toBe('buttstein');
    expect(createEngine('mojojojo').id).toBe('mojojojo');
  });

  it('each learned engine builds an independent brain with a ticking interface', () => {
    for (const id of ['neural', 'disciple', 'prodigy', 'buttstein', 'mojojojo']) {
      const engine = createEngine(id);
      const a = engine.createBrain();
      const b = engine.createBrain();
      expect(a).not.toBe(b); // per-bot instances, never shared buffers
      expect(typeof a.tick).toBe('function');
    }
  });
});

describe('re-exported evolution seam', () => {
  it('NEURAL_SHIPPED_NET is a consistent FEATURE_DIM → OUTPUT_DIM net', () => {
    const { dims, weights, biases } = NEURAL_SHIPPED_NET;
    expect(dims[0]).toBe(FEATURE_DIM);
    expect(dims[dims.length - 1]).toBe(OUTPUT_DIM);
    expect(weights).toHaveLength(dims.length - 1);
    expect(biases).toHaveLength(dims.length - 1);
    for (let l = 0; l < dims.length - 1; l++) {
      expect(weights[l]).toHaveLength((dims[l] ?? 0) * (dims[l + 1] ?? 0));
      expect(biases[l]).toHaveLength(dims[l + 1] ?? 0);
      for (const v of weights[l] ?? []) expect(Number.isFinite(v)).toBe(true);
      for (const v of biases[l] ?? []) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('createNeuralEngineWithWeights builds candidate engines under alternate ids', () => {
    const engine = createNeuralEngineWithWeights('neural-cand', NEURAL_SHIPPED_NET);
    expect(engine.id).toBe('neural-cand');
    expect(engine.createBrain()).toBeDefined();
    // INERT for normal play: the candidate id is NOT in the static registry.
    expect(engineIds()).not.toContain('neural-cand');
  });

  it('MOJOJOJO_SHIPPED_NET is a consistent FEATURE_DIM_V3 → 31-logit net', () => {
    const { dims, weights, biases } = MOJOJOJO_SHIPPED_NET;
    expect(dims[0]).toBe(FEATURE_DIM_V3);
    expect(dims[dims.length - 1]).toBe(31); // 7 buttons + 24 aim bins
    expect(weights).toHaveLength(dims.length - 1);
    expect(biases).toHaveLength(dims.length - 1);
    for (let l = 0; l < dims.length - 1; l++) {
      expect(weights[l]).toHaveLength((dims[l] ?? 0) * (dims[l + 1] ?? 0));
      expect(biases[l]).toHaveLength(dims[l + 1] ?? 0);
      for (const v of weights[l] ?? []) expect(Number.isFinite(v)).toBe(true);
      for (const v of biases[l] ?? []) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('createMojojojoEngineWithWeights builds candidate engines under alternate ids', () => {
    const engine = createMojojojoEngineWithWeights('mojojojo-cand', MOJOJOJO_SHIPPED_NET);
    expect(engine.id).toBe('mojojojo-cand');
    expect(engine.createBrain()).toBeDefined();
    // INERT for normal play: the candidate id is NOT in the static registry.
    expect(engineIds()).not.toContain('mojojojo-cand');
  });
});

describe('re-exported threat scans (the recorder/runtime shared organ)', () => {
  const bullet = (over: Partial<RelativeBullet>): RelativeBullet => ({
    rx: 0,
    ry: 0,
    vx: 0,
    vy: 0,
    ...over,
  });

  it('nearestBulletThreat works through the index export', () => {
    const t = nearestBulletThreat([bullet({ rx: -100, vx: 10 })]);
    expect(t?.closing).toBeCloseTo(10, 12);
    expect(nearestBulletThreat([])).toBeNull();
  });

  it('nearestThreatBullet agrees with nearestBulletThreat on the winner', () => {
    const all = [
      bullet({ rx: -100, ry: 50, vx: 10 }),
      bullet({ rx: -200, ry: 5, vx: 10 }),
      bullet({ rx: 100, vx: 10 }), // receding — filtered
    ];
    const winner = nearestThreatBullet(all);
    expect(winner).toBe(all[1]);
    expect(nearestBulletThreat([winner as RelativeBullet])).toEqual(
      nearestBulletThreat(all),
    );
  });
});
