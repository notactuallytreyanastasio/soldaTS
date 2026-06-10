import type { World } from '../world';
import type { Sprite, Control } from './types';
import type { ParticleSystem } from '../physics/particles';
import type { MapCollision } from '../map/polymap';
import { SLIDELIMIT } from '../map/collision';
export declare const MAX_VELOCITY: 11;
export declare const JUMP_TICKS: 9;
export declare const POS_STAND: 1;
export declare const POS_CROUCH: 2;
export declare const POS_PRONE: 4;
export declare const SPRITE_EDAMPING: number;
export { SLIDELIMIT };
export declare const JET_THRUST: number;
export declare const JET_GROUND_THRUST: number;
export declare const JET_AIR_DRIFT: number;
/**
 * Maps the movement control booleans to per-tick Forces on the sprite COM
 * particle. Faithful port of the horizontal-movement decisions in the
 * "// make anims out of controls" block of ControlSprite (Control.pas).
 *
 * PORTED (movement-critical):
 *   - right, on ground (Control.pas:1934-1938):
 *       Forces.X := RUNSPEED;  Forces.Y := -RUNSPEEDUP;
 *   - right, in air (Control.pas:1940):
 *       Forces.X := FLYSPEED;
 *   - left, on ground (Control.pas:1961-1964):
 *       Forces.X := -RUNSPEED; Forces.Y := -RUNSPEEDUP;
 *   - left, in air (Control.pas:1967):
 *       Forces.X := -FLYSPEED;
 *
 * PORTED (M3 — jump / jetpack):
 *   - jump, on ground (Control.pas:1873-1894): Forces.Y := -JUMPSPEED.
 *   - side-jump, on ground + horizontal (Control.pas:1815-1822 / 1863-1870):
 *       Forces.X := ±JUMPDIRSPEED; Forces.Y := -JUMPDIRSPEED / 1.2.
 *   - jetpack thrust (Control.pas:324-338): on ground Forces.Y := -2.5*JETSPEED;
 *     in air Forces.Y -= JETSPEED. Gated on jetsCount fuel; decrements fuel.
 *
 * DEFERRED (require the animation state machine / prone, later milestone):
 *   - the animation-frame windows that gate jump force in Pascal (here a jump is
 *     applied as a force each tick the player is on the ground holding up — once
 *     airborne OnGround is false so the impulse stops, faithful to the net path).
 *   - crouch-run, prone-move, roll forces (CROUCHRUNSPEED/PRONESPEED/ROLLSPEED).
 *   - prone-jetpack lateral thrust (Control.pas:336-337), the left/right conflict
 *     arbitration (Control.pas:139-165), and the "cheat" velocity divide.
 *
 * The forces are written into the COM particle's force accumulator
 * (forceX/forceY at index sprite.num), which the next Euler step consumes.
 */
export declare function applyControl(sprite: Sprite, control: Control, spriteParts: ParticleSystem): void;
/**
 * Jetpack thrust — faithful port of the jets block (Control.pas:324-381),
 * reduced to the non-prone, non-RollBack movement-relevant cases.
 *
 *   - active only while `control.jetpack` is held AND fuel (`jetsCount`) > 0
 *     (Control.pas:324);
 *   - on ground (Control.pas:326-328): Pascal assigns Forces.Y := -2.5 *
 *     JETSPEED; we take the MOST UPWARD of the existing force and the jet
 *     kick instead (design override, node 100 — see the branch comment);
 *   - in air, not prone (Control.pas:330-334): Forces.Y -= JETSPEED (accumulates
 *     against the gravity the Euler step will add);
 *   - fuel decrements by one each thrusting tick (Control.pas:373, Dec).
 *
 * Because GRAV (0.06) > 0.05 the `iif(GRAV > 0.05, JETSPEED, GRAV*2)` selector
 * resolves to JETSPEED (see JET_THRUST). The prone lateral-thrust branch
 * (Control.pas:336-337) and the RollBack gate (Control.pas:313-322) are
 * DEFERRED with the animation/prone systems.
 */
