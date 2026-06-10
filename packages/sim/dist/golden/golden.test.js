/**
 * Golden-master harness tests (Track A / M2).
 *
 * Asserts:
 *  1. The free-fall trace matches the closed form v_n = n*g, y_n = g*n(n+1)/2.
 *  2. Running the SAME scenario twice yields byte-identical traces (internal
 *     determinism: same f64/f32 math, no clock, no RNG).
 *  3. compareTraces flags a deliberately perturbed trace at the right tick.
 *
 * Runs in both f64 (default) and STRICT_F32 (`STRICT_F32=1`) modes; the
 * closed-form check is done within an epsilon so f32 rounding is tolerated,
 * and an exact iterative reference (computed with the same `f`) is also
 * asserted bit-for-bit.
 */
import { describe, it, expect } from 'vitest';
import { f32, STRICT_F32 } from '../scalar';
import { freeFallScenario, twoParticleConstraint, FREEFALL_GRAVITY } from './scenarios';
import { compareTraces } from './compare';
const TICKS = 600;
const g = FREEFALL_GRAVITY;
describe(`golden harness (STRICT_F32=${STRICT_F32})`, () => {
    it('free fall matches the closed form v_n = n*g, y_n = g*n(n+1)/2', () => {
        const trace = freeFallScenario(TICKS).run();
        expect(trace.frames).toHaveLength(TICKS + 1);
        expect(trace.tickRate).toBe(60);
        expect(trace.scenario).toBe('freeFall');
        // Exact iterative reference using the SAME scalar policy as the sim, so the
        // assertion is bit-for-bit in both f64 and STRICT_F32 modes.
        let vRef = 0;
        let yRef = 0;
        for (let n = 0; n <= TICKS; n++) {
            const frame = trace.frames[n];
            expect(frame.tick).toBe(n);
            expect(frame.particles).toHaveLength(1);
            const p = frame.particles[0];
            expect(p.i).toBe(1);
            // Exact match against the iterative recurrence (bit-for-bit).
            expect(p.vy).toBe(vRef);
            expect(p.y).toBe(yRef);
            // Free fall is purely vertical.
            expect(p.x).toBe(0);
            expect(p.vx).toBe(0);
            // Closed-form sanity within epsilon (tolerates f32 accumulation drift).
            const vClosed = n * g;
            const yClosed = (g * n * (n + 1)) / 2;
            const tol = STRICT_F32 ? 1e-1 : 1e-6;
            expect(Math.abs(p.vy - vClosed)).toBeLessThan(tol + Math.abs(vClosed) * 1e-4);
            expect(Math.abs(p.y - yClosed)).toBeLessThan(tol + Math.abs(yClosed) * 1e-4);
            // Advance the iterative reference for the NEXT tick (n -> n+1):
            // velocity += g; pos += velocity (eDamping = 1). The sim stores pos/vel
            // in Float32Array, so each result round-trips through f32 regardless of
            // STRICT_F32; mirror that storage boundary with f32(...).
            vRef = f32(vRef + g);
            yRef = f32(yRef + vRef);
        }
    });
    it('same scenario run twice yields byte-identical traces (determinism)', () => {
        const a = freeFallScenario(TICKS).run();
        const b = freeFallScenario(TICKS).run();
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        const cmp = compareTraces(a, b, 0);
        expect(cmp.match).toBe(true);
        expect(cmp.firstDivergenceTick).toBeNull();
        expect(cmp.maxDelta).toBe(0);
        // The constraint scenario must also be internally deterministic.
        const c = twoParticleConstraint(200).run();
        const d = twoParticleConstraint(200).run();
        expect(JSON.stringify(c)).toBe(JSON.stringify(d));
        expect(compareTraces(c, d, 0).match).toBe(true);
    });
    it('compareTraces flags a deliberately perturbed trace at the right tick', () => {
        const base = freeFallScenario(TICKS).run();
        // Deep clone via JSON (traces are JSON-serializable by contract).
        const perturbed = JSON.parse(JSON.stringify(base));
        const perturbTick = 137;
        const epsilon = 1e-3;
        // Perturb y at one tick well above epsilon; later ticks remain perturbed
        // too, but firstDivergenceTick must report the EARLIEST exceedance.
        const target = perturbed.frames[perturbTick].particles[0];
        target.y = base.frames[perturbTick].particles[0].y + 5;
        const cmp = compareTraces(base, perturbed, epsilon);
        expect(cmp.match).toBe(false);
        expect(cmp.firstDivergenceTick).toBe(perturbTick);
        expect(cmp.maxDelta).toBeGreaterThanOrEqual(5 - 1e-9);
        // Within a generous epsilon the same perturbation is NOT flagged.
        const lenient = compareTraces(base, perturbed, 10);
        expect(lenient.match).toBe(true);
        expect(lenient.firstDivergenceTick).toBeNull();
        // A structural mismatch (extra particle) is flagged as infinite divergence.
        const structural = JSON.parse(JSON.stringify(base));
        structural.frames[10].particles.push({ i: 2, x: 0, y: 0, vx: 0, vy: 0 });
        const sCmp = compareTraces(base, structural, epsilon);
        expect(sCmp.match).toBe(false);
        expect(sCmp.firstDivergenceTick).toBe(10);
        expect(sCmp.maxDelta).toBe(Number.POSITIVE_INFINITY);
    });
});
//# sourceMappingURL=golden.test.js.map