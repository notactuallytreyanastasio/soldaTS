/**
 * Per-tick spine tests (Track B integration).
 *
 * Plain f64 (STRICT_F32 off): we validate the orchestration contract — that one
 * full tick advances every subsystem in UpdateFrame order — plus DETERMINISM:
 * two identically-seeded worlds driven by the same step options produce a
 * bit-identical trajectory.
 *
 *   1. initSimWorld wires the four ParticleSystems and tunes them.
 *   2. A sprite released above empty space falls DOWNWARD under gravity across N
 *      ticks (monotone +Y, since +Y is down in Soldat space).
 *   3. Tick counters increment exactly once per stepWorld.
 *   4. A second identically-seeded world reproduces the first's trajectory
 *      exactly (determinism).
 */
import { describe, it, expect } from 'vitest';
import { createWorld } from './world';
import { initSimWorld } from './setup';
import { stepWorld, stepWorldN } from './step';
import { vec2 } from './math/vec2';
import { POS_STAND } from './entities/sprite';

const SEED = 0x1234abcd;

/** Build a seeded world with one active sprite + COM particle above empty space. */
function makeWorld(startY: number) {
  const world = createWorld();
  initSimWorld(world, { seed: SEED });

  // CreateSprite uses mass 1 (Sprites.pas:323): OneOverMass = 1. Place the COM
  // particle (index == sprite num == 1) at (0, startY) with zero velocity.
  world.spriteParts!.createPart(vec2(0, startY), vec2(0, 0), 1, 1);

  const sprite = world.sprites[1]!;
  sprite.active = true;
  sprite.num = 1;
  sprite.style = 1;
  sprite.position = POS_STAND;
  sprite.direction = 1;

  return world;
}

describe('initSimWorld', () => {
  it('instantiates and configures all four particle systems', () => {
    const world = createWorld();
    expect(world.spriteParts).toBeNull();

    const returned = initSimWorld(world);
    expect(returned).toBe(world);

    expect(world.spriteParts).not.toBeNull();
    expect(world.bulletParts).not.toBeNull();
    expect(world.sparkParts).not.toBeNull();
    expect(world.thingParts).not.toBeNull();

    // Sanity: each was tuned (TimeStep set to 1 by every configure* helper).
    expect(world.spriteParts!.timeStep).toBe(1);
    expect(world.bulletParts!.timeStep).toBe(1);
    expect(world.sparkParts!.timeStep).toBe(1);

    // Gravity differs per system: bullets fall faster than sprites.
    expect(world.bulletParts!.gravity).toBeGreaterThan(world.spriteParts!.gravity);
  });

  it('reseeds world.rng deterministically when a seed is given', () => {
    const a = createWorld();
    const b = createWorld();
    initSimWorld(a, { seed: SEED });
    initSimWorld(b, { seed: SEED });
    expect(a.rng.next()).toBe(b.rng.next());
  });
});

describe('stepWorld — tick counters', () => {
  it('increments ticks / serverTickCounter / mainTickCounter once per tick', () => {
    const world = makeWorld(0);
    expect(world.ticks).toBe(0);
    expect(world.mainTickCounter).toBe(0);

    stepWorld(world);
    expect(world.ticks).toBe(1);
    expect(world.serverTickCounter).toBe(1);
    expect(world.mainTickCounter).toBe(1);

    stepWorldN(world, 9);
    expect(world.ticks).toBe(10);
    expect(world.mainTickCounter).toBe(10);
  });
});

describe('stepWorld — sprite gravity', () => {
  it('advances the sprite downward under gravity over N ticks', () => {
    const world = makeWorld(0);
    const parts = world.spriteParts!;

    // No floor (default floorY = +Infinity): pure free fall.
    let prevY = parts.posY[1]!;
    let prevVy = parts.velocityY[1]!;

    for (let tick = 0; tick < 30; tick++) {
      stepWorld(world);
      const y = parts.posY[1]!;
      const vy = parts.velocityY[1]!;
      // +Y is down; gravity must move the body strictly downward each tick.
      expect(y).toBeGreaterThan(prevY);
      // Velocity must keep increasing (accelerating fall) each tick.
      expect(vy).toBeGreaterThanOrEqual(prevVy);
      prevY = y;
      prevVy = vy;
    }

    // After 30 ticks of fall it has travelled a meaningful distance.
    expect(parts.posY[1]!).toBeGreaterThan(0);
    expect(parts.velocityY[1]!).toBeGreaterThan(0);
  });

  it('comes to rest on a flat floor when floorY is provided', () => {
    const world = makeWorld(0);
    const parts = world.spriteParts!;
    const FLOOR_Y = 100;

    stepWorldN(world, 600, { floorY: FLOOR_Y });

    expect(parts.posY[1]!).toBeCloseTo(FLOOR_Y, 4);
    expect(world.sprites[1]!.onGround).toBe(true);
    expect(Math.abs(parts.velocityY[1]!)).toBeLessThan(1e-6);
  });
});

describe('stepWorld — determinism', () => {
  it('two identically-seeded worlds produce identical trajectories', () => {
    const a = makeWorld(-200);
    const b = makeWorld(-200);

    const trajA: number[] = [];
    const trajB: number[] = [];

    for (let tick = 0; tick < 120; tick++) {
      stepWorld(a, { floorY: 100 });
      stepWorld(b, { floorY: 100 });
      trajA.push(a.spriteParts!.posY[1]!, a.spriteParts!.velocityY[1]!);
      trajB.push(b.spriteParts!.posY[1]!, b.spriteParts!.velocityY[1]!);
    }

    // Bit-identical, not merely close.
    expect(trajB).toEqual(trajA);
    expect(a.mainTickCounter).toBe(b.mainTickCounter);
  });
});
