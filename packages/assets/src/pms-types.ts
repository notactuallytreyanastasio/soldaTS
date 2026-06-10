// Parsed .PMS binary map structures.
//
// Faithful port of the on-disk record layout from shared/MapFile.pas. Field
// order, sizes and 1-indexing semantics mirror the Pascal records exactly.
// See docs/rewrite-reference/pms-map-format.md for the byte-level spec.
//
// PORT: shared/MapFile.pas:8-89 (type declarations)

import type { Scalar } from '@soldat/sim';

// ---------------------------------------------------------------------------
// Capacity constants — PolyMap.pas / Waypoints.pas (quoted in pms-map-format.md)
// ---------------------------------------------------------------------------

/** PORT: PolyMap.pas — maximum collision polygons. */
export const MAX_POLYS = 5000;
/** PORT: PolyMap.pas — maximum half-dimension of the sector grid. */
export const MAX_SECTOR = 25;
/** PORT: PolyMap.pas — maximum props and scenery. */
export const MAX_PROPS = 500;
/** PORT: PolyMap.pas — maximum circular colliders. */
export const MAX_COLLIDERS = 128;
/** PORT: PolyMap.pas — maximum spawnpoints. */
export const MAX_SPAWNPOINTS = 255;
/** PORT: shared/Waypoints.pas:14 — maximum bot waypoints. */
export const MAX_WAYPOINTS = 5000;
/** PORT: shared/Waypoints.pas:15 — maximum connections per waypoint. */
export const MAX_CONNECTIONS = 20;

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/**
 * RGBA color, indices [r, g, b, a].
 *
 * Note on byte order: the file stores B, G, R, A sequentially, but
 * ReadColor (MapFile.pas:240-246) deliberately writes them into result slots
 * [2], [1], [0], [3] so the in-memory array is [r, g, b, a]. We keep the same
 * in-memory ordering. The tuple is fixed length 4.
 *
 * PORT: shared/MapFile.pas:9-10 (TMapColor = array[0..3] of Byte)
 */
export type MapColor = readonly [r: number, g: number, b: number, a: number];

// ---------------------------------------------------------------------------
// Polygons
// ---------------------------------------------------------------------------

/** PORT: shared/MapFile.pas:12-17 (TMapVertex) */
export interface MapVertex {
  x: Scalar;
  y: Scalar;
  z: Scalar;
  rhw: Scalar;
  color: MapColor;
  u: Scalar;
  v: Scalar;
}

/** A 3-component float vector. PORT: Vector.TVector3 (used by Normals). */
export interface Vec3 {
  x: Scalar;
  y: Scalar;
  z: Scalar;
}

/**
 * Polygon collision type. PORT: PolyMap.pas:22-47 (POLY_TYPE_*).
 * Stored in the file as a single Uint8.
 */
export enum PolyType {
  Normal = 0,
  OnlyBullets = 1,
  OnlyPlayer = 2,
  Doesnt = 3,
  Ice = 4,
  Deadly = 5,
  BloodyDeadly = 6,
  Hurts = 7,
  Regenerates = 8,
  Lava = 9,
  RedBullets = 10,
  RedPlayer = 11,
  BlueBullets = 12,
  BluePlayer = 13,
  YellowBullets = 14,
  YellowPlayer = 15,
  GreenBullets = 16,
  GreenPlayer = 17,
  Bouncy = 18,
  Explodes = 19,
  HurtsFlaggers = 20,
  OnlyFlaggers = 21,
  NotFlaggers = 22,
  NonFlaggerCollides = 23,
  Background = 24,
  BackgroundTransition = 25,
}

/**
 * Single collision polygon: 3 vertices, 3 per-edge normals, type + texture idx.
 * Vertices and normals are 1-indexed in Pascal ([1..3]); we expose them as
 * fixed length-3 tuples (TS index 0 == Pascal index 1).
 *
 * PORT: shared/MapFile.pas:19-25 (TMapPolygon)
 */
export interface MapPolygon {
  vertices: readonly [MapVertex, MapVertex, MapVertex];
  normals: readonly [Vec3, Vec3, Vec3];
  /** Raw byte preserved as `polyType`; numeric value is a PolyType member. */
  polyType: PolyType;
  /** Always 0 on load (set during read, not stored in file). */
  textureIndex: number;
}

