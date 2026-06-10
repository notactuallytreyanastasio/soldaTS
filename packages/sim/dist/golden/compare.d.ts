/**
 * Golden-master trace comparison.
 *
 * `compareTraces` walks two traces frame-by-frame, particle-by-particle, and
 * reports whether every per-particle x/y/vx/vy stays within `epsilon`. It is
 * "windowed" in the sense that it reports the FIRST tick whose worst delta
 * exceeds `epsilon` (the divergence point), while still scanning the remaining
 * frames to compute the overall `maxDelta`.
 *
 * Pure and allocation-light; no side effects.
 */
import type { GoldenTrace } from './trace';
export interface CompareResult {
    /** True iff no per-particle field ever exceeded `epsilon`. */
    match: boolean;
    /** First tick whose max delta exceeded `epsilon`, or null if none. */
    firstDivergenceTick: number | null;
    /** Largest absolute per-field delta seen across all compared frames. */
    maxDelta: number;
}
/**
 * Compare two traces within `epsilon`.
 *
 * A structural mismatch (differing frame count, differing tick numbers, or a
 * particle present in one frame but absent in the other) is treated as an
 * infinite divergence at that tick: `match` is false, `maxDelta` is Infinity,
 * and `firstDivergenceTick` is set to that tick.
 */
export declare function compareTraces(a: GoldenTrace, b: GoldenTrace, epsilon: number): CompareResult;
//# sourceMappingURL=compare.d.ts.map