export declare function applyJetpack(sprite: Sprite, control: Control, spriteParts: ParticleSystem): void;
/**
 * Configure a ParticleSystem to behave as OpenSoldat's `SpriteParts` (the COM
 * particles, one per sprite). Mirrors Anims.pas:364-366 + Cvar.pas:229:
 *   TimeStep := 1; Gravity := GRAV; EDamping := 0.99;
 *
 * Call once after creating the shared sprite ParticleSystem. (CreateSprite uses
 * mass 1 per particle — Sprites.pas:323 — i.e. OneOverMass = 1.)
 */
export declare function configureSpriteParts(spriteParts: ParticleSystem): void;
/**
 * Applies the on-ground surface friction to the sprite's COM velocity. Faithful
 * port of the friction branch of CheckMapCollision (Sprites.pas:2786-2837),
 * reduced to the movement-relevant animation cases.
 *
 * In the Pascal this runs only inside a confirmed polygon collision, when the
 * contact perpendicular has Step.Y > SLIDELIMIT (Sprites.pas:2786) and the poly
 * is neither ICE nor BOUNCY. The coefficient depends on LegsAnimation:
 *   - Stand / Fall / Crouch    -> STANDSURFACECOEF (0,0)  + Forces.X -= Velocity.X
 *                                 (Sprites.pas:2788-2794)
 *   - CrouchRun / CrouchRunBack -> CROUCHMOVESURFACECOEF (0.85, 0.97)
 *                                 (Sprites.pas:2827-2831)
 *   - otherwise (e.g. Run/RunBack/GetUp/Prone-moving) -> SURFACECOEF (0.97,0.97)
 *                                 (Sprites.pas:2809-2836)
 *
 * M2 SIMPLIFICATION: this milestone has no animation state machine, so we model
 * the two macroscopic cases the movement test needs:
 *   - moving (Velocity.X beyond SLIDELIMIT, i.e. running): SURFACECOEF — the
 *     dominant case for a running/sliding player on flat ground (Run branch).
 *   - (near-)still on ground: STANDSURFACECOEF zeroes velocity and cancels the
 *     residual force (the Stand branch), bringing the body to rest.
 * The crouch/prone-specific coefficients are wired as the `position` argument
 * but the full per-animation selection is DEFERRED with the animation system.
 *
 * `stepY` is the vertical component of the contact perpendicular from the
 * collision helper; friction only applies when stepY > SLIDELIMIT, matching
 * Sprites.pas:2786.
 */
export declare function applySurfaceFriction(sprite: Sprite, spriteParts: ParticleSystem, stepY: number): void;
/**
 * Clamps the COM velocity to +/-MAX_VELOCITY. PORT: Sprites.pas:1414-1421.
 */
export declare function clampVelocity(sprite: Sprite, spriteParts: ParticleSystem): void;
/**
 * Integrate the sprite COM particle by one Euler step and resolve flat-ground
 * collision + friction. Thin convenience over the particle subsystem's
 * doEulerTimeStepFor plus the ground-collision/friction resolution; the gravity
 * is supplied by the configured ParticleSystem.gravity (set via
 * configureSpriteParts).
 *
 * @param floorY world Y of the flat floor (the M2 collision stand-in).
 */
export declare function applyGravityAndFriction(sprite: Sprite, spriteParts: ParticleSystem, floorY: number): void;
/**
 * Advance a single sprite's movement by one tick against the M2 flat-floor
 * collision stand-in.
 *
 * Order (fuses ServerLoop.pas:292-299 integrate-then-Update for one sprite):
 *   1. integrate + collide + friction + clamp (applyGravityAndFriction)
 *   2. read control input -> set next-tick Forces (applyControl)
 *
 * This ordering means the control forces set on tick N are consumed by the
 * Euler step on tick N+1 — matching Pascal, where ControlSprite (inside Update)
 * sets Forces that DoEulerTimeStepFor consumes on the following tick.
 *
 * @param world        the world; world.spriteParts must be configured
 *                     (configureSpriteParts) and have a particle at spriteIndex.
 * @param spriteIndex  1-based sprite index (also the COM particle index).
 * @param floorY       world Y of the flat floor (M2 stand-in for PolyMap).
 */
