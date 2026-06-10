// Convert a parsed .PMS map into renderable geometry buffers.
//
// PURE module: no pixi / DOM imports so it can run headless in vitest. Each PMS
// polygon is already a triangle (3 vertices with x/y, rgba color, u/v texcoord),
// so triangulation is a straight flatten — mirroring the vertex-buffer fill in
// client/MapGraphics.pas:701-712.
//
// PORT: client/MapGraphics.pas:681-714 (polygon vertex buffer build)

import type { PmsMap } from '@soldat/assets';

/**
 * Renderable map geometry. Track D consumes this contract.
 *
 * - `positions`: interleaved x,y pairs (2 floats per vertex).
 * - `colors`: interleaved r,g,b,a (4 floats per vertex, normalized 0..1).
 * - `uvs`: interleaved u,v texcoords (2 floats per vertex).
 * - `indices`: index into the vertex arrays (1 entry per vertex).
 * - `polygonCount`: number of source PMS polygons (triangles).
 */
export interface MapMesh {
  positions: Float32Array;
  colors: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  polygonCount: number;
}

/** PMS in-memory color is [r, g, b, a] in 0..255; normalize to 0..1. */
const BYTE_TO_UNIT = 1 / 255;

/**
 * Triangulate every PMS polygon into flat render buffers.
 *
 * Each polygon contributes exactly 3 vertices (it is already a triangle). The
 * Pascal source copies x, y, u, v and the 4 color bytes per vertex in order
 * (MapGraphics.pas:703-707); we do the same, normalizing color bytes to 0..1.
 *
 * PORT: client/MapGraphics.pas:701-712
 */
export function buildMapMesh(map: PmsMap): MapMesh {
  const polygonCount = map.polygons.length;
  const vertexCount = polygonCount * 3;

  const positions = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 4);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(vertexCount);

  let vi = 0; // running vertex index (mirrors Pascal vbIndex)
  for (let p = 0; p < polygonCount; p++) {
    const poly = map.polygons[p];
    if (poly === undefined) continue; // guard for noUncheckedIndexedAccess

    // Pascal iterates Vertices[1..3]; our tuple is 0-indexed (TS 0 == Pascal 1).
    for (let j = 0; j < 3; j++) {
      const vert = poly.vertices[j];
      if (vert === undefined) continue;

      const pos2 = vi * 2;
      positions[pos2] = vert.x;
      positions[pos2 + 1] = vert.y;

      uvs[pos2] = vert.u;
      uvs[pos2 + 1] = vert.v;

      const col4 = vi * 4;
      const color = vert.color; // [r, g, b, a] in 0..255
      colors[col4] = color[0] * BYTE_TO_UNIT;
      colors[col4 + 1] = color[1] * BYTE_TO_UNIT;
      colors[col4 + 2] = color[2] * BYTE_TO_UNIT;
      colors[col4 + 3] = color[3] * BYTE_TO_UNIT;

      indices[vi] = vi;
      vi++;
    }
  }

  return { positions, colors, uvs, indices, polygonCount };
}
