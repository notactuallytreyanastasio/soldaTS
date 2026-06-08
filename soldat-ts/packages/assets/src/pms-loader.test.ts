import { describe, expect, it } from 'vitest';

import { crc32, PMS_CRC_SEED, pmsHash } from './crc32';
import { loadPms, PmsParseError } from './pms-loader';
import { PolyType, SpawnTeam, WaypointAction, MAX_CONNECTIONS } from './pms-types';

// ---------------------------------------------------------------------------
// Minimal little-endian writer that mirrors the .PMS read layout in MapFile.pas.
// Used only to synthesize a valid file in-memory; the loader is the unit under
// test, the writer is just scaffolding.
// ---------------------------------------------------------------------------

class Writer {
  private bytes: number[] = [];

  uint8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }
  uint16(v: number): this {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  int32(v: number): this {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setInt32(0, v, true);
    this.bytes.push(...new Uint8Array(buf));
    return this;
  }
  single(v: number): this {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, true);
    this.bytes.push(...new Uint8Array(buf));
    return this;
  }
  /** length-prefixed fixed-width string: 1 length byte + maxSize padded data */
  str(s: string, maxSize: number): this {
    this.uint8(s.length);
    for (let i = 0; i < maxSize; i++) {
      this.uint8(i < s.length ? s.charCodeAt(i) : 0);
    }
    return this;
  }
  /** file order is B, G, R, A */
  color(r: number, g: number, b: number, a: number): this {
    return this.uint8(b).uint8(g).uint8(r).uint8(a);
  }
  pad(n: number): this {
    for (let i = 0; i < n; i++) this.uint8(0);
    return this;
  }
  vec3(x: number, y: number, z: number): this {
    return this.single(x).single(y).single(z);
  }
  vertex(x: number, y: number): this {
    // x, y, z, rhw, color(BGRA), u, v
    return this.single(x).single(y).single(0).single(1).color(10, 20, 30, 40).single(0).single(0);
  }

  toArrayBuffer(): ArrayBuffer {
    const out = new Uint8Array(this.bytes);
    return out.buffer.slice(0) as ArrayBuffer;
  }
}

function buildMinimalPms(): ArrayBuffer {
  const w = new Writer();

  // header / options
  w.int32(11); // version
  w.str('ctf_Test', 38); // mapName
  w.str('texture.bmp', 24); // texture0
  w.color(1, 2, 3, 255); // bgColorTop r=1 g=2 b=3 a=255
  w.color(4, 5, 6, 128); // bgColorBtm
  w.int32(8); // startJet
  w.uint8(2); // grenadePacks
  w.uint8(3); // medikits
  w.uint8(1); // weather
  w.uint8(0); // steps
  w.int32(123456); // randomId

  // polygons: 1 polygon
  w.int32(1);
  w.vertex(100, 200);
  w.vertex(300, 400);
  w.vertex(500, 600);
  w.vec3(0, -1, 0);
  w.vec3(1, 0, 0);
  w.vec3(0, 1, 0);
  w.uint8(PolyType.Ice); // polyType = 4

  // sectors: sectorsDivision, sectorsNum
  w.int32(200); // sectorsDivision
  w.int32(1); // sectorsNum -> grid (2*1+1)^2 = 9 sectors
  for (let i = 0; i < 9; i++) {
    if (i === 4) {
      // center sector references polygon index 1
      w.uint16(1); // count
      w.uint16(1); // poly index
    } else {
      w.uint16(0); // empty
    }
  }

  // props: 1
  w.int32(1);
  w.uint8(1).pad(1); // active + padding
  w.uint16(7); // style
  w.int32(64); // width
  w.int32(48); // height
  w.single(12.5); // x
  w.single(-7.25); // y
  w.single(1.5); // rotation
  w.single(2); // scaleX
  w.single(0.5); // scaleY
  w.uint8(200).pad(3); // alpha + padding
  w.color(9, 8, 7, 255); // color r=9 g=8 b=7
  w.uint8(1).pad(3); // level + padding

  // scenery: 1
  w.int32(1);
  w.str('grass.bmp', 50);
  w.int32(20240101);

  // colliders: 1
  w.int32(1);
  w.uint8(1).pad(3); // active + padding
  w.single(50).single(60).single(15); // x, y, radius

  // spawnpoints: 1
  w.int32(1);
  w.uint8(1).pad(3); // active + padding
  w.int32(-100); // x
  w.int32(250); // y
  w.int32(SpawnTeam.Bravo); // team = 2

  // waypoints: 1
  w.int32(1);
  w.uint8(1).pad(3); // active + padding
  w.int32(42); // id
  w.int32(11); // x
  w.int32(22); // y
  w.uint8(1); // left
  w.uint8(0); // right
  w.uint8(1); // up
  w.uint8(0); // down
  w.uint8(1); // jetpack
  w.uint8(3); // pathNum
  w.uint8(WaypointAction.Wait5Seconds); // action = 3
  w.pad(5); // padding
  w.int32(2); // connectionsNum
  // MAX_CONNECTIONS int32 connection ids
  for (let j = 0; j < MAX_CONNECTIONS; j++) {
    w.int32(j < 2 ? 100 + j : 0);
  }

  return w.toArrayBuffer();
}

