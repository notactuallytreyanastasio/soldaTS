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

// ---------------------------------------------------------------------------
// Blood — cosmetic droplet bursts when a bullet lands on a soldier.
//
// In OpenSoldat blood IS the spark system (Bullets.pas sprite-hit calls
// CreateSpark with the blood styles, count scaled by damage). The faithful
// sim-side port would have to draw randomness, so here the burst lives purely
// in the render layer: driven by the world.onBulletHit observer, simulated
// with Math.random (visual only — the sim never sees these particles), and
// integrated against the render clock. Zero effect on determinism.
// ---------------------------------------------------------------------------

/** One blood droplet (world units; velocities are world units per SECOND). */
export interface BloodParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds of life remaining (alpha fades as life → 0). */
  life: number;
  /** Initial life (the fade reference). */
  maxLife: number;
  /** Droplet radius (world units). */
  r: number;
  /** Fill color (one of BLOOD_COLORS). */
  color: number;
}

/** Downward pull on droplets (world units / s²) — sim gravity is ~216 u/s². */
export const BLOOD_GRAVITY = 320;
/** Dark-to-bright reds; each droplet picks one so the spray has depth. */
const BLOOD_COLORS: readonly number[] = [0x8c0a0a, 0xb01414, 0xd02020, 0x6e0606];
/** Hard cap on live droplets (oldest are dropped first). */
const MAX_BLOOD_PARTICLES = 900;
/** Half-angle (rad) of the forward spray cone around the bullet direction. */
const SPRAY_CONE = 0.85;

/**
 * Build the droplet burst for one bullet impact at (x, y). `dirX/dirY` is the
 * bullet's travel velocity (only its direction matters); `damage` scales the
 * droplet count the way the Pascal hit code scales its CreateSpark count, and
 * a `fatal` hit roughly doubles the burst with bigger, longer-lived droplets.
 *
 * Pure (randomness injected via `rand`) so the burst shape is unit-testable.
 */
export function spawnBloodBurst(
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  damage: number,
  fatal: boolean,
  rand: () => number = Math.random,
): BloodParticle[] {
  // Direction of travel; a (near-)stationary hit sprays in a full circle.
  const speed = Math.hypot(dirX, dirY);
  const hasDir = speed >= MIN_SPEED;
  const baseAng = hasDir ? Math.atan2(dirY, dirX) : 0;

  // Count scales with damage (AK body hits land ~30-60): 8..22, x2 on a kill.
  let count = Math.round(8 + Math.min(damage, 80) * 0.18);
  if (fatal) count = Math.round(count * 2.2);

  const sizeBoost = fatal ? 1.45 : 1;
  const out: BloodParticle[] = [];
  for (let i = 0; i < count; i++) {
    // Most droplets carry on along the bullet's travel; roughly a quarter
    // splash BACK out of the entry side, slower.
    const backsplash = hasDir && rand() < 0.25;
    const ang = hasDir
      ? baseAng + (backsplash ? Math.PI : 0) + (rand() * 2 - 1) * SPRAY_CONE
      : rand() * Math.PI * 2;
    const v = (backsplash ? 30 : 60) + rand() * (backsplash ? 90 : 220);
    const life = (fatal ? 0.55 : 0.4) + rand() * 0.5;
    out.push({
      x,
      y,
      vx: Math.cos(ang) * v,
      vy: Math.sin(ang) * v - (20 + rand() * 40), // slight upward kick
      life,
      maxLife: life,
      r: (1.4 + rand() * 1.8) * sizeBoost,
      color: BLOOD_COLORS[Math.floor(rand() * BLOOD_COLORS.length)] ?? 0xb01414,
    });
  }
  // A short-lived central splash so the impact reads at spectator zoom.
  const splashes = fatal ? 3 : 2;
  for (let i = 0; i < splashes; i++) {
    const life = 0.14 + rand() * 0.12;
    out.push({
      x,
      y,
      vx: (rand() * 2 - 1) * 30,
      vy: (rand() * 2 - 1) * 30,
      life,
      maxLife: life,
      r: (3.2 + rand() * 2.2) * sizeBoost,
      color: BLOOD_COLORS[1] ?? 0xb01414,
    });
  }
  return out;
}

/**
 * Advance droplets by `dt` seconds IN PLACE (gravity + integration + life
 * countdown) and compact away the expired ones (swap-pop; order not kept).
 * Pure array math — exported for tests.
 */
