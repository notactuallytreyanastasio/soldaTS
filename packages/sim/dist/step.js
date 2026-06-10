import { updateSpriteMovement, updateSpriteMovementMap } from './entities/sprite';
import { updateBullet } from './entities/bullet';
import { updateSpark } from './entities/spark';
import { updateThing } from './entities/thing';
import { getGun, WeaponIndex } from './weapons/guns';
import { MAX_SPRITES, MAX_BULLETS, MAX_SPARKS, MAX_THINGS } from './constants';
/**
 * num → Gun lookup, built lazily from the weapon tables. A Bullet stores its
 * owning weapon's TGun.Num (bullet.ownerWeapon, Bullets.pas:183), but getGun is
 * keyed by WeaponIndex (the array slot), and Num != Index for the
 * secondary/bonus weapons (see WeaponNum QUIRK in guns.ts). We resolve once per
 * (realistic) table by scanning every WeaponIndex and mapping gun.num → gun.
 * Cached so step has no per-tick allocation.
 */
const numToGunCache = new Map();
function gunByNum(num, realistic) {
    let table = numToGunCache.get(realistic);
    if (table === undefined) {
        table = new Map();
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
export function stepWorld(world, opts) {
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
            // Full map movement: integrate -> multi-point collide -> clamp -> apply
            // control (so input/jump actually drive the sprite). PORT: the M3 driver.
            updateSpriteMovementMap(world, j, spriteRadius);
        }
        else {
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
export function stepWorldN(world, n, opts) {
    for (let i = 0; i < n; i++) {
        stepWorld(world, opts);
    }
}
//# sourceMappingURL=step.js.map