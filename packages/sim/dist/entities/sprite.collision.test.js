import { describe, it, expect } from 'vitest';
import { ParticleSystem } from '../physics/particles';
import { resolveParticleMapCollision } from './sprite';
import { POLY_TYPE_NORMAL, POLY_TYPE_BOUNCY } from '../map/polymap';
/**
 * Unit tests for the faithful collision-resolution primitive
 * (PORT: Sprites.pas:2718-2751). We drive it with a synthetic MapCollision so
 * the test does not depend on the full PolyMap query path.
 */
describe('resolveParticleMapCollision', () => {
    const setup = (vx, vy) => {
        const p = new ParticleSystem();
        p.active[1] = true;
        p.posX[1] = 0;
        p.posY[1] = 0;
        p.velocityX[1] = vx;
        p.velocityY[1] = vy;
        p.oneOverMass[1] = 1;
        return p;
    };
    it('pushes the particle out along the perpendicular, clamped to velocity length', () => {
        // Moving straight down at speed 5 into a floor; surface normal points up.
        const p = setup(0, 5);
        const col = {
            polyIndex: 0,
            polyType: POLY_TYPE_NORMAL,
            bounciness: 0,
            perp: { x: 0, y: 1 }, // normalized; pushing the particle up (−y)
            distance: 10, // penetration deeper than velocity length → clamps to 5
            edge: 1,
        };
        resolveParticleMapCollision(p, 1, col);
        // Pos := Pos − perp*min(distance,|v|) = (0,0) − (0,5) = (0,−5).
        expect(p.posX[1]).toBe(0);
        expect(p.posY[1]).toBe(-5);
        // Velocity := Velocity − perp*clamped = (0,5) − (0,5) = (0,0): normal killed.
        expect(p.velocityX[1]).toBe(0);
        expect(p.velocityY[1]).toBe(0);
        // OldPos mirrors the pre-pushout position (Verlet/friction path).
        expect(p.oldX[1]).toBe(0);
        expect(p.oldY[1]).toBe(0);
    });
    it('reflects velocity on a bouncy polygon by bounciness * |velocity|', () => {
        const p = setup(0, 4);
        const col = {
            polyIndex: 0,
            polyType: POLY_TYPE_BOUNCY,
            bounciness: 1.5,
            perp: { x: 0, y: 1 },
            distance: 2, // < |v|=4, so pushout magnitude = 2
            edge: 1,
        };
        resolveParticleMapCollision(p, 1, col);
        // Pos pushed out by 2: (0,0) − (0,2) = (0,−2).
        expect(p.posY[1]).toBe(-2);
        // Velocity := v − perp*(bounciness*|v|) = 4 − 1*(1.5*4) = 4 − 6 = −2 (rebounds up).
        expect(p.velocityY[1]).toBe(-2);
    });
});
//# sourceMappingURL=sprite.collision.test.js.map