// ---------------------------------------------------------------------------
// Sectors (spatial hash grid)
// ---------------------------------------------------------------------------

/**
 * One sector cell: a list of polygon indices (Uint16) into the global Polygons
 * array. Pascal stores these as Polys: array of Word.
 *
 * PORT: shared/MapFile.pas:27-30 (TMapSector)
 */
export interface MapSector {
  polys: number[];
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** PORT: shared/MapFile.pas:32-43 (TMapProp) */
export interface MapProp {
  active: boolean;
  style: number; // Word
  width: number; // Integer
  height: number; // Integer
  x: Scalar;
  y: Scalar;
  rotation: Scalar;
  scaleX: Scalar;
  scaleY: Scalar;
  alpha: number; // Byte
  color: MapColor;
  level: number; // Byte
}

// ---------------------------------------------------------------------------
// Scenery
// ---------------------------------------------------------------------------

/** PORT: shared/MapFile.pas:45-49 (TMapScenery) */
export interface MapScenery {
  filename: string;
  date: number; // Integer
}

// ---------------------------------------------------------------------------
// Colliders
// ---------------------------------------------------------------------------

/** PORT: shared/MapFile.pas:51-56 (TMapCollider) */
export interface MapCollider {
  active: boolean;
  x: Scalar;
  y: Scalar;
  radius: Scalar;
}

// ---------------------------------------------------------------------------
// Spawnpoints
// ---------------------------------------------------------------------------

/**
 * Spawn / object team type. PORT: spawnpoint Team field
 * (MapFile.pas:61, semantics from pms-map-format.md:186).
 */
export enum SpawnTeam {
  Any = 0,
  Alpha = 1,
  Bravo = 2,
  Charlie = 3,
  Delta = 4,
  Flag1 = 5,
  Flag2 = 6,
}

/** PORT: shared/MapFile.pas:58-62 (TMapSpawnpoint) */
export interface MapSpawnpoint {
  active: boolean;
  x: number; // Integer
  y: number; // Integer
  team: number; // Integer (see SpawnTeam)
}

// ---------------------------------------------------------------------------
// Waypoints
// ---------------------------------------------------------------------------

/** PORT: shared/Waypoints.pas:18-19 (TWaypointAction, scopedenums on) */
export enum WaypointAction {
  None = 0,
  StopAndCamp = 1,
  Wait1Second = 2,
  Wait5Seconds = 3,
  Wait10Seconds = 4,
  Wait15Seconds = 5,
  Wait20Seconds = 6,
}

/**
 * Bot path node. Connections is a fixed-length array of MAX_CONNECTIONS Int32
 * waypoint IDs; Pascal indexes it [1..MAX_CONNECTIONS]. We keep all 20 slots
 * (TS index 0 == Pascal index 1).
 *
 * PORT: shared/Waypoints.pas:20-29 (TWaypoint)
 */
export interface Waypoint {
  active: boolean;
  id: number;
  x: number;
  y: number;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jetpack: boolean;
  pathNum: number; // Byte
  action: WaypointAction;
  connectionsNum: number;
  connections: number[]; // length MAX_CONNECTIONS
}

// ---------------------------------------------------------------------------
// Top-level map
// ---------------------------------------------------------------------------

/**
 * Fully parsed .PMS map. Field grouping mirrors TMapFile; runtime-only fields
 * of the Pascal record (Filename, MapInfo) are omitted since the loader is
 * buffer-driven and has no filesystem context.
 *
 * PORT: shared/MapFile.pas:64-89 (TMapFile)
 */
export interface PmsMap {
  /** crc32(5381, whole file). PORT: MapFile.pas:449 */
  hash: number; // LongWord (unsigned 32-bit)
  version: number;
  mapName: string;
  /** Single texture filename; Pascal stores Textures[0]. MapFile.pas:284-290 */
  textures: string[];
  bgColorTop: MapColor;
  bgColorBtm: MapColor;
  startJet: number;
  grenadePacks: number; // Byte
  medikits: number; // Byte
  weather: number; // Byte
  steps: number; // Byte
  randomId: number;
  polygons: MapPolygon[];
  sectorsDivision: number;
  sectorsNum: number;
  sectors: MapSector[];
  props: MapProp[];
  scenery: MapScenery[];
  colliders: MapCollider[];
  spawnpoints: MapSpawnpoint[];
  waypoints: Waypoint[];
}
