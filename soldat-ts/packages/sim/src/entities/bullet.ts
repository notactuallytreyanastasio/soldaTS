/**
 * Bullet ballistics, map/sprite collision and lifetime — faithful port of the
 * core of `shared/mechanics/Bullets.pas` (CreateBullet + TBullet.Update +
 * TBullet.CheckMapCollision + TBullet.CheckSpriteCollision).
 *
 * These are PURE functions over the {@link World} state. A bullet is a slot in
 * `world.bullets[1..MAX_BULLETS]`; its physics live in the `world.bulletParts`
 * ParticleSystem at index = `bullet.num` (exactly Pascal `BulletParts[Num]`).
 * Bullets are Euler-integrated by `world.bulletParts` like every other particle
 * system (Parts.pas); per-style gravity / forces are applied here each tick
 * before the integrator runs (matching the Pascal force-accumulation in Update).
 *
 * SCALAR POLICY: every physics arithmetic step is wrapped in `f()` so STRICT_F32
 * reproduces Pascal `Single`. Vec2/ops come from `../math/vec2`, geometry from
 * `../math/calc`, and map collision from `world.map.collideCircle`.
 *
 * SCOPE (M4, faithful subset). Implemented: plain/shotgun/M2 hitscan-style
 * bullets and frag/M79/LAW-style projectiles for ballistics + map collision +
 * timeout + distance degradation + flame upward force + a simplified sprite hit.
 * DEFERRED (commented at the use site): ricochet impulse math, collider/thing
 * collision, cluster spawning, explosion AoE, and the FULL per-body-part sprite
 * hitbox test (which needs the per-sprite `Skeleton` ParticleSystem that
 * `entities/types.ts` deliberately omits). The sprite-hit here uses the sprite
 * centre-of-mass (`world.spriteParts`) as a single circular hitbox and reports a
 * torso hit; see {@link checkSpriteCollision}.
 *
 * Track A owns `weapons/guns.ts`. To stay decoupled while it lands, the gun
 * stats spawn/update need are passed in via {@link BulletGun} (a structural
 * subset of the SHARED WEAPON CONTRACT `Gun`, so a resolved `getGun(...)` can be
 * handed straight in).
 */
import { f } from '../scalar';
import type { World } from '../world';
import type { Vec2 } from '../math/vec2';
import { vec2, length as vec2Length, sub as vec2Sub } from '../math/vec2';
import type { ParticleSystem } from '../physics/particles';
import { DEFAULT_GRAVITY } from '../constants';
import {
  POLY_TYPE_ONLY_PLAYER,
  POLY_TYPE_DOESNT,
  POLY_TYPE_ONLY_FLAGGERS,
  POLY_TYPE_NOT_FLAGGERS,
  POLY_TYPE_BACKGROUND,
  POLY_TYPE_BACKGROUND_TRANSITION,
} from '../map/polymap';
import { applyBulletDamage, type GunModifiers } from '../combat/damage';
// BulletStyle + bullet-lifetime constants are owned by ../weapons/guns (single
// source of truth, ported from Weapons.pas/Constants.pas). Imported for internal
// use here — re-exported by the package barrel from guns, not from this module.
import {
  BulletStyle,
  BULLET_TIMEOUT,
  GRENADE_TIMEOUT,
  M2BULLET_TIMEOUT,
  FLAMER_TIMEOUT,
} from '../weapons/guns';

// ---------------------------------------------------------------------------
// Constants — PORT: shared/Constants.pas / shared/Weapons.pas
// ---------------------------------------------------------------------------

// PORT: shared/Constants.pas:131 — arrow speed degradation resist.
export const ARROW_RESIST = 280 as const;

// PORT: shared/Cvar.pas:231 — BulletParts.Gravity := GRAV * 2.25.
export const BULLET_GRAVITY = f(DEFAULT_GRAVITY * 2.25);

