/**
 * buildPolyMap construction tests on synthetic single-triangle maps.
 *
 * Plain f64 (STRICT_F32 off). Covers:
 *   1. Valid .PMS normals: perpendiculars normalized, direction preserved,
 *      bounciness recovered from the RAW length of normal 3 (and only 3).
 *   2. The all-degenerate-normals fallback: inward edge normals derived from
 *      the vertex geometry, agreeing with pointInPoly's half-planes.
 *   3. PARTIAL degeneracy (one or two zero normals): the fallback does NOT
 *      trigger — zero perps are retained (suspect behaviour, see below).
 *   4. The sector flat-index walk: 1-based polygon indices kept verbatim,
 *      empty cells omitted.
 */
import { describe, it, expect } from 'vitest';
import { buildPolyMap, type PmsMapInput } from './buildPolyMap';
import { PolyMap } from './polymap';

const INV_SQRT2 = 1 / Math.sqrt(2);

interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Right triangle A=(0,0), B=(200,0), C=(0,200) — same geometry as
 * polymap.test.ts. Gridless (sectorsNum = 0) so PolyMap brute-forces all
 * polys; the sector walk is exercised separately.
 */
function triangleMap(normals: readonly [Vec3Like, Vec3Like, Vec3Like]): PmsMapInput {
  return {
    sectorsDivision: 0,
    sectorsNum: 0,
    sectors: [],
    polygons: [
      {
        vertices: [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
          { x: 0, y: 200 },
        ],
        normals,
        polyType: 0,
      },
    ],
  };
}

const VALID_NORMALS: readonly [Vec3Like, Vec3Like, Vec3Like] = [
  { x: 0, y: 1, z: 0 }, // edge1 A->B inward (+y)
  { x: -INV_SQRT2, y: -INV_SQRT2, z: 0 }, // edge2 B->C inward
  { x: 1, y: 0, z: 0 }, // edge3 C->A inward (+x); length 1 -> bounciness 1
];

const ZERO: Vec3Like = { x: 0, y: 0, z: 0 };

describe('buildPolyMap — valid normals', () => {
  it('normalizes the stored perpendiculars and preserves their direction', () => {
    const map = buildPolyMap(triangleMap(VALID_NORMALS));
    expect(map.polys).toHaveLength(1);
    const poly = map.polys[0]!;

    expect(poly.perp[0].x).toBeCloseTo(0, 10);
    expect(poly.perp[0].y).toBeCloseTo(1, 10);
    expect(poly.perp[1].x).toBeCloseTo(-INV_SQRT2, 6);
    expect(poly.perp[1].y).toBeCloseTo(-INV_SQRT2, 6);
    expect(poly.perp[2].x).toBeCloseTo(1, 10);
    expect(poly.perp[2].y).toBeCloseTo(0, 10);
  });

  it('copies vertices and polyType verbatim', () => {
    const map = buildPolyMap(triangleMap(VALID_NORMALS));
    const poly = map.polys[0]!;
    expect(poly.vertices[0]).toEqual({ x: 0, y: 0 });
    expect(poly.vertices[1]).toEqual({ x: 200, y: 0 });
    expect(poly.vertices[2]).toEqual({ x: 0, y: 200 });
    expect(poly.polyType).toBe(0);
  });

  it('recovers bounciness from the RAW length of normal 3 only', () => {
    // Normal 1 is long (length 3) and normal 3 has length 2: bounciness must
    // come from normal 3 (PolyMap.pas:204), not normal 1 or 2.
    const map = buildPolyMap(
      triangleMap([
        { x: 0, y: 3, z: 0 },
        { x: -INV_SQRT2, y: -INV_SQRT2, z: 0 },
        { x: 2, y: 0, z: 0 },
      ]),
    );
    const poly = map.polys[0]!;
    expect(poly.bounciness).toBeCloseTo(2, 10);
    // The long normals are still normalized in the perp slots.
    expect(poly.perp[0].y).toBeCloseTo(1, 10);
    expect(poly.perp[2].x).toBeCloseTo(1, 10);
  });
});

describe('buildPolyMap — all-degenerate normal fallback', () => {
  it('derives inward unit edge normals from the vertices', () => {
    const map = buildPolyMap(triangleMap([ZERO, ZERO, ZERO]));
    const poly = map.polys[0]!;

    // edge1 A->B (top, horizontal): inward = toward C = (0, +1).
    expect(poly.perp[0].x).toBeCloseTo(0, 10);
    expect(poly.perp[0].y).toBeCloseTo(1, 10);
    // edge2 B->C (hypotenuse): inward = toward A = (-1/sqrt2, -1/sqrt2).
    expect(poly.perp[1].x).toBeCloseTo(-INV_SQRT2, 6);
    expect(poly.perp[1].y).toBeCloseTo(-INV_SQRT2, 6);
    // edge3 C->A (left, vertical): inward = toward B = (+1, 0).
    expect(poly.perp[2].x).toBeCloseTo(1, 10);
    expect(poly.perp[2].y).toBeCloseTo(0, 10);

    // Every derived perp is unit-length.
    for (const p of poly.perp) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 6);
    }
    // Degenerate normal 3 -> bounciness 0 (raw length of the stored normal).
    expect(poly.bounciness).toBe(0);
  });

  it('pointInPoly / pointInPolyEdges / closestPerpendicular work on derived normals', () => {
    const map = buildPolyMap(triangleMap([ZERO, ZERO, ZERO]));
    const poly = map.polys[0]!;

    // Interior / exterior agreement between both point tests.
    expect(PolyMap.pointInPoly({ x: 66, y: 66 }, poly)).toBe(true);
    expect(map.pointInPolyEdges(66, 66, 0)).toBe(true);
    expect(PolyMap.pointInPoly({ x: 150, y: 150 }, poly)).toBe(false);
    expect(map.pointInPolyEdges(50, -5, 0)).toBe(false);

    // A point just below the top edge is closest to edge 1; the derived
    // perpendicular points inward (+y) and is non-zero, so the push-out works.
    const cp = map.closestPerpendicular(0, { x: 100, y: 3 });
    expect(cp.edge).toBe(1);
    expect(cp.distance).toBeCloseTo(3, 6);
    expect(cp.perp.x).toBeCloseTo(0, 10);
    expect(cp.perp.y).toBeCloseTo(1, 10);
  });
});

