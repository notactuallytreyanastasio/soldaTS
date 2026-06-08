# .PMS Binary Map File Format Specification

## Overview

The .PMS format is OpenSoldat's binary map file format. The file contains collision polygons, sectors (spatial hash), props, scenery, colliders, spawnpoints, and bot waypoints. All multi-byte integers use little-endian byte order.

## Header and Options (Bytes 0-62)

| Field | Type | Size | Byte Offset | Description |
|-------|------|------|-------------|-------------|
| Version | Int32 | 4 | 0-3 | Map format version number |
| MapName | String | 39 | 4-42 | Length-prefixed string: 1 byte length (0-38) + 38 bytes padded data |
| Texture0 | String | 25 | 43-67 | Length-prefixed string: 1 byte length (0-24) + 24 bytes padded data |
| BgColorTop | TMapColor | 4 | 68-71 | Background color (top), order: B, G, R, A (bytes read as Uint8 in order) |
| BgColorBtm | TMapColor | 4 | 72-75 | Background color (bottom), order: B, G, R, A |
| StartJet | Int32 | 4 | 76-79 | Starting jet time in game units |
| GrenadePacks | Uint8 | 1 | 80 | Number of grenade packs on map |
| Medikits | Uint8 | 1 | 81 | Number of medikits on map |
| Weather | Uint8 | 1 | 82 | Weather type (0-255) |
| Steps | Uint8 | 1 | 83 | Steps type (0-255) |
| RandomID | Int32 | 4 | 84-87 | Random map seed/ID |

**String Format**: All strings are length-prefixed. First byte is the actual string length (0-MaxSize). Remaining bytes are the padded data (read regardless of length).

## Polygons Section

| Field | Type | Size | Description |
|-------|------|------|-------------|
| PolygonCount | Int32 | 4 | Number of polygons (0 to MAX_POLYS = 5000) |
| Polygons[PolygonCount] | TMapPolygon | variable | Array of polygons |

### TMapPolygon Structure (repeated PolygonCount times)

Each polygon contains 3 vertices and 3 normals (one per vertex/edge):

| Field | Type | Size | Description |
|-------|------|------|-------------|
| Vertex[1] | TMapVertex | 40 | First triangle vertex |
| Vertex[2] | TMapVertex | 40 | Second triangle vertex |
| Vertex[3] | TMapVertex | 40 | Third triangle vertex |
| Normal[1] | TVector3 | 12 | Normal at edge 1 (length encodes bounciness) |
| Normal[2] | TVector3 | 12 | Normal at edge 2 (length encodes bounciness) |
| Normal[3] | TVector3 | 12 | Normal at edge 3 (length encodes bounciness) |
| PolyType | Uint8 | 1 | Polygon type/flags (0-25) |
| TextureIndex | Uint8 | 1 | (Set to 0 during load; unused in file) |

**Total per polygon**: 40 + 40 + 40 + 12 + 12 + 12 + 1 + 1 = 158 bytes

### TMapVertex Structure

| Field | Type | Size | Byte Order | Description |
|-------|------|------|-----------|-------------|
| x | Single | 4 | IEEE 754 | X coordinate (3D) |
| y | Single | 4 | IEEE 754 | Y coordinate (3D) |
| z | Single | 4 | IEEE 754 | Z coordinate (3D) |
| rhw | Single | 4 | IEEE 754 | Rhw (1.0 typically; Direct3D legacy) |
| Color | TMapColor | 4 | - | Vertex color (B, G, R, A) |
| u | Single | 4 | IEEE 754 | Texture U coordinate |
| v | Single | 4 | IEEE 754 | Texture V coordinate |

### TVector3 Structure

| Field | Type | Size | Description |
|-------|------|------|-------------|
| x | Single | 4 | X component |
| y | Single | 4 | Y component |
| z | Single | 4 | Z component |

## Normal Vector Bounciness Encoding

The length of `Normal[3]` (third normal in a polygon) encodes the polygon's bounciness value. In-memory, this is computed as:

```pascal
Bounciness[i] := Vec2Length(Normal[3])  // PolyMap.pas:204
```

Where `Vec2Length(v) = Sqrt(v.x^2 + v.y^2)`. The normal is then normalized by dividing x and y by this length, meaning:
- Bounciness > 1.0 = bouncy polygon
- Bounciness = 1.0 = normal polygon  
- Bounciness < 1.0 = reduced bounce

## Sectors Section (Spatial Hash Grid)

| Field | Type | Size | Description |
|-------|------|------|-------------|
| SectorsDivision | Int32 | 4 | World coordinate divisor (e.g., 200 means 200-unit grid cells) |
| SectorsNum | Int32 | 4 | Half-dimension of sector grid (e.g., 25 means -25 to +25 in each direction) |
| Sectors[(2*SectorsNum+1)^2] | TMapSector[] | variable | Flattened 2D grid of sectors in row-major order |

