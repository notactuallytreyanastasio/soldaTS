import { ParticleSystem } from './physics/particles';
import { configureSpriteParts } from './entities/sprite';
import { configureBulletParts } from './entities/bullet';
import { configureSparkParts } from './entities/spark';
import { configureThingParts } from './entities/thing';
/**
 * Instantiate world.spriteParts / bulletParts / sparkParts / thingParts as
 * fresh ParticleSystems and configure each via its subsystem's configure*
 * helper, mirroring the per-system tuning Pascal applies at startup:
 *   - SpriteParts: TimeStep=1, Gravity=GRAV, EDamping=SPRITE_EDAMPING
 *     (Anims.pas:364-366)
 *   - BulletParts: TimeStep=1, Gravity=GRAV*2.25, EDamping=1 (Cvar.pas:228-231)
 *   - SparkParts:  TimeStep=1, Gravity=SPARK_GRAV, EDamping=SPARK_EDAMPING
 *   - ThingParts:  configured by Track A's configureThingParts
 *
 * Returns the same world for call chaining.
 *
 * PORT: shared/Game.pas (particle-system construction + per-system config).
 */
export function initSimWorld(world, opts) {
    if (opts?.seed !== undefined) {
        world.rng.reseed(opts.seed);
    }
    const spriteParts = new ParticleSystem();
    configureSpriteParts(spriteParts);
    world.spriteParts = spriteParts;
    const bulletParts = new ParticleSystem();
    configureBulletParts(bulletParts);
    world.bulletParts = bulletParts;
    const sparkParts = new ParticleSystem();
    configureSparkParts(sparkParts);
    world.sparkParts = sparkParts;
    const thingParts = new ParticleSystem();
    configureThingParts(thingParts);
    world.thingParts = thingParts;
    return world;
}
//# sourceMappingURL=setup.js.map