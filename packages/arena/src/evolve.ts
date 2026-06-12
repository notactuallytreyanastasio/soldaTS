// Evolution-strategies core for the neural engine's phase-2 self-play
// (decision node 341 → action 347). PURE math + (de)serialization — no fs,
// no rng ambient state, no Game access. tools/evolve.mjs is the driver that
// wires this to runMatch and the checkpoint files; evolve.test.ts proves the
// update math (rank shaping sums to ~0, antithetic symmetry cancels, the
// mean moves toward the better-scoring perturbation).
//
// Algorithm: OpenAI-style natural evolution strategies with antithetic
// (mirrored) sampling and rank-shaped fitness —
//   candidates j = mean ± σ·ε_i   (ε_i ~ N(0, I), i = 1..N pairs)
//   u_j = centeredRank(f_j)        (utilities sum to 0, scale-free)
//   mean ← mean + (lr/M)·Σ_j u_j·ε_j − decay·(mean − anchor)
// The optional decay pulls toward an ANCHOR (the imitation weights), not
// zero — shrinking toward zero would erode the behavior-cloned prior the
// whole phase is built on.

import {
  createMojojojoEngineWithWeights,
  createNeuralEngineWithWeights,
  registerEngine,
  type NeuralNet,
} from '@soldat/client/headless';

// Re-exported so tools/evolve.mjs can reach the shipped baselines and the
// net type through ONE module (resolution-identical with runner.ts's
// registry — both go through the arena package's @soldat/client link).
export { MOJOJOJO_SHIPPED_NET, NEURAL_SHIPPED_NET, type NeuralNet } from '@soldat/client/headless';

// ---------------------------------------------------------------------------
// Flat-vector ↔ NeuralNet (layout: W0,B0,W1,B1,... — layer order, weights
// before biases, matching how the trainer iterates its tensors).
// ---------------------------------------------------------------------------

/** Total parameter count for an MLP with the given layer dims. */
export function paramCount(dims: readonly number[]): number {
  let n = 0;
  for (let l = 0; l < dims.length - 1; l++) {
    n += (dims[l] ?? 0) * (dims[l + 1] ?? 0) + (dims[l + 1] ?? 0);
  }
  return n;
}

export function flattenNet(net: NeuralNet): Float64Array {
  const flat = new Float64Array(paramCount(net.dims));
  let o = 0;
  for (let l = 0; l < net.dims.length - 1; l++) {
    for (const v of net.weights[l] ?? []) flat[o++] = v;
    for (const v of net.biases[l] ?? []) flat[o++] = v;
  }
  if (o !== flat.length) throw new Error(`flattenNet: ${o} values for ${flat.length} params`);
  return flat;
}

export function unflattenNet(dims: readonly number[], flat: ArrayLike<number>): NeuralNet {
  if (flat.length !== paramCount(dims)) {
    throw new Error(`unflattenNet: ${flat.length} values for ${paramCount(dims)} params`);
  }
  const weights: number[][] = [];
  const biases: number[][] = [];
  let o = 0;
  for (let l = 0; l < dims.length - 1; l++) {
    const nw = (dims[l] ?? 0) * (dims[l + 1] ?? 0);
    weights.push(Array.from({ length: nw }, () => flat[o++] ?? 0));
    biases.push(Array.from({ length: dims[l + 1] ?? 0 }, () => flat[o++] ?? 0));
  }
  return { dims: [...dims], weights, biases };
}

/** Root-mean-square of a vector — the "weight scale" σ is expressed against. */
export function rms(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, v.length));
}

// ---------------------------------------------------------------------------
// Seeded randomness (mulberry32 + Box-Muller) — same generator family as the
// imitation trainer, so runs are reproducible from --seed.
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One standard normal draw (Box-Muller; rejects the log(0) corner). */
export function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** N unit-gaussian perturbation directions; candidate j is mean ± σ·eps[j]
 *  (the caller mirrors — that's the antithetic pairing). */
export function samplePerturbations(
  rng: () => number,
  dim: number,
  pairs: number,
): Float64Array[] {
  const eps: Float64Array[] = [];
  for (let i = 0; i < pairs; i++) {
    const e = new Float64Array(dim);
    for (let k = 0; k < dim; k++) e[k] = gaussian(rng);
    eps.push(e);
  }
  return eps;
}

// ---------------------------------------------------------------------------
// Rank-shaped fitness + the ES update
// ---------------------------------------------------------------------------

/** Centered-rank utilities: best fitness → +0.5, worst → −0.5, sum ≈ 0.
 *  Scale-free, so one blowout match can't dominate the gradient. */
export function rankShape(fitnesses: readonly number[]): number[] {
  const m = fitnesses.length;
  if (m === 1) return [0];
  const order = fitnesses
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f - b.f || a.i - b.i);
  const u = new Array<number>(m).fill(0);
  for (let rank = 0; rank < m; rank++) {
    u[(order[rank] as { i: number }).i] = rank / (m - 1) - 0.5;
  }
  return u;
}

