/**
 * Deterministic RNG for the simulation.
 *
 * The platform-pure sim must never call Math.random (it would break
 * determinism, the golden master, and client/server reproducibility). All
 * randomness flows through a World-held Rng with an explicit seed.
 *
 * Implementation is mulberry32 — small, fast, fully deterministic. NOTE: this
 * is NOT yet bit-compatible with FreePascal's `Random`; matching Pascal's RNG
 * sequence (needed for golden-master fidelity of spread/sparks and the wire
 * bullet seed) is a later fidelity task. For now it removes all nondeterminism.
 */
export declare class Rng {
    private state;
    constructor(seed?: number);
    /** Next float in [0, 1). */
    next(): number;
    /** Integer in [0, n) — mirrors Pascal `Random(n)` semantics (not its sequence). */
    nextInt(n: number): number;
    /** Reseed for reproducible scenarios (golden master, demos). */
    reseed(seed: number): void;
}
//# sourceMappingURL=rng.d.ts.map