// PORT: shared/mechanics/Sprites.pas:33 — PART_RADIUS = 7.
export const PART_RADIUS = 7 as const;
// PORT: shared/mechanics/Sprites.pas:35 — SPRITE_RADIUS = 16.
export const SPRITE_RADIUS = 16 as const;

// PORT: shared/mechanics/Bullets.pas:725 — flame upward force per tick.
export const FLAME_UPWARD_FORCE = f(-0.15);

/**
 * The slice of the SHARED WEAPON CONTRACT `Gun` that bullet spawn/update need.
 * A resolved `Gun` from Track A's `getGun(...)` satisfies this structurally.
 */
export interface BulletGun extends GunModifiers {
  /**
   * TGun.Timeout — initial bullet lifetime in ticks (Bullets.pas:164).
   * Named `timeout` to match Track A's `Gun` contract (weapons/guns.ts), so a
   * resolved `getGun(...)` satisfies this interface structurally.
   */
  timeout: number;
  /** TGun.BulletStyle — dispatch style (Weapons.pas:50). */
  bulletStyle: number;
  /** TGun.Num — weapon num (stored as ownerWeapon). */
  num: number;
  /** TGun.Speed — muzzle speed (used for the pierce check, Bullets.pas:1669). */
  bulletSpeed: number;
  /** TGun.Push — push impulse (kept for parity; push application deferred). */
  push: number;
}

// ---------------------------------------------------------------------------
// BulletParts configuration
// ---------------------------------------------------------------------------

/**
 * Configure a ParticleSystem to behave as OpenSoldat's `BulletParts`.
 *   TimeStep := 1; Gravity := GRAV * 2.25; (EDamping/VDamping unused → 1/0)
 *
 * Bullets are Euler-integrated with no velocity damping, so EDamping = 1 (the
 * Euler step multiplies velocity by EDamping each frame; 1 = no damping).
 *
 * PORT: shared/Cvar.pas:228-231 (Gravity), shared/Game.pas init of BulletParts.
 */
export function configureBulletParts(bulletParts: ParticleSystem): void {
  bulletParts.timeStep = 1;
  bulletParts.gravity = BULLET_GRAVITY;
  bulletParts.eDamping = 1; // no Euler velocity damping for bullets
  bulletParts.vDamping = 0; // bullets use the Euler path, not Verlet
}

// ---------------------------------------------------------------------------
// spawnBullet — PORT: shared/mechanics/Bullets.pas:94-357 (CreateBullet, subset)
// ---------------------------------------------------------------------------

export interface SpawnBulletArgs {
  /** sPos — initial position. */
  pos: Vec2;
  /** sVelocity — initial velocity. */
  velocity: Vec2;
  /** sOwner — firing sprite index (0 = none). */
  owner: number;
  /** HitM — per-shot damage multiplier (HitMultiply). */
  hitMultiply: number;
  /** The owner weapon's stats (Track A contract). */
  gun: BulletGun;
  /** Seed (Bullets.pas:213). Defaults to 0; callers may thread the RNG seed. */
  seed?: number;
}

/**
 * Allocate and activate a bullet, faithfully reproducing the state-setup core of
 * `CreateBullet` (Bullets.pas:134-356) minus all networking/demo/WepStats/client
 * branches. Finds a free slot (`N = 255` path: first inactive in 1..MAX_BULLETS),
 * sets the TBullet fields, and creates the BulletParts particle.
 *
 * @returns the 1-based bullet index, or -1 if no free slot (Bullets.pas:140).
 *
 * PORT: shared/mechanics/Bullets.pas:94-357.
 */
