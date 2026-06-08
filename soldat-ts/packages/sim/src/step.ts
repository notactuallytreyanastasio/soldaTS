/**
 * The unified per-tick simulation spine — one full 60 Hz tick over every
 * subsystem, in the exact order the engine runs them.
 *
 * PORT: server/ServerLoop.pas:270-311 (UpdateFrame, the core game-simulation
 * sub-steps) and docs/rewrite-reference/tick-pipeline.md §"UpdateFrame Sub-Steps".
 * The canonical ordering this mirrors:
 *
 *   1. (OldSpritePos ring shift)            — ServerLoop.pas:286-290  [lag comp;
 *                                              DEFERRED, see note below]
 *   2. SpriteParts.DoEulerTimeStepFor(j)    — ServerLoop.pas:292-295
 *   3. Sprite[j].Update                     — ServerLoop.pas:297-299
 *   4. Bullet[j].Update                     — ServerLoop.pas:302-304
 *   5. BulletParts.DoEulerTimeStep          — ServerLoop.pas:306
 *   6. Spark[j].Update                      — client UpdateFrame.pas:76-82
 *                                              (server has no sparks; we run them
 *                                              here so the shared spine drives the
 *                                              full client tick)
 *   7. Thing[j].Update                      — ServerLoop.pas:309-311
 *
 * Steps 2 and 3 are FUSED for sprites in this port: updateSpriteMovement
 * (sprite.ts) already calls DoEulerTimeStepFor internally before resolving
 * collision/friction (see applyGravityAndFriction). So the no-map path calls
 * updateSpriteMovement alone (NOT a second DoEulerTimeStepFor — that would
 * double-integrate). The map path runs DoEulerTimeStepFor explicitly and then
 * collideSpriteAgainstMap (which does the pushout but does NOT integrate),
 * matching the engine's integrate-then-collide split.
 *
 * Periodic ServerLoop maintenance (bonus spawns, flag cleanup, mode scoring,
 * timers, network sends) is NOT part of this entity-physics spine and is
 * DEFERRED to higher-level game-mode/network layers. This module advances the
 * deterministic physics core only.
 */
import type { World } from './world';
import type { BulletGun } from './entities/bullet';
import { updateSpriteMovement, collideSpriteAgainstMap } from './entities/sprite';
import { updateBullet } from './entities/bullet';
import { updateSpark } from './entities/spark';
import { updateThing } from './entities/thing';
import { getGun, WeaponIndex } from './weapons/guns';
import { MAX_SPRITES, MAX_BULLETS, MAX_SPARKS, MAX_THINGS } from './constants';

export interface StepOptions {
  /**
   * World Y of the flat-floor collision stand-in used when world.map is null.
   * PORT: M2 sprite path (updateSpriteMovement floorY argument). When a PolyMap
   * is loaded this is ignored and collideSpriteAgainstMap is used instead.
   * Defaults to Number.POSITIVE_INFINITY (no floor) so a free-fall trajectory is
   * never clipped unless a floor is explicitly requested.
   */
  floorY?: number;
  /**
   * Sprite collision radius for the PolyMap path (collideSpriteAgainstMap).
   * Only used when world.map is non-null. PORT: Sprites.pas skeleton radius
   * (full multi-point port pending; the M3 approximation collides the COM).
   */
  spriteRadius?: number;
  /**
   * Whether to resolve bullet guns from the REALISTIC stat table. PORT: the
   * server resolves Guns[...] from the active mode; bullets need their owning
   * gun's stat block for damage/degradation. Defaults to false (NORMAL table).
   */
  realistic?: boolean;
}

/**
 * num → Gun lookup, built lazily from the weapon tables. A Bullet stores its
 * owning weapon's TGun.Num (bullet.ownerWeapon, Bullets.pas:183), but getGun is
 * keyed by WeaponIndex (the array slot), and Num != Index for the
 * secondary/bonus weapons (see WeaponNum QUIRK in guns.ts). We resolve once per
 * (realistic) table by scanning every WeaponIndex and mapping gun.num → gun.
 * Cached so step has no per-tick allocation.
 */
const numToGunCache: Map<boolean, Map<number, BulletGun>> = new Map();

