// Procedural "Gostek" figure renderer.
//
// The real Soldat client (client/GostekGraphics.pas + GostekGraphics.inc)
// composes a player out of ~40 textured sprites, one per bone (head/MORDA,
// chest/KLATA, hip/BIODRO, thighs/UDO, lowerlegs/NOGA, feet/STOPA, arms/RAMIE,
// forearms/REKA, hands/DLON, plus the held weapon). Each sprite is anchored
// between two skeleton constraint points and rotated to follow the physics
// skeleton. We can't ship those sprites here, so we draw a clean, readable
// procedural figure with pixi Graphics that mirrors the same proportions and
// posing: head atop a torso, two swinging legs, two arms, and a weapon barrel
// line pointed along the aim vector.
//
// Coordinates are sim world units with y DOWN (screen-like). The renderer
// container already applies the camera, so we draw directly in world space.
// The caller owns the Graphics object (clears / batches as it sees fit); we
// only append draw commands for ONE figure.

import type { Graphics } from 'pixi.js';

/**
 * Inputs for a single Gostek figure. All positions are in sim world units.
 * `comX/comY` is the centre-of-mass (roughly the hip/chest area of the soldier,
 * matching where Soldat's skeleton is centred).
 */
export interface GostekOpts {
  /** Centre-of-mass world X (hip/chest anchor). */
  comX: number;
  /** Centre-of-mass world Y (hip/chest anchor). */
  comY: number;
  /** Aim target world X (mouse/cursor in world space). */
  aimX: number;
  /** Aim target world Y. */
  aimY: number;
  /** Horizontal velocity (world units/s); drives walk-cycle vs planted legs. */
  vx: number;
  /** Vertical velocity (world units/s). */
  vy: number;
  /** Whether the soldier is standing on ground (legs plant/swing vs tuck). */
  onGround: boolean;
  /** Walk-cycle phase in 0..1, advanced by the caller. */
  phase: number;
  /** Team id: 1 = alpha (red), 2 = bravo (blue), else neutral (green). */
  team: number;
  /** Overall alpha 0..1. */
  alpha: number;
  /** When true, draw a limp/prone "dead" pose instead of an active figure. */
  dead: boolean;
}

// --- Proportions (world units) -------------------------------------------
// Soldat soldiers are roughly head radius ~7, total standing height ~36 (see
// GostekGraphics.inc sprite anchor spacing: head MORDA, chest KLATA, hip
// BIODRO, thigh UDO, lowerleg NOGA stack up to ~this height).
const HEAD_RADIUS = 7;
const TORSO_LEN = 20; // chest(KLATA) top down to hip(BIODRO)
const NECK_GAP = 1; // small gap between torso top and head bottom
const THIGH_LEN = 11; // UDO p1->p2 spacing analogue
const SHIN_LEN = 9; // NOGA spacing analogue
const ARM_LEN = 14; // RAMIE+REKA combined reach
const BARREL_LEN = 22; // weapon line length out past the front hand
const LEG_SWING = 0.7; // radians of forward/back swing while walking
const TORSO_W = 5; // capsule half-ish width for the torso stroke
const LIMB_W = 3; // limb stroke width

const TEAM_ALPHA = 0xd24a4a; // red
const TEAM_BRAVO = 0x4a78d2; // blue
const TEAM_NEUTRAL = 0x4fb050; // green
const SKIN = 0xffd9a8;
const WEAPON = 0x2a2a2a;

/** Pure: aim angle in radians for an aim delta (dx, dy). aimAngle(1,0)===0. */
export function aimAngle(dx: number, dy: number): number {
  return Math.atan2(dy, dx);
}

/**
 * Pure: per-leg swing angle (radians) for a walk-cycle phase.
 * `side` is +1 for one leg and -1 for the other so they swing in anti-phase,
 * mimicking the alternating UDO/NOGA leg animation in GostekGraphics.pas.
 */
