/**
 * Bot-brain tests (M5). Plain f64 (STRICT_F32 off): we validate the qualitative
 * decisions of the ported brain — perception, combat aim/fire, and waypoint
 * navigation — not bit-exact f32 fidelity.
 *
 * world.rng is reseeded for determinism so the accuracy jitter and the
 * probabilistic fire bands (DIST_VERY_FAR/TOO_FAR) are reproducible.
 *
 * Scenarios:
 *   1. An enemy directly to the bot's right, in close range, yields aim toward
 *      +x (mouseAimX > bot.x) and control.fire.
 *   2. An enemy directly to the right produces rightward facing intent.
 *   3. With no enemy in sight, a navigation waypoint to the right sets
 *      control.right toward it.
 */
import { describe, it, expect } from 'vitest';
import { createWorld } from '../world';
import { ParticleSystem } from '../physics/particles';
import { vec2 } from '../math/vec2';
import { WaypointGraph, type Waypoint } from './waypoints';
import {
  updateBot,
  createBotState,
  checkDistance,
  DIST_TOO_CLOSE,
  DIST_VERY_CLOSE,
  DIST_FAR,
} from './bot';

/**
 * Build a world with two sprites at the given positions. spriteParts holds the
 * COM positions/velocities the bot brain reads (PORT: SpriteParts.Pos/Velocity).
 */
function makeWorld(
  posA: { x: number; y: number },
  posB: { x: number; y: number },
  velB: { x: number; y: number } = { x: 0, y: 0 },
) {
  const world = createWorld();
  const parts = new ParticleSystem();
  parts.createPart(vec2(posA.x, posA.y), vec2(0, 0), 1, 1);
  parts.createPart(vec2(posB.x, posB.y), vec2(velB.x, velB.y), 1, 2);
  world.spriteParts = parts;
  world.rng.reseed(12345);

  const a = world.sprites[1]!;
  a.active = true;
  a.num = 1;
  a.alpha = 255;

  const b = world.sprites[2]!;
  b.active = true;
  b.num = 2;
  b.alpha = 255;

  return { world, parts, a, b };
}

/** A tiny WaypointGraph (1-indexed; slot 0 sentinel) with the given nodes. */
function makeGraph(nodes: Array<Partial<Waypoint> & { id: number; x: number; y: number }>): WaypointGraph {
  const sentinel: Waypoint = {
    active: false,
    id: 0,
    x: 0,
    y: 0,
    left: false,
    right: false,
    up: false,
    down: false,
    jetpack: false,
    pathNum: 0,
    action: 0,
    connections: [],
  };
  const arr: Waypoint[] = [sentinel];
  for (const n of nodes) {
    arr.push({
      active: true,
      left: false,
      right: false,
      up: false,
      down: false,
      jetpack: false,
      pathNum: 0,
      action: 0,
      connections: [],
      ...n,
    });
  }
  return new WaypointGraph(arr);
}

const EMPTY_GRAPH = makeGraph([]);

describe('checkDistance — distance banding', () => {
  it('quantizes one-axis distance into bands', () => {
    expect(checkDistance(0, 10)).toBe(DIST_TOO_CLOSE); // |10| <= 35
    expect(checkDistance(0, 50)).toBe(DIST_VERY_CLOSE); // <= 55
    expect(checkDistance(0, 300)).toBe(DIST_FAR); // <= 350
  });
});

describe('updateBot — combat (enemy to the right)', () => {
  it('aims toward +x and fires when an enemy is in close range to the right', () => {
    // Enemy 50px to the right, same height: DIST_VERY_CLOSE band -> fire.
    const { world, a } = makeWorld({ x: 0, y: 0 }, { x: 50, y: 0 });
    const brain = createBotState();

    updateBot(world, 1, brain, EMPTY_GRAPH);

    // Saw the enemy.
    expect(brain.targetNum).toBe(2);
    // Aim leads toward the target's +x side.
    expect(a.control.mouseAimX).toBeGreaterThan(0);
    // Close-range band fires.
    expect(a.control.fire).toBe(true);
  });

  it('faces right when the enemy is far to the right', () => {
    // Enemy 300px right (DIST_FAR band): faces right toward the target.
    const { world, a } = makeWorld({ x: 0, y: 0 }, { x: 300, y: 0 });
    const brain = createBotState();

    updateBot(world, 1, brain, EMPTY_GRAPH);

    expect(brain.targetNum).toBe(2);
    expect(a.control.right).toBe(true);
    expect(a.control.left).toBe(false);
    expect(a.control.mouseAimX).toBeGreaterThan(0);
  });

  it('faces left when the enemy is far to the left', () => {
    const { world, a } = makeWorld({ x: 0, y: 0 }, { x: -300, y: 0 });
    const brain = createBotState();

    updateBot(world, 1, brain, EMPTY_GRAPH);

    expect(brain.targetNum).toBe(2);
    expect(a.control.left).toBe(true);
    expect(a.control.right).toBe(false);
    expect(a.control.mouseAimX).toBeLessThan(0);
  });
});

describe('updateBot — navigation (no enemy in sight)', () => {
  it('sets rightward movement toward a navigation waypoint when no enemy is seen', () => {
    // Only the bot is active; the other sprite is inactive -> no target.
    const { world, a, b } = makeWorld({ x: 0, y: 0 }, { x: 50, y: 0 });
    b.active = false; // remove the enemy from perception

    // Waypoint at x=200 to the right of the bot.
    const graph = makeGraph([{ id: 1, x: 200, y: 0 }]);
    const brain = createBotState();

    updateBot(world, 1, brain, graph);

    expect(brain.targetNum).toBe(0);
    expect(brain.currentWaypoint).toBe(1);
    // Moves toward the waypoint (to the right).
    expect(a.control.right).toBe(true);
    expect(a.control.left).toBe(false);
    expect(a.control.fire).toBe(false);
  });

  it('moves left and rises toward a waypoint that is up-and-left', () => {
    const { world, a, b } = makeWorld({ x: 0, y: 0 }, { x: 50, y: 0 });
    b.active = false;

    // Waypoint to the upper-left (screen-space y is down-positive: y<0 is higher).
    const graph = makeGraph([{ id: 7, x: -150, y: -120 }]);
    const brain = createBotState();

    updateBot(world, 1, brain, graph);

    expect(brain.currentWaypoint).toBe(7);
    expect(a.control.left).toBe(true);
    expect(a.control.up).toBe(true);
  });
});

describe('updateBot — guards', () => {
  it('does nothing for a dead bot', () => {
    const { world, a } = makeWorld({ x: 0, y: 0 }, { x: 50, y: 0 });
    a.deadMeat = true;
    const brain = createBotState();

    updateBot(world, 1, brain, EMPTY_GRAPH);

    expect(a.control.fire).toBe(false);
    expect(brain.targetNum).toBe(0);
  });
});
