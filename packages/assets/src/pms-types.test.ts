import { describe, expect, it } from 'vitest';

import {
  MAX_COLLIDERS,
  MAX_CONNECTIONS,
  MAX_POLYS,
  MAX_PROPS,
  MAX_SECTOR,
  MAX_SPAWNPOINTS,
  MAX_WAYPOINTS,
  PolyType,
  SpawnTeam,
  WaypointAction,
} from './pms-types';
import type { MapColor, MapPolygon, MapVertex, Vec3, Waypoint } from './pms-types';

/** Count the value-side members of a numeric enum (each adds a reverse mapping). */
function numericMemberCount(e: Record<string, unknown>): number {
  return Object.keys(e).filter((k) => Number.isNaN(Number(k))).length;
}

describe('capacity constants', () => {
  it('match the Pascal PolyMap.pas / Waypoints.pas limits', () => {
    expect(MAX_POLYS).toBe(5000);
    expect(MAX_SECTOR).toBe(25);
    expect(MAX_PROPS).toBe(500);
    expect(MAX_COLLIDERS).toBe(128);
    expect(MAX_SPAWNPOINTS).toBe(255);
    expect(MAX_WAYPOINTS).toBe(5000);
    expect(MAX_CONNECTIONS).toBe(20);
  });
});

describe('PolyType', () => {
  it('matches the original POLY_TYPE_* Pascal constants 0..25', () => {
    expect(PolyType.Normal).toBe(0);
    expect(PolyType.OnlyBullets).toBe(1);
    expect(PolyType.OnlyPlayer).toBe(2);
    expect(PolyType.Doesnt).toBe(3);
    expect(PolyType.Ice).toBe(4);
    expect(PolyType.Deadly).toBe(5);
    expect(PolyType.BloodyDeadly).toBe(6);
    expect(PolyType.Hurts).toBe(7);
    expect(PolyType.Regenerates).toBe(8);
    expect(PolyType.Lava).toBe(9);
    expect(PolyType.RedBullets).toBe(10);
    expect(PolyType.RedPlayer).toBe(11);
    expect(PolyType.BlueBullets).toBe(12);
    expect(PolyType.BluePlayer).toBe(13);
    expect(PolyType.YellowBullets).toBe(14);
    expect(PolyType.YellowPlayer).toBe(15);
    expect(PolyType.GreenBullets).toBe(16);
    expect(PolyType.GreenPlayer).toBe(17);
    expect(PolyType.Bouncy).toBe(18);
    expect(PolyType.Explodes).toBe(19);
    expect(PolyType.HurtsFlaggers).toBe(20);
    expect(PolyType.OnlyFlaggers).toBe(21);
    expect(PolyType.NotFlaggers).toBe(22);
    expect(PolyType.NonFlaggerCollides).toBe(23);
    expect(PolyType.Background).toBe(24);
    expect(PolyType.BackgroundTransition).toBe(25);
  });

  it('has exactly 26 contiguous members with no gaps or duplicates', () => {
    expect(numericMemberCount(PolyType)).toBe(26);
    for (let v = 0; v <= 25; v++) {
      expect(PolyType[v]).toBeTypeOf('string'); // reverse mapping exists
    }
    expect(PolyType[26]).toBeUndefined();
  });
});

describe('SpawnTeam', () => {
  it('covers Any, the four teams, and both flags with values 0..6', () => {
    expect(SpawnTeam.Any).toBe(0);
    expect(SpawnTeam.Alpha).toBe(1);
    expect(SpawnTeam.Bravo).toBe(2);
    expect(SpawnTeam.Charlie).toBe(3);
    expect(SpawnTeam.Delta).toBe(4);
    expect(SpawnTeam.Flag1).toBe(5);
    expect(SpawnTeam.Flag2).toBe(6);
    expect(numericMemberCount(SpawnTeam)).toBe(7);
  });
});

describe('WaypointAction', () => {
  it('is sequential 0..6 matching TWaypointAction declaration order', () => {
    expect(WaypointAction.None).toBe(0);
    expect(WaypointAction.StopAndCamp).toBe(1);
    expect(WaypointAction.Wait1Second).toBe(2);
    expect(WaypointAction.Wait5Seconds).toBe(3);
    expect(WaypointAction.Wait10Seconds).toBe(4);
    expect(WaypointAction.Wait15Seconds).toBe(5);
    expect(WaypointAction.Wait20Seconds).toBe(6);
    expect(numericMemberCount(WaypointAction)).toBe(7);
  });
});

describe('type-level contracts', () => {
  it('MapColor is a fixed length-4 [r,g,b,a] tuple', () => {
    const c: MapColor = [10, 20, 30, 40];
    // @ts-expect-error - 3 elements is not a MapColor
    const tooShort: MapColor = [10, 20, 30];
    // @ts-expect-error - 5 elements is not a MapColor
    const tooLong: MapColor = [10, 20, 30, 40, 50];
    void tooShort;
    void tooLong;
    expect(c).toHaveLength(4);
  });

  it('MapPolygon vertices and normals are fixed length-3 tuples', () => {
    const v: MapVertex = { x: 0, y: 0, z: 0, rhw: 1, color: [0, 0, 0, 255], u: 0, v: 0 };
    const n: Vec3 = { x: 0, y: -1, z: 0 };
    const poly: MapPolygon = {
      vertices: [v, v, v],
      normals: [n, n, n],
      polyType: PolyType.Normal,
      textureIndex: 0,
    };
    const badPoly: MapPolygon = {
      // @ts-expect-error - 2 vertices is not a valid vertex tuple
      vertices: [v, v],
      // @ts-expect-error - 4 normals is not a valid normal tuple
      normals: [n, n, n, n],
      polyType: PolyType.Normal,
      textureIndex: 0,
    };
    void badPoly;
    expect(poly.vertices).toHaveLength(3);
    expect(poly.normals).toHaveLength(3);
  });

  it('Waypoint.connections is typed number[] (length not enforced by the type)', () => {
    // SUSPECT (reviewer finding): the doc comment promises a fixed length of
    // MAX_CONNECTIONS (20), but the type is a plain number[], so TS happily
    // accepts a shorter array. Consumers must rely on the loader invariant.
    const wp: Waypoint = {
      active: true,
      id: 1,
      x: 0,
      y: 0,
      left: false,
      right: false,
      up: false,
      down: false,
      jetpack: false,
      pathNum: 1,
      action: WaypointAction.None,
      connectionsNum: 1,
      connections: [2], // compiles despite being shorter than MAX_CONNECTIONS
    };
    expect(wp.connections.length).toBeLessThan(MAX_CONNECTIONS);
  });
});
