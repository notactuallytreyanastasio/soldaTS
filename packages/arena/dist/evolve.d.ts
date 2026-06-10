import { type NeuralNet } from '@soldat/client/headless';
export { NEURAL_SHIPPED_NET, type NeuralNet } from '@soldat/client/headless';
/** Total parameter count for an MLP with the given layer dims. */
export declare function paramCount(dims: readonly number[]): number;
export declare function flattenNet(net: NeuralNet): Float64Array;
export declare function unflattenNet(dims: readonly number[], flat: ArrayLike<number>): NeuralNet;
/** Root-mean-square of a vector — the "weight scale" σ is expressed against. */
export declare function rms(v: ArrayLike<number>): number;
export declare function mulberry32(seed: number): () => number;
/** One standard normal draw (Box-Muller; rejects the log(0) corner). */
export declare function gaussian(rng: () => number): number;
/** N unit-gaussian perturbation directions; candidate j is mean ± σ·eps[j]
 *  (the caller mirrors — that's the antithetic pairing). */
export declare function samplePerturbations(rng: () => number, dim: number, pairs: number): Float64Array[];
/** Centered-rank utilities: best fitness → +0.5, worst → −0.5, sum ≈ 0.
 *  Scale-free, so one blowout match can't dominate the gradient. */
export declare function rankShape(fitnesses: readonly number[]): number[];
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
export declare function esUpdate(mean: Float64Array, eps: readonly Float64Array[], fitPlus: readonly number[], fitMinus: readonly number[], opts: EsUpdateOpts): Float64Array;
export declare const CHECKPOINT_SCHEMA = "soldat-evolve-checkpoint/1";
export interface EvolveCheckpoint {
    schema: typeof CHECKPOINT_SCHEMA;
    gen: number;
    dims: readonly number[];
    /** Current MEAN weights, flat (layout of flattenNet). */
    mean: number[];
    /** Past-self opponent pool snapshots (oldest first). */
    pastSelves: {
        gen: number;
        flat: number[];
    }[];
    meanFitness: number;
    bestFitness: number;
}
export declare function makeCheckpoint(gen: number, dims: readonly number[], mean: Float64Array, pastSelves: readonly {
    gen: number;
    flat: Float64Array;
}[], meanFitness: number, bestFitness: number): EvolveCheckpoint;
export declare function parseCheckpoint(json: string): EvolveCheckpoint;
/** (Re-)register engine `id` to run `net`. Last registration wins, so the
 *  evolve loop re-registers 'neural-cand' before every candidate's matches. */
export declare function registerNeuralNet(id: string, net: NeuralNet): void;
//# sourceMappingURL=evolve.d.ts.map