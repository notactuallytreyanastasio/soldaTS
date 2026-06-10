import type { Vec2 } from '../math/vec2';
export declare const SLIDELIMIT: number;
/** Per-point body-collision sample. `area` mirrors the Pascal `Area` argument. */
export interface SpriteCollisionPoint {
    /** X offset from the COM. */
    dx: number;
    /** Y offset from the COM (positive = below the COM, screen space). */
    dy: number;
    /** Pascal `Area`: 0 = legs/feet (always resolve), 1 = head (gated resolve). */
    area: 0 | 1;
    /** True for the leg points whose contact establishes OnGround. */
    isLeg: boolean;
}
/**
 * The four sprite body collision points, in the exact order TSprite.Update
 * tests them (head L, head R, leg R, leg L).
 *
 * PORT: shared/mechanics/Sprites.pas:819-862.
 */
export declare const SPRITE_COLLISION_POINTS: readonly SpriteCollisionPoint[];
/**
 * Result of a flat-ground test. `collided` is the Pascal `OnGround` boolean;
 * `correctedY` is the de-penetrated sprite Y (clamped to floorY); `stepY` is the
 * vertical component of the contact perpendicular (1 for a flat floor), used by
 * the friction gate `Step.Y > SLIDELIMIT` in Sprites.pas:2767/2786.
 */
export interface FloorCollision {
    collided: boolean;
    correctedY: number;
    stepY: number;
}
/**
 * Flat horizontal floor at world Y = floorY (screen space: larger Y is lower).
 *
 * STAND-IN for the sector-polygon test in CheckMapCollision (Sprites.pas:2613
 * `PointInPoly` + 2718 `ClosestPerpendicular`). A sprite whose predicted
 * position (posY + velY) reaches/passes the floor is `OnGround`; we de-penetrate
 * by snapping the body Y back to the floor. `stepY = 1` mirrors the upward
 * (0, -1)-style ground normal of a flat polygon edge, so it always exceeds
 * SLIDELIMIT and enables the friction branch (faithful to a flat sector).
 *
 * @param posY     current sprite COM Y
 * @param velY     current sprite COM Y velocity (predicted = posY + velY)
 * @param floorY   world Y of the floor surface
 */
export declare function flatGroundCollision(posY: number, velY: number, floorY: number): FloorCollision;
/**
 * Distance from a point to a single (infinite) line through a,b — thin wrapper
 * over the faithfully ported calc.pointLineDistance.
 *
 * STAND-IN for `Map.ClosestPerpendicular` against ONE polygon edge. The real
 * routine returns a perpendicular *vector* over the closest sector edge; here
 * we only expose the scalar distance for movement validation.
 */
export declare function segmentPointDistance(a: Vec2, b: Vec2, p: Vec2): number;
/**
 * Single-segment vs. moving circle collision — thin wrapper over the ported
 * calc.lineCircleCollision. Returns the first contact point of the sprite's
 * collision circle (center `center`, radius `radius`) sweeping along start->end,
 * or null if no contact.
 *
 * STAND-IN: the real system tests the sprite against every sector polygon edge.
 * Here we test exactly one segment treated as a circle at its midpoint... no —
 * we treat the SPRITE as the circle and the SEGMENT endpoints as the sweep, to
 * reuse lineCircleCollision faithfully: we sweep the segment direction against
 * the sprite circle. Sufficient to validate the math wiring; not the M3 system.
 */
export declare function segmentCircleCollision(segStart: Vec2, segEnd: Vec2, center: Vec2, radius: number): Vec2 | null;
//# sourceMappingURL=collision.d.ts.map