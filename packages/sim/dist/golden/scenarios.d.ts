import { ScenarioRunner } from './runner';
/** Gravity used by the reference scenarios (Parts default GRAV, 0.06). */
export declare const FREEFALL_GRAVITY: number;
/**
 * Single particle in free fall under constant gravity.
 *
 * Configuration: one active particle (id 1), `oneOverMass = 1` (mass 1),
 * `timeStep = 1`, `gravity = 0.06`.
 *
 * NOTE ON DAMPING: the closed-form solution the golden test asserts
 *   v_n = n*g,   y_n = g * n * (n+1) / 2
 * holds only when velocity damping is the identity, i.e. `eDamping = 1`. The
 * conventional RKV value (0.98, shared/Parts.pas:32) is the spark/body Euler
 * damping used in-game; with RKV the velocity would decay geometrically and the
 * trace would no longer match the textbook free-fall recurrence. We therefore
 * pin `eDamping = 1` here so the scenario exercises the exact analytic motion.
 */
export declare function freeFallScenario(ticks?: number): ScenarioRunner;
/**
 * Two particles joined by a distance constraint, falling under gravity.
 *
 * Particle 1 (the anchor) is mass-infinite (`oneOverMass = 0`) so the
 * constraint solver never moves it (Parts.pas:165/190 guard on
 * `OneOverMass[PartA] > 0`); particle 2 hangs below it. Each tick we run the
 * Euler step then satisfy the constraint, mirroring the Verlet-style
 * integrate-then-constrain pattern but driven by the Euler integrator so the
 * scenario shares the same per-tick path as free fall.
 *
 * Rest length is the initial separation, so the pair should settle toward
 * swinging/stretching about that length rather than free-falling apart.
 */
export declare function twoParticleConstraint(ticks?: number): ScenarioRunner;
//# sourceMappingURL=scenarios.d.ts.map