export interface EsUpdateOpts {
  lr: number;
  /** Pull-strength toward `anchor` (0 = off). */
  decay?: number;
  /** What decay pulls toward — the imitation weights, NOT zero. */
  anchor?: ArrayLike<number>;
}

/**
 * One ES step. `eps` are the N unit-gaussian directions; `fitPlus[i]` /
 * `fitMinus[i]` are the fitnesses of mean+σ·eps[i] / mean−σ·eps[i].
 * Utilities are ranked over ALL 2N candidates. Returns the new mean
 * (the input is not mutated). σ cancels out of the rank-shaped update,
 * so it isn't a parameter here — it only shapes the sampling.
 */
export function esUpdate(
  mean: Float64Array,
  eps: readonly Float64Array[],
  fitPlus: readonly number[],
  fitMinus: readonly number[],
  opts: EsUpdateOpts,
): Float64Array {
  const n = eps.length;
  if (fitPlus.length !== n || fitMinus.length !== n) {
    throw new Error('esUpdate: fitness arrays must match eps length');
  }
  const u = rankShape([...fitPlus, ...fitMinus]);
  const m = 2 * n;
  const next = new Float64Array(mean);
  const decay = opts.decay ?? 0;
  const anchor = opts.anchor;
  for (let i = 0; i < n; i++) {
    const du = ((u[i] ?? 0) - (u[i + n] ?? 0)) * (opts.lr / m);
    if (du === 0) continue;
    const e = eps[i] as Float64Array;
    for (let k = 0; k < next.length; k++) next[k] = (next[k] ?? 0) + du * (e[k] ?? 0);
  }
  if (decay > 0 && anchor !== undefined) {
    for (let k = 0; k < next.length; k++) {
      next[k] = (next[k] ?? 0) - decay * ((next[k] ?? 0) - (anchor[k] ?? 0));
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Checkpoints — plain JSON, round-trippable (evolve.test.ts proves it).
// ---------------------------------------------------------------------------

export const CHECKPOINT_SCHEMA = 'soldat-evolve-checkpoint/1';

export interface EvolveCheckpoint {
  schema: typeof CHECKPOINT_SCHEMA;
  gen: number;
  dims: readonly number[];
  /** Current MEAN weights, flat (layout of flattenNet). */
  mean: number[];
  /** Past-self opponent pool snapshots (oldest first). */
  pastSelves: { gen: number; flat: number[] }[];
  meanFitness: number;
  bestFitness: number;
}

export function makeCheckpoint(
  gen: number,
  dims: readonly number[],
  mean: Float64Array,
  pastSelves: readonly { gen: number; flat: Float64Array }[],
  meanFitness: number,
  bestFitness: number,
): EvolveCheckpoint {
  return {
    schema: CHECKPOINT_SCHEMA,
    gen,
    dims: [...dims],
    mean: [...mean],
    pastSelves: pastSelves.map((p) => ({ gen: p.gen, flat: [...p.flat] })),
    meanFitness,
    bestFitness,
  };
}

export function parseCheckpoint(json: string): EvolveCheckpoint {
  const c = JSON.parse(json) as EvolveCheckpoint;
  if (c.schema !== CHECKPOINT_SCHEMA) {
    throw new Error(`unknown checkpoint schema '${String(c.schema)}'`);
  }
  if (c.mean.length !== paramCount(c.dims)) {
    throw new Error('checkpoint mean length does not match dims');
  }
  return c;
}

// ---------------------------------------------------------------------------
// Registry seam — runMatch resolves engines by id from the shared registry,
// so injecting a candidate is: register its id with a factory closing over
// the weights, then name that id in the match's TeamSpec. Distinct ids per
// weight set is also what lets neural fight its past self (the Game groups
// teams by engine id, so a true mirror id is rejected by runMatch).
// ---------------------------------------------------------------------------

/** (Re-)register engine `id` to run `net`. Last registration wins, so the
 *  evolve loop re-registers 'neural-cand' before every candidate's matches. */
export function registerNeuralNet(id: string, net: NeuralNet): void {
  registerEngine(id, (tweaks) => createNeuralEngineWithWeights(id, net, tweaks));
}

/** Same seam, MOJOJOJO's brain (features v3, 48→…→31): tools/evolve.mjs
 *  --engine mojojojo registers candidates/past-selves through this instead —
 *  the net SHAPE differs from the neural engine's, the registry mechanics
 *  don't. */
export function registerMojojojoNet(id: string, net: NeuralNet): void {
  registerEngine(id, (tweaks) => createMojojojoEngineWithWeights(id, net, tweaks));
}
