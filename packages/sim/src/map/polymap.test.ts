/**
 * PolyMap collision tests on a synthetic single-triangle map.
 *
 * Plain f64 (STRICT_F32 off): we assert geometric behaviour — point-in-poly
 * inside/outside, sector bucketing, and the nearest-edge perpendicular + scalar
 * distance returned by collideCircle against a chosen edge.
 */
import { describe, it, expect } from 'vitest';
import { buildPolyMap, type PmsMapInput } from './buildPolyMap';
import { PolyMap } from './polymap';

// ---------------------------------------------------------------------------
// Synthetic map: ONE right-triangle collision polygon.
//
//   A = (0, 0)      B = (200, 0)
//                   \
//   C = (0, 200)
//
// Edges (Pascal order): edge1 = A->B (the top), edge2 = B->C (hypotenuse),
// edge3 = C->A (the left side). We supply per-edge normals pointing INWARD
// (toward the triangle interior) so pointInPolyEdges/closestPerpendicular agree
// with pointInPoly.
//
//   edge1 A->B is along +x at y=0; inward (toward +y) normal = (0, +1).
//   edge3 C->A is along -y at x=0; inward (toward +x) normal = (+1, 0).
//   edge2 B->C hypotenuse; inward normal = (-1/√2, -1/√2)... pointing toward
//   origin side = (-√0.5, -√0.5).
//
// The third normal's LENGTH encodes bounciness; we give it length 1 (normal).
// ---------------------------------------------------------------------------

const SECTORS_DIVISION = 50;
const SECTORS_NUM = 25;

function syntheticMap(): PmsMapInput {
  const A = { x: 0, y: 0 };
  const B = { x: 200, y: 0 };
  const C = { x: 0, y: 200 };

  const INV_SQRT2 = 1 / Math.sqrt(2);

  // sectors: flat (2*N+1)^2 grid, row-major over i=-N..N, j=-N..N.
  const dim = 2 * SECTORS_NUM + 1;
  const sectors = Array.from({ length: dim * dim }, () => ({ polys: [] as number[] }));

  // The triangle spans world x∈[0,200], y∈[0,200]. With division 50 it occupies
  // sector cells kx,ky ∈ {0..4} (Round(0/50)=0 .. Round(200/50)=4). Register the
  // polygon (1-based index 1) in every cell it could be queried from. For this
  // test we register it in the cell that contains the centroid (~ (66,66) ->
  // Round(1.33)=1) and a few neighbours, mirroring how a real .PMS bins a poly.
  const register = (i: number, j: number): void => {
    const flatIndex = (i + SECTORS_NUM) * dim + (j + SECTORS_NUM);
    const cell = sectors[flatIndex];
    if (cell !== undefined) {
      cell.polys.push(1); // 1-based polygon index
    }
  };
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      register(i, j);
    }
  }

  return {
    sectorsDivision: SECTORS_DIVISION,
    sectorsNum: SECTORS_NUM,
    polygons: [
      {
        vertices: [
          { x: A.x, y: A.y },
          { x: B.x, y: B.y },
          { x: C.x, y: C.y },
        ],
        normals: [
          { x: 0, y: 1, z: 0 }, // edge1 A->B inward
          { x: -INV_SQRT2, y: -INV_SQRT2, z: 0 }, // edge2 B->C inward
          { x: 1, y: 0, z: 0 }, // edge3 C->A inward; length 1 = bounciness 1
        ],
        polyType: 0, // POLY_TYPE_NORMAL
      },
    ],
    sectors,
  };
}

const acceptAll = (): boolean => true;

