// Combat FX renderers — bullet tracers, a crosshair, and an optional muzzle
// flash. PixiJS v8 Graphics (the proven-working draw path; no custom shaders).
//
// GLUE module: pure-ish draw helpers that render into a caller-provided Graphics
// (or, for the crosshair, a self-contained Container). OpenSoldat draws bullets
// as textured streaks oriented along velocity (GameRendering.pas RenderBullets)
// and the aim cursor as an interface sprite; here we approximate both with thin
// bright Graphics primitives so motion reads clearly against the map.
//
// Coordinates are sim WORLD units (y down). The renderer's world container
// already applies the camera, so everything is drawn in world space. The pure
// geometry helper `tracerTail` is exported and unit-tested in fx.test.ts.

import { Container, Graphics } from 'pixi.js';

/**
 * Minimal per-bullet view consumed by {@link drawBullets}. Positions/velocities
 * are sim world units; `style` is a 24-bit RGB color (0xRRGGBB) used to tint the
 * tracer so different ammo types can read distinctly.
 *
 * - `x`, `y`: bullet tip position (world units).
 * - `vx`, `vy`: bullet velocity (world units / tick); direction + speed.
 * - `style`: tracer color as 0xRRGGBB.
 */
export interface BulletView {
  x: number;
  y: number;
  vx: number;
  vy: number;
  style: number;
}

/** Tracer length per unit of speed: tail length ≈ speed * this factor. */
const TRACER_SPEED_SCALE = 2;
/** Minimum drawable speed; below this a bullet is rendered as just a dot. */
const MIN_SPEED = 1e-4;
/** Tracer line thickness (world units). */
const TRACER_WIDTH = 1.5;
/** Bright glow dot radius at the tracer tip (world units). */
const TIP_RADIUS = 2;
/** Color of the bright tip glow dot. */
const TIP_COLOR = 0xffffff;

/** Endpoints of a tracer segment: tail (back) and tip (the bullet position). */
export interface TracerSegment {
  tailX: number;
  tailY: number;
  tipX: number;
  tipY: number;
}

/**
 * Pure geometry: compute the tail endpoint of a tracer drawn BACK along the
 * velocity from the bullet tip (x, y). The tail sits `len` world units behind
 * the tip in the direction opposite to (vx, vy). For a stationary bullet
 * (|v| < MIN_SPEED) the tail collapses onto the tip (zero-length segment).
 *
 * Exported so it can be unit-tested without pixi/DOM.
 */
export function tracerTail(
  x: number,
  y: number,
  vx: number,
  vy: number,
  len: number,
): TracerSegment {
  const speed = Math.hypot(vx, vy);
  if (speed < MIN_SPEED) {
    return { tailX: x, tailY: y, tipX: x, tipY: y };
  }
  const ux = vx / speed;
  const uy = vy / speed;
  return {
    tailX: x - ux * len,
    tailY: y - uy * len,
    tipX: x,
    tipY: y,
  };
}

/**
 * Clear `g` and draw every active bullet as a bright tracer: a line from the
 * bullet position back along its velocity (length ≈ speed * 2) plus a small glow
 * dot at the tip. Tracer color comes from each bullet's `style`. Call once per
 * frame with the active bullets.
 */
export function drawBullets(g: Graphics, bullets: readonly BulletView[]): void {
  g.clear();
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    if (b === undefined) continue;

    const speed = Math.hypot(b.vx, b.vy);
    const len = speed * TRACER_SPEED_SCALE;
    if (speed >= MIN_SPEED && len > 0) {
      const seg = tracerTail(b.x, b.y, b.vx, b.vy, len);
      g.moveTo(seg.tailX, seg.tailY)
        .lineTo(seg.tipX, seg.tipY)
        .stroke({ color: b.style, width: TRACER_WIDTH, alpha: 0.9 });
    }
    // Bright glow dot at the tip, regardless of speed.
    g.circle(b.x, b.y, TIP_RADIUS).fill({ color: TIP_COLOR, alpha: 0.95 });
  }
}