export function spawnBullet(world: World, args: SpawnBulletArgs): number {
  const bp = world.bulletParts;
  if (bp === null) {
    return -1;
  }

  const sStyle = args.gun.bulletStyle;

  // Find a free slot — Bullets.pas:134-150 (N = 255 branch).
  let i = -1;
  for (let k = 1; k <= world.bullets.length - 1; k++) {
    const b = world.bullets[k];
    if (b !== undefined && !b.active) {
      i = k;
      break;
    }
  }
  if (i === -1) {
    return -1; // no free slot (Bullets.pas:140)
  }

  const bullet = world.bullets[i];
  if (bullet === undefined) {
    return -1;
  }

  // activate (Bullets.pas:157-213)
  bullet.active = true;
  bullet.style = sStyle;
  bullet.num = i;
  bullet.owner = args.owner;
  bullet.timeOut = args.gun.timeout; // Bullets.pas:164
  bullet.timeOutPrev = args.gun.timeout; // Bullets.pas:166
  bullet.hitMultiply = args.hitMultiply; // Bullets.pas:168
  bullet.hitMultiplyPrev = args.hitMultiply; // Bullets.pas:170
  bullet.whizzed = false;
  bullet.ownerWeapon = args.gun.num; // Bullets.pas:183
  bullet.hitBody = 0;
  bullet.hitSpot = vec2(0, 0);
  bullet.tracking = 0;
  bullet.startUpTime = world.mainTickCounter; // Bullets.pas:197
  bullet.ricochetCount = 0;
  bullet.degradeCount = 0;
  bullet.seed = args.seed ?? 0;
  bullet.velocityPrev = { x: args.velocity.x, y: args.velocity.y };
  // reset the per-sprite collision set (Bullets.pas:1071 Kill clears it)
  bullet.spriteCollisions.fill(false);

  // Flame bullets advance one frame on creation (Bullets.pas:222-226).
  let sPos: Vec2 = { x: args.pos.x, y: args.pos.y };
  if (sStyle === BulletStyle.FLAME) {
    sPos = { x: f(sPos.x + args.velocity.x), y: f(sPos.y + args.velocity.y) };
  }

  bullet.initial = { x: sPos.x, y: sPos.y }; // Bullets.pas:228

  // activate the particle — Mass := 1.0 (Bullets.pas:219, 234).
  bp.createPart(sPos, args.velocity, 1.0, i);

  return i;
}

// ---------------------------------------------------------------------------
// Map collision filter — PORT: Bullets.pas:1125-1130 (collidable poly types)
// ---------------------------------------------------------------------------

/**
 * Whether a polygon participates in bullet collision. Bullets collide with
 * everything EXCEPT only-player / doesn't-collide / flagger-restricted /
 * background polys (Bullets.pas:1125-1130). Team-coloured poly gating
 * (`TeamCollides`) is deferred — without per-sprite team data wired here we
 * treat all non-excluded polys as collidable (the common case).
 *
 * PORT: shared/mechanics/Bullets.pas:1125-1130.
 */
export function bulletCollidesWithPoly(polyType: number): boolean {
  return (
    polyType !== POLY_TYPE_ONLY_PLAYER &&
    polyType !== POLY_TYPE_DOESNT &&
    polyType !== POLY_TYPE_ONLY_FLAGGERS &&
    polyType !== POLY_TYPE_NOT_FLAGGERS &&
    polyType !== POLY_TYPE_BACKGROUND &&
    polyType !== POLY_TYPE_BACKGROUND_TRANSITION
  );
}

/**
 * Test the bullet's current position against the map. Returns the colliding
 * MapCollision (so callers can inspect the perpendicular for ricochet) or null.
 *
 * Faithful note: the Pascal `CheckMapCollision` sub-steps the velocity for
 * accurate detection (DetAcc = Trunc(maxVel / 2.5)) and uses `PointInPolyEdges`.
 * `world.map.collideCircle` already performs the sector lookup + point-in-poly
 * test the engine does; we drive it at the bullet's leading point with a small
 * radius so a thin floor still registers. The multi-step sweep is approximated
 * by the single leading-point query here (sufficient for non-grazing hits);
 * sub-stepping is a // TODO refinement for very fast bullets.
 *
 * PORT: shared/mechanics/Bullets.pas:1073-1131.
 */
