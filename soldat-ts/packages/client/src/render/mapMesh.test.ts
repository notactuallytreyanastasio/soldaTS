import { describe, it, expect } from 'vitest';
import type {
  MapColor,
  MapPolygon,
  MapVertex,
  PmsMap,
  Vec3,
} from '@soldat/assets';
import { PolyType } from '@soldat/assets';
import { buildMapMesh } from './mapMesh';

function vertex(
  x: number,
  y: number,
  u: number,
  v: number,
  color: MapColor,
): MapVertex {
  return { x, y, z: 0, rhw: 1, color, u, v };
}

const ZERO_NORMAL: Vec3 = { x: 0, y: 0, z: 0 };
const NORMALS: readonly [Vec3, Vec3, Vec3] = [
  ZERO_NORMAL,
  ZERO_NORMAL,
  ZERO_NORMAL,
];

function polygon(
  vertices: readonly [MapVertex, MapVertex, MapVertex],
): MapPolygon {
  return {
    vertices,
    normals: NORMALS,
    polyType: PolyType.Normal,
    textureIndex: 0,
  };
}

function syntheticMap(polygons: MapPolygon[]): PmsMap {
  return {
    hash: 0,
    version: 0,
    mapName: 'test',
    textures: [],
    bgColorTop: [0, 0, 0, 255],
    bgColorBtm: [0, 0, 0, 255],
    startJet: 0,
    grenadePacks: 0,
    medikits: 0,
    weather: 0,
    steps: 0,
    randomId: 0,
    polygons,
    sectorsDivision: 0,
    sectorsNum: 0,
    sectors: [],
    props: [],
    scenery: [],
    colliders: [],
    spawnpoints: [],
    waypoints: [],
  };
}

describe('buildMapMesh', () => {
  // Two triangles with distinct positions, colors (0..255 -> 0..1), and uvs.
  const p0 = polygon([
    vertex(0, 0, 0, 0, [255, 0, 0, 255]),
    vertex(10, 0, 1, 0, [0, 255, 0, 255]),
    vertex(0, 10, 0, 1, [0, 0, 255, 128]),
  ]);
  const p1 = polygon([
    vertex(20, 20, 0, 0, [255, 255, 255, 255]),
    vertex(30, 20, 1, 0, [128, 64, 32, 255]),
    vertex(20, 30, 0, 1, [0, 0, 0, 0]),
  ]);
  const mesh = buildMapMesh(syntheticMap([p0, p1]));

  it('reports the polygon count', () => {
    expect(mesh.polygonCount).toBe(2);
  });

  it('produces correctly sized buffers (6 vertices)', () => {
    // 2 polys * 3 verts = 6 vertices
    expect(mesh.positions.length).toBe(6 * 2);
    expect(mesh.colors.length).toBe(6 * 4);
    expect(mesh.uvs.length).toBe(6 * 2);
    expect(mesh.indices.length).toBe(6);
  });

  it('flattens positions in vertex order', () => {
    // First poly vertices.
    expect(mesh.positions[0]).toBe(0);
    expect(mesh.positions[1]).toBe(0);
    expect(mesh.positions[2]).toBe(10);
    expect(mesh.positions[3]).toBe(0);
    expect(mesh.positions[4]).toBe(0);
    expect(mesh.positions[5]).toBe(10);
    // Second poly first vertex starts at vertex index 3 -> offset 6.
    expect(mesh.positions[6]).toBe(20);
    expect(mesh.positions[7]).toBe(20);
    expect(mesh.positions[10]).toBe(20);
    expect(mesh.positions[11]).toBe(30);
  });

  it('flattens uvs in vertex order', () => {
    expect(mesh.uvs[2]).toBe(1); // poly0 vert1 u
    expect(mesh.uvs[3]).toBe(0); // poly0 vert1 v
    expect(mesh.uvs[10]).toBe(0); // poly1 vert2 u
    expect(mesh.uvs[11]).toBe(1); // poly1 vert2 v
  });

  it('normalizes color bytes 0..255 to 0..1', () => {
    // poly0 vert0: red, full alpha.
    expect(mesh.colors[0]).toBeCloseTo(1, 6);
    expect(mesh.colors[1]).toBeCloseTo(0, 6);
    expect(mesh.colors[2]).toBeCloseTo(0, 6);
    expect(mesh.colors[3]).toBeCloseTo(1, 6);
    // poly0 vert2: blue, half alpha (128/255).
    const v2 = 2 * 4;
    expect(mesh.colors[v2 + 2]).toBeCloseTo(1, 6);
    expect(mesh.colors[v2 + 3]).toBeCloseTo(128 / 255, 6);
    // poly1 vert2: all zero -> all 0.
    const v5 = 5 * 4;
    expect(mesh.colors[v5]).toBe(0);
    expect(mesh.colors[v5 + 3]).toBe(0);
  });

  it('produces sequential indices', () => {
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('handles an empty map', () => {
    const empty = buildMapMesh(syntheticMap([]));
    expect(empty.polygonCount).toBe(0);
    expect(empty.positions.length).toBe(0);
    expect(empty.indices.length).toBe(0);
  });
});