**Grid Organization**: If SectorsNum = 25, grid is 51x51 = 2601 sectors. Sectors are stored in row-major order (i=0 to 50, then j=0 to 50). Grid indices map as: (i - SectorsNum) and (j - SectorsNum) to get world sector coordinates from -SectorsNum to +SectorsNum.

**Collision Query**: To find sector containing point (x, y):
```pascal
kx := Round(x / SectorsDivision)
ky := Round(y / SectorsDivision)
```

### TMapSector Structure

| Field | Type | Size | Description |
|-------|------|------|-------------|
| PolygonCount | Uint16 | 2 | Number of polygon indices in this sector |
| PolygonIndices[PolygonCount] | Uint16[] | 2*PolygonCount | Indices into global Polygons array |

**Note**: In-memory, sectors use 1-based indexing (Polys[1..n]), but file stores only the polygon count as Uint16 followed by PolygonCount indices.

## Props Section

| Field | Type | Size | Description |
|-------|------|------|-------------|
| PropCount | Int32 | 4 | Number of props (0 to MAX_PROPS = 500) |
| Props[PropCount] | TMapProp | variable | Array of props |

### TMapProp Structure

| Field | Type | Size | Byte Offset | Description |
|-------|------|------|-------------|-------------|
| Active | Uint8 | 1 | 0 | Boolean (nonzero = active) |
| Padding | Uint8 | 1 | 1 | Padding byte (skipped) |
| Style | Uint16 | 2 | 2-3 | Prop style ID (index into Scenery array) |
| Width | Int32 | 4 | 4-7 | Prop width in pixels |
| Height | Int32 | 4 | 8-11 | Prop height in pixels |
| X | Single | 4 | 12-15 | X position (world coordinates) |
| Y | Single | 4 | 16-19 | Y position (world coordinates) |
| Rotation | Single | 4 | 20-23 | Rotation angle (radians) |
| ScaleX | Single | 4 | 24-27 | Scale X multiplier |
| ScaleY | Single | 4 | 28-31 | Scale Y multiplier |
| Alpha | Uint8 | 1 | 32 | Opacity (0-255) |
| Padding | Uint8 | 3 | 33-35 | 3 padding bytes (skipped) |
| Color | TMapColor | 4 | 36-39 | Tint color (B, G, R, A) |
| Level | Uint8 | 1 | 40 | Draw layer (0-2 or higher) |
| Padding | Uint8 | 3 | 41-43 | 3 padding bytes (skipped) |

**Total per prop**: 44 bytes

## Scenery Section

| Field | Type | Size | Description |
|-------|------|------|-------------|
| SceneryCount | Int32 | 4 | Number of scenery definitions (0 to MAX_PROPS = 500) |
| Scenery[SceneryCount] | TMapScenery | variable | Array of scenery |

### TMapScenery Structure

| Field | Type | Size | Description |
|-------|------|------|-------------|
| Filename | String | 51 | Prop sprite filename (1 length byte + 50 data bytes) |
| Date | Int32 | 4 | File modification date (Unix timestamp or zero) |

**Total per scenery**: 55 bytes

## Colliders Section (Circular Collision Zones)

| Field | Type | Size | Description |
|-------|------|------|-------------|
| ColliderCount | Int32 | 4 | Number of colliders (0 to MAX_COLLIDERS = 128) |
| Colliders[ColliderCount] | TMapCollider | variable | Array of colliders |

### TMapCollider Structure

| Field | Type | Size | Byte Offset | Description |
|-------|------|------|-------------|-------------|
| Active | Uint8 | 1 | 0 | Boolean (nonzero = active) |
| Padding | Uint8 | 3 | 1-3 | 3 padding bytes (skipped) |
| X | Single | 4 | 4-7 | Center X coordinate |
| Y | Single | 4 | 8-11 | Center Y coordinate |
| Radius | Single | 4 | 12-15 | Collision radius |

**Total per collider**: 16 bytes

## Spawnpoints Section

| Field | Type | Size | Description |
|-------|------|------|-------------|
| SpawnpointCount | Int32 | 4 | Number of spawnpoints (0 to MAX_SPAWNPOINTS = 255) |
| Spawnpoints[SpawnpointCount] | TMapSpawnpoint | variable | Array of spawnpoints |

### TMapSpawnpoint Structure

| Field | Type | Size | Byte Offset | Description |
|-------|------|------|-------------|-------------|
| Active | Uint8 | 1 | 0 | Boolean (nonzero = active) |
| Padding | Uint8 | 3 | 1-3 | 3 padding bytes (skipped) |
| X | Int32 | 4 | 4-7 | X coordinate (integer units) |
| Y | Int32 | 4 | 8-11 | Y coordinate (integer units) |
| Team | Int32 | 4 | 12-15 | Team ID: 1=Alpha, 2=Bravo, 3=Charlie, 4=Delta, 5=Flag1, 6=Flag2, 0=any |

