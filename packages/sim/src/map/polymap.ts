/**
 * In-memory collision map — faithful port of `TPolyMap` (shared/PolyMap.pas).
 *
 * Holds the collision polygons (vertices + per-edge normals + polytype +
 * bounciness), the Sectors spatial-hash grid (sector size `sectorsDivision`,
 * half-extent `sectorsNum`, per-sector polygon index lists), and the query
 * routines that `TSprite.CheckMapCollision` / `ClosestPerpendicular` depend on
 * (shared/mechanics/Sprites.pas:2573-2846).
 *
 * Pascal 1-indexing is preserved at the data level: `polys[i]` corresponds to
 * Pascal `Polys[i+1]`, but the *sector index lists* store the original 1-based
 * polygon indices exactly as the .PMS file does (so a stored index `w` reads as
 * `polys[w - 1]`). See `buildPolyMap.ts` for the load-time construction that
 * mirrors `TPolyMap.LoadData`.
 *
 * Determinism: all physics arithmetic flows through `f()` (sim scalar policy)
 * and reuses Vec2/ops from sim math, so STRICT_F32 reproduces Pascal `Single`.
 *
 * PORT: shared/PolyMap.pas:66-111 (TPolyMap)
 */
import { f } from '../scalar';
import type { Vec2 } from '../math/vec2';
import { vec2, length as vec2Length, normalize as vec2Normalize } from '../math/vec2';
import { pointLineDistance } from '../math/calc';

// ---------------------------------------------------------------------------
// Constants — PORT: shared/PolyMap.pas:8-60
// ---------------------------------------------------------------------------

/** PORT: PolyMap.pas:8 — maximum collision polygons. */
export const MAX_POLYS = 5000;
/** PORT: PolyMap.pas:11-12 — extended sector grid bounds used by RayCast. */
export const MIN_SECTORZ = -35;
export const MAX_SECTORZ = 35;

/**
 * Polygon collision type. PORT: shared/PolyMap.pas:22-47 (POLY_TYPE_*).
 * Numeric values are stable and match the on-disk byte exactly.
 */
export const POLY_TYPE_NORMAL = 0;
export const POLY_TYPE_ONLY_BULLETS = 1;
export const POLY_TYPE_ONLY_PLAYER = 2;
export const POLY_TYPE_DOESNT = 3;
export const POLY_TYPE_ICE = 4;
export const POLY_TYPE_DEADLY = 5;
export const POLY_TYPE_BLOODY_DEADLY = 6;
export const POLY_TYPE_HURTS = 7;
export const POLY_TYPE_REGENERATES = 8;
export const POLY_TYPE_LAVA = 9;
export const POLY_TYPE_RED_BULLETS = 10;
export const POLY_TYPE_RED_PLAYER = 11;
export const POLY_TYPE_BLUE_BULLETS = 12;
export const POLY_TYPE_BLUE_PLAYER = 13;
export const POLY_TYPE_YELLOW_BULLETS = 14;
export const POLY_TYPE_YELLOW_PLAYER = 15;
export const POLY_TYPE_GREEN_BULLETS = 16;
export const POLY_TYPE_GREEN_PLAYER = 17;
export const POLY_TYPE_BOUNCY = 18;
export const POLY_TYPE_EXPLODES = 19;
export const POLY_TYPE_HURTS_FLAGGERS = 20;
export const POLY_TYPE_ONLY_FLAGGERS = 21;
export const POLY_TYPE_NOT_FLAGGERS = 22;
export const POLY_TYPE_NON_FLAGGER_COLLIDES = 23;
export const POLY_TYPE_BACKGROUND = 24;
export const POLY_TYPE_BACKGROUND_TRANSITION = 25;

// ---------------------------------------------------------------------------
// Polytype helpers
// ---------------------------------------------------------------------------

/**
 * "Deadly" surfaces that instantly kill on contact.
 * PORT: handled in HandleSpecialPolyTypes (Sprites.pas); grouped here for the
 * query API the orchestrator drives from sprite movement.
 */
