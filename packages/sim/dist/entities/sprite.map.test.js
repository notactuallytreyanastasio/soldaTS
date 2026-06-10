/**
 * Multi-point map-collision + jump/jetpack tests (M3 — Track B).
 *
 * Plain f64 (STRICT_F32 off): we validate qualitative behaviour against a real
 * floor POLYGON (not the M2 flat-floor stand-in):
 *
 *   1. A sprite released above a floor polygon falls under gravity and comes to
 *      rest STANDING on its surface — the COM settles ABOVE the polygon (the feet
 *      rest on the surface) and `onGround` latches true. It must NOT sink halfway
 *      through (the bug the COM-only query produced).
 *   2. A jump from the ground (control.up + onGround) imparts upward velocity and
 *      lifts the body off the floor.
 *   3. Jetpack thrust lifts a grounded sprite and burns fuel (jetsCount).
 */
import { describe, it, expect } from 'vitest';
import { createWorld } from '../world';
import { ParticleSystem } from '../physics/particles';
import { vec2 } from '../math/vec2';
import { buildPolyMap } from '../map/buildPolyMap';
import { configureSpriteParts, updateSpriteMovementMap, POS_STAND, } from './sprite';
// ---------------------------------------------------------------------------
// Synthetic floor map: ONE wide triangle whose TOP edge is the walking surface.
//
//   A = (-300, 200)  ───────────────  B = (300, 200)     <- floor surface y=200
//                       \         /
//                          C = (0, 600)                   <- interior below
//
// edge1 = A->B (the top / surface); inward normal points DOWN into the interior
// = (0, +1). A player stands ABOVE the surface (smaller y) so the foot collision
// resolves along (0, +1), pushing the COM up and setting onGround (perp.y > 0).
// ---------------------------------------------------------------------------
const SURFACE_Y = 200;
const SECTORS_DIVISION = 50;
const SECTORS_NUM = 25;
function floorMap() {
    const A = { x: -300, y: SURFACE_Y };
    const B = { x: 300, y: SURFACE_Y };
    const C = { x: 0, y: 600 };
    const dim = 2 * SECTORS_NUM + 1;
    const sectors = Array.from({ length: dim * dim }, () => ({ polys: [] }));
    const register = (i, j) => {
        const flat = (i + SECTORS_NUM) * dim + (j + SECTORS_NUM);
        sectors[flat]?.polys.push(1); // 1-based polygon index
    };
    // The triangle spans x∈[-300,300] (kx -6..6) and y∈[200,600] (ky 4..12).
    for (let i = -6; i <= 6; i++) {
        for (let j = 4; j <= 12; j++) {
            register(i, j);
        }
    }
    return {
        sectorsDivision: SECTORS_DIVISION,
        sectorsNum: SECTORS_NUM,
        polygons: [
            {
                vertices: [A, B, C],
                normals: [
                    { x: 0, y: 1, z: 0 }, //          edge1 A->B (top) inward = (0,1)
                    { x: -0.8, y: -0.6, z: 0 }, //    edge2 B->C inward (roughly)
                    { x: 0.8, y: -0.6, z: 0 }, //     edge3 C->A inward (roughly)
                ],
                polyType: 0, // POLY_TYPE_NORMAL
            },
        ],
        sectors,
    };
}
const FOOT_OFFSET = 2; // SPRITE_COLLISION_POINTS leg dy = +2 (COM is 2 above feet).
// Point-feet: the engine collides on the predicted foot POINT (radius 0), so the
// foot rests exactly on the polygon surface. PORT: Sprites.pas:858-862.
const COLLIDER_RADIUS = 0;
function makeWorldOnFloor(startPos) {
    const world = createWorld();
    const parts = new ParticleSystem();
    configureSpriteParts(parts);
    parts.createPart(vec2(startPos.x, startPos.y), vec2(0, 0), 1, 1);
    world.spriteParts = parts;
    world.map = buildPolyMap(floorMap());
    const sprite = world.sprites[1];
    sprite.active = true;
    sprite.num = 1;
    sprite.style = 1;
    sprite.position = POS_STAND;
    sprite.direction = 1;
    sprite.jetsCount = 100;
    return { world, parts, sprite };
}
describe('updateSpriteMovementMap — rest on a floor polygon', () => {
    it('falls and comes to rest STANDING on the polygon surface (not sunk through)', () => {
        // Start well above the surface with no input.
        const { world, parts, sprite } = makeWorldOnFloor({ x: 0, y: 0 });
        let everFell = false;
        let prevY = parts.posY[1];
        for (let tick = 0; tick < 1200; tick++) {
            updateSpriteMovementMap(world, 1, COLLIDER_RADIUS);
            const y = parts.posY[1];
            if (y > prevY + 1e-9) {
                everFell = true;
            }
            prevY = y;
        }
        // Gravity acted.
        expect(everFell).toBe(true);
        // The sprite is on the ground.
        expect(sprite.onGround).toBe(true);
        // COM stays ABOVE the polygon surface (it does NOT sink halfway through, the
        // bug the COM-only query produced): the COM rests ~FOOT_OFFSET above the
        // surface, with the feet (COM + 2) resting essentially ON the surface line.
        const comY = parts.posY[1];
        expect(comY).toBeLessThan(SURFACE_Y); // COM above the surface line
        expect(comY).toBeCloseTo(SURFACE_Y - FOOT_OFFSET, 0); // ~198, standing
        // Feet rest right at the surface, never deep inside the polygon.
        const footY = comY + FOOT_OFFSET;
        expect(footY).toBeGreaterThan(SURFACE_Y - 1);
        expect(footY).toBeLessThan(SURFACE_Y + 1);
        // Settled: residual vertical velocity is killed (at rest).
        expect(Math.abs(parts.velocityY[1])).toBeLessThan(1e-3);
    });
});
describe('updateSpriteMovementMap — jump', () => {
    it('a jump from the ground gives upward velocity and leaves the floor', () => {
        // Settle on the floor first.
        const { world, parts, sprite } = makeWorldOnFloor({ x: 0, y: 0 });
        for (let tick = 0; tick < 400; tick++) {
            updateSpriteMovementMap(world, 1, COLLIDER_RADIUS);
        }
        expect(sprite.onGround).toBe(true);
        const restY = parts.posY[1];
        // Press jump (up).
        sprite.control.up = true;
        let minVy = 0; // most-negative (upward) vertical velocity observed
        let leftGround = false;
        for (let tick = 0; tick < 40; tick++) {
            updateSpriteMovementMap(world, 1, COLLIDER_RADIUS);
            minVy = Math.min(minVy, parts.velocityY[1]);
            if (!sprite.onGround) {
                leftGround = true;
            }
        }
        // Jump imparted upward (negative Y, screen space) velocity.
        expect(minVy).toBeLessThan(0);
        // The body actually rose above its resting height.
        expect(parts.posY[1]).toBeLessThan(restY);
        expect(leftGround).toBe(true);
    });
});
describe('updateSpriteMovementMap — jetpack', () => {
    it('jetpack thrust lifts a grounded sprite and burns fuel', () => {
        const { world, parts, sprite } = makeWorldOnFloor({ x: 0, y: 0 });
        for (let tick = 0; tick < 400; tick++) {
            updateSpriteMovementMap(world, 1, COLLIDER_RADIUS);
        }
        expect(sprite.onGround).toBe(true);
        const restY = parts.posY[1];
        const fuelBefore = sprite.jetsCount;
        sprite.control.jetpack = true;
        let minVy = 0;
        for (let tick = 0; tick < 30; tick++) {
            updateSpriteMovementMap(world, 1, COLLIDER_RADIUS);
            minVy = Math.min(minVy, parts.velocityY[1]);
        }
        // Thrust pushed the sprite upward and it rose.
        expect(minVy).toBeLessThan(0);
        expect(parts.posY[1]).toBeLessThan(restY);
        // Fuel was consumed.
        expect(sprite.jetsCount).toBeLessThan(fuelBefore);
    });
});
//# sourceMappingURL=sprite.map.test.js.map