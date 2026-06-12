// Hydra brain unit tests — the cut-head rotation, pinned against hand-built
// worlds: shared-focus determinism across heads, the ROTATE_BELOW anchor
// withdrawal and its ANCHOR_MIN/MAX band (with ANCHOR_FIRE_MAX trigger
// discipline), bearing-slot geometry for 1/4 fronts with HIGH_OFF on and off,
// the shared FOCUS_RETARGET clock, and the in-slot juke-vs-bob switch.
//
// Worlds are real sim worlds (createWorld + initSimWorld, map null so line of
// sight is always clear); only positions/health/ammo are staged.

import { describe, it, expect } from 'vitest';
import {
  buildWaypoints,
  createWorld,
  initSimWorld,
  type World,
} from '@soldat/sim';
import { createHydraEngine } from './hydra';
import type { BotEngineContext } from './engine';

interface BotSpec {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  team?: number;
  health?: number;
  jets?: number;
}

function makeWorld(seed = 7): World {
  return initSimWorld(createWorld(), { seed });
}

function addBot(world: World, i: number, spec: BotSpec): void {
  const s = world.sprites[i]!;
  s.active = true;
  s.deadMeat = false;
  s.alpha = 255;
  s.team = spec.team ?? 0;
  s.health = spec.health ?? 150;
  s.jetsCount = spec.jets ?? 1000;
  const p = world.spriteParts!;
  p.posX[i] = spec.x;
  p.posY[i] = spec.y;
  p.velocityX[i] = spec.vx ?? 0;
  p.velocityY[i] = spec.vy ?? 0;
}

interface CtxOpts {
  ammo?: Record<number, number>;
  reloading?: Record<number, boolean>;
}

function makeCtx(world: World, opts: CtxOpts = {}): BotEngineContext {
  return {
    world,
    graph: buildWaypoints({ waypoints: [] }),
    spawns: [{ x: 0, y: 0 }],
    spectate: true,
    ammoOf: (i: number): number => opts.ammo?.[i] ?? 30,
    reloadingOf: (i: number): boolean => opts.reloading?.[i] ?? false,
    magSize: 30,
  };
}

function newBrain(tweaks?: Record<string, number>) {
  return createHydraEngine(tweaks).createBrain();
}

describe('hydra: one mind, many heads (shared focus)', () => {
  it('every head independently aims at the lowest-health enemy', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0, team: 1 });
    addBot(world, 2, { x: 60, y: 0, team: 1 });
    addBot(world, 3, { x: 400, y: -10, team: 2, health: 150 });
    addBot(world, 4, { x: 460, y: 0, team: 2, health: 80 }); // the wounded one
    const ctx = makeCtx(world);
    newBrain().tick(1, ctx);
    newBrain().tick(2, ctx);
    // Both heads converge on enemy 4 — aim is exactly (focusX − headX) for
    // stationary targets (drop only shifts Y).
    expect(world.sprites[1]!.control.mouseAimX).toBe(460);
    expect(world.sprites[2]!.control.mouseAimX).toBe(400);
  });

  it('re-evaluates the focus only on the shared FOCUS_RETARGET clock', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0, team: 1 });
    addBot(world, 2, { x: 60, y: 0, team: 1 });
    addBot(world, 3, { x: 400, y: 0, team: 2, health: 150 });
    addBot(world, 4, { x: 460, y: 0, team: 2, health: 80 });
    const ctx = makeCtx(world);
    const c = world.sprites[1]!.control;
    const brain = newBrain();

    world.mainTickCounter = 1;
    brain.tick(1, ctx); // initial pick (focus was 0): enemy 4
    expect(c.mouseAimX).toBe(460);

    world.sprites[3]!.health = 10; // a weaker enemy appears mid-window
    world.mainTickCounter = 2; // not a retarget tick → focus is sticky
    brain.tick(1, ctx);
    expect(c.mouseAimX).toBe(460);

    world.mainTickCounter = 30; // retarget tick → the pack phases together
    brain.tick(1, ctx);
    expect(c.mouseAimX).toBe(400);
  });
});

