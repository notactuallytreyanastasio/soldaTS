/**
 * Player sprite movement core — faithful port of the movement-critical path of
 * OpenSoldat's `TSprite` (shared/mechanics/Sprites.pas) and the control->forces
 * mapping in shared/mechanics/Control.pas.
 *
 * SCOPE (M2 movement validation). This file ports the *movement* spine only:
 *
 *   1. applyControl       — control booleans -> per-tick Forces on the sprite
 *                           COM particle. Ports the run/jump force assignments
 *                           from Control.pas:1872-1983 (the "// make anims out
 *                           of controls" left/right/up/else block). Animation
 *                           state machine, weapons, jets, prone/roll, idle, and
 *                           the conflicting-key arbitration are DEFERRED.
 *   2. applyGravityAndFriction — the SpriteParts Euler integration step (gravity
 *                           + force integration + velocity EDamping, Parts.pas /
 *                           Anims.pas config) followed by the on-ground surface
 *                           friction (CheckMapCollision, Sprites.pas:2786-2837)
 *                           and the MAX_VELOCITY safety clamp (Sprites.pas:1414).
 *   3. updateSpriteMovement — ties them together against the minimal collision
 *                           helper in ../map/collision (a flat-floor stand-in;
 *                           full PolyMap sector collision is DEFERRED TO M3).
 *
 * Pipeline order mirrors ServerLoop.pas:292-299: per tick the engine first calls
 * SpriteParts.DoEulerTimeStepFor(j) (integrate), THEN Sprite[j].Update (which
 * runs ControlSprite to set NEXT tick's forces and resolves collision/friction).
 * We fuse these into updateSpriteMovement so a single call advances one sprite
 * by one tick: integrate -> collide/friction -> read control -> set forces.
 *
 * Determinism: all physics arithmetic is wrapped in f() (sim scalar module) and
 * vector math reuses ../math/vec2. The COM particle lives in the shared
 * ParticleSystem (world.spriteParts) at index = sprite.num, exactly as Pascal's
 * SpriteParts[Num].
 */
import { f } from '../scalar';
import type { World } from '../world';
import type { Sprite, Control } from './types';
import type { ParticleSystem } from '../physics/particles';
import {
  RUNSPEED,
  RUNSPEEDUP,
  FLYSPEED,
  SURFACECOEFX,
  SURFACECOEFY,
  STANDSURFACECOEFX,
  STANDSURFACECOEFY,
  CROUCHMOVESURFACECOEFX,
  CROUCHMOVESURFACECOEFY,
  DEFAULT_GRAVITY,
} from '../constants';
import { flatGroundCollision, SLIDELIMIT } from '../map/collision';

// ===========================================================================
// Local movement constants not (yet) exported from constants.ts.
// The orchestrator owns constants.ts; these are declared here with provenance
// so they can be hoisted into the shared module later without behaviour change.
// ===========================================================================

// PORT: shared/mechanics/Sprites.pas:51 — MAX_VELOCITY = 11;
export const MAX_VELOCITY = 11 as const;

// PORT: shared/mechanics/Sprites.pas:59-61 — POS_STAND/CROUCH/PRONE.
export const POS_STAND = 1 as const;
export const POS_CROUCH = 2 as const;
export const POS_PRONE = 4 as const;

// PORT: shared/Anims.pas:366 — SpriteParts.EDamping := 0.99;
// (Euler velocity damping for the sprite COM particle; TimeStep := 1,
//  Gravity := GRAV — see Anims.pas:364-365 / Cvar.pas:229.)
export const SPRITE_EDAMPING = f(0.99);

// SLIDELIMIT (Sprites.pas:50) is re-exported from the collision helper.
export { SLIDELIMIT };

// ===========================================================================
// 1. Control -> Forces
// ===========================================================================

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
 * DEFERRED (require the animation state machine / jets / prone, later milestone):
 *   - jump / side-jump (Control.pas:1820-1894, JUMPSPEED/JUMPDIRSPEED) — gated on
 *     LegsAnimation frames.
 *   - crouch-run, prone-move, roll forces (CROUCHRUNSPEED/PRONESPEED/ROLLSPEED).
 *   - jetpack (Control.pas:324-387), the left/right conflict arbitration
 *     (Control.pas:139-165), and the "cheat" velocity divide (Control.pas:1363).
 *
 * Because jump is animation-frame gated, vertical jump impulse is intentionally
 * NOT applied here; only the small -RUNSPEEDUP "step up onto slope" nudge that
 * accompanies on-ground running is ported (it is unconditional in the Pascal
 * on-ground run branch).
 *
 * The forces are written into the COM particle's force accumulator
 * (forceX/forceY at index sprite.num), which the next Euler step consumes.
 */
