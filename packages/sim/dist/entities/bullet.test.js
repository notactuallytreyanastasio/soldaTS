/**
 * Bullet ballistics / collision / damage tests (plain f64, STRICT_F32 off).
 *
 * We assert behaviour, not bit-fidelity:
 *   1. a bullet under gravity follows the expected Euler arc for N ticks,
 *   2. a bullet whose swept path enters a floor polygon deactivates (map hit),
 *   3. damage reduces sprite health by speed * hitMultiply * hitboxModifier.
 *
 * The full pipeline (force → BulletParts.Euler → updateBullet) is exercised so
 * the test mirrors how the orchestrator drives bullets each tick.
 */
import { describe, it, expect } from 'vitest';
import { createWorld } from '../world';
import { ParticleSystem } from '../physics/particles';
import { buildPolyMap } from '../map/buildPolyMap';
import { spawnBullet, updateBullet, configureBulletParts, BULLET_GRAVITY, } from './bullet';
import { BulletStyle, getGun, WeaponIndex } from '../weapons/guns';
import { applyBulletDamage, STARTHEALTH } from '../combat/damage';
// A plain rifle-like gun stat block satisfying the BulletGun/GunModifiers contract.
const PLAIN_GUN = {
    timeout: 420,
    bulletStyle: BulletStyle.PLAIN,
    num: 3, // AK-74-ish num
    bulletSpeed: 24.6,
    push: 0.01376,
    hitMultiply: 1.004,
    modifierHead: 1.1,
    modifierChest: 0.95,
    modifierLegs: 0.85,
};
function freshWorld() {
    const world = createWorld();
    const bulletParts = new ParticleSystem();
    configureBulletParts(bulletParts);
    world.bulletParts = bulletParts;
    return { world, bulletParts };
}
describe('spawnBullet', () => {
    it('activates a slot and seeds the BulletParts particle', () => {
        const { world, bulletParts } = freshWorld();
        const i = spawnBullet(world, {
            pos: { x: 100, y: 50 },
            velocity: { x: 24.6, y: 0 },
            owner: 1,
            hitMultiply: 1.004,
            gun: PLAIN_GUN,
        });
        expect(i).toBeGreaterThan(0);
        const bullet = world.bullets[i];
        expect(bullet.active).toBe(true);
        expect(bullet.style).toBe(BulletStyle.PLAIN);
        expect(bullet.timeOut).toBe(420);
        expect(bulletParts.active[bullet.num]).toBe(true);
        expect(bulletParts.posX[bullet.num]).toBe(100);
        // velocity is stored in a Float32Array → compare with f32 tolerance.
        expect(bulletParts.velocityX[bullet.num]).toBeCloseTo(24.6, 4);
    });
});
describe('updateBullet — gravity arc', () => {
    it('follows the analytic Euler projectile arc for N ticks', () => {
        const { world, bulletParts } = freshWorld();
        // No map → no collision; bullet just integrates and counts down.
        const i = spawnBullet(world, {
            pos: { x: 0, y: 0 },
            velocity: { x: 10, y: 0 }, // horizontal launch
            owner: 1,
            hitMultiply: 1.004,
            gun: PLAIN_GUN,
        });
        const num = world.bullets[i].num;
        // Reference Euler integration matching ParticleSystem.euler with
        // gravity = BULLET_GRAVITY, mass 1, timeStep 1, eDamping 1.
        let px = 0;
        let py = 0;
        let vx = 10;
        let vy = 0;
        const g = BULLET_GRAVITY;
        const N = 30;
        for (let t = 0; t < N; t++) {
            // engine tick order: forces already 0 here (plain), integrate, then update.
            bulletParts.doEulerTimeStepFor(num);
            updateBullet(world, i, PLAIN_GUN);
            // reference: forceY += g; v += force*oom*ts^2; p += v
            vy = vy + g;
            px = px + vx;
            py = py + vy;
            // velocity *= eDamping (1) → unchanged
        }
        expect(bulletParts.posX[num]).toBeCloseTo(px, 4);
        expect(bulletParts.posY[num]).toBeCloseTo(py, 4);
        expect(bulletParts.velocityY[num]).toBeCloseTo(vy, 4);
        // Horizontal velocity is unchanged (no drag).
        expect(bulletParts.velocityX[num]).toBeCloseTo(10, 6);
        // Arc curves downward (screen-space +y is down): py grows, monotone vy.
        expect(py).toBeGreaterThan(0);
        // timeout counted down N ticks.
        expect(world.bullets[i].timeOut).toBe(420 - N);
    });
});
// ---------------------------------------------------------------------------
// Floor map: ONE large triangle spanning x∈[-1000,1000] with its top edge at
// y=100, so any bullet whose position drops to y>=100 inside that x-range is
// inside the polygon and registers a map collision.
//
//   A=(-1000,100)  B=(1000,100)
//                  \
//   C=(0,2000)   (a wide downward triangle; top edge A->B is the floor)
// ---------------------------------------------------------------------------
const FLOOR_DIV = 50;
const FLOOR_N = 60;
function floorMap() {
    const A = { x: -1000, y: 100 };
    const B = { x: 1000, y: 100 };
    const C = { x: 0, y: 2000 };
    const dim = 2 * FLOOR_N + 1;
    const sectors = Array.from({ length: dim * dim }, () => ({ polys: [] }));
    // Register poly 1 in every sector cell it could be queried from (the whole
    // grid — simplest and correct for a single-poly test map).
    for (let k = 0; k < sectors.length; k++) {
        sectors[k].polys.push(1);
    }
    return {
        sectorsDivision: FLOOR_DIV,
        sectorsNum: FLOOR_N,
        polygons: [
            {
                vertices: [
                    { x: A.x, y: A.y },
                    { x: B.x, y: B.y },
                    { x: C.x, y: C.y },
                ],
                // inward normals (toward interior, i.e. downward for the top edge).
                normals: [
                    { x: 0, y: 1, z: 0 }, // edge1 A->B top; inward = +y (down)
                    { x: -1, y: 0, z: 0 }, // edge2 B->C
                    { x: 1, y: 0, z: 0 }, // edge3 C->A
                ],
                polyType: 0, // POLY_TYPE_NORMAL
            },
        ],
        sectors,
    };
}
describe('updateBullet — map collision', () => {
    it('deactivates when the bullet enters a floor polygon', () => {
        const { world, bulletParts } = freshWorld();
        world.map = buildPolyMap(floorMap());
        // Fire straight down from above the floor toward y=100.
        const i = spawnBullet(world, {
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 30 },
            owner: 1,
            hitMultiply: 1.004,
            gun: PLAIN_GUN,
        });
        const num = world.bullets[i].num;
        let collided = false;
        for (let t = 0; t < 20; t++) {
            bulletParts.doEulerTimeStepFor(num);
            updateBullet(world, i, PLAIN_GUN);
            if (!world.bullets[i].active) {
                collided = true;
                break;
            }
        }
        expect(collided).toBe(true);
        expect(world.bullets[i].active).toBe(false);
        expect(bulletParts.active[num]).toBe(false);
        // It should have died at/just past the floor (y >= 100), not earlier.
        expect(bulletParts.posY[num]).toBeGreaterThanOrEqual(100 - 30);
    });
    it('does NOT collide when there is no map', () => {
        const { world, bulletParts } = freshWorld();
        const i = spawnBullet(world, {
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 30 },
            owner: 1,
            hitMultiply: 1.004,
            gun: PLAIN_GUN,
        });
        const num = world.bullets[i].num;
        for (let t = 0; t < 20; t++) {
            bulletParts.doEulerTimeStepFor(num);
            updateBullet(world, i, PLAIN_GUN);
        }
        expect(world.bullets[i].active).toBe(true);
    });
});
describe('applyBulletDamage', () => {
    it('reduces health by speed * hitMultiply * chest modifier (torso hit)', () => {
        const { world, bulletParts } = freshWorld();
        // Victim sprite at index 2.
        const victim = world.sprites[2];
        victim.active = true;
        victim.health = 150;
        victim.deadMeat = false;
        // Spawn a bullet whose live velocity is a known speed.
        const i = spawnBullet(world, {
            pos: { x: 0, y: 0 },
            velocity: { x: 20, y: 0 }, // speed = 20
            owner: 1,
            hitMultiply: 1.5,
            gun: PLAIN_GUN,
        });
        const num = world.bullets[i].num;
        // Force the live BulletParts velocity to a clean 20 (spawn already did).
        bulletParts.velocityX[num] = 20;
        bulletParts.velocityY[num] = 0;
        const where = 10; // torso → modifierChest = 0.95
        const expected = 20 * 1.5 * 0.95; // 28.5
        const hm = applyBulletDamage(world, i, 2, where, PLAIN_GUN);
        expect(hm).toBeCloseTo(expected, 4);
        expect(victim.health).toBeCloseTo(150 - expected, 4);
        expect(victim.deadMeat).toBe(false);
    });
    it('head hit uses the head modifier and overkill marks deadMeat', () => {
        const { world, bulletParts } = freshWorld();
        const victim = world.sprites[3];
        victim.active = true;
        victim.health = 10;
        const i = spawnBullet(world, {
            pos: { x: 0, y: 0 },
            velocity: { x: 30, y: 0 },
            owner: 1,
            hitMultiply: 2,
            gun: PLAIN_GUN,
        });
        const num = world.bullets[i].num;
        bulletParts.velocityX[num] = 30;
        bulletParts.velocityY[num] = 0;
        // Where = 12 → head modifier 1.1. damage = 30 * 2 * 1.1 = 66 > 10 → dead.
        const hm = applyBulletDamage(world, i, 3, 12, PLAIN_GUN);
        expect(hm).toBeCloseTo(66, 4);
        expect(victim.deadMeat).toBe(true);
        expect(victim.health).toBeLessThan(1);
    });
});
describe('applyBulletDamage — onBulletHit observer (cosmetic blood FX hook)', () => {
    function hitSetup(health) {
        const { world, bulletParts } = freshWorld();
        const victim = world.sprites[2];
        victim.active = true;
        victim.health = health;
        const i = spawnBullet(world, {
            pos: { x: 40, y: 60 }, // updateBullet moves the bullet to the hit point;
            velocity: { x: 20, y: 0 }, // here the spawn pos stands in for it.
            owner: 1,
            hitMultiply: 1.5,
            gun: PLAIN_GUN,
        });
        const num = world.bullets[i].num;
        bulletParts.velocityX[num] = 20;
        bulletParts.velocityY[num] = 0;
        return { world, i };
    }
    it('reports victim, hit point, bullet velocity, damage and fatal=false', () => {
        const { world, i } = hitSetup(150);
        const calls = [];
        world.onBulletHit = (...args) => {
            calls.push(args);
        };
        const hm = applyBulletDamage(world, i, 2, 10, PLAIN_GUN);
        expect(calls).toHaveLength(1);
        const [victim, x, y, vx, vy, damage, fatal] = calls[0];
        expect(victim).toBe(2);
        expect(x).toBe(40);
        expect(y).toBe(60);
        expect(vx).toBeCloseTo(20, 4);
        expect(vy).toBeCloseTo(0, 4);
        expect(damage).toBeCloseTo(hm, 6);
        expect(fatal).toBe(false);
    });
    it('flags fatal=true exactly on the killing hit', () => {
        const { world, i } = hitSetup(10); // any torso hit kills
        const fatals = [];
        world.onBulletHit = (_v, _x, _y, _vx, _vy, _dmg, fatal) => {
            fatals.push(fatal);
        };
        applyBulletDamage(world, i, 2, 10, PLAIN_GUN);
        expect(fatals).toEqual([true]);
        // A hit on the already-dead body is NOT fatal again.
        applyBulletDamage(world, i, 2, 10, PLAIN_GUN);
        expect(fatals).toEqual([true, false]);
    });
    it('is a no-op when the hook is null (headless determinism path)', () => {
        const { world, i } = hitSetup(150);
        expect(world.onBulletHit).toBeNull();
        expect(() => applyBulletDamage(world, i, 2, 10, PLAIN_GUN)).not.toThrow();
    });
});
// ---------------------------------------------------------------------------
// Barrett (goal node 382): distance-degradation exemption + one-hit kill.
//
// The Pascal degradation rule (Bullets.pas:638-665) halves hitMultiply past
// 500 px and again past 900 px — but EXEMPTS BARRETT/M79/KNIFE/LAW by weapon
// num. These tests prove the port's exemption with the REAL contract gun
// (getGun(WeaponIndex.BARRETT)): a Barrett round keeps its full 4.45 across
// the map, and a torso hit one-shots a full-health (150 hp) soldier at point
// blank AND past 900 px. AK rounds still degrade exactly as before.
//
// OHK math: damage = |v| * hitMultiply * modifierChest = 55 * 4.45 * 1.0
//         = 244.75 >= 150 (minimum hitMultiply for OHK at speed 55: 150/55
//         ≈ 2.73 — the contract's 4.45 clears it with 63% margin).
// Gravity is zeroed test-locally so the flight path is exactly horizontal;
// the exemption itself is a pure function of travel distance, not gravity.
// ---------------------------------------------------------------------------
const BARRETT_GUN = getGun(WeaponIndex.BARRETT, false);
function sniperWorld(victimX) {
    const { world, bulletParts } = freshWorld();
    bulletParts.gravity = 0; // flat flight for exact distances (test-local)
    if (victimX !== undefined) {
        const spriteParts = new ParticleSystem();
        world.spriteParts = spriteParts;
        spriteParts.createPart({ x: victimX, y: 0 }, { x: 0, y: 0 }, 1, 2);
        const victim = world.sprites[2];
        victim.active = true;
        victim.num = 2;
        victim.health = STARTHEALTH;
        victim.deadMeat = false;
    }
    return { world, bulletParts };
}
function fireBarrett(world) {
    return spawnBullet(world, {
        pos: { x: 0, y: 0 },
        velocity: { x: BARRETT_GUN.bulletSpeed, y: 0 }, // 55 px/tick, horizontal
        owner: 1,
        hitMultiply: BARRETT_GUN.hitMultiply, // contract 4.45
        gun: BARRETT_GUN,
    });
}
describe('Barrett distance-degradation exemption (DEGRADATION_EXEMPT_NUMS)', () => {
    it('keeps full hitMultiply past 500 AND 900 px (degradeCount stays 0)', () => {
        const { world, bulletParts } = sniperWorld();
        const i = fireBarrett(world);
        const num = world.bullets[i].num;
        for (let t = 0; t < 24; t++) {
            // 24 ticks * 55 = 1320 px — past both thresholds
            bulletParts.doEulerTimeStepFor(num);
            updateBullet(world, i, BARRETT_GUN);
        }
        const b = world.bullets[i];
        expect(b.active).toBe(true);
        expect(bulletParts.posX[num]).toBeGreaterThan(900);
        expect(b.degradeCount).toBe(0);
        expect(b.hitMultiply).toBeCloseTo(BARRETT_GUN.hitMultiply, 6);
    });
    it('control: an AK74 round still degrades (x0.5 past 500, x0.25 past 900)', () => {
        const { world, bulletParts } = sniperWorld();
        const i = spawnBullet(world, {
            pos: { x: 0, y: 0 },
            velocity: { x: 55, y: 0 }, // same trajectory, non-exempt num 3
            owner: 1,
            hitMultiply: PLAIN_GUN.hitMultiply,
            gun: PLAIN_GUN,
        });
        const num = world.bullets[i].num;
        for (let t = 0; t < 24; t++) {
            bulletParts.doEulerTimeStepFor(num);
            updateBullet(world, i, PLAIN_GUN);
        }
        const b = world.bullets[i];
        expect(b.degradeCount).toBe(2);
        expect(b.hitMultiply).toBeCloseTo(PLAIN_GUN.hitMultiply * 0.25, 6);
    });
    it('one-hit-kills a full-health soldier at point blank (torso)', () => {
        const { world, bulletParts } = sniperWorld(60);
        const i = fireBarrett(world);
        const num = world.bullets[i].num;
        for (let t = 0; t < 5 && world.bullets[i].active; t++) {
            bulletParts.doEulerTimeStepFor(num);
            updateBullet(world, i, BARRETT_GUN);
        }
        const victim = world.sprites[2];
        expect(world.bullets[i].active).toBe(false); // round spent on the hit
        expect(victim.deadMeat).toBe(true);
        expect(victim.health).toBeLessThan(1); // 150 - 244.75
    });
    it('one-hit-kills at 935 px — the exemption preserves the OHK cross-map', () => {
        const { world, bulletParts } = sniperWorld(935);
        const i = fireBarrett(world);
        const num = world.bullets[i].num;
        let hitTick = -1;
        for (let t = 0; t < 30 && world.bullets[i].active; t++) {
            bulletParts.doEulerTimeStepFor(num);
            updateBullet(world, i, BARRETT_GUN);
            hitTick = t;
        }
        const victim = world.sprites[2];
        expect(world.bullets[i].active).toBe(false);
        expect(hitTick).toBeGreaterThan(12); // travelled > 700 px before impact
        expect(victim.deadMeat).toBe(true);
        expect(victim.health).toBeLessThan(1);
    });
    it('control: the same AK74 shot at 935 px does NOT one-hit-kill', () => {
        const { world, bulletParts } = sniperWorld(935);
        const i = spawnBullet(world, {
            pos: { x: 0, y: 0 },
            velocity: { x: 55, y: 0 },
            owner: 1,
            hitMultiply: PLAIN_GUN.hitMultiply,
            gun: PLAIN_GUN,
        });
        const num = world.bullets[i].num;
        for (let t = 0; t < 30 && world.bullets[i].active; t++) {
            bulletParts.doEulerTimeStepFor(num);
            updateBullet(world, i, PLAIN_GUN);
        }
        const victim = world.sprites[2];
        // Degraded: 55 * (1.004 * 0.5) * 0.95 ≈ 26.2 — a scratch, not a kill.
        expect(victim.deadMeat).toBe(false);
        expect(victim.health).toBeGreaterThan(100);
    });
});
//# sourceMappingURL=bullet.test.js.map