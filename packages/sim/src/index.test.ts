/**
 * Barrel-export tests for @soldat/sim (index.ts).
 *
 * No logic lives here — we pin the public API surface: the names downstream
 * packages (client, server, netcode) import must exist, be the same bindings
 * as the underlying modules, and compose in the documented usage pattern.
 */
import { describe, it, expect } from 'vitest';
import * as sim from './index';
import { vec2, normalize } from './math/vec2';
import { f, f32, EPSILON } from './scalar';
import { Rng } from './rng';
import { createWorld } from './world';
import { initSimWorld } from './setup';
import { stepWorld } from './step';
import { ParticleSystem } from './physics/particles';
import { MAX_SPRITES, MAX_BULLETS } from './constants';

describe('public API surface (spot checks)', () => {
  it('exports the math layer', () => {
    expect(typeof sim.vec2).toBe('function');
    expect(typeof sim.normalize).toBe('function');
    expect(typeof sim.distance).toBe('function');
    expect(typeof sim.pointLineDistance).toBe('function');
  });

  it('exports the scalar policy', () => {
    expect(typeof sim.f).toBe('function');
    expect(typeof sim.f32).toBe('function');
    expect(typeof sim.STRICT_F32).toBe('boolean');
    expect(sim.EPSILON).toBe(1e-4);
  });

  it('exports the world / rng / setup / step spine', () => {
    expect(typeof sim.createWorld).toBe('function');
    expect(typeof sim.Rng).toBe('function');
    expect(typeof sim.initSimWorld).toBe('function');
    expect(typeof sim.stepWorld).toBe('function');
    expect(typeof sim.ParticleSystem).toBe('function');
  });

  it('exports the OpenSoldat hard caps', () => {
    expect(sim.MAX_SPRITES).toBe(32);
    expect(sim.MAX_BULLETS).toBe(254);
  });

  it('has no default export (pure named-export barrel)', () => {
    expect((sim as Record<string, unknown>)['default']).toBeUndefined();
  });
});

describe('re-exports are the same bindings as the sub-modules', () => {
  it('math/vec2', () => {
    expect(sim.vec2).toBe(vec2);
    expect(sim.normalize).toBe(normalize);
  });

  it('scalar', () => {
    expect(sim.f).toBe(f);
    expect(sim.f32).toBe(f32);
    expect(sim.EPSILON).toBe(EPSILON);
  });

  it('rng / world / setup / step / physics / constants', () => {
    expect(sim.Rng).toBe(Rng);
    expect(sim.createWorld).toBe(createWorld);
    expect(sim.initSimWorld).toBe(initSimWorld);
    expect(sim.stepWorld).toBe(stepWorld);
    expect(sim.ParticleSystem).toBe(ParticleSystem);
    expect(sim.MAX_SPRITES).toBe(MAX_SPRITES);
    expect(sim.MAX_BULLETS).toBe(MAX_BULLETS);
  });
});

describe('common usage pattern through the barrel', () => {
  it('createWorld + initSimWorld wires a steppable world', () => {
    const world = sim.initSimWorld(sim.createWorld(), { seed: 42 });
    expect(world.spriteParts).toBeInstanceOf(sim.ParticleSystem);
    expect(world.bulletParts).toBeInstanceOf(sim.ParticleSystem);
    expect(world.sparkParts).toBeInstanceOf(sim.ParticleSystem);
    expect(world.thingParts).toBeInstanceOf(sim.ParticleSystem);
  });

  it('Rng via the barrel is deterministic for a fixed seed', () => {
    const a = new sim.Rng(7);
    const b = new sim.Rng(7);
    expect(a.next()).toBe(b.next());
    expect(a.nextInt(100)).toBe(b.nextInt(100));
  });
});
