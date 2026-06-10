/**
 * Golden-master fidelity seeds for the particle integrator
 * (port of shared/Parts.pas). These are the first per-function checks of the
 * golden-master suite: each expected value is derived from the ported formula,
 * not copied from a black box.
 *
 * Tests pass under plain f64 (default) and remain valid under STRICT_F32.
 */
import { describe, it, expect } from 'vitest';
import { ParticleSystem } from './particles';
import { vec2 } from '../math/vec2';
import { f } from '../scalar';
import { NUM_PARTICLES, RKV } from '../constants';
describe('ParticleSystem.createPart / makeConstraint', () => {
    it('marks a particle active and seeds Pos/OldPos/OneOverMass (Parts.pas:203-212)', () => {
        const ps = new ParticleSystem();
        ps.createPart(vec2(10, 20), vec2(1, -2), 4, 1);
        expect(ps.active[1]).toBe(true);
        expect(ps.posX[1]).toBe(10);
        expect(ps.posY[1]).toBe(20);
        expect(ps.oldX[1]).toBe(10); // OldPos := Start
        expect(ps.oldY[1]).toBe(20);
        expect(ps.velocityX[1]).toBe(1);
        expect(ps.velocityY[1]).toBe(-2);
        expect(ps.oneOverMass[1]).toBeCloseTo(0.25, 6); // 1 / Mass
    });
    it('appends 1-indexed constraints and bumps constraintCount (Parts.pas:214-224)', () => {
        const ps = new ParticleSystem();
        expect(ps.constraintCount).toBe(0);
        ps.makeConstraint(1, 2, 30);
        expect(ps.constraintCount).toBe(1);
        const c = ps.constraints[1];
        expect(c?.active).toBe(true);
        expect(c?.partA).toBe(1);
        expect(c?.partB).toBe(2);
        expect(c?.restlength).toBe(30);
    });
});
describe('ParticleSystem.satisfyConstraints (Parts.pas:149-201)', () => {
    it('relaxes a 2-particle distance constraint toward restlength', () => {
        const ps = new ParticleSystem();
        // Two equal-mass free particles 100 apart on the X axis.
        ps.createPart(vec2(0, 0), vec2(0, 0), 1, 1);
        ps.createPart(vec2(100, 0), vec2(0, 0), 1, 2);
        const rest = 40;
        ps.makeConstraint(1, 2, rest);
        const dist = () => Math.abs(ps.posX[2] - ps.posX[1]);
        expect(dist()).toBe(100);
        // A single relaxation pass already snaps an unloaded pair exactly to rest:
        // diff = (100 - 40)/100 = 0.6; each end moves Delta*0.5*0.6 = +/-30 in X,
        // giving 30 and 70 -> distance 40.
        ps.satisfyConstraints();
        expect(dist()).toBeCloseTo(rest, 4);
        expect(ps.posX[1]).toBeCloseTo(30, 4);
        expect(ps.posX[2]).toBeCloseTo(70, 4);
        // Idempotent at rest: further passes do not move it.
        ps.satisfyConstraints();
        expect(dist()).toBeCloseTo(rest, 4);
    });
    it('only moves the movable end when one mass is pinned (OneOverMass = 0)', () => {
        const ps = new ParticleSystem();
        ps.createPart(vec2(0, 0), vec2(0, 0), 1, 1);
        ps.createPart(vec2(100, 0), vec2(0, 0), 1, 2);
        ps.oneOverMass[1] = 0; // pin particle 1 (Parts.pas:165 guard)
        ps.makeConstraint(1, 2, 40);
        ps.satisfyConstraints();
        // Pinned end stays; movable end takes the full correction (half of it):
        // posB := 100 - delta(=100)*0.5*0.6 = 100 - 30 = 70.
        expect(ps.posX[1]).toBe(0);
        expect(ps.posX[2]).toBeCloseTo(70, 4);
    });
    it('skips inactive constraints in the batch path (Parts.pas:158)', () => {
        const ps = new ParticleSystem();
        ps.createPart(vec2(0, 0), vec2(0, 0), 1, 1);
        ps.createPart(vec2(100, 0), vec2(0, 0), 1, 2);
        ps.makeConstraint(1, 2, 40);
        const c = ps.constraints[1];
        if (c)
            c.active = false;
        ps.satisfyConstraints();
        expect(ps.posX[1]).toBe(0);
        expect(ps.posX[2]).toBe(100); // untouched
    });
});
describe('ParticleSystem.doEulerTimeStep (Parts.pas:106-124)', () => {
    it('advances a single free particle under gravity by the ported amount', () => {
        const ps = new ParticleSystem();
        ps.timeStep = 1;
        ps.gravity = 0.06; // sv_gravity (physics-and-balance-constants.md:7)
        ps.eDamping = 1; // no velocity damping -> closed-form expected values
        ps.createPart(vec2(0, 0), vec2(0, 0), 1, 1); // mass 1 -> oneOverMass 1
        const g = ps.gravity;
        const N = 5;
        for (let step = 1; step <= N; step++) {
            ps.doEulerTimeStep();
            // Closed form of the ported Euler (ts=1, oneOverMass=1, eDamping=1):
            //   v_n = n * g ;  y_n = g * (1 + 2 + ... + n) = g * n(n+1)/2
            let expectedVel = 0;
            for (let k = 1; k <= step; k++)
                expectedVel = f(expectedVel + g);
            let expectedPos = 0;
            let v = 0;
            for (let k = 1; k <= step; k++) {
                v = f(v + g);
                expectedPos = f(expectedPos + v);
            }
            expect(ps.velocityY[1]).toBeCloseTo(expectedVel, 5);
            expect(ps.posY[1]).toBeCloseTo(expectedPos, 4);
            expect(ps.posX[1]).toBe(0); // no horizontal force
            expect(ps.forceY[1]).toBe(0); // forces cleared each step
        }
        // After 5 steps: v = 5*0.06 = 0.30; y = 0.06 * 15 = 0.90.
        expect(ps.velocityY[1]).toBeCloseTo(0.3, 5);
        expect(ps.posY[1]).toBeCloseTo(0.9, 4);
    });
    it('applies eDamping to velocity each step (Parts.pas:119)', () => {
        const ps = new ParticleSystem();
        ps.timeStep = 1;
        ps.gravity = 0.06;
        ps.eDamping = RKV; // 0.98 (Parts.pas:32)
        ps.createPart(vec2(0, 0), vec2(0, 0), 1, 1);
        // One step: v = (0 + g) * EDamping ; y = 0 + (0 + g) = g (damping applied
        // AFTER the position update, so first y move is the undamped g).
        ps.doEulerTimeStep();
        expect(ps.velocityY[1]).toBeCloseTo(f(0.06 * RKV), 6);
        expect(ps.posY[1]).toBeCloseTo(0.06, 6);
    });
});
describe('ParticleSystem.doVerletTimeStep (Parts.pas:126-147)', () => {
    it('integrates one Verlet step matching the ported formula', () => {
        const ps = new ParticleSystem();
        ps.timeStep = 1;
        ps.gravity = 0.06;
        ps.vDamping = 0; // pure Verlet, no damping
        ps.createPart(vec2(0, 0), vec2(0, 0), 1, 1); // Pos = OldPos = 0
        ps.doVerletTimeStep(); // no constraints -> just the integration
        // D = Pos*(1+0) - OldPos*0 = 0 ; force term = g*1*1 = g ; Pos := 0 + g.
        expect(ps.posY[1]).toBeCloseTo(0.06, 6);
        expect(ps.oldY[1]).toBe(0); // OldPos := previous Pos (0)
    });
});
describe('constants wiring', () => {
    it('exposes 1-indexed SoA arrays sized NUM_PARTICLES + 1', () => {
        const ps = new ParticleSystem();
        expect(ps.posX.length).toBe(NUM_PARTICLES + 1);
        expect(ps.oneOverMass.length).toBe(NUM_PARTICLES + 1);
        expect(NUM_PARTICLES).toBe(560); // Parts.pas:31
        expect(RKV).toBeCloseTo(0.98, 6); // Parts.pas:32
    });
});
//# sourceMappingURL=particles.test.js.map