function gunByNum(num: number, realistic: boolean): BulletGun | undefined {
  let table = numToGunCache.get(realistic);
  if (table === undefined) {
    table = new Map<number, BulletGun>();
    for (const index of Object.values(WeaponIndex)) {
      const gun = getGun(index, realistic);
      // A resolved Gun structurally satisfies BulletGun (timeout/bulletStyle/
      // num/bulletSpeed/push + GunModifiers). First writer wins on num clashes.
      if (!table.has(gun.num)) {
        table.set(gun.num, gun);
      }
    }
    numToGunCache.set(realistic, table);
  }
  return table.get(num);
}

/**
 * Run ONE 60 Hz simulation tick over all active entities, in UpdateFrame order.
 *
 * PORT: server/ServerLoop.pas:270-311 (UpdateFrame entity sub-steps).
 */
export function stepWorld(world: World, opts?: StepOptions): void {
  // --- Tick counters (ServerLoop.pas:43-49 / tick-pipeline.md §Tick Increment)
  // AppOnIdle increments ticks + MainTickCounter once per simulated tick, with
  // MainTickCounter wrapping at 2147483640 (ServerLoop.pas:48-49).
  world.ticks += 1;
  world.serverTickCounter += 1;
  world.mainTickCounter += 1;
  if (world.mainTickCounter === 2147483640) {
    world.mainTickCounter = 0;
  }

  const hasMap = world.map !== null;
  const floorY = opts?.floorY ?? Number.POSITIVE_INFINITY;
  const spriteRadius = opts?.spriteRadius ?? 0;
  const realistic = opts?.realistic ?? false;

  // --- (2)+(3) Sprite particle integration + Sprite.Update -------------------
  // PORT: ServerLoop.pas:292-299. updateSpriteMovement fuses DoEulerTimeStepFor
  // with the Update (integrate -> collide -> friction -> read control). With a
  // PolyMap loaded we instead integrate explicitly then push out via
  // collideSpriteAgainstMap (which does NOT integrate), preserving the engine's
  // integrate-then-collide ordering without double-integrating.
  for (let j = 1; j <= MAX_SPRITES; j++) {
    const sprite = world.sprites[j];
    if (sprite === undefined || !sprite.active) {
      continue;
    }
    if (hasMap) {
      world.spriteParts?.doEulerTimeStepFor(sprite.num);
      collideSpriteAgainstMap(world, j, spriteRadius);
    } else {
      updateSpriteMovement(world, j, floorY);
    }
  }

  // --- (4) Bullet.Update -----------------------------------------------------
  // PORT: ServerLoop.pas:302-304. Each bullet resolves its owning gun's stat
  // block by Num; an unresolvable num is skipped (no faithful behaviour exists
  // without its weapon table entry).
  for (let j = 1; j <= MAX_BULLETS; j++) {
    const bullet = world.bullets[j];
    if (bullet === undefined || !bullet.active) {
      continue;
    }
    const gun = gunByNum(bullet.ownerWeapon, realistic);
    if (gun === undefined) {
      continue;
    }
    updateBullet(world, j, gun);
  }

  // --- (5) BulletParts.DoEulerTimeStep ---------------------------------------
  // PORT: ServerLoop.pas:306. Bullets are integrated as a batch AFTER their
  // per-bullet Update (collision/timeout) has run for this tick.
  world.bulletParts?.doEulerTimeStep();

  // --- (6) Spark.Update ------------------------------------------------------
  // PORT: client/UpdateFrame.pas:76-82. Sparks are client-only in the engine;
  // we run them here so the shared spine drives a complete client tick.
  for (let j = 1; j <= MAX_SPARKS; j++) {
    const spark = world.sparks[j];
    if (spark === undefined || !spark.active) {
      continue;
    }
    updateSpark(world, j);
  }

  // --- (7) Thing.Update ------------------------------------------------------
  // PORT: ServerLoop.pas:309-311. Track A owns updateThing (physics/pickup/
  // scoring for one Thing per tick).
  for (let j = 1; j <= MAX_THINGS; j++) {
    const thing = world.things[j];
    if (thing === undefined || !thing.active) {
      continue;
    }
    updateThing(world, j);
  }
}

/**
 * Convenience: run `n` ticks back-to-back. Equivalent to calling stepWorld n
 * times with the same options.
 */
export function stepWorldN(world: World, n: number, opts?: StepOptions): void {
  for (let i = 0; i < n; i++) {
    stepWorld(world, opts);
  }
}
