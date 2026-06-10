/**
 * The simulation scalar policy.
 *
 * OpenSoldat's physics is computed in Pascal `Single` (IEEE-754 32-bit float);
 * JS `number` is f64. See docs/PORT-PLAN.md §2 for the full rationale.
 *
 * Because the rewrite is a clean break and both client and server run this
 * identical TypeScript, internal client/server determinism is free (same f64
 * math on both sides). We only need f32 *fidelity* to validate that the port
 * still FEELS like Soldat — that is what STRICT_F32 + the golden-master suite
 * are for.
 *
 *   - Production: STRICT_F32 off, `f()` is identity, sim runs in fast f64.
 *   - Golden master / fidelity tests: STRICT_F32 on, `f()` === Math.fround, so
 *     ported functions reproduce Pascal `Single` results bit-for-bit.
 */
export type Scalar = number;
/** Enabled via `STRICT_F32=1` in the environment (golden-master / fidelity runs). */
export declare const STRICT_F32: boolean;
/**
 * Round to f32 when STRICT_F32 is on; identity in production f64 mode.
 * Wrap the result of each arithmetic step in ported physics to get Pascal
 * `Single` semantics under the golden master: `a = f(a + f(b * c))`.
 */
export declare const f: (x: number) => number;
/** Always round to f32, regardless of mode — for explicit storage boundaries. */
export declare const f32: (x: number) => number;
/** Default comparison tolerance for golden-master windowed assertions. */
export declare const EPSILON = 0.0001;
//# sourceMappingURL=scalar.d.ts.map