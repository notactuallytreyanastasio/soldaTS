// Read-only .PMS binary map loader.
//
// Faithful port of LoadMapFile / the Read* helpers in shared/MapFile.pas.
// All multi-byte values are little-endian (Pascal x86 in-memory layout, read
// via Move into typed fields). We use a single DataView over the buffer and a
// manually advanced cursor, exactly mirroring TFileBuffer.Pos.
//
// PORT: shared/MapFile.pas:104-451

import { f } from '@soldat/sim';

import { pmsHash } from './crc32';
import {
  MAX_COLLIDERS,
  MAX_CONNECTIONS,
  MAX_POLYS,
  MAX_PROPS,
  MAX_SECTOR,
  MAX_SPAWNPOINTS,
  MAX_WAYPOINTS,
  type MapCollider,
  type MapColor,
  type MapPolygon,
  type MapProp,
  type MapScenery,
  type MapSector,
  type MapSpawnpoint,
  type MapVertex,
  type PmsMap,
  type PolyType,
  type Vec3,
  type Waypoint,
  type WaypointAction,
} from './pms-types';

/** Thrown when the buffer is not a valid / supported .PMS file. */
export class PmsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PmsParseError';
  }
}

/**
 * Cursor over the raw file bytes. PORT: shared/MapFile.pas:104-107 (TFileBuffer).
 * BufferRead (MapFile.pas:185-191) zero-fills past EOF rather than throwing;
 * we reproduce that so truncated files parse like Pascal does.
 */
class FileBuffer {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  pos = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  private inBounds(size: number): boolean {
    // PORT: MapFile.pas:188 — (bf.Pos + Size) <= Length(bf.Data)
    return this.pos + size <= this.bytes.length;
  }

  // PORT: MapFile.pas:193-196 (ReadUint8)
  readUint8(): number {
    const ok = this.inBounds(1);
    const v = ok ? (this.view.getUint8(this.pos) ?? 0) : 0;
    this.pos += 1;
    return v;
  }

  // PORT: MapFile.pas:198-201 (ReadUint16) — little-endian
  readUint16(): number {
    const ok = this.inBounds(2);
    const v = ok ? this.view.getUint16(this.pos, true) : 0;
    this.pos += 2;
    return v;
  }

  // PORT: MapFile.pas:203-206 (ReadInt32) — signed little-endian
  readInt32(): number {
    const ok = this.inBounds(4);
    const v = ok ? this.view.getInt32(this.pos, true) : 0;
    this.pos += 4;
    return v;
  }

  // PORT: MapFile.pas:208-211 (ReadSingle) — IEEE-754 32-bit little-endian.
  // Already a true f32; f() keeps determinism semantics consistent.
  readSingle(): number {
    const ok = this.inBounds(4);
    const v = ok ? this.view.getFloat32(this.pos, true) : 0;
    this.pos += 4;
    return f(v);
  }

  /** Advance without reading (skip padding). PORT: MapFile.pas:357 etc. `Inc(bf.Pos, n)` */
  skip(n: number): void {
    this.pos += n;
  }

