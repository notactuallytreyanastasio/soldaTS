/**
 * Simulation bootstrap — instantiate and configure the four ParticleSystems
 * that the per-tick spine (step.ts) integrates each frame.
 *
 * PORT: shared/Game.pas — the `SpriteParts`, `BulletParts`, `SparkParts` and
 * `ThingParts` globals are constructed once at startup and tuned with the
 * per-system TimeStep/Gravity/Damping values before any UpdateFrame runs. In
 * Pascal these live as unit `var`s wired up in Game initialisation; here they
 * hang off the World record (world.ts) and are configured by the dedicated
 * configure* helpers each subsystem exports.
 *
 * This module is DATA WIRING ONLY: it does not advance the simulation. Run a
 * tick with stepWorld (step.ts) after calling initSimWorld.
 */
import type { World } from './world';
import { ParticleSystem } from './physics/particles';
import { configureSpriteParts } from './entities/sprite';
import { configureBulletParts } from './entities/bullet';
import { configureSparkParts } from './entities/spark';
import { configureThingParts } from './entities/thing';

export interface InitSimOptions {
  /**
   * Optional deterministic seed for world.rng. The sim must never call
   * Math.random; all randomness flows through world.rng. Reseeding here makes a
   * world's entire trajectory reproducible (golden master / demos / netcode).
   * Omit to leave the world's existing rng state untouched.
   */
  seed?: number;
}

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
export function initSimWorld(world: World, opts?: InitSimOptions): World {
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