export function isDeadly(polyType: number): boolean {
  return (
    polyType === POLY_TYPE_DEADLY ||
    polyType === POLY_TYPE_BLOODY_DEADLY ||
    polyType === POLY_TYPE_LAVA
  );
}

/** Bouncy surface — bounciness scaled by `Bounciness[w]`. PORT: PolyMap.pas:40 */
export function isBouncy(polyType: number): boolean {
  return polyType === POLY_TYPE_BOUNCY;
}

/** Ice surface — reduced friction. PORT: PolyMap.pas:4 (POLY_TYPE_ICE). */
export function isIce(polyType: number): boolean {
  return polyType === POLY_TYPE_ICE;
}

/** Only bullets collide; players pass through. PORT: PolyMap.pas:1. */
export function isOnlyBullets(polyType: number): boolean {
  return polyType === POLY_TYPE_ONLY_BULLETS;
}

/** Only players collide; bullets pass through. PORT: PolyMap.pas:2. */
export function isOnlyPlayer(polyType: number): boolean {
  return polyType === POLY_TYPE_ONLY_PLAYER;
}

/** Background polys never collide (drawn only). PORT: PolyMap.pas:24-25. */
export function isBackground(polyType: number): boolean {
  return (
    polyType === POLY_TYPE_BACKGROUND ||
    polyType === POLY_TYPE_BACKGROUND_TRANSITION
  );
}

// ---------------------------------------------------------------------------
// Geometry structures
// ---------------------------------------------------------------------------

/**
 * One collision polygon as the queries need it: the three triangle vertices and
 * the three (normalized) per-edge perpendiculars. Vertex/perp slot 0 == Pascal
 * index 1. `Polys[i].PolyType`, `PolyType[i]` and `Bounciness[i]` of the Pascal
 * record are flattened onto the parallel arrays in `PolyMap` to mirror the
 * source layout (Polys / PolyType / Perp / Bounciness).
 *
 * PORT: shared/PolyMap.pas:85-89 (Polys / Perp / PolyType / Bounciness)
 */
export interface CollisionPoly {
  /** Pascal Polys[i].Vertices[1..3] — triangle corners. */
  vertices: readonly [Vec2, Vec2, Vec2];
  /** Pascal Perp[i][1..3] — normalized edge perpendiculars. */
  perp: readonly [Vec2, Vec2, Vec2];
  /** Pascal PolyType[i]. */
  polyType: number;
  /** Pascal Bounciness[i] = Vec2Length(Normals[3]) before normalization. */
  bounciness: number;
}

/**
 * Result of a successful point/circle collision query — the data
 * `CheckMapCollision` operates on after `PointInPoly` succeeds.
 *
 * `perp` is the *raw* (normalized) closest-edge perpendicular from
 * `ClosestPerpendicular`; `distance` is its scalar distance `d`; `edge` is the
 * 1-based edge index `n` (1, 2 or 3); `polyIndex` is the 0-based index into
 * `polys` (Pascal `w - 1`); `polyType`/`bounciness` are copied for convenience.
 *
 * Callers reproduce the Pascal push-out themselves (e.g. `Vec2Scale(Perp,
 * Bounciness[w] * D)` in Sprites.pas:2742, or `1.5 * d` in
 * CollisionTest/PolyMap.pas:563); see `collidePointPushout` for the latter.
 */
export interface MapCollision {
  polyIndex: number;
  polyType: number;
  bounciness: number;
  /** Normalized closest-edge perpendicular (Pascal Perp[w][n]). */
  perp: Vec2;
  /** Scalar distance to the closest edge (Pascal `d`). */
  distance: number;
  /** 1-based closest-edge index (Pascal `n`: 1, 2 or 3). */
  edge: number;
}

// ---------------------------------------------------------------------------
// PolyMap
// ---------------------------------------------------------------------------