  /**
   * Length-prefixed, fixed-width string.
   * PORT: shared/MapFile.pas:213-231 (ReadString).
   * Byte 0 = length n. Always consume MaxSize data bytes. If n is invalid
   * (>= 129 buffer or > MaxSize), Pascal returns '' but still advances MaxSize.
   */
  readString(maxSize: number): string {
    const n = this.readUint8();
    const start = this.pos;
    // Always advance MaxSize regardless of validity (MapFile.pas:223 / 229).
    this.skip(maxSize);
    if (n >= 129 || n > maxSize) {
      return '';
    }
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = this.bytes[start + i];
      if (c === undefined || c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}

/**
 * Read a color. PORT: shared/MapFile.pas:240-246 (ReadColor).
 * File order is B, G, R, A; the Pascal helper stores them into result slots
 * [2],[1],[0],[3], yielding in-memory [r, g, b, a].
 */
function readColor(bf: FileBuffer): MapColor {
  const b = bf.readUint8(); // -> Result[2]
  const g = bf.readUint8(); // -> Result[1]
  const r = bf.readUint8(); // -> Result[0]
  const a = bf.readUint8(); // -> Result[3]
  return [r, g, b, a] as const;
}

// PORT: shared/MapFile.pas:233-238 (ReadVec3)
function readVec3(bf: FileBuffer): Vec3 {
  return { x: bf.readSingle(), y: bf.readSingle(), z: bf.readSingle() };
}

// PORT: shared/MapFile.pas:248-257 (ReadVertex)
function readVertex(bf: FileBuffer): MapVertex {
  return {
    x: bf.readSingle(),
    y: bf.readSingle(),
    z: bf.readSingle(),
    rhw: bf.readSingle(),
    color: readColor(bf),
    u: bf.readSingle(),
    v: bf.readSingle(),
  };
}

/**
 * Parse a .PMS file from a raw buffer and validate its CRC32.
 * PORT: shared/MapFile.pas:271-451 (LoadMapFile).
 */
export function loadPms(buffer: ArrayBuffer): PmsMap {
  const bf = new FileBuffer(buffer);

  // --- header / options --- PORT: MapFile.pas:282-298
  const version = bf.readInt32();
  const mapName = bf.readString(38);
  const texture0 = bf.readString(24);
  const bgColorTop = readColor(bf);
  const bgColorBtm = readColor(bf);
  const startJet = bf.readInt32();
  const grenadePacks = bf.readUint8();
  const medikits = bf.readUint8();
  const weather = bf.readUint8();
  const steps = bf.readUint8();
  const randomId = bf.readInt32();

  // --- polygons --- PORT: MapFile.pas:300-319
  let n = bf.readInt32();
  if (n > MAX_POLYS || n < 0) {
    throw new PmsParseError(`polygon count out of range: ${n}`);
  }
  const polygons: MapPolygon[] = [];
  for (let i = 0; i < n; i++) {
    const v1 = readVertex(bf);
    const v2 = readVertex(bf);
    const v3 = readVertex(bf);
    const nrm1 = readVec3(bf);
    const nrm2 = readVec3(bf);
    const nrm3 = readVec3(bf);
    const polyType = bf.readUint8() as PolyType;
    polygons.push({
      vertices: [v1, v2, v3] as const,
      normals: [nrm1, nrm2, nrm3] as const,
      polyType,
      textureIndex: 0, // PORT: MapFile.pas:318 — always 0
    });
  }

  // --- sectors --- PORT: MapFile.pas:321-344
  const sectorsDivision = bf.readInt32();
  const sectorsNum = bf.readInt32();
  if (sectorsNum > MAX_SECTOR || sectorsNum < 0) {
    throw new PmsParseError(`sectorsNum out of range: ${sectorsNum}`);
  }
  const sectorCount = (2 * sectorsNum + 1) * (2 * sectorsNum + 1);
  const sectors: MapSector[] = [];
  for (let i = 0; i < sectorCount; i++) {
    const m = bf.readUint16();
    if (m > MAX_POLYS) {
      throw new PmsParseError(`sector polygon count out of range: ${m}`);
    }
    const polys: number[] = [];
    for (let j = 0; j < m; j++) {
      polys.push(bf.readUint16());
    }
    sectors.push({ polys });
  }

  // --- props --- PORT: MapFile.pas:346-369
  n = bf.readInt32();
  if (n > MAX_PROPS || n < 0) {
    throw new PmsParseError(`prop count out of range: ${n}`);
  }
  const props: MapProp[] = [];
  for (let i = 0; i < n; i++) {
    const active = bf.readUint8() !== 0;
    bf.skip(1); // PORT: MapFile.pas:357 — Inc(bf.Pos, 1)
    const style = bf.readUint16();
    const width = bf.readInt32();
    const height = bf.readInt32();
    const x = bf.readSingle();
    const y = bf.readSingle();
    const rotation = bf.readSingle();
    const scaleX = bf.readSingle();
    const scaleY = bf.readSingle();
    const alpha = bf.readUint8();
    bf.skip(3); // PORT: MapFile.pas:366 — Inc(bf.Pos, 3)
    const color = readColor(bf);
    const level = bf.readUint8();
    bf.skip(3); // PORT: MapFile.pas:368 — Inc(bf.Pos, 3)
    props.push({
      active,
      style,
      width,
      height,
      x,
      y,
      rotation,
      scaleX,
      scaleY,
      alpha,
      color,
      level,
    });
  }

  // --- scenery --- PORT: MapFile.pas:371-384
  n = bf.readInt32();
  if (n > MAX_PROPS || n < 0) {
    throw new PmsParseError(`scenery count out of range: ${n}`);
  }
  const scenery: MapScenery[] = [];
  for (let i = 0; i < n; i++) {
    const filename = bf.readString(50);
    const date = bf.readInt32();
    scenery.push({ filename, date });
  }

  // --- colliders --- PORT: MapFile.pas:386-401
  n = bf.readInt32();
  if (n > MAX_COLLIDERS || n < 0) {
    throw new PmsParseError(`collider count out of range: ${n}`);
  }
  const colliders: MapCollider[] = [];
  for (let i = 0; i < n; i++) {
    const active = bf.readUint8() !== 0;
    bf.skip(3); // PORT: MapFile.pas:397 — Inc(bf.Pos, 3)
    const x = bf.readSingle();
    const y = bf.readSingle();
    const radius = bf.readSingle();
    colliders.push({ active, x, y, radius });
  }

  // --- spawnpoints --- PORT: MapFile.pas:403-418
  n = bf.readInt32();
  if (n > MAX_SPAWNPOINTS || n < 0) {
    throw new PmsParseError(`spawnpoint count out of range: ${n}`);
  }
  const spawnpoints: MapSpawnpoint[] = [];
  for (let i = 0; i < n; i++) {
    const active = bf.readUint8() !== 0;
    bf.skip(3); // PORT: MapFile.pas:414 — Inc(bf.Pos, 3)
    const x = bf.readInt32();
    const y = bf.readInt32();
    const team = bf.readInt32();
    spawnpoints.push({ active, x, y, team });
  }

  // --- waypoints --- PORT: MapFile.pas:420-447
  n = bf.readInt32();
  if (n > MAX_WAYPOINTS || n < 0) {
    throw new PmsParseError(`waypoint count out of range: ${n}`);
  }
  const waypoints: Waypoint[] = [];
  for (let i = 0; i < n; i++) {
    const active = bf.readUint8() !== 0;
    bf.skip(3); // PORT: MapFile.pas:431 — Inc(bf.Pos, 3)
    const id = bf.readInt32();
    const x = bf.readInt32();
    const y = bf.readInt32();
    const left = bf.readUint8() !== 0;
    const right = bf.readUint8() !== 0;
    const up = bf.readUint8() !== 0;
    const down = bf.readUint8() !== 0;
    const jetpack = bf.readUint8() !== 0;
    const pathNum = bf.readUint8();
    const action = bf.readUint8() as WaypointAction;
    bf.skip(5); // PORT: MapFile.pas:442 — Inc(bf.Pos, 5)
    const connectionsNum = bf.readInt32();
    const connections: number[] = [];
    for (let j = 0; j < MAX_CONNECTIONS; j++) {
      connections.push(bf.readInt32());
    }
    waypoints.push({
      active,
      id,
      x,
      y,
      left,
      right,
      up,
      down,
      jetpack,
      pathNum,
      action,
      connectionsNum,
      connections,
    });
  }

  // --- hash --- PORT: MapFile.pas:449 — crc32(5381, @bf.Data[0], Length)
  const hash = pmsHash(bf.bytes);

  return {
    hash,
    version,
    mapName,
    textures: [texture0],
    bgColorTop,
    bgColorBtm,
    startJet,
    grenadePacks,
    medikits,
    weather,
    steps,
    randomId,
    polygons,
    sectorsDivision,
    sectorsNum,
    sectors,
    props,
    scenery,
    colliders,
    spawnpoints,
    waypoints,
  };
}
