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

const GROUND_TOP = 560;
const PLATFORM_THICKNESS = 24;
const WALL_THICKNESS = 32;

/**
 * "Skyreach" — a big AERIAL arena (goal node 124, iterated by node 127):
 * jetpack dogfights are the point, so most of the playable space is open sky.
 * The arena spans x in [-1400, 1400] and ~1100px of altitude, SEALED at the
 * top — bots hovering on the fuel trickle drifted ever upward until matches
 * left the map, so a ceiling slab now bounds the airspace.
 *
 * The pad layout is deliberately IRREGULAR (node 127 "less uniform"): no two
 * pads share a height, widths vary 130-300px, and density is asymmetric — a
 * stacked western face, an open eastern bowl, one central high island. Pads
 * are perches to reload/refuel on, not floors to fight on; getting anywhere
 * means flying.
 */
const CEILING_Y = GROUND_TOP - 1080; // top edge of the airspace (y=-520)

const PLATFORMS: readonly Platform[] = [
  // Ground floor — the fallback net, not the battlefield.
  { x: -1400, y: GROUND_TOP, w: 2800, h: 140, color: COLOR_GROUND },
  // Side walls, ceiling to ground: the airspace is a closed box.
  { x: -1400, y: CEILING_Y, w: WALL_THICKNESS, h: 1080, color: COLOR_WALL },
  { x: 1400 - WALL_THICKNESS, y: CEILING_Y, w: WALL_THICKNESS, h: 1080, color: COLOR_WALL },
  // Ceiling slab — the height limit.
  { x: -1400, y: CEILING_Y - 40, w: 2800, h: 40, color: COLOR_WALL },

  // Western face — dense, stacked, climbs like a cliff. [4..8]
  { x: -1180, y: 470, w: 300, h: 28, color: COLOR_PLATFORM },
  { x: -620, y: 330, w: 150, h: 20, color: COLOR_PLATFORM },
  { x: -880, y: 150, w: 200, h: PLATFORM_THICKNESS, color: COLOR_PLATFORM },
  { x: -1230, y: -40, w: 170, h: 20, color: COLOR_PLATFORM },
  { x: -420, y: -130, w: 130, h: PLATFORM_THICKNESS, color: COLOR_PLATFORM },

  // Center — a wide mid bench, a small step, one high island. [9..11]
  { x: -150, y: 240, w: 260, h: 32, color: COLOR_PLATFORM },
  { x: 80, y: 30, w: 140, h: 20, color: COLOR_PLATFORM },
  { x: -100, y: -310, w: 180, h: PLATFORM_THICKNESS, color: COLOR_PLATFORM },

  // Eastern bowl — sparse and open, long sightlines. [12..15]
  { x: 330, y: 380, w: 220, h: 28, color: COLOR_PLATFORM },
  { x: 560, y: 140, w: 130, h: 20, color: COLOR_PLATFORM },
  { x: 900, y: 260, w: 280, h: PLATFORM_THICKNESS, color: COLOR_PLATFORM },
  { x: 1120, y: -90, w: 160, h: 20, color: COLOR_PLATFORM },

  // Apex perches, tight under the ceiling. [16..18]
  { x: 640, y: -260, w: 140, h: PLATFORM_THICKNESS, color: COLOR_PLATFORM },
  { x: 300, y: -440, w: 170, h: 20, color: COLOR_PLATFORM },
  { x: -700, y: -420, w: 150, h: 20, color: COLOR_PLATFORM },
];

/**
 * Indices into {@link PLATFORMS} that carry spawns — spread across the
 * western face, center, bowl, and apex so fights START in the air and arrive
 * from uneven angles.
 */
const SPAWN_PLATFORMS: readonly number[] = [4, 5, 6, 8, 9, 11, 12, 14, 16, 18];

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
    mapName: 'Skyreach',
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