describe('PolyMap (synthetic triangle)', () => {
  it('pointInPoly: inside vs outside', () => {
    const map = buildPolyMap(syntheticMap());
    const poly = map.polys[0];
    expect(poly).toBeDefined();

    // Centroid (~66.6, 66.6) is clearly inside.
    expect(PolyMap.pointInPoly({ x: 66, y: 66 }, poly!)).toBe(true);
    // A point near vertex A but inside.
    expect(PolyMap.pointInPoly({ x: 10, y: 10 }, poly!)).toBe(true);
    // Outside: beyond the hypotenuse (x+y > 200).
    expect(PolyMap.pointInPoly({ x: 150, y: 150 }, poly!)).toBe(false);
    // Outside: negative quadrant.
    expect(PolyMap.pointInPoly({ x: -10, y: 50 }, poly!)).toBe(false);
    expect(PolyMap.pointInPoly({ x: 50, y: -10 }, poly!)).toBe(false);
  });

  it('pointInPolyEdges agrees with pointInPoly on interior points', () => {
    const map = buildPolyMap(syntheticMap());
    expect(map.pointInPolyEdges(66, 66, 0)).toBe(true);
    expect(map.pointInPolyEdges(10, 10, 0)).toBe(true);
    // Outside the top edge (y < 0).
    expect(map.pointInPolyEdges(50, -5, 0)).toBe(false);
  });

  it('sector lookup buckets the polygon', () => {
    const map = buildPolyMap(syntheticMap());

    // Centroid (66, 66): Round(66/50) = Round(1.32) = 1 in each axis.
    const idx = map.sectorIndex({ x: 66, y: 66 });
    expect(idx).toEqual({ kx: 1, ky: 1 });
    expect(map.sectorInBounds(idx.kx, idx.ky)).toBe(true);

    const cell = map.sectorPolys(idx.kx, idx.ky);
    expect(cell).toContain(1); // 1-based polygon index present

    // A far-away empty cell has no polygons.
    expect(map.sectorPolys(20, 20)).toHaveLength(0);
  });

  it('roundHalfEven sector boundary matches Pascal Round (banker rounding)', () => {
    const map = buildPolyMap(syntheticMap());
    // x = 25 -> 25/50 = 0.5 -> round-half-to-even -> 0.
    expect(map.sectorIndex({ x: 25, y: 25 })).toEqual({ kx: 0, ky: 0 });
    // x = 75 -> 1.5 -> round-half-to-even -> 2.
    expect(map.sectorIndex({ x: 75, y: 75 })).toEqual({ kx: 2, ky: 2 });
  });

  it('collideCircle: hit returns nearest-edge perpendicular + distance', () => {
    const map = buildPolyMap(syntheticMap());

    // Center inside near the TOP edge (A->B, edge index 1). Closest edge is the
    // top (y=0); distance from (50,10) to line y=0 is 10; inward normal (0,1).
    const hit = map.collideCircle({ x: 50, y: 10 }, 0, acceptAll);
    expect(hit).not.toBeNull();
    expect(hit!.polyIndex).toBe(0);
    expect(hit!.polyType).toBe(0);
    expect(hit!.edge).toBe(1);
    expect(hit!.distance).toBeCloseTo(10, 6);
    expect(hit!.perp.x).toBeCloseTo(0, 6);
    expect(hit!.perp.y).toBeCloseTo(1, 6);
    // Bounciness recovered from |normal[3]| = 1.
    expect(hit!.bounciness).toBeCloseTo(1, 6);
  });

  it('collideCircle: closest edge is the left side near edge3', () => {
    const map = buildPolyMap(syntheticMap());
    // Center (8, 100): nearest edge is the left side x=0 (edge3 C->A),
    // distance 8, inward normal (1, 0).
    const hit = map.collideCircle({ x: 8, y: 100 }, 0, acceptAll);
    expect(hit).not.toBeNull();
    expect(hit!.edge).toBe(3);
    expect(hit!.distance).toBeCloseTo(8, 6);
    expect(hit!.perp.x).toBeCloseTo(1, 6);
    expect(hit!.perp.y).toBeCloseTo(0, 6);
  });

  it('collideCircle: outside but within radius of an edge still collides', () => {
    const map = buildPolyMap(syntheticMap());
    // Just above the top edge at (50, -5): outside the triangle, but the closest
    // edge (top) is 5 away — a radius-6 collider reaches it.
    expect(map.collideCircle({ x: 50, y: -5 }, 6, acceptAll)).not.toBeNull();
    // ...a radius-2 collider does not.
    expect(map.collideCircle({ x: 50, y: -5 }, 2, acceptAll)).toBeNull();
  });

  it('collidePoint: center outside -> no collision; respects accept filter', () => {
    const map = buildPolyMap(syntheticMap());
    // Outside the triangle entirely.
    expect(map.collidePoint({ x: 150, y: 150 }, acceptAll)).toBeNull();
    // Inside, but accept rejects the polytype -> no collision.
    expect(
      map.collidePoint({ x: 66, y: 66 }, (pt) => pt !== 0),
    ).toBeNull();
    // Inside, accepted -> collision.
    expect(map.collidePoint({ x: 66, y: 66 }, acceptAll)).not.toBeNull();
  });

  it('collidePointPushout scales the perpendicular by 1.5 * distance', () => {
    const map = buildPolyMap(syntheticMap());
    const res = map.collidePointPushout({ x: 50, y: 10 }, acceptAll);
    expect(res).not.toBeNull();
    // Top edge: perp (0,1), distance 10 -> pushout (0, 15).
    expect(res!.perp.x).toBeCloseTo(0, 6);
    expect(res!.perp.y).toBeCloseTo(15, 6);
  });
});
