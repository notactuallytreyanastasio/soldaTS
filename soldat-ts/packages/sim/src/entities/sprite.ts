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
import type { MapCollision } from '../map/polymap';
import { POLY_TYPE_BOUNCY, isBackground, isOnlyBullets } from '../map/polymap';
import {
  RUNSPEED,
  RUNSPEEDUP,
  FLYSPEED,
  JUMPSPEED,
  JUMPDIRSPEED,
  JETSPEED,
  SURFACECOEFX,
  SURFACECOEFY,
  STANDSURFACECOEFX,
  STANDSURFACECOEFY,
  CROUCHMOVESURFACECOEFX,
  CROUCHMOVESURFACECOEFY,
  DEFAULT_GRAVITY,
} from '../constants';
import {
  flatGroundCollision,
  SLIDELIMIT,
  SPRITE_COLLISION_POINTS,
} from '../map/collision';
import { isBouncy, isIce } from '../map/polymap';

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

// PORT: shared/mechanics/Control.pas:328/334 — iif(GRAV > 0.05, JETSPEED, GRAV*2).
// DEFAULT_GRAVITY (0.06) > 0.05, so the jet thrust per frame is JETSPEED. We
// precompute the selected value once; if GRAV ever drops to <= 0.05 the
// orchestrator can re-derive this from the live gravity.
// PORT: Control.pas:328 — on-ground jetpack force = -2.5 * JETSPEED.
export const JET_THRUST = JETSPEED;
export const JET_GROUND_THRUST = f(2.5 * JETSPEED);

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
export function applyControl(
  sprite: Sprite,
  control: Control,
  spriteParts: ParticleSystem,
): void {
  const num = sprite.num;

  // -----------------------------------------------------------------------
  // Jump / side-jump (Control.pas:1815-1894).
  // In Pascal the jump force is applied across the Jump/JumpSide animation
  // frames while the player remains on the ground. With no animation system we
  // apply the same per-tick force whenever `up` is held AND the player is on the
  // ground: the next Euler step turns it into upward velocity, the body leaves
  // the floor, OnGround drops to false (the leg collision points no longer
  // contact), and the impulse naturally stops — matching the net Pascal path.
  // -----------------------------------------------------------------------
  if (control.up && sprite.onGround) {
    if (control.right && !control.left) {
      // PORT: Control.pas:1820-1821 — JumpSide to the right.
      spriteParts.forceX[num] = JUMPDIRSPEED;
      spriteParts.forceY[num] = f(-JUMPDIRSPEED / 1.2);
    } else if (control.left && !control.right) {
      // PORT: Control.pas:1868-1869 — JumpSide to the left.
      spriteParts.forceX[num] = f(-JUMPDIRSPEED);
      spriteParts.forceY[num] = f(-JUMPDIRSPEED / 1.2);
    } else {
      // PORT: Control.pas:1894 — straight Jump.
      spriteParts.forceY[num] = f(-JUMPSPEED);
    }
    // Jetpack may still add on top of the jump (Control.pas:324 runs separately).
    applyJetpack(sprite, control, spriteParts);
    return;
  }

  // Jetpack thrust (independent of the run/jump else-if chain in Pascal —
  // Control.pas:324 is its own block running before the movement anims).
  applyJetpack(sprite, control, spriteParts);

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

/**
 * Jetpack thrust — faithful port of the jets block (Control.pas:324-381),
 * reduced to the non-prone, non-RollBack movement-relevant cases.
 *
 *   - active only while `control.jetpack` is held AND fuel (`jetsCount`) > 0
 *     (Control.pas:324);
 *   - on ground (Control.pas:326-328): Forces.Y := -2.5 * JETSPEED (a single
 *     assignment — it OVERWRITES any jump force this tick, matching Pascal);
 *   - in air, not prone (Control.pas:330-334): Forces.Y -= JETSPEED (accumulates
 *     against the gravity the Euler step will add);
 *   - fuel decrements by one each thrusting tick (Control.pas:373, Dec).
 *
 * Because GRAV (0.06) > 0.05 the `iif(GRAV > 0.05, JETSPEED, GRAV*2)` selector
 * resolves to JETSPEED (see JET_THRUST). The prone lateral-thrust branch
 * (Control.pas:336-337) and the RollBack gate (Control.pas:313-322) are
 * DEFERRED with the animation/prone systems.
 */
export function applyJetpack(
  sprite: Sprite,
  control: Control,
  spriteParts: ParticleSystem,
): void {
  // PORT: Control.pas:324 — jetpack held AND JetsCount > 0.
  if (!control.jetpack || sprite.jetsCount <= 0) {
    return;
  }

  const num = sprite.num;

  if (sprite.onGround) {
    // PORT: Control.pas:327-328 — Forces.Y := -2.5 * JETSPEED (assignment).
    spriteParts.forceY[num] = f(-JET_GROUND_THRUST);
  } else if (sprite.position !== POS_PRONE) {
    // PORT: Control.pas:333-334 — Forces.Y := Forces.Y - JETSPEED.
    spriteParts.forceY[num] = f((spriteParts.forceY[num] ?? 0) - JET_THRUST);
  }
  // (prone lateral thrust, Control.pas:336-337, deferred.)

  // PORT: Control.pas:373 — Dec(JetsCount).
  sprite.jetsCount -= 1;
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
export function updateSpriteMovementMap(
  world: World,
  spriteIndex: number,
  radius: number,
): void {
  const sprite = world.sprites[spriteIndex];
  const spriteParts = world.spriteParts;
  if (sprite === undefined || spriteParts === null) {
    return;
  }

  // 1. Integrate: gravity + Forces -> Velocity -> Pos, then EDamping.
  // PORT: ServerLoop.pas:295 — SpriteParts.DoEulerTimeStepFor(j).
  spriteParts.doEulerTimeStepFor(spriteIndex);

  // 2. Multi-point map collision: pushout, OnGround, surface friction.
  collideSpriteAgainstMap(world, spriteIndex, radius);

  // 3. Velocity safety clamp. PORT: Sprites.pas:1414-1421.
  clampVelocity(sprite, spriteParts);

  // 4. Translate this tick's control input into forces for the NEXT integration.
  applyControl(sprite, sprite.control, spriteParts);
}

// ---------------------------------------------------------------------------
// PolyMap collision (M3)
// ---------------------------------------------------------------------------

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
export function resolveParticleMapCollision(
  parts: ParticleSystem,
  num: number,
  col: MapCollision,
): void {
  // D := Vec2Length(Velocity) — Sprites.pas:2723.
  const velLen = f(Math.sqrt(f(f(parts.velocityX[num]! * parts.velocityX[num]!) + f(parts.velocityY[num]! * parts.velocityY[num]!))));
  // Perp magnitude is clamped to the velocity length (Sprites.pas:2724-2728).
  const mag = col.distance > velLen ? velLen : col.distance;
  // col.perp is normalized; pushout = perp * mag.
  let perpX = f(col.perp.x * mag);
  let perpY = f(col.perp.y * mag);

  // OldPos := Pos; Pos := Pos - Perp (Sprites.pas:2737-2738).
  parts.oldX[num] = parts.posX[num]!;
  parts.oldY[num] = parts.posY[num]!;
  parts.posX[num] = f(parts.posX[num]! - perpX);
  parts.posY[num] = f(parts.posY[num]! - perpY);

  // Bouncy polygons reflect with bounciness * |velocity| (Sprites.pas:2739-2742).
  if (col.polyType === POLY_TYPE_BOUNCY) {
    perpX = f(col.perp.x * f(col.bounciness * velLen));
    perpY = f(col.perp.y * f(col.bounciness * velLen));
  }

  // Velocity := Velocity - Perp (Sprites.pas:2750).
  parts.velocityX[num] = f(parts.velocityX[num]! - perpX);
  parts.velocityY[num] = f(parts.velocityY[num]! - perpY);
}

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
export function collideSpriteAgainstMap(
  world: World,
  spriteIndex: number,
  radius: number,
): MapCollision | null {
  const sprite = world.sprites[spriteIndex];
  const parts = world.spriteParts;
  const map = world.map;
  if (sprite === undefined || parts === null || map === null) {
    return null;
  }
  const num = sprite.num;

  // Players collide on POLY_TYPE_NORMAL + team/player polys; ignore bullet-only
  // and background polys (full polytype/team gating is M3+).
  const accept = (polyType: number): boolean =>
    !isBackground(polyType) && !isOnlyBullets(polyType);

  // PORT: Sprites.pas:806 — OnGround := False; recomputed from the leg points.
  sprite.onGroundLastFrame = sprite.onGround; // PORT: Sprites.pas:876 (order kept)
  let onGround = false;
  let firstHit: MapCollision | null = null;
  // PORT: Sprites.pas:856-857 — "If collided then don't check the other side as
  // a possible double CheckMapCollision collision would result in too much of a
  // ground repelling force." We apply the floor stabilization/friction for the
  // FIRST resolving leg point only, so gravity is cancelled exactly once.
  let groundResolved = false;

  for (const point of SPRITE_COLLISION_POINTS) {
    // PORT: Sprites.pas:2587-2591 — SPos := body point; Pos := SPos + Velocity.
    const sx = f((parts.posX[num] ?? 0) + point.dx);
    const sy = f((parts.posY[num] ?? 0) + point.dy);
    const predicted = {
      x: f(sx + (parts.velocityX[num] ?? 0)),
      y: f(sy + (parts.velocityY[num] ?? 0)),
    };

    const col = map.collideCircle(predicted, radius, accept);
    if (col === null) {
      continue;
    }

    // PORT: Sprites.pas:2731-2735 — Area gate. Area 0 always resolves; Area 1
    // resolves only when moving up or sliding fast horizontally.
    const velY = parts.velocityY[num] ?? 0;
    const velX = parts.velocityX[num] ?? 0;
    const resolves =
      point.area === 0 ||
      velY < 0 ||
      velX > SLIDELIMIT ||
      velX < f(-SLIDELIMIT);

    if (resolves) {
      // Pushout: OldPos := Pos; Pos := Pos - Perp; Velocity := Velocity - Perp.
      // PORT: Sprites.pas:2737-2750 (resolveParticleMapCollision moves the COM).
      resolveParticleMapCollision(parts, num, col);
      if (firstHit === null) {
        firstHit = col;
      }

      // PORT: Sprites.pas:858-862 — a leg contact establishes OnGround. A floor
      // (ground) contact has its perpendicular pointing upward in screen space
      // (Step.Y = col.perp.y > SLIDELIMIT, the gate of Sprites.pas:2767/2786).
      const stepY = col.perp.y; // Step := Perp before scale (Sprites.pas:2719).
      if (point.area === 0 && point.isLeg && stepY > SLIDELIMIT) {
        onGround = true;
      }

      // PORT: Sprites.pas:2753-2839 — the Area = 0 stabilization + friction.
      // Applied for the FIRST resolving leg only (Sprites.pas:856-857) so the
      // gravity-cancel and friction are not doubled by the second leg.
      if (point.area === 0 && !groundResolved) {
        groundResolved = true;
        // Standing/idle on a floor (|Velocity.X| < SLIDELIMIT, Step.Y > SLIDELIMIT):
        // revert the pushout and cancel gravity so the body rests stably on the
        // surface instead of sinking. PORT: Sprites.pas:2765-2771.
        if (
          velX < SLIDELIMIT &&
          velX > f(-SLIDELIMIT) &&
          stepY > SLIDELIMIT
        ) {
          parts.posX[num] = parts.oldX[num]!;
          parts.posY[num] = parts.oldY[num]!;
          parts.forceY[num] = f((parts.forceY[num] ?? 0) - (parts.gravity ?? 0));
        }

        // Surface friction on a non-ice, non-bouncy floor.
        // PORT: Sprites.pas:2786-2837.
        if (stepY > SLIDELIMIT && !isIce(col.polyType) && !isBouncy(col.polyType)) {
          applySurfaceFriction(sprite, parts, stepY);
        }
      }
    }
  }

  sprite.onGround = onGround; // PORT: Sprites.pas:858-870

  // PORT: Sprites.pas:873-874 — OnGroundPermanent latch (two equal frames).
  if (!(sprite.onGround !== sprite.onGroundLastFrame)) {
    sprite.onGroundPermanent = sprite.onGround;
  }

  return firstHit;
}
