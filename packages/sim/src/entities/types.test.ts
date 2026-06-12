/**
 * Entity record contract tests.
 *
 * types.ts is declarations-only (pure interfaces), so the testable surface is
 * the documented invariants as realized by the world factory (createWorld):
 *
 *   - Bullet.spriteCollisions models Pascal `Set of 1..32` as a length-33
 *     boolean array ([0] unused), per the types.ts:161-163 contract.
 *   - Thing.collideCount models `array[1..4] of Byte` as length-5 ([0] unused).
 *   - Every entity slot starts inactive; entity arrays are CAP+1 with the
 *     index-0 sentinel.
 *   - The Control sub-record and Vec2-typed fields are fully initialized.
 *   - Slots do not share mutable sub-objects (per-slot factory allocation).
 */
import { describe, it, expect } from 'vitest';
import { createWorld } from '../world';
import {
  MAX_SPRITES,
  MAX_BULLETS,
  MAX_THINGS,
  MAX_SPARKS,
} from '../constants';
import type { Control } from './types';

describe('entity array allocation (CAP+1, 1-based with index-0 sentinel)', () => {
  it('allocates every entity array at CAP+1', () => {
    const world = createWorld();
    expect(world.sprites).toHaveLength(MAX_SPRITES + 1);
    expect(world.bullets).toHaveLength(MAX_BULLETS + 1);
    expect(world.things).toHaveLength(MAX_THINGS + 1);
    expect(world.sparks).toHaveLength(MAX_SPARKS + 1);
  });

  it('every slot (including the index-0 sentinel) starts inactive', () => {
    const world = createWorld();
    expect(world.sprites.every((s) => s.active === false)).toBe(true);
    expect(world.bullets.every((b) => b.active === false)).toBe(true);
    expect(world.things.every((t) => t.active === false)).toBe(true);
    expect(world.sparks.every((s) => s.active === false)).toBe(true);
  });
});

describe('Bullet.spriteCollisions — Set of 1..32 modeled as boolean[0..32]', () => {
  it('allocates length 33 (MAX_SPRITES + 1), all false', () => {
    const world = createWorld();
    expect(MAX_SPRITES).toBe(32);
    for (const bullet of world.bullets) {
      expect(bullet.spriteCollisions).toHaveLength(33);
      expect(bullet.spriteCollisions.every((v) => v === false)).toBe(true);
    }
  });

  it('slots do not share the spriteCollisions array (per-slot allocation)', () => {
    const world = createWorld();
    world.bullets[1]!.spriteCollisions[5] = true;
    expect(world.bullets[2]!.spriteCollisions[5]).toBe(false);
    expect(world.bullets[0]!.spriteCollisions[5]).toBe(false);
  });

  it('Vec2 fields are initialized to (0,0) and not shared between slots', () => {
    const world = createWorld();
    const b1 = world.bullets[1]!;
    expect(b1.velocityPrev).toEqual({ x: 0, y: 0 });
    expect(b1.hitSpot).toEqual({ x: 0, y: 0 });
    expect(b1.initial).toEqual({ x: 0, y: 0 });

    b1.velocityPrev.x = 9;
    expect(world.bullets[2]!.velocityPrev.x).toBe(0);
    // Nor shared WITHIN a slot.
    expect(b1.hitSpot.x).toBe(0);
    expect(b1.initial.x).toBe(0);
  });
});

describe('Thing.collideCount — array[1..4] modeled as number[0..4]', () => {
  it('allocates length 5, all zero', () => {
    const world = createWorld();
    for (const thing of world.things) {
      expect(thing.collideCount).toHaveLength(5);
      expect(thing.collideCount.every((v) => v === 0)).toBe(true);
    }
  });

  it('slots do not share the collideCount array', () => {
    const world = createWorld();
    world.things[1]!.collideCount[2] = 7;
    expect(world.things[2]!.collideCount[2]).toBe(0);
  });
});

describe('Sprite.control — TControl sub-record initialization', () => {
  it('has every documented field present with its zero value', () => {
    const world = createWorld();
    const control = world.sprites[1]!.control;
    const expected: Control = {
      left: false,
      right: false,
      up: false,
      down: false,
      fire: false,
      jetpack: false,
      throwNade: false,
      changeWeapon: false,
      throwWeapon: false,
      reload: false,
      prone: false,
      flagThrow: false,
      mouseAimX: 0,
      mouseAimY: 0,
      mouseDist: 0,
    };
    expect(control).toEqual(expected);
  });

  it('control records are not shared between sprite slots', () => {
    const world = createWorld();
    world.sprites[1]!.control.fire = true;
    world.sprites[1]!.control.mouseAimX = 42;
    expect(world.sprites[2]!.control.fire).toBe(false);
    expect(world.sprites[2]!.control.mouseAimX).toBe(0);
  });
});

describe('Spark — zeroed scalar record', () => {
  it('initializes all spark fields to their zero values', () => {
    const world = createWorld();
    expect(world.sparks[1]).toEqual({
      active: false,
      num: 0,
      lifeReal: 0,
      life: 0,
      lifePrev: 0,
      style: 0,
      owner: 0,
      collideCount: 0,
    });
  });
});