export function applyControl(
  sprite: Sprite,
  control: Control,
  spriteParts: ParticleSystem,
): void {
  const num = sprite.num;

  // Pascal assigns (not accumulates) Forces in these branches; the force
  // accumulator was zeroed by the previous Euler step (Parts.pas:122-123,145).
  // Only one of left/right is meaningful at a time (Control.pas:139-159 resolves
  // simultaneous left+right; that arbitration is deferred — here right wins the
  // else-if chain, matching Control.pas:1916 ordering).

  // right (Control.pas:1916-1941)
  if (control.right && !control.left) {
    if (sprite.onGround) {
      // Control.pas:1936-1937
      spriteParts.forceX[num] = RUNSPEED;
      spriteParts.forceY[num] = f(-RUNSPEEDUP);
    } else {
      // Control.pas:1940
      spriteParts.forceX[num] = FLYSPEED;
    }
    return;
  }

  // left (Control.pas:1943-1968)
  if (control.left && !control.right) {
    if (sprite.onGround) {
      // Control.pas:1963-1964
      spriteParts.forceX[num] = f(-RUNSPEED);
      spriteParts.forceY[num] = f(-RUNSPEEDUP);
    } else {
      // Control.pas:1967
      spriteParts.forceX[num] = f(-FLYSPEED);
    }
    return;
  }

  // else: no horizontal key (or both / cancelled) — no horizontal force this
  // tick (Control.pas:1970-1983 only sets the Stand/Fall animation, no Force).
}

// ===========================================================================
// 2. Gravity + Euler integration + surface friction
// ===========================================================================

/**
 * Configure a ParticleSystem to behave as OpenSoldat's `SpriteParts` (the COM
 * particles, one per sprite). Mirrors Anims.pas:364-366 + Cvar.pas:229:
 *   TimeStep := 1; Gravity := GRAV; EDamping := 0.99;
 *
 * Call once after creating the shared sprite ParticleSystem. (CreateSprite uses
 * mass 1 per particle — Sprites.pas:323 — i.e. OneOverMass = 1.)
 */
export function configureSpriteParts(spriteParts: ParticleSystem): void {
  spriteParts.timeStep = 1; // PORT: Anims.pas:364
  spriteParts.gravity = DEFAULT_GRAVITY; // PORT: Anims.pas:365 / Cvar.pas:229 — GRAV
  spriteParts.eDamping = SPRITE_EDAMPING; // PORT: Anims.pas:366
  spriteParts.vDamping = 0; // unused for the Euler-integrated COM particle
}

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
export function applySurfaceFriction(
  sprite: Sprite,
  spriteParts: ParticleSystem,
  stepY: number,
): void {
  const num = sprite.num;

  // PORT: Sprites.pas:2786 — only on a sufficiently flat/steep ground contact.
  if (!(stepY > SLIDELIMIT)) {
    return;
  }

  const velX = spriteParts.velocityX[num] ?? 0;
  const velY = spriteParts.velocityY[num] ?? 0;

  // Is the player actively running this tick? In the Pascal the friction branch
  // is selected by LegsAnimation: holding a horizontal key drives the Run/RunBack
  // animation (Control.pas:1916-1968) -> SURFACECOEF (0.97). With no animation
  // system in M2 we approximate "running" by live horizontal control input.
  const running = sprite.control.left !== sprite.control.right; // exactly one held

  if (sprite.position === POS_CROUCH) {
    // PORT: Sprites.pas:2827-2831 — CrouchRun/CrouchRunBack.
    spriteParts.velocityX[num] = f(velX * CROUCHMOVESURFACECOEFX);
    spriteParts.velocityY[num] = f(velY * CROUCHMOVESURFACECOEFY);
    return;
  }

  if (running) {
    // Run / RunBack branch: gentle SURFACECOEF so the player keeps moving.
    // PORT: Sprites.pas:2835-2836 (default, non-Stand) — SURFACECOEF.
    spriteParts.velocityX[num] = f(velX * SURFACECOEFX);
    spriteParts.velocityY[num] = f(velY * SURFACECOEFY);
    return;
  }

  // Idle on ground (Stand/Fall): STANDSURFACECOEF zeroes velocity and cancels the
  // residual force, bringing the body to rest. The |Vel.X| < SLIDELIMIT gate
  // keeps a fast slide alive for one or two frames, matching the Run-vs-Stand
  // hand-off in Sprites.pas:2765-2794.
  const slow = velX < SLIDELIMIT && velX > f(-SLIDELIMIT);
  if (slow) {
    // PORT: Sprites.pas:2792-2794 — STANDSURFACECOEF (zeroes velocity) and
    // subtracts the (now-zero) velocity from the force accumulator.
    spriteParts.velocityX[num] = f(velX * STANDSURFACECOEFX);
    spriteParts.velocityY[num] = f(velY * STANDSURFACECOEFY);
    spriteParts.forceX[num] = f(
      (spriteParts.forceX[num] ?? 0) - (spriteParts.velocityX[num] ?? 0),
    );
    return;
  }

  // Still-sliding fast while idle: SURFACECOEF bleeds it down toward SLIDELIMIT.
  // PORT: Sprites.pas:2835-2836 — SURFACECOEF.
  spriteParts.velocityX[num] = f(velX * SURFACECOEFX);
  spriteParts.velocityY[num] = f(velY * SURFACECOEFY);
}