/** Length (world units) of each crosshair tick arm. */
const CROSSHAIR_ARM = 7;
/** Gap (world units) between the center and the start of each tick arm. */
const CROSSHAIR_GAP = 4;
/** Crosshair line thickness (world units). */
const CROSSHAIR_WIDTH = 1.5;
/** Crosshair center dot radius (world units). */
const CROSSHAIR_DOT = 1;
/** Crosshair color. */
const CROSSHAIR_COLOR = 0xff3030;

/**
 * A reusable aim crosshair: four ticks (up/down/left/right) around a center dot.
 *
 * Construct once and add to the world container; reposition each frame with
 * {@link moveTo} using the world-space aim point. The geometry is drawn once
 * (centered on the local origin) and only the Container's position changes, so
 * per-frame cost is a transform update, not a redraw.
 */
export class Crosshair extends Container {
  private readonly gfx: Graphics = new Graphics();

  constructor() {
    super();
    this.addChild(this.gfx);
    this.draw();
  }

  /** Move the crosshair so its center sits at the given world aim point. */
  moveTo(worldX: number, worldY: number): void {
    this.position.set(worldX, worldY);
  }

  /** Draw the static crosshair geometry centered on the local origin. */
  private draw(): void {
    const g = this.gfx;
    g.clear();
    const a = CROSSHAIR_ARM;
    const gap = CROSSHAIR_GAP;
    // Up
    g.moveTo(0, -gap).lineTo(0, -gap - a);
    // Down
    g.moveTo(0, gap).lineTo(0, gap + a);
    // Left
    g.moveTo(-gap, 0).lineTo(-gap - a, 0);
    // Right
    g.moveTo(gap, 0).lineTo(gap + a, 0);
    g.stroke({ color: CROSSHAIR_COLOR, width: CROSSHAIR_WIDTH });
    // Center dot
    g.circle(0, 0, CROSSHAIR_DOT).fill({ color: CROSSHAIR_COLOR });
  }
}

/** Base radius (world units) of the muzzle flash at full ttl. */
const FLASH_RADIUS = 5;
/** Length (world units) the flash extends forward along the aim direction. */
const FLASH_LENGTH = 14;
/** Inner (hot) flash color. */
const FLASH_CORE = 0xffffcc;
/** Outer (warm) flash color. */
const FLASH_GLOW = 0xffaa33;

/**
 * Draw a small muzzle flash at a gun muzzle (x, y), pointing toward (aimX, aimY).
 * `ttl` in [0, 1] is the remaining lifetime fraction; the flash shrinks and fades
 * as ttl → 0. Does NOT clear `g` — the caller composes flashes into whatever
 * Graphics they like (e.g. the bullet layer) and clears it once per frame. A
 * non-positive ttl draws nothing.
 */
export function drawMuzzleFlash(
  g: Graphics,
  x: number,
  y: number,
  aimX: number,
  aimY: number,
  ttl: number,
): void {
  if (ttl <= 0) return;
  const t = ttl > 1 ? 1 : ttl;

  const dx = aimX - x;
  const dy = aimY - y;
  const dist = Math.hypot(dx, dy);
  // Aim direction (default to facing +x if the aim point coincides with muzzle).
  const ux = dist < MIN_SPEED ? 1 : dx / dist;
  const uy = dist < MIN_SPEED ? 0 : dy / dist;

  const tipX = x + ux * FLASH_LENGTH * t;
  const tipY = y + uy * FLASH_LENGTH * t;
  const r = FLASH_RADIUS * t;

  // Perpendicular for a small forward-pointing triangle (the flame).
  const px = -uy;
  const py = ux;
  g.moveTo(x + px * r, y + py * r)
    .lineTo(tipX, tipY)
    .lineTo(x - px * r, y - py * r)
    .closePath()
    .fill({ color: FLASH_GLOW, alpha: 0.7 * t });
  // Hot core blob at the muzzle.
  g.circle(x, y, r * 0.7).fill({ color: FLASH_CORE, alpha: 0.85 * t });
}