export function limbAngle(phase: number, side: 1 | -1): number {
  return Math.sin(phase * Math.PI * 2) * LEG_SWING * side;
}

function teamColor(team: number): number {
  if (team === 1) return TEAM_ALPHA;
  if (team === 2) return TEAM_BRAVO;
  return TEAM_NEUTRAL;
}

/**
 * Draw ONE articulated Gostek figure into `g`. Does not clear `g`; the caller
 * manages clearing/batching. Pure-ish: only appends draw commands derived from
 * `opts`.
 */
export function drawGostek(g: Graphics, opts: GostekOpts): void {
  const { comX, comY, alpha } = opts;
  const body = teamColor(opts.team);
  const a = Math.max(0, Math.min(1, alpha));

  // Aim direction (unit). Default to facing right if aim coincides with com.
  let adx = opts.aimX - comX;
  let ady = opts.aimY - comY;
  let alen = Math.hypot(adx, ady);
  if (alen < 1e-4) {
    adx = 1;
    ady = 0;
    alen = 1;
  }
  const aimX = adx / alen;
  const aimY = ady / alen;
  const facing = aimX >= 0 ? 1 : -1; // body leans toward aim side

  if (opts.dead) {
    drawDead(g, opts, body, a);
    return;
  }

  // Anchor points. com sits at the hip; torso rises upward (y negative is up).
  const hipX = comX;
  const hipY = comY;
  const torsoTopX = hipX + facing * 1.5; // slight lean toward aim
  const torsoTopY = hipY - TORSO_LEN;

  // --- Legs (drawn first, behind torso) ---
  drawLegs(g, opts, hipX, hipY, body, a);

  // --- Back arm (behind torso): supports the weapon ---
  const shoulderX = torsoTopX;
  const shoulderY = torsoTopY + 4;
  drawArm(g, shoulderX, shoulderY, aimX, aimY, body, a, 0.85);

  // --- Torso capsule (chest KLATA -> hip BIODRO) ---
  g.moveTo(hipX, hipY)
    .lineTo(torsoTopX, torsoTopY)
    .stroke({ color: body, width: TORSO_W, alpha: a, cap: 'round' });

  // --- Head (MORDA): a circle just above the torso top ---
  const headX = torsoTopX + facing * 1.5;
  const headY = torsoTopY - NECK_GAP - HEAD_RADIUS;
  g.circle(headX, headY, HEAD_RADIUS).fill({ color: SKIN, alpha: a });
  // Helmet/cap cue tinted by team, on the aim-facing side.
  g.moveTo(headX - aimY * HEAD_RADIUS, headY + aimX * HEAD_RADIUS)
    .arc(
      headX,
      headY,
      HEAD_RADIUS,
      aimAngle(aimX, aimY) - Math.PI / 2,
      aimAngle(aimX, aimY) + Math.PI / 2,
    )
    .stroke({ color: body, width: 2.5, alpha: a });

  // --- Front arm + weapon barrel (drawn last, in front) ---
  drawArm(g, shoulderX, shoulderY, aimX, aimY, body, a, 1);
  drawWeapon(g, shoulderX, shoulderY, aimX, aimY, a);
}

function drawLegs(
  g: Graphics,
  opts: GostekOpts,
  hipX: number,
  hipY: number,
  body: number,
  a: number,
): void {
  const moving = Math.abs(opts.vx) > 4;
  for (const side of [1, -1] as const) {
    let swing: number;
    if (!opts.onGround) {
      // Airborne: tuck legs slightly back.
      swing = -0.4 * side;
    } else if (moving) {
      swing = limbAngle(opts.phase, side) * Math.sign(opts.vx || 1);
    } else {
      // Standing: legs splayed a touch for a stable stance.
      swing = 0.18 * side;
    }
    // Thigh down from hip.
    const kneeX = hipX + Math.sin(swing) * THIGH_LEN;
    const kneeY = hipY + Math.cos(swing) * THIGH_LEN;
    // Shin continues, knee bends a little when swinging forward.
    const bend = swing * 0.5;
    const footX = kneeX + Math.sin(swing - bend) * SHIN_LEN;
    const footY = kneeY + Math.cos(swing - bend) * SHIN_LEN;
    g.moveTo(hipX, hipY)
      .lineTo(kneeX, kneeY)
      .lineTo(footX, footY)
      .stroke({ color: body, width: LIMB_W, alpha: a, cap: 'round' });
  }
}

