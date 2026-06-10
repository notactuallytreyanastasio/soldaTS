import type { Vec2 } from '../math/vec2';
/** PORT: PolyMap.pas:8 — maximum collision polygons. */
export declare const MAX_POLYS = 5000;
/** PORT: PolyMap.pas:11-12 — extended sector grid bounds used by RayCast. */
export declare const MIN_SECTORZ = -35;
export declare const MAX_SECTORZ = 35;
/**
 * Polygon collision type. PORT: shared/PolyMap.pas:22-47 (POLY_TYPE_*).
 * Numeric values are stable and match the on-disk byte exactly.
 */
export declare const POLY_TYPE_NORMAL = 0;
export declare const POLY_TYPE_ONLY_BULLETS = 1;
export declare const POLY_TYPE_ONLY_PLAYER = 2;
export declare const POLY_TYPE_DOESNT = 3;
export declare const POLY_TYPE_ICE = 4;
export declare const POLY_TYPE_DEADLY = 5;
export declare const POLY_TYPE_BLOODY_DEADLY = 6;
export declare const POLY_TYPE_HURTS = 7;
export declare const POLY_TYPE_REGENERATES = 8;
export declare const POLY_TYPE_LAVA = 9;
export declare const POLY_TYPE_RED_BULLETS = 10;
export declare const POLY_TYPE_RED_PLAYER = 11;
export declare const POLY_TYPE_BLUE_BULLETS = 12;
export declare const POLY_TYPE_BLUE_PLAYER = 13;
export declare const POLY_TYPE_YELLOW_BULLETS = 14;
export declare const POLY_TYPE_YELLOW_PLAYER = 15;
export declare const POLY_TYPE_GREEN_BULLETS = 16;
export declare const POLY_TYPE_GREEN_PLAYER = 17;
export declare const POLY_TYPE_BOUNCY = 18;
export declare const POLY_TYPE_EXPLODES = 19;
export declare const POLY_TYPE_HURTS_FLAGGERS = 20;
export declare const POLY_TYPE_ONLY_FLAGGERS = 21;
export declare const POLY_TYPE_NOT_FLAGGERS = 22;
export declare const POLY_TYPE_NON_FLAGGER_COLLIDES = 23;
export declare const POLY_TYPE_BACKGROUND = 24;
export declare const POLY_TYPE_BACKGROUND_TRANSITION = 25;
/**
 * "Deadly" surfaces that instantly kill on contact.
 * PORT: handled in HandleSpecialPolyTypes (Sprites.pas); grouped here for the
 * query API the orchestrator drives from sprite movement.
 */
export declare function isDeadly(polyType: number): boolean;
/** Bouncy surface — bounciness scaled by `Bounciness[w]`. PORT: PolyMap.pas:40 */
export declare function isBouncy(polyType: number): boolean;
/** Ice surface — reduced friction. PORT: PolyMap.pas:4 (POLY_TYPE_ICE). */
export declare function isIce(polyType: number): boolean;
/** Only bullets collide; players pass through. PORT: PolyMap.pas:1. */
export declare function isOnlyBullets(polyType: number): boolean;
/** Only players collide; bullets pass through. PORT: PolyMap.pas:2. */
export declare function isOnlyPlayer(polyType: number): boolean;
/** Background polys never collide (drawn only). PORT: PolyMap.pas:24-25. */
export declare function isBackground(polyType: number): boolean;
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
export declare class PolyMap {
    /** Pascal Polys/Perp/PolyType/Bounciness flattened to one array (0-based). */
    readonly polys: readonly CollisionPoly[];
    /** Pascal SectorsDivision — world-coordinate divisor for the grid. */
    readonly sectorsDivision: number;
    /** Pascal SectorsNum — half-extent of the sector grid (cells -N..+N). */
    readonly sectorsNum: number;
    /** Encoded-sector -> 1-based polygon index list. */
    private readonly sectors;
    /** True when a usable sector grid exists; false → brute-force all polys. */
    private readonly hasGrid;
    /** 1-based indices of every polygon (the no-grid candidate set). */
    private readonly allIndices;
    constructor(args: {
        polys: readonly CollisionPoly[];
        sectorsDivision: number;
        sectorsNum: number;
        sectors: ReadonlyMap<number, readonly number[]>;
    });
    /**
     * Candidate 1-based polygon indices near `p`: the sector's polygons when a
     * grid exists, otherwise every polygon (gridless fallback).
     */
    private candidatePolys;
    /** Encode a (kx, ky) cell into a single number key. */
    static encodeSector(kx: number, ky: number): number;
    /**
     * 2D half-plane (signed-area) triangle test. True iff `p` lies inside the
     * polygon `poly`. Faithful port of the StackOverflow same-side method used by
     * the Pascal original; the `> 0` strictness and short-circuit order are kept
     * exactly so edge/degenerate cases match.
     *
     * PORT: shared/PolyMap.pas:410-455
     */
    static pointInPoly(p: Vec2, poly: CollisionPoly): boolean;
    /** Instance form of {@link PolyMap.pointInPoly} for a polygon index (0-based). */
    pointInPolyAt(p: Vec2, polyIndex: number): boolean;
    /**
     * Point-in-polygon by the per-edge perpendiculars: inside iff the point is on
     * the non-negative side of all three normals. Used by the sprite leg/foot
     * collision in Sprites.pas:2522.
     *
     * PORT: shared/PolyMap.pas:382-408
     */
    pointInPolyEdges(x: number, y: number, polyIndex: number): boolean;
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
    };
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
    sectorIndex(p: Vec2): {
        kx: number;
        ky: number;
    };
    /** True iff (kx, ky) is inside the strict valid range Pascal tests against. */
    sectorInBounds(kx: number, ky: number): boolean;
    /**
     * The 1-based polygon index list stored in sector (kx, ky), or an empty list.
     * Indices are exactly as the .PMS stores them (read a polygon as
     * `polys[index - 1]`).
     */
    sectorPolys(kx: number, ky: number): readonly number[];
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
    collidePoint(pos: Vec2, accept: (polyType: number, polyIndex: number) => boolean): MapCollision | null;
    /**
     * Convenience: the `CollisionTest` push-out vector — the closest-edge
     * perpendicular scaled by `1.5 * d`.
     *
     * PORT: shared/PolyMap.pas:562-563 (PerpVec := ClosestPerpendicular(..);
     *       Vec2Scale(PerpVec, PerpVec, 1.5 * d)).
     */
    collidePointPushout(pos: Vec2, accept: (polyType: number, polyIndex: number) => boolean): {
        perp: Vec2;
        hit: MapCollision;
    } | null;
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
    collideCircle(center: Vec2, radius: number, accept: (polyType: number, polyIndex: number) => boolean): MapCollision | null;
}
/**
 * Round-half-to-even, matching FreePascal `System.Round` (which uses the FPU's
 * round-to-nearest-even mode). This governs which sector a position buckets
 * into, so it must match the engine exactly at the .5 boundaries.
 */
export declare function roundHalfEven(x: number): number;
/**
 * Build a normalized edge perpendicular from a raw .PMS normal, returning both
 * the unit perp and the pre-normalization length (the bounciness for normal 3).
 *
 * PORT: shared/PolyMap.pas:197-208 — Perp[i][k] := Normals[k]; Bounciness :=
 *       Vec2Length(Perp[i][3]); then Vec2Normalize each perp.
 */
export declare function makePerp(nx: number, ny: number): {
    perp: Vec2;
    length: number;
};
//# sourceMappingURL=polymap.d.ts.map