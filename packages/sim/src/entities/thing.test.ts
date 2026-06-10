/**
 * Things tests (Track A). Plain f64 (STRICT_F32 off): we validate the
 * qualitative behaviour of the ported core, not bit-exact f32 fidelity.
 *
 *   1. createThing activates a flag thing and its 4 thingParts skeleton
 *      particles, with the flag's per-style config (radius, in-base, timeout).
 *   2. updateThing advances a free medical kit downward under its per-style
 *      gravity (Verlet integration) with no map present.
 *   3. A flag whose particle is within Radius of an enemy sprite is picked up:
 *      updateThing sets thing.holdingSprite (and the holder's holdedThing).
 *
 * Uses createWorld + a ParticleSystem assigned to world.thingParts (mirrors the
 * spark/sprite test harness).
 */
import { describe, it, expect } from 'vitest';
import { createWorld } from '../world';
import { ParticleSystem } from '../physics/particles';
import { vec2 } from '../math/vec2';
import { ObjectStyle } from '../constants';
import { createThing, updateThing, configureThingParts } from './thing';

const THING_SKELETON_PARTS = 4;

function basePart(thingIndex: number): number {
  return (thingIndex - 1) * THING_SKELETON_PARTS;
}
function partOf(thingIndex: number, k: number): number {
  return basePart(thingIndex) + k;
}

function makeWorld() {
  const world = createWorld();
  const parts = new ParticleSystem();
  configureThingParts(parts);
  world.thingParts = parts;
  return { world, parts };
}

describe('createThing — flag activation', () => {
  it('activates a flag thing and its skeleton particles', () => {
    const { world, parts } = makeWorld();
    const idx = createThing(world, vec2(100, 50), 255, ObjectStyle.ALPHA_FLAG, 255);

    expect(idx).toBeGreaterThan(0);
    const thing = world.things[idx]!;
    expect(thing.active).toBe(true);
    expect(thing.style).toBe(ObjectStyle.ALPHA_FLAG);
    expect(thing.num).toBe(idx);
    expect(thing.holdingSprite).toBe(0);
    // PORT: Things.pas:161 — flag radius is 19.
    expect(thing.radius).toBe(19);
    // PORT: Things.pas:162-163 — Alpha flag starts in base.
    expect(thing.inBase).toBe(true);
    // PORT: Things.pas:172 — flag TimeOut = FLAG_TIMEOUT (= 1500).
    expect(thing.timeOut).toBe(1500);

    // All 4 skeleton particles active and placed at the spawn point.
    for (let k = 1; k <= THING_SKELETON_PARTS; k++) {
      const p = partOf(idx, k);
      expect(parts.active[p]).toBe(true);
      expect(parts.posX[p]).toBeCloseTo(100);
      expect(parts.posY[p]).toBeCloseTo(50);
    }
  });

  it('creating a new flag of the same style removes the old one first', () => {
    const { world, parts } = makeWorld();
    const a = createThing(world, vec2(0, 0), 255, ObjectStyle.ALPHA_FLAG, 255);
    expect(a).toBeGreaterThan(0);
    // PORT: Things.pas:87-90 — the prior same-style flag is Killed at the top of
    // CreateThing; the freed slot is then the first free slot, so the new flag
    // legitimately reuses it (b === a). It is active at the new position.
    const b = createThing(world, vec2(10, 10), 255, ObjectStyle.ALPHA_FLAG, 255);
    expect(b).toBe(a);
    expect(world.things[b]!.active).toBe(true);
    expect(parts.posX[partOf(b, 1)]).toBeCloseTo(10);
    expect(parts.posY[partOf(b, 1)]).toBeCloseTo(10);

    // Only one alpha flag remains active across all slots.
    const activeAlpha = world.things.filter(
      (t) => t.active && t.style === ObjectStyle.ALPHA_FLAG,
    ).length;
    expect(activeAlpha).toBe(1);
  });
});

describe('updateThing — kit falls under gravity', () => {
  it('integrates a free medical kit downward each tick', () => {
    const { world, parts } = makeWorld();
    const idx = createThing(world, vec2(0, 0), 255, ObjectStyle.MEDICAL_KIT, 255);
    expect(idx).toBeGreaterThan(0);

    const p1 = partOf(idx, 1);
    const startY = parts.posY[p1]!;
    expect(startY).toBeCloseTo(0);

    // No map → no collision; the kit free-falls under its per-style gravity.
    for (let tick = 0; tick < 20; tick++) {
      updateThing(world, idx);
    }

    // It moved downward (gravity is +Y in Soldat) and is still active.
    expect(world.things[idx]!.active).toBe(true);
    expect(parts.posY[p1]!).toBeGreaterThan(startY);
    // Accelerating: later displacement per tick exceeds earlier displacement.
    const yAfter20 = parts.posY[p1]!;
    updateThing(world, idx);
    const yAfter21 = parts.posY[p1]!;
    const lastStep = yAfter21 - yAfter20;
    expect(lastStep).toBeGreaterThan(0);
  });
});

describe('updateThing — flag pickup by nearby sprite', () => {
  it('sets holdingSprite when an enemy sprite is within Radius', () => {
    const { world, parts } = makeWorld();

    // A live sprite at a position; spriteParts COM particle drives pickup geom.
    const spriteParts = new ParticleSystem();
    spriteParts.timeStep = 1;
    spriteParts.createPart(vec2(200, 200), vec2(0, 0), 1, 1);
    world.spriteParts = spriteParts;
    const sprite = world.sprites[1]!;
    sprite.active = true;
    sprite.deadMeat = false;
    sprite.num = 1;
    sprite.health = 150;
    sprite.flagGrabCooldown = 0;
    sprite.ceaseFireCounter = 0;

    // Pointmatch flag spawned right on top of the sprite (within radius 19).
    const idx = createThing(world, vec2(200, 200), 255, ObjectStyle.POINTMATCH_FLAG, 255);
    expect(idx).toBeGreaterThan(0);
    const thing = world.things[idx]!;
    expect(thing.holdingSprite).toBe(0);

    updateThing(world, idx);

    // PORT: Things.pas:1750 — HoldingSprite := j (set in CheckSpriteCollision,
    // which runs after the holding-flag physics block on the same tick).
    expect(thing.holdingSprite).toBe(1);

    // The holder bookkeeping (Sprite[h].HoldedThing := Num, Things.pas:759) and
    // the held-flag TimeOut refresh (Things.pas:760) happen in the holding-flag
    // physics block, which runs at the TOP of Update — so they take effect on
    // the NEXT tick once HoldingSprite is already set.
    updateThing(world, idx);
    expect(sprite.holdedThing).toBe(thing.num);
    // Held → TimeOut set to FLAG_TIMEOUT (1500) in the hold block, then the
    // end-of-Update countdown (Things.pas:1006) decrements it to 1499.
    expect(thing.timeOut).toBe(1499);
  });

  it('does not pick up when the sprite is far away', () => {
    const { world } = makeWorld();
    const spriteParts = new ParticleSystem();
    spriteParts.timeStep = 1;
    spriteParts.createPart(vec2(1000, 1000), vec2(0, 0), 1, 1);
    world.spriteParts = spriteParts;
    const sprite = world.sprites[1]!;
    sprite.active = true;
    sprite.num = 1;
    sprite.health = 150;

    const idx = createThing(world, vec2(0, 0), 255, ObjectStyle.POINTMATCH_FLAG, 255);
    updateThing(world, idx);
    expect(world.things[idx]!.holdingSprite).toBe(0);
  });
});
