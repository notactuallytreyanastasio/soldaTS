import { PolyMap, makePerp } from './polymap';
import { vec2 } from '../math/vec2';
/**
 * Inward unit normal of the edge a->b, oriented toward the opposite vertex
 * `opp` (the polygon interior). Used as a geometric fallback when a polygon's
 * stored .PMS normals are degenerate. Matches the half-plane convention
 * pointInPoly tests: dot(perp, p - a) >= 0 ⇔ p on the interior side of the edge.
 */
function inwardEdgeNormal(a, b, opp) {
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    let nx = ey;
    let ny = -ex;
    // Flip to point toward the interior (the opposite vertex).
    if (nx * (opp.x - a.x) + ny * (opp.y - a.y) < 0) {
        nx = -nx;
        ny = -ny;
    }
    const len = Math.sqrt(nx * nx + ny * ny);
    return len > 0 ? vec2(nx / len, ny / len) : vec2();
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
export function buildPolyMap(map) {
    const polys = [];
    // PORT: PolyMap.pas:193-216 — per-polygon perp/bounciness derivation.
    for (const poly of map.polygons) {
        const v0 = poly.vertices[0];
        const v1 = poly.vertices[1];
        const v2 = poly.vertices[2];
        const n0 = poly.normals[0];
        const n1 = poly.normals[1];
        const n2 = poly.normals[2];
        // Perp[i][1..3] := normalize(Normals[1..3]); Bounciness := |Normals[3]|.
        let p0 = makePerp(n0.x, n0.y);
        let p1 = makePerp(n1.x, n1.y);
        let p2 = makePerp(n2.x, n2.y);
        // Robustness fallback: real .PMS maps store valid edge normals, but
        // hand-built / synthetic maps may leave them degenerate (zero-length). The
        // perp drives both pointInPoly and the collision push-out, so a zero perp
        // means "collision detected, push-out (0,0)" → entities fall through. When
        // the stored normals are degenerate, derive the INWARD edge normals from the
        // vertices (the same half-planes pointInPoly tests), so collision works for
        // any geometry. (NOT a .PMS port — a safety net for normal-less maps.)
        if (p0.length < 1e-6 && p1.length < 1e-6 && p2.length < 1e-6) {
            const a = vec2(v0.x, v0.y);
            const b = vec2(v1.x, v1.y);
            const c = vec2(v2.x, v2.y);
            p0 = { perp: inwardEdgeNormal(a, b, c), length: 0 };
            p1 = { perp: inwardEdgeNormal(b, c, a), length: 0 };
            p2 = { perp: inwardEdgeNormal(c, a, b), length: 0 };
        }
        polys.push({
            vertices: [vec2(v0.x, v0.y), vec2(v1.x, v1.y), vec2(v2.x, v2.y)],
            perp: [p0.perp, p1.perp, p2.perp],
            polyType: poly.polyType,
            // PORT: PolyMap.pas:204 — Bounciness[i] := Vec2Length(Perp[i][3]) (raw).
            bounciness: p2.length,
        });
    }
    // PORT: PolyMap.pas:218-233 — replay the flat-index sector walk.
    const sectors = new Map();
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
//# sourceMappingURL=buildPolyMap.js.map