/**
 * The collision map: polygons + the sector spatial grid + bounds.
 *
 * The sector grid is stored as a flat `Map<number, number[]>` keyed by an
 * encoded (kx, ky) pair, each value being the .PMS-stored 1-based polygon index
 * list for that cell (exactly Pascal `Sectors[kx, ky].Polys[1..n]`). Empty
 * sectors are simply absent from the map.
 *
 * PORT: shared/PolyMap.pas:66-92 (TPolyMap fields).
 */
export class PolyMap {
  /** Pascal Polys/Perp/PolyType/Bounciness flattened to one array (0-based). */
  readonly polys: readonly CollisionPoly[];
  /** Pascal SectorsDivision — world-coordinate divisor for the grid. */
  readonly sectorsDivision: number;
  /** Pascal SectorsNum — half-extent of the sector grid (cells -N..+N). */
  readonly sectorsNum: number;

  /** Encoded-sector -> 1-based polygon index list. */
  private readonly sectors: ReadonlyMap<number, readonly number[]>;

  /** True when a usable sector grid exists; false → brute-force all polys. */
  private readonly hasGrid: boolean;
  /** 1-based indices of every polygon (the no-grid candidate set). */
  private readonly allIndices: readonly number[];

  constructor(args: {
    polys: readonly CollisionPoly[];
    sectorsDivision: number;
    sectorsNum: number;
    sectors: ReadonlyMap<number, readonly number[]>;
  }) {
    this.polys = args.polys;
    this.sectorsDivision = args.sectorsDivision;
    this.sectorsNum = args.sectorsNum;
    this.sectors = args.sectors;
    // A map without a valid sector grid (e.g. small/synthetic maps) still needs
    // collision: fall back to testing every polygon. Real .PMS maps always have
    // a grid, so this only affects gridless maps and keeps their behaviour.
    this.hasGrid =
      args.sectorsNum > 0 && args.sectorsDivision > 0 && args.sectors.size > 0;
    this.allIndices = args.polys.map((_, i) => i + 1);
  }

  /**
   * Candidate 1-based polygon indices near `p`: the sector's polygons when a
   * grid exists, otherwise every polygon (gridless fallback).
   */
  private candidatePolys(p: Vec2): readonly number[] {
    if (!this.hasGrid) {
      return this.allIndices;
    }
    const { kx, ky } = this.sectorIndex(p);
    if (!this.sectorInBounds(kx, ky)) {
      return EMPTY_SECTOR;
    }
    return this.sectorPolys(kx, ky);
  }

  /** Encode a (kx, ky) cell into a single number key. */
  static encodeSector(kx: number, ky: number): number {
    // Offset by a fixed bias so negatives stay positive; bias well beyond
    // MAX_SECTORZ keeps keys collision-free for any valid map.
    return (kx + 256) * 1024 + (ky + 256);
  }

  // -------------------------------------------------------------------------
  // Point-in-polygon — PORT: shared/PolyMap.pas:410-455 (TPolyMap.PointInPoly)
  // -------------------------------------------------------------------------

  /**
   * 2D half-plane (signed-area) triangle test. True iff `p` lies inside the
   * polygon `poly`. Faithful port of the StackOverflow same-side method used by
   * the Pascal original; the `> 0` strictness and short-circuit order are kept
   * exactly so edge/degenerate cases match.
   *
   * PORT: shared/PolyMap.pas:410-455
   */
  static pointInPoly(p: Vec2, poly: CollisionPoly): boolean {
    const a = poly.vertices[0];
    const b = poly.vertices[1];
    const c = poly.vertices[2];

    // PORT: PolyMap.pas:441-442.
    const apX = f(p.x - a.x);
    const apY = f(p.y - a.y);

    // PORT: PolyMap.pas:444-445.
    const pAb = f(f(b.x - a.x) * apY) - f(f(b.y - a.y) * apX) > 0;
    const pAc = f(f(c.x - a.x) * apY) - f(f(c.y - a.y) * apX) > 0;

    // PORT: PolyMap.pas:447-448.
    if (pAc === pAb) {
      return false;
    }

    // PORT: PolyMap.pas:451 — p_bc <> p_ab.
    const pBc =
      f(f(c.x - b.x) * f(p.y - b.y)) - f(f(c.y - b.y) * f(p.x - b.x)) > 0;
    if (pBc !== pAb) {
      return false;
    }

    return true;
  }

