/**
 * Movement-core tests (M2). Plain f64 (STRICT_F32 off): we validate the
 * qualitative movement feel of the ported core, not bit-exact f32 fidelity.
 *
 *   1. A sprite released above the flat floor falls under gravity and comes to
 *      rest ON the floor (with friction killing residual velocity).
 *   2. Horizontal control input accelerates the sprite, then — once input is
 *      released on the ground — surface friction damps it back toward rest.
 */
import { describe, it, expect } from 'vitest';
import { createWorld } from '../world';
import { ParticleSystem } from '../physics/particles';
import { vec2 } from '../math/vec2';
import { configureSpriteParts, updateSpriteMovement, POS_STAND, MAX_VELOCITY, } from './sprite';
const FLOOR_Y = 100;
function makeWorldWithSprite(startPos) {
    const world = createWorld();
    const parts = new ParticleSystem();
    configureSpriteParts(parts);
    // CreateSprite uses mass 1 (Sprites.pas:323): OneOverMass = 1.
    parts.createPart(vec2(startPos.x, startPos.y), vec2(0, 0), 1, 1);
    world.spriteParts = parts;
    const sprite = world.sprites[1];
    sprite.active = true;
    sprite.num = 1;
    sprite.style = 1;
    sprite.position = POS_STAND;
    sprite.direction = 1;
    return { world, parts, sprite };
}
describe('updateSpriteMovement — gravity + floor rest', () => {
    it('falls under gravity and comes to rest on the floor', () => {
        // Start well above the floor with no input.
        const { world, parts, sprite } = makeWorldWithSprite({ x: 0, y: 0 });
        let prevY = parts.posY[1];
        let everMovedDown = false;
        for (let tick = 0; tick < 600; tick++) {
            updateSpriteMovement(world, 1, FLOOR_Y);
            const y = parts.posY[1];
            if (y > prevY) {
                everMovedDown = true;
            }
            prevY = y;
        }
        // It must have actually fallen (gravity acted).
        expect(everMovedDown).toBe(true);
        // Comes to rest exactly on the floor surface.
        expect(parts.posY[1]).toBeCloseTo(FLOOR_Y, 5);
        expect(sprite.onGround).toBe(true);
        // Residual vertical velocity is killed (at rest).
        expect(Math.abs(parts.velocityY[1])).toBeLessThan(1e-6);
    });
    it('does not tunnel through or exceed MAX_VELOCITY while falling', () => {
        // Start very high so terminal velocity / clamp is exercised.
        const { world, parts } = makeWorldWithSprite({ x: 0, y: -5000 });
        let maxObservedVy = 0;
        for (let tick = 0; tick < 2000; tick++) {
            updateSpriteMovement(world, 1, FLOOR_Y);
            maxObservedVy = Math.max(maxObservedVy, Math.abs(parts.velocityY[1]));
            // Never below the floor.
            expect(parts.posY[1]).toBeLessThanOrEqual(FLOOR_Y + 1e-6);
        }
        expect(maxObservedVy).toBeLessThanOrEqual(MAX_VELOCITY + 1e-6);
        expect(parts.posY[1]).toBeCloseTo(FLOOR_Y, 5);
    });
});
describe('updateSpriteMovement — horizontal control', () => {
    it('accelerates right under input, then damps when released on the ground', () => {
        // Start on the floor so onGround is established immediately.
        const { world, parts, sprite } = makeWorldWithSprite({ x: 0, y: FLOOR_Y });
        // Settle one tick so onGround latches.
        updateSpriteMovement(world, 1, FLOOR_Y);
        expect(sprite.onGround).toBe(true);
        // Press right for a while; horizontal velocity should build up.
        sprite.control.right = true;
        sprite.control.left = false;
        let vxAfterAccel = 0;
        let prevVx = parts.velocityX[1];
        let accelerated = false;
        for (let tick = 0; tick < 60; tick++) {
            updateSpriteMovement(world, 1, FLOOR_Y);
            const vx = parts.velocityX[1];
            if (vx > prevVx + 1e-9) {
                accelerated = true;
            }
            prevVx = vx;
            vxAfterAccel = vx;
        }
        // Moved right and gained positive horizontal velocity.
        expect(accelerated).toBe(true);
        expect(vxAfterAccel).toBeGreaterThan(0);
        expect(parts.posX[1]).toBeGreaterThan(0);
        // Release input: ground friction (SURFACECOEF then STAND) damps velocity.
        sprite.control.right = false;
        for (let tick = 0; tick < 300; tick++) {
            updateSpriteMovement(world, 1, FLOOR_Y);
        }
        // Damped to (near) rest.
        expect(Math.abs(parts.velocityX[1])).toBeLessThan(0.05);
    });
    it('moves left under left input', () => {
        const { world, parts, sprite } = makeWorldWithSprite({ x: 0, y: FLOOR_Y });
        updateSpriteMovement(world, 1, FLOOR_Y);
        sprite.control.left = true;
        sprite.control.right = false;
        for (let tick = 0; tick < 30; tick++) {
            updateSpriteMovement(world, 1, FLOOR_Y);
        }
        expect(parts.posX[1]).toBeLessThan(0);
        expect(parts.velocityX[1]).toBeLessThan(0);
    });
});
//# sourceMappingURL=sprite.test.js.map