import type { World } from '../world';
import type { Vec2 } from '../math/vec2';
import type { ParticleSystem } from '../physics/particles';
export declare const SPARK_GRAVITY: number;
export declare const SPARK_EDAMPING: number;
/**
 * Configure a ParticleSystem to act as the SparkParts system.
 * PORT: shared/Anims.pas:382-385.
 */
export declare function configureSparkParts(parts: ParticleSystem): void;
/**
 * Allocate and activate a spark. Returns the 1-based spark index, or 0 if no
 * slot was free.
 *
 * Faithful to the allocation loop (Sparks.pas:59-80): find the first slot that
 * is inactive, has Style 0, and whose paired SparkParts particle is inactive.
 * The render-only camera culling and `r_maxsparks` throttling (Sparks.pas:42-68)
 * are DEFERRED (see file header); here we scan the full 1..MAX_SPARKS range.
 *
 * PORT: shared/mechanics/Sparks.pas:35-98
 */
export declare function createSpark(world: World, sPos: Vec2, sVelocity: Vec2, sStyle: number, sOwner: number, life: number): number;
/**
 * Deactivate a spark and its paired SparkParts particle.
 * PORT: shared/mechanics/Sparks.pas:553-559.
 */
export declare function killSpark(world: World, sparkIndex: number): void;
/**
 * Advance one spark by one tick: integrate (unless NONEULER), out-of-bounds
 * kill, map-collision bounce for COLLIDABLE styles, then the Life countdown to
 * Kill.
 *
 * PORT: shared/mechanics/Sparks.pas:101-161
 *
 * DEFERRED: the screen-wobble (121-133), the smoke/iskry random child-spark
 * spawns (136-155) — all render-cvar / camera driven (see file header).
 */
export declare function updateSpark(world: World, sparkIndex: number): void;
//# sourceMappingURL=spark.d.ts.map