**Total per spawnpoint**: 16 bytes

## Waypoints Section (Bot Path Nodes)

| Field | Type | Size | Description |
|-------|------|------|-------------|
| WaypointCount | Int32 | 4 | Number of waypoints (0 to MAX_WAYPOINTS = 5000) |
| Waypoints[WaypointCount] | TWaypoint | variable | Array of waypoints |

### TWaypoint Structure

| Field | Type | Size | Byte Offset | Description |
|-------|------|------|-------------|-------------|
| Active | Uint8 | 1 | 0 | Boolean (nonzero = active) |
| Padding | Uint8 | 3 | 1-3 | 3 padding bytes (skipped) |
| Id | Int32 | 4 | 4-7 | Unique waypoint identifier |
| X | Int32 | 4 | 8-11 | X coordinate (integer units) |
| Y | Int32 | 4 | 12-15 | Y coordinate (integer units) |
| Left | Uint8 | 1 | 16 | Boolean (can go left) |
| Right | Uint8 | 1 | 17 | Boolean (can go right) |
| Up | Uint8 | 1 | 18 | Boolean (can go up) |
| Down | Uint8 | 1 | 19 | Boolean (can go down) |
| Jetpack | Uint8 | 1 | 20 | Boolean (use jetpack) |
| PathNum | Uint8 | 1 | 21 | Path number/group identifier |
| Action | Uint8 | 1 | 22 | TWaypointAction enum (0-6): None=0, StopAndCamp=1, Wait1Second=2, Wait5Seconds=3, Wait10Seconds=4, Wait15Seconds=5, Wait20Seconds=6 |
| Padding | Uint8 | 5 | 23-27 | 5 padding bytes (skipped) |
| ConnectionsNum | Int32 | 4 | 28-31 | Number of waypoint connections (0 to MAX_CONNECTIONS = 20) |
| Connections[MAX_CONNECTIONS] | Int32[] | 80 | 32-111 | Array of 20 Int32 waypoint IDs (indices 1-20) |

**Total per waypoint**: 112 bytes

## CRC32 Hash Calculation

After all file data is read, a CRC32 hash is computed over the entire file contents:

```pascal
Hash := crc32(5381, @FileData[0], Length(FileData))
```

**CRC32 Algorithm** (MapFile.pas:145-154):
- Initial seed: 5381 (arbitrary starting value for this implementation)
- Polynomial table: 256-entry lookup table (lines 110-143)
- Update formula: `Result := CRCTable[Data^ xor ((Result shr 24) and $FF)] xor (Result shl 8)`
- Process one byte at a time, updating Result

The CRC32 polynomial used is the standard CRC-32-IEEE (0x04C11DB7, reflected). The full table is provided in MapFile.pas lines 110-143.

**Hash Storage**: The computed hash is stored in `TMapFile.Hash` (Int32 unsigned). This hash is used for map validation between client and server to ensure map consistency.

## Polygon Type Enumeration (POLY_TYPE_*)

All numeric values and gameplay meanings from PolyMap.pas:22-47:

| Constant | Value | Gameplay Meaning |
|----------|-------|------------------|
| POLY_TYPE_NORMAL | 0 | Standard collision polygon |
| POLY_TYPE_ONLY_BULLETS | 1 | Only bullets collide; players pass through |
| POLY_TYPE_ONLY_PLAYER | 2 | Only players collide; bullets pass through |
| POLY_TYPE_DOESNT | 3 | No collision (visual only, or both pass through) |
| POLY_TYPE_ICE | 4 | Slippery surface (reduced friction) |
| POLY_TYPE_DEADLY | 5 | Instant kill on contact |
| POLY_TYPE_BLOODY_DEADLY | 6 | Instant kill with gore effects |
| POLY_TYPE_HURTS | 7 | Damage on contact (non-lethal) |
| POLY_TYPE_REGENERATES | 8 | Heals players on contact |
| POLY_TYPE_LAVA | 9 | Damage over time on contact |
| POLY_TYPE_RED_BULLETS | 10 | Only Red/Alpha team bullets collide |
| POLY_TYPE_RED_PLAYER | 11 | Only Red/Alpha team players collide |
| POLY_TYPE_BLUE_BULLETS | 12 | Only Blue/Bravo team bullets collide |
| POLY_TYPE_BLUE_PLAYER | 13 | Only Blue/Bravo team players collide |
| POLY_TYPE_YELLOW_BULLETS | 14 | Only Yellow/Charlie team bullets collide |
| POLY_TYPE_YELLOW_PLAYER | 15 | Only Yellow/Charlie team players collide |
| POLY_TYPE_GREEN_BULLETS | 16 | Only Green/Delta team bullets collide |
| POLY_TYPE_GREEN_PLAYER | 17 | Only Green/Delta team players collide |
| POLY_TYPE_BOUNCY | 18 | Bouncy surface (bounciness encoded in Normal[3] length) |
| POLY_TYPE_EXPLODES | 19 | Triggers explosion on impact |
| POLY_TYPE_HURTS_FLAGGERS | 20 | Damages flag carriers (CTF mode) |
| POLY_TYPE_ONLY_FLAGGERS | 21 | Only flag carriers collide |
| POLY_TYPE_NOT_FLAGGERS | 22 | Excludes flag carriers from collision |
| POLY_TYPE_NON_FLAGGER_COLLIDES | 23 | Only non-flag-carriers collide |
| POLY_TYPE_BACKGROUND | 24 | Background decoration (no collision) |
| POLY_TYPE_BACKGROUND_TRANSITION | 25 | Background transition layer (no collision) |

