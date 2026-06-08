/**
 * Construct an in-memory {@link PolyMap} from a parsed `.PMS` map — faithful
 * port of `TPolyMap.LoadData` (shared/PolyMap.pas:162-257), restricted to the
 * collision-relevant fields (polygons, per-edge perpendiculars, bounciness,
 * polytype, and the sector spatial grid).
 *
 * The parsed input is the already-ported `PmsMap` from `@soldat/assets`. Pascal
 * 1-indexing is preserved where it matters: the sector index lists keep the
 * file's 1-based polygon indices verbatim (so a stored index `w` reads as
 * `polys[w - 1]`), exactly as `LoadData` copies `MapFile.Sectors[k].Polys` into
 * `Sectors[i, j].Polys[1..n]`.
 *
 * PORT: shared/PolyMap.pas:162-257 (TPolyMap.LoadData)
 */
import type { CollisionPoly } from './polymap';
import { PolyMap, makePerp } from './polymap';
import { vec2 } from '../math/vec2';

// ---------------------------------------------------------------------------
// Minimal structural input — mirrors the assets `PmsMap`.
//
// The sim package does not (and must not) take a runtime dependency on
// @soldat/assets — assets already depends on @soldat/sim, so importing it back
// would be a cycle. `import type { PmsMap } from '@soldat/assets'` is fully
// erased under verbatimModuleSyntax, but it does not yet *resolve* from sim
// (no project reference / dep is declared, and the orchestrator owns those
// files). To keep this typechecking today we declare the structural subset we
// read here, named to mirror the assets shapes 1:1.
//
// TODO(orchestrator): once @soldat/assets is wired as a sim dependency, replace
// `PmsMapInput` with `import type { PmsMap } from '@soldat/assets'` — the field
// names already match, so the swap is mechanical.
// ---------------------------------------------------------------------------

/** Mirror of assets `Vec3` (the raw .PMS normal). */
interface PmsVec3 {
  x: number;
  y: number;
  z: number;
}

/** Mirror of assets `MapVertex` (only x/y are read for collision). */
interface PmsVertex {
  x: number;
  y: number;
}

/** Mirror of assets `MapPolygon`. PORT: shared/MapFile.pas:19-25. */
interface PmsPolygon {
  vertices: readonly [PmsVertex, PmsVertex, PmsVertex];
  normals: readonly [PmsVec3, PmsVec3, PmsVec3];
  polyType: number;
}

/** Mirror of assets `MapSector`. PORT: shared/MapFile.pas:27-30. */
interface PmsSector {
  polys: readonly number[];
}

/** Structural subset of assets `PmsMap` consumed by the collision build. */
export interface PmsMapInput {
  polygons: readonly PmsPolygon[];
  sectorsDivision: number;
  sectorsNum: number;
  /** Flattened (2*sectorsNum+1)^2 grid, row-major. PORT: PolyMap.pas:220-233. */
  sectors: readonly PmsSector[];
}

/**
 * Build a {@link PolyMap} from a parsed `.PMS` map.
 *
 * Polygons: for each polygon we copy its three vertices, derive the three
 * normalized edge perpendiculars from the raw normals, and recover bounciness
 * from the (pre-normalization) length of normal 3 — exactly the
 * `LoadData` sequence at PolyMap.pas:197-208.
 *
 * Sectors: we replay the Pascal nested loop `for i := -SectorsNum to SectorsNum`
 * / `for j := -SectorsNum to SectorsNum`, advancing a flat index `k` over
 * `MapFile.Sectors`, and store each non-empty cell's 1-based polygon index list
 * under the encoded (i, j) key. Empty cells are omitted.
 *
 * PORT: shared/PolyMap.pas:174-233.
 */
export function buildPolyMap(map: PmsMapInput): PolyMap {
  const polys: CollisionPoly[] = [];

  // PORT: PolyMap.pas:193-216 — per-polygon perp/bounciness derivation.
  for (const poly of map.polygons) {
    const v0 = poly.vertices[0];
    const v1 = poly.vertices[1];
    const v2 = poly.vertices[2];

    const n0 = poly.normals[0];
    const n1 = poly.normals[1];
    const n2 = poly.normals[2];

    // Perp[i][1..3] := normalize(Normals[1..3]); Bounciness := |Normals[3]|.
    const p0 = makePerp(n0.x, n0.y);
    const p1 = makePerp(n1.x, n1.y);
    const p2 = makePerp(n2.x, n2.y);

    polys.push({
      vertices: [vec2(v0.x, v0.y), vec2(v1.x, v1.y), vec2(v2.x, v2.y)],
      perp: [p0.perp, p1.perp, p2.perp],
      polyType: poly.polyType,
      // PORT: PolyMap.pas:204 — Bounciness[i] := Vec2Length(Perp[i][3]) (raw).
      bounciness: p2.length,
    });
  }

  // PORT: PolyMap.pas:218-233 — replay the flat-index sector walk.
  const sectors = new Map<number, readonly number[]>();
  const n = map.sectorsNum;
  let k = 0;
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const src = map.sectors[k];
      if (src !== undefined && src.polys.length > 0) {
        // Pascal stores these as 1-based indices into Polys[1..]; keep verbatim.
        sectors.set(PolyMap.encodeSector(i, j), src.polys.slice());
      }
      k++;
    }
  }

  return new PolyMap({
    polys,
    sectorsDivision: map.sectorsDivision,
    sectorsNum: map.sectorsNum,
    sectors,
  });
}