export function checkBulletMapCollision(
  world: World,
  bulletIndex: number,
): { hit: true; perp: Vec2; distance: number } | { hit: false } {
  const map = world.map;
  const bp = world.bulletParts;
  const bullet = world.bullets[bulletIndex];
  if (map === null || bp === null || bullet === undefined) {
    return { hit: false };
  }

  const pos: Vec2 = { x: bp.posX[bullet.num] ?? 0, y: bp.posY[bullet.num] ?? 0 };

  const col = map.collideCircle(pos, 0, (polyType) => bulletCollidesWithPoly(polyType));
  if (col === null) {
    return { hit: false };
  }
  return { hit: true, perp: col.perp, distance: col.distance };
}

// ---------------------------------------------------------------------------
// Sprite collision — PORT: Bullets.pas:1361-1900 (simplified, see SCOPE)
// ---------------------------------------------------------------------------

export interface SpriteHit {
  spriteIndex: number;
  /** Body part id (`Where`). Simplified hit reports a torso part (10). */
  where: number;
  /** The collision point. */
  point: Vec2;
}

/**
 * Simplified sprite-hit test. The faithful `CheckSpriteCollision` walks each
 * sprite's per-part `Skeleton` (parts 12,11,10,6,5,4,3) with `LineCircleCollision`
 * over the bullet's swept segment. That skeleton ParticleSystem is deliberately
 * OMITTED from `entities/types.ts`, so here we model each sprite as ONE circular
 * hitbox at its centre-of-mass (`world.spriteParts[j]`) of radius PART_RADIUS and
 * report a torso hit (Where = 10). This preserves the *damage path* (speed *
 * hitMultiply * chest-modifier) while deferring true per-limb hitboxes.
 *
 * Returns the nearest sprite the bullet's swept segment intersects, skipping the
 * owner for non-melee styles per the engine (Bullets.pas:1487-1488 lets j=owner
 * for non-melee; we keep that — friendly self-hit is possible for thrown styles).
 *
 * DEFERRED: per-body-part skeleton hitboxes; ceasefire/team/no-collision gating
 * (Bullets.pas:1516-1530); push impulse (1540-1546).
 *
 * PORT (basis): shared/mechanics/Bullets.pas:1361-1481.
 */
export function checkSpriteCollision(
  world: World,
  bulletIndex: number,
): SpriteHit | null {
  const bp = world.bulletParts;
  const sp = world.spriteParts;
  const bullet = world.bullets[bulletIndex];
  if (bp === null || sp === null || bullet === undefined) {
    return null;
  }

  const start: Vec2 = { x: bp.posX[bullet.num] ?? 0, y: bp.posY[bullet.num] ?? 0 };
  const vel: Vec2 = {
    x: bp.velocityX[bullet.num] ?? 0,
    y: bp.velocityY[bullet.num] ?? 0,
  };
  const end: Vec2 = { x: f(start.x + vel.x), y: f(start.y + vel.y) };

  let best: SpriteHit | null = null;
  let bestDistSq = Infinity;

  for (let j = 1; j <= world.sprites.length - 1; j++) {
    const sprite = world.sprites[j];
    if (sprite === undefined || !sprite.active) {
      continue;
    }
    // GLUE (team dynamics, node 154): friendly fire is OFF in team modes —
    // a bullet passes through the owner's teammates (team 0 = FFA hits all).
    const owner = world.sprites[bullet.owner];
    if (
      owner !== undefined &&
      owner.team > 0 &&
      sprite.team === owner.team &&
      j !== bullet.owner
    ) {
      continue;
    }

    const center: Vec2 = { x: sp.posX[j] ?? 0, y: sp.posY[j] ?? 0 };

    // Line-vs-circle over the swept segment against the single COM hitbox.
    const point = lineCircleClosest(start, end, center, PART_RADIUS);
    if (point === null) {
      continue;
    }

    const dx = f(point.x - start.x);
    const dy = f(point.y - start.y);
    const distSq = f(f(dx * dx) + f(dy * dy));
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = { spriteIndex: j, where: 10, point };
    }
  }

  return best;
}

