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
export class Rng {
  private state: number;

  constructor(seed = 0x50617254 /* 'ParT' */) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, n) — mirrors Pascal `Random(n)` semantics (not its sequence). */
  nextInt(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Reseed for reproducible scenarios (golden master, demos). */
  reseed(seed: number): void {
    this.state = seed >>> 0;
  }
}