describe('loadPms', () => {
  const map = loadPms(buildMinimalPms());

  it('parses header / options', () => {
    expect(map.version).toBe(11);
    expect(map.mapName).toBe('ctf_Test');
    expect(map.textures).toEqual(['texture.bmp']);
    expect(map.bgColorTop).toEqual([1, 2, 3, 255]); // [r,g,b,a]
    expect(map.bgColorBtm).toEqual([4, 5, 6, 128]);
    expect(map.startJet).toBe(8);
    expect(map.grenadePacks).toBe(2);
    expect(map.medikits).toBe(3);
    expect(map.weather).toBe(1);
    expect(map.steps).toBe(0);
    expect(map.randomId).toBe(123456);
  });

  it('parses polygons with vertices, normals, type, and 0 texture index', () => {
    expect(map.polygons).toHaveLength(1);
    const p = map.polygons[0]!;
    expect(p.polyType).toBe(PolyType.Ice);
    expect(p.textureIndex).toBe(0);
    expect(p.vertices[0]!.x).toBeCloseTo(100);
    expect(p.vertices[0]!.y).toBeCloseTo(200);
    expect(p.vertices[2]!.x).toBeCloseTo(500);
    // color stored in-memory as [r,g,b,a] from BGRA file bytes
    expect(p.vertices[0]!.color).toEqual([10, 20, 30, 40]);
    expect(p.normals[0]).toEqual({ x: 0, y: -1, z: 0 });
    expect(p.normals[2]).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('parses the sector grid (row-major, count-prefixed)', () => {
    expect(map.sectorsDivision).toBe(200);
    expect(map.sectorsNum).toBe(1);
    expect(map.sectors).toHaveLength(9);
    expect(map.sectors[4]!.polys).toEqual([1]);
    expect(map.sectors[0]!.polys).toEqual([]);
  });

  it('parses props (with padding skipped)', () => {
    expect(map.props).toHaveLength(1);
    const prop = map.props[0]!;
    expect(prop.active).toBe(true);
    expect(prop.style).toBe(7);
    expect(prop.width).toBe(64);
    expect(prop.height).toBe(48);
    expect(prop.x).toBeCloseTo(12.5);
    expect(prop.y).toBeCloseTo(-7.25);
    expect(prop.rotation).toBeCloseTo(1.5);
    expect(prop.scaleX).toBeCloseTo(2);
    expect(prop.scaleY).toBeCloseTo(0.5);
    expect(prop.alpha).toBe(200);
    expect(prop.color).toEqual([9, 8, 7, 255]);
    expect(prop.level).toBe(1);
  });

  it('parses scenery', () => {
    expect(map.scenery).toHaveLength(1);
    expect(map.scenery[0]!.filename).toBe('grass.bmp');
    expect(map.scenery[0]!.date).toBe(20240101);
  });

  it('parses colliders', () => {
    expect(map.colliders).toHaveLength(1);
    const c = map.colliders[0]!;
    expect(c.active).toBe(true);
    expect(c.x).toBeCloseTo(50);
    expect(c.y).toBeCloseTo(60);
    expect(c.radius).toBeCloseTo(15);
  });

  it('parses spawnpoints with team enum', () => {
    expect(map.spawnpoints).toHaveLength(1);
    const s = map.spawnpoints[0]!;
    expect(s.active).toBe(true);
    expect(s.x).toBe(-100);
    expect(s.y).toBe(250);
    expect(s.team).toBe(SpawnTeam.Bravo);
  });

  it('parses waypoints with connections and action enum', () => {
    expect(map.waypoints).toHaveLength(1);
    const wp = map.waypoints[0]!;
    expect(wp.active).toBe(true);
    expect(wp.id).toBe(42);
    expect(wp.x).toBe(11);
    expect(wp.y).toBe(22);
    expect(wp.left).toBe(true);
    expect(wp.right).toBe(false);
    expect(wp.up).toBe(true);
    expect(wp.down).toBe(false);
    expect(wp.jetpack).toBe(true);
    expect(wp.pathNum).toBe(3);
    expect(wp.action).toBe(WaypointAction.Wait5Seconds);
    expect(wp.connectionsNum).toBe(2);
    expect(wp.connections).toHaveLength(MAX_CONNECTIONS);
    expect(wp.connections.slice(0, 2)).toEqual([100, 101]);
    expect(wp.connections[2]).toBe(0);
  });

  it('computes the crc32 hash over the whole buffer with seed 5381', () => {
    const buf = buildMinimalPms();
    expect(map.hash >>> 0).toBe(map.hash); // unsigned 32-bit
    expect(pmsHash(new Uint8Array(buf))).toBe(map.hash);
  });

  it('rejects an out-of-range polygon count', () => {
    const w = new Writer();
    w.int32(11).str('x', 38).str('y', 24);
    w.color(0, 0, 0, 0).color(0, 0, 0, 0);
    w.int32(0).uint8(0).uint8(0).uint8(0).uint8(0).int32(0);
    w.int32(999999); // polygon count > MAX_POLYS
    expect(() => loadPms(w.toArrayBuffer())).toThrow(PmsParseError);
  });
});

describe('crc32', () => {
  it('is order-sensitive and unsigned', () => {
    const a = crc32(PMS_CRC_SEED, new Uint8Array([1, 2, 3]));
    const b = crc32(PMS_CRC_SEED, new Uint8Array([3, 2, 1]));
    expect(a).not.toBe(b);
    expect(a >>> 0).toBe(a);
  });

  it('matches a hand-computed reference value for the forward table', () => {
    // Reproduces the MapFile.pas update loop directly for a known input.
    const data = new Uint8Array([0x00, 0xff, 0x10]);
    let result = PMS_CRC_SEED >>> 0;
    const table: number[] = [];
    for (let nVal = 0; nVal < 256; nVal++) {
      let c = nVal << 24;
      for (let k = 0; k < 8; k++) {
        c = (c & 0x80000000) !== 0 ? (c << 1) ^ 0x04c11db7 : c << 1;
      }
      table.push(c >>> 0);
    }
    for (const byte of data) {
      const idx = (byte ^ ((result >>> 24) & 0xff)) & 0xff;
      result = (table[idx]! ^ (result << 8)) >>> 0;
    }
    expect(crc32(PMS_CRC_SEED, data)).toBe(result);
  });
});