/**
 * Closest collision point of the swept segment start->end against a circle, or
 * null. A self-contained line/circle test (the shared `lineCircleCollision` in
 * `../math/calc` returns the same; reproduced here to keep f()-wrapped and avoid
 * a circular import surprise). Returns `start` if it already lies inside.
 *
 * PORT: shared/Calc.pas:165-197 (LineCircleCollision) — same algorithm.
 */
function lineCircleClosest(
  start: Vec2,
  end: Vec2,
  center: Vec2,
  radius: number,
): Vec2 | null {
  const r2 = f(radius * radius);

  const sd = sqrDist(start, center);
  if (sd <= r2) {
    return { x: start.x, y: start.y };
  }
  const ed = sqrDist(end, center);
  if (ed <= r2) {
    return { x: end.x, y: end.y };
  }

  // Project center onto the segment, clamp to [0,1].
  const dx = f(end.x - start.x);
  const dy = f(end.y - start.y);
  const lenSq = f(f(dx * dx) + f(dy * dy));
  if (lenSq === 0) {
    return null;
  }
  const t = f(f(f(f(center.x - start.x) * dx) + f(f(center.y - start.y) * dy)) / lenSq);
  if (t < 0 || t > 1) {
    return null;
  }
  const px = f(start.x + f(t * dx));
  const py = f(start.y + f(t * dy));
  const pd = sqrDist({ x: px, y: py }, center);
  if (pd <= r2) {
    return { x: px, y: py };
  }
  return null;
}

function sqrDist(a: Vec2, b: Vec2): number {
  const dx = f(a.x - b.x);
  const dy = f(a.y - b.y);
  return f(f(dx * dx) + f(dy * dy));
}

// ---------------------------------------------------------------------------
// kill / deactivate — PORT: shared/mechanics/Bullets.pas:1060-1071 (TBullet.Kill)
// ---------------------------------------------------------------------------

/**
 * Deactivate a bullet and free its particle.
 * PORT: shared/mechanics/Bullets.pas:1060-1071.
 */
export function killBullet(world: World, bulletIndex: number): void {
  const bullet = world.bullets[bulletIndex];
  if (bullet === undefined) {
    return;
  }
  bullet.active = false; // Bullets.pas:1066
  const bp = world.bulletParts;
  if (bp !== null && bullet.num > 0) {
    bp.active[bullet.num] = false; // Bullets.pas:1067-1068
  }
  bullet.spriteCollisions.fill(false); // Bullets.pas:1070
}

// ---------------------------------------------------------------------------
// updateBullet — PORT: shared/mechanics/Bullets.pas:529-737 (TBullet.Update)
// ---------------------------------------------------------------------------

/**
 * Advance one bullet by one tick: apply per-style forces, then run map and
 * sprite collision against the (already integrated) position, then count down
 * the timeout and apply distance degradation.
 *
 * IMPORTANT ordering (matches the engine pipeline): the BulletParts Euler step
 * runs in the orchestrator BETWEEN force application and collision, exactly like
 * Pascal where `BulletParts.DoEulerTimeStep` is called before `Bullet[i].Update`
 * checks collisions on the new position. This function therefore:
 *   1. saves prev (TimeOutPrev/HitMultiplyPrev/VelocityPrev), Bullets.pas:540-542
 *   2. applies per-style forces (flame upward), Bullets.pas:723-725
 *   3. checks map collision (deactivates on wall hit), Bullets.pas:554-560
 *   4. checks sprite collision (applies damage), Bullets.pas:590
 *   5. decrements TimeOut and kills on expiry, Bullets.pas:611-635
 *   6. distance degradation every 6 ticks, Bullets.pas:638-665
 *
 * @param gun the owner weapon stats (for degradation exclusions + damage).
 *
 * PORT: shared/mechanics/Bullets.pas:529-737.
 */
