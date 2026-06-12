/**
 * Direct tests for initSimWorld (setup.ts) — the data-wiring bootstrap that
 * instantiates and tunes the four ParticleSystems on a World.
 *
 * step.test.ts covers this indirectly as part of the per-tick spine; here we
 * pin the wiring contract itself: chaining, per-system tuning values
 * (Anims.pas / Cvar.pas / Things.pas), and seed semantics.
 */
import { describe, it, expect } from 'vitest';
import { createWorld } from './world';
import { initSimWorld } from './setup';
import { ParticleSystem } from './physics/particles';
import { DEFAULT_GRAVITY } from './constants';

describe('initSimWorld — wiring', () => {
  it('returns the same world object for call chaining', () => {
    const world = createWorld();
    expect(initSimWorld(world)).toBe(world);
  });

  it('instantiates all four systems as distinct ParticleSystem instances', () => {
    const world = initSimWorld(createWorld());
    const systems = [
      world.spriteParts,
      world.bulletParts,
      world.sparkParts,
      world.thingParts,
    ];
    for (const s of systems) {
      expect(s).toBeInstanceOf(ParticleSystem);
    }
    // No aliasing between systems.
    expect(new Set(systems).size).toBe(4);
  });

  it('sets timeStep = 1 on every system (per-system Pascal startup tuning)', () => {
    const world = initSimWorld(createWorld());
    expect(world.spriteParts!.timeStep).toBe(1);
    expect(world.bulletParts!.timeStep).toBe(1);
    expect(world.sparkParts!.timeStep).toBe(1);
    expect(world.thingParts!.timeStep).toBe(1); // PORT: Things.pas:124
  });

  it('gives each system its own gravity: bullets fall fastest, things defer per-thing', () => {
    const world = initSimWorld(createWorld());
    // Sprites: GRAV (Anims.pas:365 / Cvar.pas:229).
    expect(world.spriteParts!.gravity).toBe(DEFAULT_GRAVITY);
    // Bullets: GRAV * 2.25 (Cvar.pas:228-231) — strictly heavier than sprites.
    expect(world.bulletParts!.gravity).toBeGreaterThan(world.spriteParts!.gravity);
    // Sparks fall too.
    expect(world.sparkParts!.gravity).toBeGreaterThan(0);
    // Things: gravity is applied per-thing in updateThing, left 0 at setup.
    expect(world.thingParts!.gravity).toBe(0);
  });

  it('sets Euler damping per system: bullets undamped (1), things Verlet (0)', () => {
    const world = initSimWorld(createWorld());
    expect(world.bulletParts!.eDamping).toBe(1);
    expect(world.thingParts!.eDamping).toBe(0);
    // Sprites use a real damping factor strictly between 0 and 1.
    expect(world.spriteParts!.eDamping).toBeGreaterThan(0);
    expect(world.spriteParts!.eDamping).toBeLessThanOrEqual(1);
  });

  it('calling initSimWorld twice replaces all four systems with fresh instances', () => {
    const world = initSimWorld(createWorld());
    const prev = {
      sprite: world.spriteParts,
      bullet: world.bulletParts,
      spark: world.sparkParts,
      thing: world.thingParts,
    };
    initSimWorld(world);
    expect(world.spriteParts).not.toBe(prev.sprite);
    expect(world.bulletParts).not.toBe(prev.bullet);
    expect(world.sparkParts).not.toBe(prev.spark);
    expect(world.thingParts).not.toBe(prev.thing);
  });
});

describe('initSimWorld — seed semantics', () => {
  it('reseeds deterministically, including the falsy seed 0', () => {
    const a = initSimWorld(createWorld(), { seed: 0 });
    const b = initSimWorld(createWorld(), { seed: 0 });
    for (let i = 0; i < 5; i++) {
      expect(a.rng.next()).toBe(b.rng.next());
    }
  });

  it('different seeds diverge', () => {
    const a = initSimWorld(createWorld(), { seed: 1 });
    const b = initSimWorld(createWorld(), { seed: 2 });
    expect(a.rng.next()).not.toBe(b.rng.next());
  });

  it('omitting the seed leaves the rng state untouched', () => {
    // Two worlds share the default seed; advance both to an identical
    // mid-stream state, then init only one of them without a seed.
    const a = createWorld();
    const b = createWorld();
    a.rng.next();
    b.rng.next();
    initSimWorld(a);
    expect(a.rng.next()).toBe(b.rng.next());
  });

  it('omitting opts entirely behaves like omitting the seed', () => {
    const a = createWorld();
    const b = createWorld();
    initSimWorld(a);
    initSimWorld(b, {});
    expect(a.rng.next()).toBe(b.rng.next());
  });
});