## Map Capacity Constants

From PolyMap.pas and Waypoints.pas:

| Constant | Value | Description |
|----------|-------|-------------|
| MAX_POLYS | 5000 | Maximum number of collision polygons |
| MAX_SECTOR | 25 | Maximum half-dimension of sector grid |
| MAX_PROPS | 500 | Maximum number of props and scenery |
| MAX_COLLIDERS | 128 | Maximum number of circular colliders |
| MAX_SPAWNPOINTS | 255 | Maximum number of spawnpoints |
| MAX_WAYPOINTS | 5000 | Maximum number of bot waypoints |
| MAX_CONNECTIONS | 20 | Maximum connections per waypoint |
| TILESECTOR | 3 | Tile/sector conversion factor |
| MIN_SECTOR | -25 | Minimum sector index |
| MAX_SECTOR | 25 | Maximum sector index |
| MIN_SECTORZ | -35 | Minimum extended sector index (Z) |
| MAX_SECTORZ | 35 | Maximum extended sector index (Z) |

**Sector Grid Layout**: With SectorsNum = N, the sector grid is (2N+1) x (2N+1). For N=25, that is 51x51 = 2601 total sectors. In-memory, sectors are indexed from -N to +N in each dimension.

## Collision Query Model

Collision detection uses a spatial hash grid (sector-based):

1. **Sector Lookup**: Given position (x, y), compute sector indices:
   ```pascal
   kx := Round(x / SectorsDivision);
   ky := Round(y / SectorsDivision);
   ```

2. **Sector Bounds Check**: Verify sector is within valid range:
   ```pascal
   if (kx > -SectorsNum) and (kx < SectorsNum) and
      (ky > -SectorsNum) and (ky < SectorsNum) then
   ```

3. **Polygon Iteration**: For each polygon index in `Sectors[kx, ky].Polys[]`:
   - Test point-in-polygon using 2D half-plane method
   - If inside, compute closest perpendicular distance to polygon edges
   - Scale perpendicular by 1.5x the distance for push-out vector

4. **Type-Based Filtering**: Collision acceptance depends on entity type (player/flag/bullet) and polygon type (PolyMap.pas:538-540, 574-575)

## Key Implementation Notes

1. **String Reading**: The `ReadString` function reads a length byte (capped at MaxSize), then always reads MaxSize data bytes regardless of actual string length. The string is null-terminated based on the length byte.

2. **Padding**: Props, colliders, spawnpoints, and waypoints contain padding bytes that are explicitly skipped during read. These must be preserved when writing.

3. **1-Based Indexing**: In-memory structures use 1-based arrays for polygons (Polys[1..PolyCount]), but file format uses 0-based iteration (i := 0 to n-1). Sector polygon indices are stored as Uint16 and treated as 1-based in-memory (Sectors[i, j].Polys[1..m]).

4. **Color Format**: All colors are stored in BGRA order (Blue, Green, Red, Alpha), read as 4 sequential Uint8 values.

5. **Waypoint ID vs Index**: Waypoint.Id is a user-defined identifier, distinct from array index. Connections reference waypoint IDs, not array indices.

6. **Out-of-Bounds Validation**: Spawnpoints and waypoints with |x| >= 2000000 or |y| >= 2000000 are marked inactive during load (PolyMap.pas:237-256).

7. **Sector Count Formula**: Total sectors = (2 * SectorsNum + 1) * (2 * SectorsNum + 1), stored in row-major order.

8. **Bounciness Encoding**: Only the length of Normal[3] is used. The normal is normalized after length extraction, so the length value is effectively "baked in" to the normal vector during file creation.