export function updateBullet(world: World, bulletIndex: number, gun: BulletGun): void {
  const bp = world.bulletParts;
  const bullet = world.bullets[bulletIndex];
  if (bp === null || bullet === undefined || !bullet.active) {
    return;
  }

  // (1) snapshot prev (Bullets.pas:540-542)
  bullet.timeOutPrev = bullet.timeOut;
  bullet.hitMultiplyPrev = bullet.hitMultiply;
  bullet.velocityPrev = {
    x: bp.velocityX[bullet.num] ?? 0,
    y: bp.velocityY[bullet.num] ?? 0,
  };

  // (2) per-style force: flame floats up (Bullets.pas:723-725).
  if (bullet.style === BulletStyle.FLAME) {
    bp.forceY[bullet.num] = f((bp.forceY[bullet.num] ?? 0) + FLAME_UPWARD_FORCE);
  }

  // (3) map collision. On a wall hit the engine repositions + kills the bullet
  // for hitscan styles (Bullets.pas:1133-1211). We faithfully deactivate the
  // bullet; ricochet impulse math is DEFERRED (// TODO ricochet).
  const mapHit = checkBulletMapCollision(world, bulletIndex);
  if (mapHit.hit) {
    killBullet(world, bulletIndex);
    return;
  }

  // (4) sprite collision → damage. Only the hitscan-style branch is modelled
  // here (plain/shotgun/M2/punch/knife); explosive styles defer to AoE.
  if (isHitscanStyle(bullet.style)) {
    const spriteHit = checkSpriteCollision(world, bulletIndex);
    if (spriteHit !== null) {
      // move bullet to the hit point (Bullets.pas:1554) then apply damage.
      bp.posX[bullet.num] = spriteHit.point.x;
      bp.posY[bullet.num] = spriteHit.point.y;
      applyBulletDamage(world, bulletIndex, spriteHit.spriteIndex, spriteHit.where, gun);
      bullet.hitBody = spriteHit.spriteIndex; // Bullets.pas:1650

      // Pierce check (Bullets.pas:1653-1678): dead bodies / very fast / fast
      // bullets pass through with reduced velocity; otherwise the bullet dies.
      // Simplified: a live, normal-speed hit destroys the bullet.
      killBullet(world, bulletIndex);
      return;
    }
  }

  // (5) timeout countdown (Bullets.pas:611-635).
  bullet.timeOut -= 1;
  if (bullet.timeOut === 0) {
    // For the modelled styles, expiry simply kills the bullet (the explosive
    // detonation-on-timeout for FRAGNADE/M79/etc. is DEFERRED with AoE).
    killBullet(world, bulletIndex);
    return;
  }

  // (6) distance degradation (Bullets.pas:638-665). Excludes BARRETT/M79/KNIFE/
  // LAW by weapon num; without those nums wired here we apply the generic rule
  // (the exclusion is a // TODO once Track A's WeaponIndex nums are available).
  if (bullet.timeOut % 6 === 0) {
    const initial = bullet.initial;
    const pos: Vec2 = { x: bp.posX[bullet.num] ?? 0, y: bp.posY[bullet.num] ?? 0 };
    const dist = vec2Length(vec2Sub(initial, pos));

    if (bullet.degradeCount === 0) {
      if (dist > 500) {
        bullet.hitMultiply = f(bullet.hitMultiply * 0.5);
        bullet.degradeCount += 1;
      }
    } else if (bullet.degradeCount === 1) {
      if (dist > 900) {
        bullet.hitMultiply = f(bullet.hitMultiply * 0.5);
        bullet.degradeCount += 1;
      }
    }
  }
}

/**
 * The styles handled by the hitscan damage branch in CheckSpriteCollision
 * (Bullets.pas:1551-1552): PLAIN, SHOTGUN, PUNCH, KNIFE, M2.
 */
export function isHitscanStyle(style: number): boolean {
  return (
    style === BulletStyle.PLAIN ||
    style === BulletStyle.SHOTGUN ||
    style === BulletStyle.PUNCH ||
    style === BulletStyle.KNIFE ||
    style === BulletStyle.M2
  );
}