describe('hydra: the cut head withdraws (anchor)', () => {
  it('the head under ROTATE_BELOW flees the enemy centroid while fresh heads fight', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0, team: 1, health: 40 }); // < ROTATE_BELOW 55
    addBot(world, 2, { x: 60, y: 0, team: 1 });
    addBot(world, 3, { x: 400, y: -10, team: 2 });
    addBot(world, 4, { x: 460, y: 0, team: 2, health: 80 });
    const ctx = makeCtx(world);
    newBrain().tick(1, ctx);
    newBrain().tick(2, ctx);
    // Anchor: enemy centroid ≈ (430, −5), d ≈ 430 < ANCHOR_MIN 600 → run.
    expect(world.sprites[1]!.control.left).toBe(true);
    expect(world.sprites[1]!.control.right).toBe(false);
    // The fresh head walks its bearing slot instead (toward 460−340=120).
    expect(world.sprites[2]!.control.right).toBe(true);
  });

  it('plants in the ANCHOR band, bobs, and holds fire beyond ANCHOR_FIRE_MAX', () => {
    const world = makeWorld();
    addBot(world, 1, { x: -300, y: 0, team: 1, health: 40 }); // d ≈ 730 ∈ [600,760]
    addBot(world, 2, { x: 60, y: 0, team: 1 });
    addBot(world, 3, { x: 400, y: -10, team: 2 });
    addBot(world, 4, { x: 460, y: 0, team: 2, health: 80 });
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world));
    expect(c.left).toBe(false);
    expect(c.right).toBe(false);
    expect(c.jetpack).toBe(true); // the planted bob's opening jet pulse
    // Focus (enemy 4) is 760 px out > ANCHOR_FIRE_MAX 700: aim yes, fire no.
    expect(c.fire).toBe(false);
  });

  it('drifts back toward the fight beyond ANCHOR_MAX', () => {
    const world = makeWorld();
    addBot(world, 1, { x: -400, y: 0, team: 1, health: 40 }); // d ≈ 830 > 760
    addBot(world, 2, { x: 60, y: 0, team: 1 });
    addBot(world, 3, { x: 400, y: -10, team: 2 });
    addBot(world, 4, { x: 460, y: 0, team: 2 });
    newBrain().tick(1, makeCtx(world));
    expect(world.sprites[1]!.control.right).toBe(true);
  });

  it('a lone wounded head has nowhere to rotate: it keeps fighting (FFA)', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0, health: 40 }); // FFA, no pack
    addBot(world, 2, { x: 400, y: 0 });
    newBrain().tick(1, makeCtx(world));
    // Engage path: walks toward its slot (400−340=60), no withdrawal.
    expect(world.sprites[1]!.control.right).toBe(true);
    expect(world.sprites[1]!.control.left).toBe(false);
  });
});

describe('hydra: bearing slots', () => {
  it('with HIGH_OFF=0 (default) four fronts split evenly left/right by position', () => {
    const world = makeWorld();
    addBot(world, 1, { x: -500, y: 0, team: 1 });
    addBot(world, 2, { x: -450, y: 0, team: 1 });
    addBot(world, 3, { x: 450, y: 0, team: 1 });
    addBot(world, 4, { x: 500, y: 0, team: 1 });
    addBot(world, 5, { x: 0, y: 0, team: 2 });
    const ctx = makeCtx(world);
    for (const i of [1, 2, 3, 4]) newBrain().tick(i, ctx);
    // Left pair converges in toward −340, right pair toward +340 — nobody
    // crosses through the prey.
    expect(world.sprites[1]!.control.right).toBe(true);
    expect(world.sprites[2]!.control.right).toBe(true);
    expect(world.sprites[3]!.control.left).toBe(true);
    expect(world.sprites[4]!.control.left).toBe(true);
  });

  it('with HIGH_OFF>0 and 3 fronts, the highest-index head takes the top slot and climbs', () => {
    const world = makeWorld();
    addBot(world, 1, { x: -400, y: 0, team: 1 });
    addBot(world, 2, { x: 400, y: 0, team: 1 });
    addBot(world, 3, { x: 300, y: 0, team: 1 }); // highest index → top slot
    addBot(world, 4, { x: 0, y: 0, team: 2 });
    const ctx = makeCtx(world);
    const tweaks = { HIGH_OFF: 200 };
    newBrain(tweaks).tick(1, ctx);
    newBrain(tweaks).tick(3, ctx);
    // The top head's slot is directly over the focus, 200 px up: it moves
    // toward x=0 AND jets to buy the altitude.
    expect(world.sprites[3]!.control.left).toBe(true);
    expect(world.sprites[3]!.control.jetpack).toBe(true);
    // A side head at height parity does not jet for its slot.
    expect(world.sprites[1]!.control.jetpack).toBe(false);
    expect(world.sprites[1]!.control.right).toBe(true);
  });

  it('in-slot heads bob by default (JUKE_MIN_TICKS=0) and strafe-juke when tweaked', () => {
    // FFA head planted exactly in its left slot (tx − BEARING_OFF).
    const bob = makeWorld();
    addBot(bob, 1, { x: 0, y: 0 });
    addBot(bob, 2, { x: 340, y: 0 });
    newBrain().tick(1, makeCtx(bob));
    expect(bob.sprites[1]!.control.left).toBe(false);
    expect(bob.sprites[1]!.control.right).toBe(false);
    expect(bob.sprites[1]!.control.jetpack).toBe(true); // the bob pulse

    const juke = makeWorld();
    addBot(juke, 1, { x: 0, y: 0 });
    addBot(juke, 2, { x: 340, y: 0 });
    newBrain({ JUKE_MIN_TICKS: 10 }).tick(1, makeCtx(juke));
    const c = juke.sprites[1]!.control;
    expect(c.left !== c.right).toBe(true); // strafing one way
    expect(c.jetpack).toBe(false); // the bob is off in juke mode
  });
});
