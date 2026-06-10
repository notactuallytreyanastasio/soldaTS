import { describe, it, expect } from 'vitest';
import {
  buildWaypoints,
  WaypointAction,
  type PmsWaypoint,
  type WaypointSource,
} from './waypoints';

/**
 * Synthetic source waypoint helper. Mirrors the parsed `.PMS` record shape:
 * fixed-length connections array padded to MAX_CONNECTIONS, `connectionsNum`
 * giving the live length.
 */
function wp(
  id: number,
  x: number,
  y: number,
  conns: number[],
  overrides: Partial<PmsWaypoint> = {},
): PmsWaypoint {
  const connections = conns.slice();
  while (connections.length < 20) {
    connections.push(0);
  }
  return {
    active: true,
    id,
    x,
    y,
    left: false,
    right: false,
    up: false,
    down: false,
    jetpack: false,
    pathNum: 0,
    action: WaypointAction.None,
    connectionsNum: conns.length,
    connections,
    ...overrides,
  };
}

/**
 * Square graph:
 *
 *   1 (0,0) --- 2 (100,0)
 *   |           |
 *   4 (0,100) - 3 (100,100)
 *
 * Edges follow the square perimeter (no diagonals). A fifth, isolated waypoint
 * (id 5) has no connections to the square — used for the unreachable case.
 */
function squareSource(): WaypointSource {
  return {
    waypoints: [
      wp(1, 0, 0, [2, 4]),
      wp(2, 100, 0, [1, 3]),
      wp(3, 100, 100, [2, 4]),
      wp(4, 0, 100, [3, 1]),
      wp(5, 1000, 1000, []),
    ],
  };
}

describe('buildWaypoints', () => {
  it('builds a 1-indexed store with a sentinel at slot 0', () => {
    const g = buildWaypoints(squareSource());
    expect(g.waypoints).toHaveLength(6); // sentinel + 5
    expect(g.waypoints[0]?.active).toBe(false);
    expect(g.waypoints[1]?.id).toBe(1);
    expect(g.waypoints[5]?.id).toBe(5);
  });

  it('trims connections to connectionsNum (drops the padded tail)', () => {
    const g = buildWaypoints(squareSource());
    expect(g.waypoints[1]?.connections).toEqual([2, 4]);
    expect(g.waypoints[5]?.connections).toEqual([]);
  });

  it('preserves action flags from the source record', () => {
    const src = squareSource();
    const first = src.waypoints[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    first.left = true;
    first.jetpack = true;
    first.pathNum = 7;
    first.action = WaypointAction.StopAndCamp;
    const g = buildWaypoints(src);
    const w = g.waypoints[1];
    expect(w?.left).toBe(true);
    expect(w?.jetpack).toBe(true);
    expect(w?.pathNum).toBe(7);
    expect(w?.action).toBe(WaypointAction.StopAndCamp);
  });

  it('clamps an out-of-range action value to None', () => {
    const src = squareSource();
    const first = src.waypoints[0];
    if (first === undefined) throw new Error('fixture');
    first.action = 99;
    const g = buildWaypoints(src);
    expect(g.waypoints[1]?.action).toBe(WaypointAction.None);
  });
});

describe('WaypointGraph.nearestTo', () => {
  it('picks the closest active waypoint by id', () => {
    const g = buildWaypoints(squareSource());
    // Just past corner 1 — nearest is waypoint 1.
    expect(g.nearestTo(10, 10)).toBe(1);
    // Near corner 3.
    expect(g.nearestTo(90, 90)).toBe(3);
    // Dead center is equidistant; tie resolves to the first scanned (id 1).
    expect(g.nearestTo(50, 50)).toBe(1);
  });

  it('skips inactive waypoints', () => {
    const src = squareSource();
    const first = src.waypoints[0];
    if (first === undefined) throw new Error('fixture');
    first.active = false; // deactivate waypoint 1
    const g = buildWaypoints(src);
    // (10,10) was nearest to 1, but 1 is inactive — falls to 2 or 4 (equidist).
    const near = g.nearestTo(10, 10);
    expect(near === 2 || near === 4).toBe(true);
    expect(near).not.toBe(1);
  });

  it('returns 0 when there are no active waypoints', () => {
    const g = buildWaypoints({ waypoints: [] });
    expect(g.nearestTo(0, 0)).toBe(0);
  });
});

describe('WaypointGraph.stepToward', () => {
  it('returns the target id when it is a direct neighbour (one hop)', () => {
    const g = buildWaypoints(squareSource());
    // 1 connects directly to 2.
    expect(g.stepToward(1, 2)).toBe(2);
    expect(g.stepToward(1, 4)).toBe(4);
  });

  it('walks one hop toward a target two edges away', () => {
    const g = buildWaypoints(squareSource());
    // 1 -> 3 around the square: first hop is 2 or 4 (both length-2 paths).
    const hop = g.stepToward(1, 3);
    expect(hop === 2 || hop === 4).toBe(true);
  });

  it('returns the source id when from == target', () => {
    const g = buildWaypoints(squareSource());
    expect(g.stepToward(2, 2)).toBe(2);
  });

  it('returns 0 for an unreachable target', () => {
    const g = buildWaypoints(squareSource());
    // Waypoint 5 is isolated from the square.
    expect(g.stepToward(1, 5)).toBe(0);
    expect(g.stepToward(5, 1)).toBe(0);
  });

  it('returns 0 when an endpoint id is unknown', () => {
    const g = buildWaypoints(squareSource());
    expect(g.stepToward(1, 999)).toBe(0);
    expect(g.stepToward(999, 1)).toBe(0);
  });

  it('ignores dangling connections to inactive/unknown ids', () => {
    // Waypoint 1 lists a connection to id 42 which does not exist; the live
    // edge to 2 must still work and the dangling edge must not crash BFS.
    const src: WaypointSource = {
      waypoints: [wp(1, 0, 0, [42, 2]), wp(2, 100, 0, [1])],
    };
    const g = buildWaypoints(src);
    expect(g.stepToward(1, 2)).toBe(2);
  });

  it('routes around a broken edge using a longer path', () => {
    // Line 1-2-3 with 1 also wired straight to 3, but 3 is inactive on that
    // wire? Simpler: 1-2, 2-3, and a separate 1-4-3 detour. Remove the direct
    // 1..3 edge so the only route from 1 to 3 is through 2.
    const src: WaypointSource = {
      waypoints: [
        wp(1, 0, 0, [2]),
        wp(2, 100, 0, [1, 3]),
        wp(3, 200, 0, [2]),
      ],
    };
    const g = buildWaypoints(src);
    expect(g.stepToward(1, 3)).toBe(2);
    expect(g.stepToward(3, 1)).toBe(2);
  });
});