export declare function updateSpriteMovement(world: World, spriteIndex: number, floorY: number): void;
/**
 * Advance a single sprite's movement by one tick against the loaded PolyMap
 * (`world.map`) — the M3 replacement for {@link updateSpriteMovement}'s
 * flat-floor stand-in.
 *
 * Order mirrors ServerLoop.pas:292-299 / TSprite.Update (Sprites.pas:796-876):
 *   1. integrate the COM by one Euler step (DoEulerTimeStepFor);
 *   2. multi-point map collision + ground detection + surface friction
 *      (collideSpriteAgainstMap — the four body collision points);
 *   3. velocity safety clamp (Sprites.pas:1414-1421);
 *   4. read control input -> set NEXT tick's forces (applyControl), so jump /
 *      jetpack / run forces are consumed by the following integration.
 *
 * `radius` is the per-point collider radius for collideCircle (use a small value
 * such as 0 for point collision, faithful to the engine's point-based feet).
 *
 * PORT: shared/ServerLoop.pas:292-299 + shared/mechanics/Sprites.pas:796-876.
 */
export declare function updateSpriteMovementMap(world: World, spriteIndex: number, radius: number): void;
/**
 * Resolve a single particle against a map collision — the faithful pushout
 * primitive from `Sprites.pas` CheckMapCollision.
 *
 * PORT: shared/mechanics/Sprites.pas:2718-2751. Given the closest-edge
 * collision for particle `num`, push the particle out along the (normalized)
 * perpendicular by `min(penetration, |velocity|)`, mirror that onto OldPos for
 * the Verlet/friction path, and remove the pushout from the velocity. Bouncy
 * polygons reflect with `bounciness * |velocity|` instead.
 *
 * NOTE: this is the resolution MATH only. WHICH particles to test (Soldat
 * collides at multiple skeleton foot points, not the COM) and the `Area`/
 * animation gating (Sprites.pas:2731-2772) are the caller's job — see
 * collideSpriteAgainstMap below, which currently drives it with the COM as an
 * approximation pending the full multi-point port (remaining M3 work).
 */
export declare function resolveParticleMapCollision(parts: ParticleSystem, num: number, col: MapCollision): void;
/**
 * Drive map collision for a sprite against a loaded PolyMap with a MULTI-POINT
 * foot/body query — faithful port of the CheckMapCollision call sites in
 * TSprite.Update (Sprites.pas:806-876).
 *
 * Instead of querying only the COM (which let the body sink halfway into floors),
 * this tests the four sprite body collision points (head L/R, leg L/R — see
 * SPRITE_COLLISION_POINTS) at their offsets from the COM. For each point:
 *
 *   1. predict the point's position at `Pos + Velocity` (Sprites.pas:2590-2591);
 *   2. query the PolyMap (collideCircle at the point with `radius`);
 *   3. on a hit, resolve via `resolveParticleMapCollision` on the COM particle —
 *      Pascal likewise computes the perpendicular from the *foot* point but
 *      pushes `SpriteParts.Pos[Num]` (the COM), so the body is lifted so the foot
 *      rests on the surface, leaving the COM standing above the polygon.
 *
 * The `area` gate (Sprites.pas:2731-2735) decides whether a contact resolves:
 *   Area 0 (legs) always resolves; Area 1 (head) only when Velocity.Y < 0 or
 *   |Velocity.X| > SLIDELIMIT. A leg (Area 0) contact whose perpendicular points
 *   upward (perp.y > SLIDELIMIT — a floor) sets `onGround` and drives surface
 *   friction, exactly as the OnGround assignment in Sprites.pas:858-862 + the
 *   friction branch in Sprites.pas:2786-2837.
 *
 * Returns the first MapCollision that was resolved, or null if no contact.
 *
 * PORT: shared/mechanics/Sprites.pas:806-876, 2585-2841.
 */
export declare function collideSpriteAgainstMap(world: World, spriteIndex: number, radius: number): MapCollision | null;
//# sourceMappingURL=sprite.d.ts.map