function drawArm(
  g: Graphics,
  shoulderX: number,
  shoulderY: number,
  aimX: number,
  aimY: number,
  body: number,
  a: number,
  reachScale: number,
): void {
  // Arm reaches toward the aim direction, with a slight droop at the elbow.
  const reach = ARM_LEN * reachScale;
  const elbowX = shoulderX + aimX * reach * 0.5;
  const elbowY = shoulderY + aimY * reach * 0.5 + 2;
  const handX = shoulderX + aimX * reach;
  const handY = shoulderY + aimY * reach;
  g.moveTo(shoulderX, shoulderY)
    .lineTo(elbowX, elbowY)
    .lineTo(handX, handY)
    .stroke({ color: body, width: LIMB_W, alpha: a, cap: 'round' });
  g.circle(handX, handY, 2).fill({ color: SKIN, alpha: a });
}

function drawWeapon(
  g: Graphics,
  shoulderX: number,
  shoulderY: number,
  aimX: number,
  aimY: number,
  a: number,
): void {
  // Weapon barrel: a line from the front hand out along the aim vector,
  // analogous to the PRIMARY_* sprite anchored at the hand and pointing along
  // the aim in GostekGraphics.pas.
  const handX = shoulderX + aimX * ARM_LEN;
  const handY = shoulderY + aimY * ARM_LEN;
  const muzzleX = handX + aimX * BARREL_LEN;
  const muzzleY = handY + aimY * BARREL_LEN;
  // Grip back a touch behind the hand for a stockier silhouette.
  const gripX = handX - aimX * 4;
  const gripY = handY - aimY * 4;
  g.moveTo(gripX, gripY)
    .lineTo(muzzleX, muzzleY)
    .stroke({ color: WEAPON, width: 2.5, alpha: a, cap: 'round' });
}

function drawDead(
  g: Graphics,
  opts: GostekOpts,
  body: number,
  a: number,
): void {
  // Limp prone figure: torso laid horizontally with splayed limbs, head off
  // one end. Matches the spirit of GOSTEK_HEAD_DEAD posing (a slumped soldier).
  const { comX, comY } = opts;
  const da = a * 0.95;
  const torsoX0 = comX - TORSO_LEN * 0.5;
  const torsoX1 = comX + TORSO_LEN * 0.5;
  const y = comY + HEAD_RADIUS; // sink toward the ground line
  // Torso.
  g.moveTo(torsoX0, y)
    .lineTo(torsoX1, y)
    .stroke({ color: body, width: TORSO_W, alpha: da, cap: 'round' });
  // Head off the right end.
  g.circle(torsoX1 + HEAD_RADIUS, y, HEAD_RADIUS).fill({
    color: SKIN,
    alpha: da,
  });
  // Splayed legs from the left end.
  g.moveTo(torsoX0, y)
    .lineTo(torsoX0 - THIGH_LEN, y - SHIN_LEN * 0.6)
    .stroke({ color: body, width: LIMB_W, alpha: da, cap: 'round' });
  g.moveTo(torsoX0, y)
    .lineTo(torsoX0 - THIGH_LEN, y + SHIN_LEN * 0.6)
    .stroke({ color: body, width: LIMB_W, alpha: da, cap: 'round' });
  // Limp arms from the middle.
  g.moveTo(comX, y)
    .lineTo(comX + ARM_LEN * 0.4, y + ARM_LEN * 0.5)
    .stroke({ color: body, width: LIMB_W, alpha: da, cap: 'round' });
}
