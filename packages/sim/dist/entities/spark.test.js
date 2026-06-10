/**
 * Spark simulation tests (M4). Plain f64 (STRICT_F32 off): we validate the
 * qualitative behaviour of the ported core, not bit-exact f32 fidelity.
 *
 *   1. A spark's Life counts down one per Update and the spark deactivates
 *      (Kill) exactly when Life reaches 0 — over its full lifetime.
 *   2. A moving spark integrates its position forward each tick and accelerates
 *      downward under SparkParts gravity (GRAV / 1.4).
 *
 * Style 1 (smoke) is used: it is NOT in NONEULER_STYLE (so it integrates) and
 * NOT in COLLIDABLE_STYLE (so no map is needed for the integration test).
 */
import { describe, it, expect } from 'vitest';
import { createWorld } from '../world';
import { ParticleSystem } from '../physics/particles';
import { vec2 } from '../math/vec2';
import { createSpark, updateSpark, configureSparkParts, SPARK_GRAVITY, } from './spark';
function makeWorld() {
    const world = createWorld();
    const parts = new ParticleSystem();
    configureSparkParts(parts);
    world.sparkParts = parts;
    return { world, parts };
}
describe('createSpark', () => {
    it('activates a free slot and its paired SparkParts particle', () => {
        const { world, parts } = makeWorld();
        const idx = createSpark(world, vec2(10, 20), vec2(1, 0), 1, 1, 50);
        expect(idx).toBeGreaterThan(0);
        const spark = world.sparks[idx];
        expect(spark.active).toBe(true);
        expect(spark.style).toBe(1);
        expect(spark.life).toBe(50);
        expect(spark.num).toBe(idx);
        expect(parts.active[idx]).toBe(true);
        expect(parts.posX[idx]).toBeCloseTo(10);
        expect(parts.posY[idx]).toBeCloseTo(20);
    });
});
describe('updateSpark — Life countdown to deactivation', () => {
    it('decrements Life each tick and Kills when Life hits 0', () => {
        const { world } = makeWorld();
        const life = 30;
        const idx = createSpark(world, vec2(0, 0), vec2(0, 0), 1, 0, life);
        const spark = world.sparks[idx];
        // Each Update lowers Life by exactly 1 (Sparks.pas:158).
        for (let tick = 1; tick < life; tick++) {
            const before = spark.life;
            updateSpark(world, idx);
            expect(spark.life).toBe(before - 1);
            expect(spark.lifePrev).toBe(before);
            expect(spark.active).toBe(true); // still alive until Life = 0
        }
        // Life is now 1; the next Update brings it to 0 -> Kill (Sparks.pas:159-160).
        expect(spark.life).toBe(1);
        updateSpark(world, idx);
        expect(spark.life).toBe(0);
        expect(spark.active).toBe(false);
        expect(spark.style).toBe(0);
        expect(world.sparkParts.active[idx]).toBe(false);
    });
});
describe('updateSpark — gravity integration', () => {
    it('integrates position and accelerates downward under spark gravity', () => {
        const { world, parts } = makeWorld();
        // Style 1 integrates (not NONEULER) and does not collide (not COLLIDABLE).
        const idx = createSpark(world, vec2(0, 0), vec2(0, 0), 1, 0, 200);
        let prevY = parts.posY[idx];
        let prevVy = parts.velocityY[idx];
        for (let tick = 0; tick < 10; tick++) {
            updateSpark(world, idx);
            const y = parts.posY[idx];
            const vy = parts.velocityY[idx];
            // Falls downward (y increases) every tick once gravity has acted.
            expect(y).toBeGreaterThan(prevY);
            // Downward velocity grows under gravity (modulo EDamping < gravity gain).
            expect(vy).toBeGreaterThan(prevVy);
            prevY = y;
            prevVy = vy;
        }
        // Gravity used is the SparkParts value (GRAV / 1.4), not the sprite gravity.
        expect(SPARK_GRAVITY).toBeCloseTo(0.06 / 1.4, 6);
    });
    it('carries horizontal velocity forward (integration, not teleport)', () => {
        const { world, parts } = makeWorld();
        const idx = createSpark(world, vec2(0, 0), vec2(2, 0), 1, 0, 200);
        updateSpark(world, idx);
        // After one Euler step the particle has moved right by ~its x-velocity.
        expect(parts.posX[idx]).toBeGreaterThan(0);
    });
});
//# sourceMappingURL=spark.test.js.map