export function updateBloodParticles(parts: BloodParticle[], dt: number): void {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p === undefined) continue;
    p.life -= dt;
    if (p.life <= 0) {
      const last = parts[parts.length - 1];
      if (last !== undefined) parts[i] = last;
      parts.pop();
      continue;
    }
    p.vy += BLOOD_GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
}

/**
 * The client's blood layer: collects bursts from bullet-hit events, advances
 * them on the render clock, and redraws into its own Graphics each frame.
 * Add {@link gfx} to the camera/world container (world-space coordinates).
 */
export class BloodFx {
  /** Draw target — add to the renderer's world container. */
  readonly gfx: Graphics = new Graphics();

  private readonly parts: BloodParticle[] = [];

  /** Spawn a burst for one bullet impact (see {@link spawnBloodBurst}). */
  spawnHit(x: number, y: number, dirX: number, dirY: number, damage: number, fatal: boolean): void {
    const burst = spawnBloodBurst(x, y, dirX, dirY, damage, fatal);
    // Cap the pool: drop the OLDEST droplets to make room for the new burst.
    const overflow = this.parts.length + burst.length - MAX_BLOOD_PARTICLES;
    if (overflow > 0) this.parts.splice(0, overflow);
    this.parts.push(...burst);
  }

  /** Advance all droplets by `dt` seconds (call once per rendered frame). */
  update(dt: number): void {
    // Clamp: a background-tab stall must not teleport droplets off-screen.
    updateBloodParticles(this.parts, dt > 0 && dt < 0.1 ? dt : 1 / 60);
  }

  /** Redraw every live droplet (alpha fades out over the last 60% of life). */
  draw(): void {
    const g = this.gfx;
    g.clear();
    for (const p of this.parts) {
      const t = p.life / p.maxLife;
      const alpha = 0.95 * (t > 0.6 ? 1 : t / 0.6);
      g.circle(p.x, p.y, p.r).fill({ color: p.color, alpha });
    }
  }
}

// ---------------------------------------------------------------------------
// Explosions — the rocket's blast ring/flash (sim onBulletExplode observer)
// ---------------------------------------------------------------------------

/** One live blast: an expanding ring + fading core flash. Render-clock only. */
export interface BlastRing {
  x: number;
  y: number;
  /** Final ring radius (the sim's EXPLOSION_RADIUS). */
  radius: number;
  /** Seconds remaining; spawned at {@link BLAST_LIFE}. */
  life: number;
}

/** Blast animation length (s) — fast: an explosion is a punch, not a bloom. */
export const BLAST_LIFE = 0.35;

/**
 * The client's explosion layer (the rocket wildcard's detonations): collects
 * blasts from the sim's onBulletExplode observer, expands/fades them on the
 * render clock, and redraws into its own Graphics each frame. Purely
 * cosmetic — the observer pattern keeps the sim byte-identical headlessly.
 * Add {@link gfx} to the camera/world container (world-space coordinates).
 */
export class ExplosionFx {
  /** Draw target — add to the renderer's world container. */
  readonly gfx: Graphics = new Graphics();

  private readonly blasts: BlastRing[] = [];

  /** Register one detonation at world (x, y) with the sim's blast radius. */
  spawn(x: number, y: number, radius: number): void {
    this.blasts.push({ x, y, radius, life: BLAST_LIFE });
  }

  /** Advance all blasts by `dt` seconds (call once per rendered frame). */
  update(dt: number): void {
    const step = dt > 0 && dt < 0.1 ? dt : 1 / 60;
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i]!;
      b.life -= step;
      if (b.life <= 0) this.blasts.splice(i, 1);
    }
  }

  /** Redraw every live blast: ring expands to `radius` as the flash fades. */
  draw(): void {
    const g = this.gfx;
    g.clear();
    for (const b of this.blasts) {
      const t = 1 - b.life / BLAST_LIFE; // 0 → 1 over the animation
      const ring = b.radius * (0.25 + 0.75 * t);
      const fade = 1 - t;
      // Expanding shockwave ring.
      g.circle(b.x, b.y, ring).stroke({ color: 0xffc06a, width: 3, alpha: 0.9 * fade });
      // Core flash, biggest at birth, gone by mid-life.
      if (t < 0.5) {
        const core = b.radius * 0.45 * (1 - t * 2);
        g.circle(b.x, b.y, core).fill({ color: 0xfff3c0, alpha: 0.85 * fade });
      }
    }
  }
}
