// loadMap — map URL selection (pickMapUrl: ?map= parsing, bare-name
// resolution, verbatim pass-through) and the fetch-and-parse glue
// (fetchAndLoadMap: assetUrl applied to the request, HTTP errors thrown with
// status detail, the body handed to the faithful PMS loader). No network:
// global fetch is a recorded stub fed an in-memory .PMS image.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAP_URL, MAP_QUERY_PARAM, fetchAndLoadMap, pickMapUrl } from './loadMap';

describe('pickMapUrl', () => {
  it('exports the documented constants', () => {
    expect(DEFAULT_MAP_URL).toBe('/maps/ctf_Ash.pms');
    expect(MAP_QUERY_PARAM).toBe('map');
  });

  it('returns the default when the search is empty or has no ?map', () => {
    expect(pickMapUrl('')).toBe(DEFAULT_MAP_URL);
    expect(pickMapUrl('?foo=bar')).toBe(DEFAULT_MAP_URL);
  });

  it('returns the caller-supplied fallback instead of the default', () => {
    expect(pickMapUrl('', '/maps/other.pms')).toBe('/maps/other.pms');
    expect(pickMapUrl('?foo=1', '/maps/other.pms')).toBe('/maps/other.pms');
  });

  it('no arguments at all (headless node, no window) → the default map', () => {
    expect(pickMapUrl()).toBe(DEFAULT_MAP_URL);
  });

  it('resolves a bare name under /maps/ with a .pms suffix', () => {
    expect(pickMapUrl('?map=ctf_Ash')).toBe('/maps/ctf_Ash.pms');
    expect(pickMapUrl('?map=Arena2')).toBe('/maps/Arena2.pms');
  });

  it('an empty ?map= value falls back', () => {
    expect(pickMapUrl('?map=')).toBe(DEFAULT_MAP_URL);
    expect(pickMapUrl('?map=', '/maps/fb.pms')).toBe('/maps/fb.pms');
  });

  it('values containing a slash are used verbatim', () => {
    expect(pickMapUrl('?map=custom/path/map')).toBe('custom/path/map');
    expect(pickMapUrl('?map=/abs/dir/thing')).toBe('/abs/dir/thing');
  });

  it('full URLs are used verbatim', () => {
    expect(pickMapUrl('?map=' + encodeURIComponent('http://host/m.pms'))).toBe(
      'http://host/m.pms',
    );
    expect(pickMapUrl('?map=' + encodeURIComponent('https://host/dir/m'))).toBe(
      'https://host/dir/m',
    );
  });

  it('detects the .pms extension case-insensitively', () => {
    expect(pickMapUrl('?map=ctf_Ash.pms')).toBe('ctf_Ash.pms');
    expect(pickMapUrl('?map=ctf_Ash.PMS')).toBe('ctf_Ash.PMS');
    expect(pickMapUrl('?map=ctf_Ash.Pms')).toBe('ctf_Ash.Pms');
  });

  it('a non-.pms extension on a bare name still gets the /maps/ + .pms treatment', () => {
    // No slash and not ending in .pms → treated as a bare name verbatim.
    expect(pickMapUrl('?map=ctf_Ash.zip')).toBe('/maps/ctf_Ash.zip.pms');
  });

  it('takes the FIRST of multiple ?map values', () => {
    expect(pickMapUrl('?map=first&map=second')).toBe('/maps/first.pms');
  });

  it('URL-decodes the value (an encoded slash counts as a path)', () => {
    expect(pickMapUrl('?map=dir%2Fmap')).toBe('dir/map');
  });
});

// ---------------------------------------------------------------------------
// Minimal little-endian .PMS writer — the same scaffolding pattern as the
// loader's own tests (packages/assets pms-loader.test.ts), shrunk to the
// smallest valid file: all section counts zero. Only used to synthesize a
// parseable body for the success path.
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

  toArrayBuffer(): ArrayBuffer {
    const out = new Uint8Array(this.bytes);
    return out.buffer.slice(0) as ArrayBuffer;
  }
}

/** The smallest well-formed .PMS: header + every section count at zero. */
function buildEmptyPms(): ArrayBuffer {
  const w = new Writer();
  w.int32(11); // version
  w.str('ctf_Empty', 38); // mapName
  w.str('texture.bmp', 24); // texture0
  w.color(1, 2, 3, 255); // bgColorTop
  w.color(4, 5, 6, 255); // bgColorBtm
  w.int32(8); // startJet
  w.uint8(0); // grenadePacks
  w.uint8(0); // medikits
  w.uint8(0); // weather
  w.uint8(0); // steps
  w.int32(42); // randomId
  w.int32(0); // polygons: none
  w.int32(200); // sectorsDivision
  w.int32(0); // sectorsNum → a (2*0+1)^2 = 1-sector grid
  w.uint16(0); // that single sector is empty
  w.int32(0); // props
  w.int32(0); // scenery
  w.int32(0); // colliders
  w.int32(0); // spawnpoints
  w.int32(0); // waypoints
  return w.toArrayBuffer();
}

type FetchArgs = Parameters<typeof fetch>;

function stubFetch(impl: (...args: FetchArgs) => Promise<Response>): FetchArgs[] {
  const calls: FetchArgs[] = [];
  vi.stubGlobal('fetch', (...args: FetchArgs): Promise<Response> => {
    calls.push(args);
    return impl(...args);
  });
  return calls;
}

const okResponse = (buffer: ArrayBuffer): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => buffer,
  }) as unknown as Response;

const errorResponse = (status: number, statusText: string): Response =>
  ({
    ok: false,
    status,
    statusText,
    arrayBuffer: async () => new ArrayBuffer(0),
  }) as unknown as Response;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAndLoadMap', () => {
  it('fetches through assetUrl and parses the body with the PMS loader', async () => {
    const calls = stubFetch(async () => okResponse(buildEmptyPms()));
    const map = await fetchAndLoadMap('maps/ctf_Empty.pms'); // note: no leading slash
    expect(calls).toHaveLength(1);
    // assetUrl normalizes the path against the base ('/' under node).
    expect(calls[0]![0]).toBe('/maps/ctf_Empty.pms');
    expect(map.mapName).toBe('ctf_Empty');
    expect(map.version).toBe(11);
    expect(map.polygons).toEqual([]);
    expect(map.spawnpoints).toEqual([]);
    expect(map.waypoints).toEqual([]);
  });

  it('throws with the URL and status detail on an HTTP error', async () => {
    stubFetch(async () => errorResponse(404, 'Not Found'));
    await expect(fetchAndLoadMap('/maps/missing.pms')).rejects.toThrow(
      "failed to fetch map '/maps/missing.pms': 404 Not Found",
    );
  });

  it('includes the status of server errors too', async () => {
    stubFetch(async () => errorResponse(500, 'Internal Server Error'));
    await expect(fetchAndLoadMap('/maps/x.pms')).rejects.toThrow('500 Internal Server Error');
  });

  it('propagates network-level fetch failures', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(fetchAndLoadMap('/maps/x.pms')).rejects.toThrow('fetch failed');
  });

  it('full URLs are fetched untouched (assetUrl pass-through)', async () => {
    const calls = stubFetch(async () => okResponse(buildEmptyPms()));
    await fetchAndLoadMap('https://example.com/maps/m.pms');
    expect(calls[0]![0]).toBe('https://example.com/maps/m.pms');
  });
});
