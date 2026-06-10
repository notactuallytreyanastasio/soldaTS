import { PolyMap } from './polymap';
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
export declare function buildPolyMap(map: PmsMapInput): PolyMap;
export {};
//# sourceMappingURL=buildPolyMap.d.ts.map