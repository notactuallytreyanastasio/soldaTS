/**
 * The world state — TS port of OpenSoldat's global game-handling arrays and
 * tick counters (the former unit-level `var` block of `shared/Game.pas`).
 *
 * PORT: shared/Game.pas:114-119 — the four 1-based fixed entity arrays:
 *   Sprite: array[1..MAX_SPRITES] of TSprite;   (Game.pas:114)
 *   Bullet: array[1..MAX_BULLETS] of TBullet;    (Game.pas:115)
 *   Spark:  array[1..MAX_SPARKS]  of TSpark;     (Game.pas:117, client-only)
 *   Thing:  array[1..MAX_THINGS]  of TThing;     (Game.pas:119)
 *
 * INDEXING CONTRACT (docs/rewrite-reference/global-state-and-caps.md §3):
 * 1-based with index 0 reserved as an unused sentinel. We model each array with
 * length CAP+1 so that valid indices are exactly 1..CAP and slot 0 is never a
 * live entity. Game.pas:111-113 warns explicitly against making these 0-based.
 *
 * This module holds DATA ONLY. It does not implement physics or the particle
 * subsystem; those live elsewhere and are referenced here as placeholder types.
 */
import type { Sprite, Bullet, Spark, Thing } from './entities/types';
import type { ParticleSystem } from './physics/particles';
import type { PolyMap } from './map/polymap';
import { Rng } from './rng';
export interface World {
    sprites: Sprite[];
    bullets: Bullet[];
    things: Thing[];
    sparks: Spark[];
    mainTickCounter: number;
    serverTickCounter: number;
    clientTickCount: number;
    ticks: number;
    map: PolyMap | null;
    spriteParts: ParticleSystem | null;
    bulletParts: ParticleSystem | null;
    sparkParts: ParticleSystem | null;
    thingParts: ParticleSystem | null;
    rng: Rng;
    /**
     * Optional damage observer: (victim, attacker, amount) after each health
     * hit lands (attacker 0 = unattributed). Notification ONLY — observers must
     * never mutate the world, or determinism dies. Used by match telemetry.
     */
    onDamage: ((victim: number, attacker: number, amount: number) => void) | null;
    /**
     * Optional bullet-impact observer: (victim, hit point x/y, bullet velocity
     * vx/vy, damage dealt, fatal) after a bullet body hit lands. Notification
     * ONLY — observers must never mutate the world, or determinism dies. Used by
     * the render client for cosmetic blood FX; null headlessly.
     */
    onBulletHit: ((victim: number, x: number, y: number, vx: number, vy: number, damage: number, fatal: boolean) => void) | null;
}
/**
 * Allocate a fresh world. Each entity array has length CAP+1 (index 0 = unused
 * sentinel, valid indices 1..CAP). Every slot is initialized inactive.
 */
export declare function createWorld(): World;
//# sourceMappingURL=world.d.ts.map