  /** Instance form of {@link PolyMap.pointInPoly} for a polygon index (0-based). */
  pointInPolyAt(p: Vec2, polyIndex: number): boolean {
    const poly = this.polys[polyIndex];
    if (poly === undefined) {
      return false;
    }
    return PolyMap.pointInPoly(p, poly);
  }

  // -------------------------------------------------------------------------
  // Edge-test point-in-poly — PORT: shared/PolyMap.pas:382-408 (PointInPolyEdges)
  // -------------------------------------------------------------------------

  /**
   * Point-in-polygon by the per-edge perpendiculars: inside iff the point is on
   * the non-negative side of all three normals. Used by the sprite leg/foot
   * collision in Sprites.pas:2522.
   *
   * PORT: shared/PolyMap.pas:382-408
   */
  pointInPolyEdges(x: number, y: number, polyIndex: number): boolean {
    const poly = this.polys[polyIndex];
    if (poly === undefined) {
      return false;
    }

    // PORT: PolyMap.pas:389-393.
    let ux = f(x - poly.vertices[0].x);
    let uy = f(y - poly.vertices[0].y);
    if (f(f(poly.perp[0].x * ux) + f(poly.perp[0].y * uy)) < 0) {
      return false;
    }

    // PORT: PolyMap.pas:395-399.
    ux = f(x - poly.vertices[1].x);
    uy = f(y - poly.vertices[1].y);
    if (f(f(poly.perp[1].x * ux) + f(poly.perp[1].y * uy)) < 0) {
      return false;
    }

    // PORT: PolyMap.pas:401-405.
    ux = f(x - poly.vertices[2].x);
    uy = f(y - poly.vertices[2].y);
    if (f(f(poly.perp[2].x * ux) + f(poly.perp[2].y * uy)) < 0) {
      return false;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Closest perpendicular — PORT: shared/PolyMap.pas:457-534 (ClosestPerpendicular)
  // -------------------------------------------------------------------------

  /**
   * For polygon `polyIndex`, find the closest of its three edges to `pos` and
   * return that edge's (normalized) perpendicular together with the scalar
   * distance `d` and the 1-based edge index `n`.
   *
   * The tie-breaking and the slightly quirky `(d3 < d2) and (d3 < d1)`
   * comparison chain are reproduced exactly from the Pascal so the chosen edge
   * matches bit-for-bit.
   *
   * PORT: shared/PolyMap.pas:457-534
   */
  closestPerpendicular(polyIndex: number, pos: Vec2): {
    perp: Vec2;
    distance: number;
    edge: number;
  } {
    const poly = this.polys[polyIndex];
    if (poly === undefined) {
      return { perp: vec2(), distance: 0, edge: 0 };
    }

    const v1 = poly.vertices[0];
    const v2 = poly.vertices[1];
    const v3 = poly.vertices[2];

    // PORT: PolyMap.pas:476-485 — edge (1,2).
    const d1 = pointLineDistance({ x: v1.x, y: v1.y }, { x: v2.x, y: v2.y }, pos);
    let d = d1;
    let edgeV1 = 1;
    let edgeV2 = 2;

    // PORT: PolyMap.pas:487-500 — edge (2,3).
    const d2 = pointLineDistance({ x: v2.x, y: v2.y }, { x: v3.x, y: v3.y }, pos);
    if (d2 < d1) {
      edgeV1 = 2;
      edgeV2 = 3;
      d = d2;
    }

    // PORT: PolyMap.pas:502-515 — edge (3,1).
    const d3 = pointLineDistance({ x: v3.x, y: v3.y }, { x: v1.x, y: v1.y }, pos);
    if (d3 < d2 && d3 < d1) {
      edgeV1 = 3;
      edgeV2 = 1;
      d = d3;
    }

    // PORT: PolyMap.pas:517-533 — select perp by chosen edge pair.
    let perp: Vec2 = vec2();
    let edge = 0;
    if (edgeV1 === 1 && edgeV2 === 2) {
      perp = { x: poly.perp[0].x, y: poly.perp[0].y };
      edge = 1;
    }
    if (edgeV1 === 2 && edgeV2 === 3) {
      perp = { x: poly.perp[1].x, y: poly.perp[1].y };
      edge = 2;
    }
    if (edgeV1 === 3 && edgeV2 === 1) {
      perp = { x: poly.perp[2].x, y: poly.perp[2].y };
      edge = 3;
    }

    return { perp, distance: d, edge };
  }

  // -------------------------------------------------------------------------
  // Sector lookup — PORT: shared/Sprites.pas:2594-2597 / PolyMap.pas:548-552
  // -------------------------------------------------------------------------

  /**
   * World position -> sector cell index (kx, ky) via `Round(p / SectorsDivision)`.
   * Pascal `Round` is banker's rounding; the sim already provides a faithful
   * `roundFair` (Floor(x+0.5)) but the engine uses `System.Round` here. We mirror
   * `System.Round` semantics with round-half-to-even via Math.round-adjusted...
   *
   * NOTE: Pascal `Round` = round-half-to-even (banker's). We reproduce that so
   * the bucket boundaries land identically. See `roundHalfEven`.
   *
   * PORT: shared/PolyMap.pas:548-549 (kx := Round(Pos.x / SectorsDivision)).
   */
  sectorIndex(p: Vec2): { kx: number; ky: number } {
    const kx = roundHalfEven(f(p.x / this.sectorsDivision));
    const ky = roundHalfEven(f(p.y / this.sectorsDivision));
    return { kx, ky };
  }

  /** True iff (kx, ky) is inside the strict valid range Pascal tests against. */
  sectorInBounds(kx: number, ky: number): boolean {
    // PORT: PolyMap.pas:551-552 / Sprites.pas:2596-2597 — strict `<`/`>`.
    return (
      kx > -this.sectorsNum &&
      kx < this.sectorsNum &&
      ky > -this.sectorsNum &&
      ky < this.sectorsNum
    );
  }

  /**
   * The 1-based polygon index list stored in sector (kx, ky), or an empty list.
   * Indices are exactly as the .PMS stores them (read a polygon as
   * `polys[index - 1]`).
   */
  sectorPolys(kx: number, ky: number): readonly number[] {
    return this.sectors.get(PolyMap.encodeSector(kx, ky)) ?? EMPTY_SECTOR;
  }

  // -------------------------------------------------------------------------
  // collidePoint — the data CheckMapCollision needs
  // -------------------------------------------------------------------------

  /**
   * Test world point `pos` against the sector polygons at its cell and return
   * the first colliding polygon's nearest-edge perpendicular + polytype, or
   * `null`. `accept(polyType)` decides which polygons participate (the caller
   * supplies the team/flag/area filtering that Sprites.pas does inline, so this
   * stays a pure geometric query). The iteration order matches Pascal
   * (`for j := 1 to High(Sectors[..].Polys)`), so "first hit" is deterministic.
   *
   * PORT: shared/mechanics/Sprites.pas:2594-2613 (sector loop + PointInPoly),
   *       shared/PolyMap.pas:548-568 (CollisionTest skeleton).
   */
  collidePoint(
    pos: Vec2,
    accept: (polyType: number, polyIndex: number) => boolean,
  ): MapCollision | null {
    const indices = this.candidatePolys(pos);
    for (const w of indices) {
      const polyIndex = w - 1; // .PMS stores 1-based; polys[] is 0-based.
      const poly = this.polys[polyIndex];
      if (poly === undefined) {
        continue;
      }
      if (!accept(poly.polyType, polyIndex)) {
        continue;
      }
      if (PolyMap.pointInPoly(pos, poly)) {
        const cp = this.closestPerpendicular(polyIndex, pos);
        return {
          polyIndex,
          polyType: poly.polyType,
          bounciness: poly.bounciness,
          perp: cp.perp,
          distance: cp.distance,
          edge: cp.edge,
        };
      }
    }

    return null;
  }

  /**
   * Convenience: the `CollisionTest` push-out vector — the closest-edge
   * perpendicular scaled by `1.5 * d`.
   *
   * PORT: shared/PolyMap.pas:562-563 (PerpVec := ClosestPerpendicular(..);
   *       Vec2Scale(PerpVec, PerpVec, 1.5 * d)).
   */
  collidePointPushout(
    pos: Vec2,
    accept: (polyType: number, polyIndex: number) => boolean,
  ): { perp: Vec2; hit: MapCollision } | null {
    const hit = this.collidePoint(pos, accept);
    if (hit === null) {
      return null;
    }
    const s = f(1.5 * hit.distance);
    return { perp: { x: f(hit.perp.x * s), y: f(hit.perp.y * s) }, hit };
  }

  // -------------------------------------------------------------------------
  // collideCircle — nearest-edge perpendicular for a circular collider
  // -------------------------------------------------------------------------

  /**
   * Circle-vs-map query: a collider at `center` with `radius` collides with a
   * sector polygon when its center is inside the polygon (faithful to the
   * engine's point-based player collision) OR when the closest edge is within
   * `radius`. Returns the first such polygon's nearest-edge perpendicular +
   * polytype, mirroring `collidePoint`'s iteration order.
   *
   * The center-inside branch reproduces `CheckMapCollision` exactly; the
   * edge-distance branch extends it for a finite-radius collider (the engine
   * itself collides on the predicted *point*, so radius 0 == `collidePoint`).
   *
   * PORT (basis): shared/mechanics/Sprites.pas:2594-2613, 2718 +
   *               shared/PolyMap.pas:457-534 (ClosestPerpendicular).
   */
  collideCircle(
    center: Vec2,
    radius: number,
    accept: (polyType: number, polyIndex: number) => boolean,
  ): MapCollision | null {
    const indices = this.candidatePolys(center);
    for (const w of indices) {
      const polyIndex = w - 1;
      const poly = this.polys[polyIndex];
      if (poly === undefined) {
        continue;
      }
      if (!accept(poly.polyType, polyIndex)) {
        continue;
      }

      const inside = PolyMap.pointInPoly(center, poly);
      const cp = this.closestPerpendicular(polyIndex, center);
      if (inside || cp.distance <= radius) {
        return {
          polyIndex,
          polyType: poly.polyType,
          bounciness: poly.bounciness,
          perp: cp.perp,
          distance: cp.distance,
          edge: cp.edge,
        };
      }
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const EMPTY_SECTOR: readonly number[] = Object.freeze([]);

/**
 * Round-half-to-even, matching FreePascal `System.Round` (which uses the FPU's
 * round-to-nearest-even mode). This governs which sector a position buckets
 * into, so it must match the engine exactly at the .5 boundaries.
 */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) {
    return floor;
  }
  if (diff > 0.5) {
    return floor + 1;
  }
  // Exactly .5 — round to the even neighbour.
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Build a normalized edge perpendicular from a raw .PMS normal, returning both
 * the unit perp and the pre-normalization length (the bounciness for normal 3).
 *
 * PORT: shared/PolyMap.pas:197-208 — Perp[i][k] := Normals[k]; Bounciness :=
 *       Vec2Length(Perp[i][3]); then Vec2Normalize each perp.
 */
export function makePerp(nx: number, ny: number): { perp: Vec2; length: number } {
  const raw: Vec2 = { x: nx, y: ny };
  const len = vec2Length(raw);
  return { perp: vec2Normalize(raw), length: len };
}