/**
 * Clamps the COM velocity to +/-MAX_VELOCITY. PORT: Sprites.pas:1414-1421.
 */
export function clampVelocity(sprite: Sprite, spriteParts: ParticleSystem): void {
  const num = sprite.num;
  let vx = spriteParts.velocityX[num] ?? 0;
  let vy = spriteParts.velocityY[num] ?? 0;
  if (vx > MAX_VELOCITY) vx = MAX_VELOCITY; // Sprites.pas:1414-1415
  if (vx < -MAX_VELOCITY) vx = -MAX_VELOCITY; // Sprites.pas:1416-1417
  if (vy > MAX_VELOCITY) vy = MAX_VELOCITY; // Sprites.pas:1418-1419
  if (vy < -MAX_VELOCITY) vy = -MAX_VELOCITY; // Sprites.pas:1420-1421
  spriteParts.velocityX[num] = vx;
  spriteParts.velocityY[num] = vy;
}

/**
 * Integrate the sprite COM particle by one Euler step and resolve flat-ground
 * collision + friction. Thin convenience over the particle subsystem's
 * doEulerTimeStepFor plus the ground-collision/friction resolution; the gravity
 * is supplied by the configured ParticleSystem.gravity (set via
 * configureSpriteParts).
 *
 * @param floorY world Y of the flat floor (the M2 collision stand-in).
 */
export function applyGravityAndFriction(
  sprite: Sprite,
  spriteParts: ParticleSystem,
  floorY: number,
): void {
  const num = sprite.num;

  // (a) Integrate: gravity + Forces -> Velocity -> Pos, then EDamping.
  // PORT: ServerLoop.pas:295 — SpriteParts.DoEulerTimeStepFor(j).
  spriteParts.doEulerTimeStepFor(num);

  // (b) Flat-ground collision (STAND-IN for CheckMapCollision; M3 = full PolyMap).
  // Note: DoEulerTimeStepFor already advanced Pos by Velocity, so we test the
  // *current* (already-integrated) position against the floor. (The Pascal tests
  // SPos + Velocity inside CheckMapCollision because Update runs before the next
  // integration; for the fused M2 path we test post-integration position with a
  // zero look-ahead.)
  const onGround = flatGroundCollision(
    spriteParts.posY[num] ?? 0,
    0,
    floorY,
  );

  sprite.onGroundLastFrame = sprite.onGround; // PORT: Sprites.pas:876 (order kept)
  sprite.onGround = onGround.collided; // PORT: Sprites.pas:858-870 (stand-in)

  if (onGround.collided) {
    // De-penetrate (PORT analogue: Sprites.pas:2738 Pos -= Perp).
    spriteParts.posY[num] = onGround.correctedY;

    // Kill downward velocity on contact (PORT analogue of Pos/Velocity -= Perp,
    // Sprites.pas:2750 — for a flat floor the perpendicular cancels the inbound
    // vertical velocity). Then surface friction scales the remaining velocity.
    if ((spriteParts.velocityY[num] ?? 0) > 0) {
      spriteParts.velocityY[num] = 0;
    }

    applySurfaceFriction(sprite, spriteParts, onGround.stepY);
  }

  // PORT: Sprites.pas:873-874 — OnGroundPermanent latch (two equal frames).
  if (!(sprite.onGround !== sprite.onGroundLastFrame)) {
    sprite.onGroundPermanent = sprite.onGround;
  }

  // (c) Velocity safety clamp. PORT: Sprites.pas:1414-1421.
  clampVelocity(sprite, spriteParts);
}

// ===========================================================================
// 3. One-tick movement update
// ===========================================================================

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
export function updateSpriteMovement(
  world: World,
  spriteIndex: number,
  floorY: number,
): void {
  const sprite = world.sprites[spriteIndex];
  const spriteParts = world.spriteParts;
  if (sprite === undefined || spriteParts === null) {
    return;
  }

  // 1. Integrate gravity/forces, resolve ground collision + friction, clamp.
  applyGravityAndFriction(sprite, spriteParts, floorY);

  // 2. Translate this tick's control input into forces for the NEXT integration.
  applyControl(sprite, sprite.control, spriteParts);
}
