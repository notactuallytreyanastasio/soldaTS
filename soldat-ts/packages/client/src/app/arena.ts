// A hand-built arena map: a real multi-platform level so the player has
// somewhere to run, jump, and fight. Produced as a {@link PmsMap} so it flows
// through the exact same pipeline as a parsed .PMS file (buildPolyMap,
// buildMapMesh, spawn handling).
//
// Geometry is authored as axis-aligned rectangles, each emitted as a pair of
// triangles (two {@link MapPolygon}s). Collision normals are written as the
// degenerate {x:0,y:0,z:1}; buildPolyMap derives correct edge normals
// geometrically, so axis-aligned platforms collide regardless of winding.
//
// Coordinates are sim world units with y pointing DOWN (screen-style): smaller
// y is higher up. The renderer container applies the camera, so everything here
// is in world space.

import type {
  MapColor,
  MapPolygon,
  MapSpawnpoint,
  MapVertex,
  PmsMap,
  Vec3,
} from '@soldat/assets';
import { PolyType, SpawnTeam } from '@soldat/assets';

// ---------------------------------------------------------------------------
// Palette — clean greys/blues for a readable arena.
// ---------------------------------------------------------------------------

/** Wide ground floor — a solid mid grey. */
const COLOR_GROUND: MapColor = [70, 78, 88, 255];
/** Floating platforms — a slightly lighter slate grey. */
const COLOR_PLATFORM: MapColor = [96, 106, 120, 255];
/** Side walls — a cool steel blue so they read as boundaries. */
const COLOR_WALL: MapColor = [58, 74, 104, 255];

/** Background gradient: deep navy at the top fading to near-black at the base. */
const BG_TOP: MapColor = [24, 30, 46, 255];
const BG_BTM: MapColor = [8, 10, 18, 255];

// ---------------------------------------------------------------------------
// Degenerate normals — buildPolyMap recomputes real collision normals.
// ---------------------------------------------------------------------------

const Z_NORMAL: Vec3 = { x: 0, y: 0, z: 1 };
const NORMALS: readonly [Vec3, Vec3, Vec3] = [Z_NORMAL, Z_NORMAL, Z_NORMAL];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function vertex(x: number, y: number, color: MapColor): MapVertex {
  return { x, y, z: 0, rhw: 1, color, u: 0, v: 0 };
}

/**
 * Emit a rectangle [x, x+w] x [y, y+h] as two triangles. Vertices are wound
 * consistently; buildPolyMap derives collision normals from the geometry so the
 * exact winding does not matter for collision.
 */
function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  color: MapColor,
): [MapPolygon, MapPolygon] {
  const tl = vertex(x, y, color);
  const tr = vertex(x + w, y, color);
  const br = vertex(x + w, y + h, color);
  const bl = vertex(x, y + h, color);
  return [
    {
      vertices: [tl, tr, br],
      normals: NORMALS,
      polyType: PolyType.Normal,
      textureIndex: 0,
    },
    {
      vertices: [tl, br, bl],
      normals: NORMALS,
      polyType: PolyType.Normal,
      textureIndex: 0,
    },
  ];
}

function spawn(x: number, y: number): MapSpawnpoint {
  return { active: true, x: Math.round(x), y: Math.round(y), team: SpawnTeam.Any };
}

// ---------------------------------------------------------------------------
// Layout description — a single source of truth for platforms + spawns.
// ---------------------------------------------------------------------------

/** Rectangular platform: top-left corner, width, height, and fill color. */
interface Platform {
  x: number;
  y: number;
  w: number;
  h: number;
  color: MapColor;
}

const GROUND_TOP = 400;
const PLATFORM_THICKNESS = 24;
const WALL_THICKNESS = 32;

/**
 * The arena spans roughly x in [-600, 600]. Ground sits at y=400 (top edge),
 * platforms float above it (smaller y). Walls bracket the play area.
 */
const PLATFORMS: readonly Platform[] = [
  // Wide ground floor.
  { x: -600, y: GROUND_TOP, w: 1200, h: 120, color: COLOR_GROUND },

  // Left side wall (rises from the ground).
  { x: -600, y: GROUND_TOP - 260, w: WALL_THICKNESS, h: 260, color: COLOR_WALL },
  // Right side wall.
  { x: 600 - WALL_THICKNESS, y: GROUND_TOP - 260, w: WALL_THICKNESS, h: 260, color: COLOR_WALL },

  // Floating platforms at varied heights.
  { x: -440, y: GROUND_TOP - 110, w: 220, h: PLATFORM_THICKNESS, color: COLOR_PLATFORM },
  { x: -90, y: GROUND_TOP - 200, w: 180, h: PLATFORM_THICKNESS, color: COLOR_PLATFORM },
  { x: 240, y: GROUND_TOP - 120, w: 220, h: PLATFORM_THICKNESS, color: COLOR_PLATFORM },
  { x: 60, y: GROUND_TOP - 320, w: 200, h: PLATFORM_THICKNESS, color: COLOR_PLATFORM },
  { x: -300, y: GROUND_TOP - 350, w: 180, h: PLATFORM_THICKNESS, color: COLOR_PLATFORM },
];

/** Indices into {@link PLATFORMS} that should carry a spawn above them. */
const SPAWN_PLATFORMS: readonly number[] = [0, 3, 4, 5, 6, 7];

/** Vertical offset placing a spawn just above a surface (player half-height-ish). */
const SPAWN_LIFT = 40;

/**
 * Spawn anchors above each chosen platform. Exported so the orchestrator can
 * place the player and bots without re-deriving the geometry.
 */
export const ARENA_SPAWNS: readonly { x: number; y: number }[] = SPAWN_PLATFORMS.map((i) => {
  const p = PLATFORMS[i];
  if (p === undefined) {
    throw new Error(`arena: spawn references missing platform index ${i}`);
  }
  return { x: p.x + p.w / 2, y: p.y - SPAWN_LIFT };
});

// ---------------------------------------------------------------------------
// Map builder
// ---------------------------------------------------------------------------

/**
 * Build the arena as a {@link PmsMap}. Field shape mirrors the parsed .PMS
 * record exactly. Sectors are intentionally empty (sectorsDivision/Num = 0):
 * collision falls back to brute force over all polygons.
 */
export function buildArena(): PmsMap {
  const polygons: MapPolygon[] = [];
  for (const p of PLATFORMS) {
    const [a, b] = rect(p.x, p.y, p.w, p.h, p.color);
    polygons.push(a, b);
  }

  const spawnpoints: MapSpawnpoint[] = ARENA_SPAWNS.map((s) => spawn(s.x, s.y));

  return {
    hash: 0,
    version: 0,
    mapName: 'Arena',
    textures: [],
    bgColorTop: BG_TOP,
    bgColorBtm: BG_BTM,
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
    spawnpoints,
    waypoints: [],
  };
}