describe('buildPolyMap — PARTIAL normal degeneracy (suspect behaviour)', () => {
  // SUSPECT BEHAVIOUR (flagged in review): the fallback at buildPolyMap.ts:129
  // only triggers when ALL THREE stored normals are degenerate (&& chain). A
  // map with one or two zero normals keeps the zero-length perpendiculars for
  // those edges, so a collision resolved against such an edge pushes out by
  // (0, 0) — entities can fall through. These tests pin the CURRENT behaviour;
  // they are not an endorsement of it.
  it('one degenerate normal among two valid ones retains the (0,0) perp', () => {
    const map = buildPolyMap(
      triangleMap([
        ZERO, // edge1 degenerate
        { x: -INV_SQRT2, y: -INV_SQRT2, z: 0 },
        { x: 1, y: 0, z: 0 },
      ]),
    );
    const poly = map.polys[0]!;

    // The degenerate edge keeps a zero perpendicular (no fallback).
    expect(poly.perp[0]).toEqual({ x: 0, y: 0 });
    // The valid edges are untouched.
    expect(poly.perp[1].x).toBeCloseTo(-INV_SQRT2, 6);
    expect(poly.perp[2].x).toBeCloseTo(1, 10);
  });

  it('two degenerate normals retain BOTH zero perps; the valid one survives', () => {
    const map = buildPolyMap(triangleMap([ZERO, ZERO, { x: 1, y: 0, z: 0 }]));
    const poly = map.polys[0]!;
    expect(poly.perp[0]).toEqual({ x: 0, y: 0 });
    expect(poly.perp[1]).toEqual({ x: 0, y: 0 });
    expect(poly.perp[2].x).toBeCloseTo(1, 10);
    // Bounciness still derives from the valid normal 3.
    expect(poly.bounciness).toBeCloseTo(1, 10);
  });

  it('a zero perp makes pointInPolyEdges accept points OUTSIDE that edge', () => {
    // Consequence of the retained (0,0) perp: the edge-1 half-plane test
    // degenerates to dot((0,0), u) = 0 >= 0, i.e. always passes. A point above
    // the top edge (outside the triangle) passes pointInPolyEdges even though
    // pointInPoly rejects it.
    const map = buildPolyMap(
      triangleMap([
        ZERO,
        { x: -INV_SQRT2, y: -INV_SQRT2, z: 0 },
        { x: 1, y: 0, z: 0 },
      ]),
    );
    const outsideTopEdge = { x: 50, y: -5 };
    expect(PolyMap.pointInPoly(outsideTopEdge, map.polys[0]!)).toBe(false);
    expect(map.pointInPolyEdges(outsideTopEdge.x, outsideTopEdge.y, 0)).toBe(true);
  });
});

describe('buildPolyMap — sector flat-index walk', () => {
  it('stores 1-based polygon indices verbatim and omits empty cells', () => {
    // sectorsNum = 1 -> 3x3 grid, row-major over i = -1..1, j = -1..1.
    // Flat index k = (i+1)*3 + (j+1).
    const dim = 3;
    const sectors = Array.from({ length: dim * dim }, () => ({
      polys: [] as number[],
    }));
    sectors[0]!.polys = [1]; // (i=-1, j=-1)
    sectors[4]!.polys = [1, 1]; // (i=0, j=0) — duplicates kept verbatim
    sectors[8]!.polys = [1]; // (i=1, j=1)

    const map = buildPolyMap({
      sectorsDivision: 25,
      sectorsNum: 1,
      sectors,
      polygons: [
        {
          vertices: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 0, y: 10 },
          ],
          normals: VALID_NORMALS,
          polyType: 0,
        },
      ],
    });

    expect(map.sectorPolys(-1, -1)).toEqual([1]);
    expect(map.sectorPolys(0, 0)).toEqual([1, 1]);
    expect(map.sectorPolys(1, 1)).toEqual([1]);
    // Empty cells return the empty list.
    expect(map.sectorPolys(-1, 0)).toEqual([]);
    expect(map.sectorPolys(0, 1)).toEqual([]);
    // Grid metadata is carried through.
    expect(map.sectorsDivision).toBe(25);
    expect(map.sectorsNum).toBe(1);
  });

  it('a missing sectors array entry is tolerated (cell simply absent)', () => {
    const map = buildPolyMap({
      sectorsDivision: 25,
      sectorsNum: 1,
      sectors: [{ polys: [1] }], // far fewer than the 9 the walk visits
      polygons: [
        {
          vertices: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 0, y: 10 },
          ],
          normals: VALID_NORMALS,
          polyType: 0,
        },
      ],
    });
    expect(map.sectorPolys(-1, -1)).toEqual([1]);
    expect(map.sectorPolys(0, 0)).toEqual([]);
  });
});
