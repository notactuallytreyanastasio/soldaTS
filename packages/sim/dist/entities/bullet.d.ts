import type { World } from '../world';
import type { Vec2 } from '../math/vec2';
import type { ParticleSystem } from '../physics/particles';
import { type GunModifiers } from '../combat/damage';
export declare const ARROW_RESIST: 280;
export declare const BULLET_GRAVITY: number;
export declare const PART_RADIUS: 7;
export declare const SPRITE_RADIUS: 16;
export declare const FLAME_UPWARD_FORCE: number;
/**
 * Weapons whose bullets are EXEMPT from distance degradation.
 * PORT: shared/mechanics/Bullets.pas:638-643 — the degradation branch runs only
 * when `OwnerWeapon` is none of Guns[BARRETT/M79/KNIFE/LAW].Num. Matched by the
 * bullet's `ownerWeapon` (== Gun.Num), so a BARRETT round keeps its full
 * HitMultiply past 500/900 px — the map-distance one-hit-kill survives.
 * No behaviour change for any other weapon (AK74 num 3 / SPAS12 num 5 still
 * degrade exactly as before; the other exempt nums have no shipped gun yet).
 */
export declare const DEGRADATION_EXEMPT_NUMS: ReadonlySet<number>;
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
/**
 * Configure a ParticleSystem to behave as OpenSoldat's `BulletParts`.
 *   TimeStep := 1; Gravity := GRAV * 2.25; (EDamping/VDamping unused → 1/0)
 *
 * Bullets are Euler-integrated with no velocity damping, so EDamping = 1 (the
 * Euler step multiplies velocity by EDamping each frame; 1 = no damping).
 *
 * PORT: shared/Cvar.pas:228-231 (Gravity), shared/Game.pas init of BulletParts.
 */
export declare function configureBulletParts(bulletParts: ParticleSystem): void;
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
export declare function spawnBullet(world: World, args: SpawnBulletArgs): number;
/**
 * Whether a polygon participates in bullet collision. Bullets collide with
 * everything EXCEPT only-player / doesn't-collide / flagger-restricted /
 * background polys (Bullets.pas:1125-1130). Team-coloured poly gating
 * (`TeamCollides`) is deferred — without per-sprite team data wired here we
 * treat all non-excluded polys as collidable (the common case).
 *
 * PORT: shared/mechanics/Bullets.pas:1125-1130.
 */
export declare function bulletCollidesWithPoly(polyType: number): boolean;
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
export declare function checkBulletMapCollision(world: World, bulletIndex: number): {
    hit: true;
    perp: Vec2;
    distance: number;
} | {
    hit: false;
};
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
export declare function checkSpriteCollision(world: World, bulletIndex: number): SpriteHit | null;
/**
 * Deactivate a bullet and free its particle.
 * PORT: shared/mechanics/Bullets.pas:1060-1071.
 */
export declare function killBullet(world: World, bulletIndex: number): void;
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
export declare function updateBullet(world: World, bulletIndex: number, gun: BulletGun): void;
/**
 * The styles handled by the hitscan damage branch in CheckSpriteCollision
 * (Bullets.pas:1551-1552): PLAIN, SHOTGUN, PUNCH, KNIFE, M2.
 */
export declare function isHitscanStyle(style: number): boolean;
//# sourceMappingURL=bullet.d.ts.map