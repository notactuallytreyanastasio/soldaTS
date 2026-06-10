/**
 * MINIMAL collision helper for movement validation (M2).
 *
 * !!! STAND-IN — NOT THE REAL POLYMAP COLLISION SYSTEM !!!
 *
 * OpenSoldat's player ground/wall collision is `TSprite.CheckMapCollision`
 * (shared/mechanics/Sprites.pas:2575-2846): it iterates the sector polygons
 * around the predicted position (Pos + Velocity), tests `PointInPoly`, finds
 * the `ClosestPerpendicular` of the polygon edge, pushes the sprite out along
 * that perpendicular, and scales velocity by the surface-friction coefficients.
 * That full sector/PolyMap pipeline is DEFERRED TO M3.
 *
 * For M2 we only need enough collision to validate the movement core (gravity,
 * friction, velocity damping, control->forces). This file provides:
 *   - flatGroundCollision: a single horizontal floor at y = floorY (y grows
 *     downward, screen space — matching the Pascal convention used throughout
 *     Sprites.pas). Models the polygon push-out + the "ground perpendicular"
 *     that CheckMapCollision returns for a flat sector edge: Step.Y = 1 (> the
 *     SLIDELIMIT of 0.2), which is what gates the friction branch in Sprites.pas.
 *   - segmentCollision: a single line-segment collision using the faithfully
 *     ported calc.ts helpers (pointLineDistance / lineCircleCollision). This is
 *     a placeholder for `Map.ClosestPerpendicular` against one polygon edge.
 *
 * None of this reproduces sector lookup, poly-type handling, bounciness, ice,
 * or multi-edge resolution. Those arrive with the real PolyMap port in M3.
 */
import { f } from '../scalar';
import type { Vec2 } from '../math/vec2';
import { pointLineDistance, lineCircleCollision } from '../math/calc';

// PORT: shared/mechanics/Sprites.pas:50 — SLIDELIMIT = 0.2;
// (Re-declared locally: the orchestrator owns constants.ts and SLIDELIMIT is
// not yet exported there. Provenance kept so it can be hoisted later.)
export const SLIDELIMIT = f(0.2);

// ===========================================================================
// Sprite body collision points (relative to the COM particle position).
//
// PORT: shared/mechanics/Sprites.pas:819-862 — TSprite.Update's CheckMapCollision
// call sites. The body is sampled at four offsets from the COM (`Pos`):
//
//   head L  = (X - 3.5, Y - 12)   Area = 1   (Sprites.pas:820-821)
//   head R  = (X + 3.5, Y - 12)   Area = 1   (Sprites.pas:823-824)
//   leg  R  = (X + 2,   Y + 2)    Area = 0   (Sprites.pas:858-859, sets OnGround)
//   leg  L  = (X - 2,   Y + 2)    Area = 0   (Sprites.pas:861-862, sets OnGround)
//
// The `Area` flag governs whether a contact resolves (pushes the COM out):
//   Area = 0 always resolves (Sprites.pas:2731 first disjunct);
//   Area = 1 resolves only when Velocity.Y < 0 or |Velocity.X| > SLIDELIMIT
//            (Sprites.pas:2732-2735) — keeps the head from "sticking" to ceilings
//            while standing.
//
// The BodyY / ArmS slope nudge (Sprites.pas:826-854) is DEFERRED: it depends on
// the LegsAnimation walk direction and the Map.RayCast leg probe, neither of
// which exists yet. With BodyY = ArmS = 0 the leg points sit at Y + 2 exactly,
// which is the faithful default when standing/idle.
// ===========================================================================

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
export const SPRITE_COLLISION_POINTS: readonly SpriteCollisionPoint[] = Object.freeze([
  { dx: f(-3.5), dy: f(-12), area: 1, isLeg: false }, // head L (Sprites.pas:820)
  { dx: f(3.5), dy: f(-12), area: 1, isLeg: false }, //  head R (Sprites.pas:823)
  { dx: f(2), dy: f(2), area: 0, isLeg: true }, //        leg  R (Sprites.pas:858)
  { dx: f(-2), dy: f(2), area: 0, isLeg: true }, //       leg  L (Sprites.pas:861)
]);

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
export function flatGroundCollision(
  posY: number,
  velY: number,
  floorY: number,
): FloorCollision {
  // PORT (analogue): CheckMapCollision predicts Pos := SPos + Velocity
  // (Sprites.pas:2590-2591) before testing PointInPoly.
  const predictedY = f(posY + velY);

  if (predictedY >= floorY) {
    return {
      collided: true,
      // De-penetrate: place the body exactly on the floor surface. This is the
      // M2 analogue of subtracting the closest-perpendicular vector (Perp) from
      // Pos in Sprites.pas:2738. Full Perp resolution is deferred to M3.
      correctedY: floorY,
      stepY: 1, // flat-floor ground normal magnitude in Y; > SLIDELIMIT.
    };
  }

  return { collided: false, correctedY: posY, stepY: 0 };
}

/**
 * Distance from a point to a single (infinite) line through a,b — thin wrapper
 * over the faithfully ported calc.pointLineDistance.
 *
 * STAND-IN for `Map.ClosestPerpendicular` against ONE polygon edge. The real
 * routine returns a perpendicular *vector* over the closest sector edge; here
 * we only expose the scalar distance for movement validation.
 */
export function segmentPointDistance(a: Vec2, b: Vec2, p: Vec2): number {
  return pointLineDistance(a, b, p);
}

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
export function segmentCircleCollision(
  segStart: Vec2,
  segEnd: Vec2,
  center: Vec2,
  radius: number,
): Vec2 | null {
  return lineCircleCollision(segStart, segEnd, center, radius);
}
