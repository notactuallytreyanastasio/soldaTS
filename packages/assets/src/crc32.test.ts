import { describe, expect, it } from 'vitest';

import { crc32, PMS_CRC_SEED, pmsHash } from './crc32';

describe('crc32 edge cases', () => {
  it('uses 5381 as the .PMS seed', () => {
    expect(PMS_CRC_SEED).toBe(5381);
  });

  it('returns the seed unchanged for an empty buffer', () => {
    expect(crc32(PMS_CRC_SEED, new Uint8Array(0))).toBe(PMS_CRC_SEED);
    expect(pmsHash(new Uint8Array(0))).toBe(PMS_CRC_SEED);
  });

  it('returns the seed unchanged when len = 0', () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(crc32(PMS_CRC_SEED, data, 0, 0)).toBe(PMS_CRC_SEED);
    expect(crc32(0xdeadbeef, data, 1, 0)).toBe(0xdeadbeef);
  });

  it('returns the seed unchanged for negative len', () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(crc32(PMS_CRC_SEED, data, 0, -1)).toBe(PMS_CRC_SEED);
    expect(crc32(PMS_CRC_SEED, data, 0, -100)).toBe(PMS_CRC_SEED);
  });

  it('returns the seed unchanged when start > data.length (default len goes negative)', () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(crc32(PMS_CRC_SEED, data, 10)).toBe(PMS_CRC_SEED);
    expect(crc32(PMS_CRC_SEED, data, data.length)).toBe(PMS_CRC_SEED);
  });

  it('processes exactly the [start, start+len) byte range', () => {
    const inner = new Uint8Array([0x41, 0x42, 0x43]);
    const padded = new Uint8Array([0xff, 0x41, 0x42, 0x43, 0xff]);
    expect(crc32(PMS_CRC_SEED, padded, 1, 3)).toBe(crc32(PMS_CRC_SEED, inner));
  });

  it('with start set and len defaulted, hashes the tail of the buffer', () => {
    const data = new Uint8Array([9, 9, 1, 2, 3]);
    const tail = new Uint8Array([1, 2, 3]);
    expect(crc32(PMS_CRC_SEED, data, 2)).toBe(crc32(PMS_CRC_SEED, tail));
  });

  it('chains incrementally: hashing in two calls equals one call', () => {
    const data = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]);
    const whole = crc32(PMS_CRC_SEED, data);
    const firstHalf = crc32(PMS_CRC_SEED, data, 0, 2);
    const chained = crc32(firstHalf, data, 2, 3);
    expect(chained).toBe(whole);
  });

  it('treats explicit out-of-bounds len as zero bytes (Pascal Move/FillChar mirror)', () => {
    // SUSPECT (reviewer finding): this defensive branch is unreachable with the
    // default len; it only fires when a caller passes len past the buffer end.
    // We pin the documented behavior: missing bytes contribute 0x00.
    const data = new Uint8Array([0x61, 0x62, 0x63]);
    const zeroPadded = new Uint8Array([0x61, 0x62, 0x63, 0, 0, 0, 0]);
    expect(crc32(PMS_CRC_SEED, data, 0, 7)).toBe(crc32(PMS_CRC_SEED, zeroPadded));
    // Consequence: an out-of-range len is indistinguishable from real trailing
    // zero bytes (the API silently accepts it rather than throwing).
    expect(crc32(PMS_CRC_SEED, data, 0, 7)).toBe(157775258);
  });

  it('forces the incoming crc to unsigned 32-bit', () => {
    const data = new Uint8Array([1, 2, 3]);
    // -1 >>> 0 === 0xffffffff: signed and unsigned spellings of the same seed agree
    expect(crc32(-1, data)).toBe(crc32(0xffffffff, data));
    expect(crc32(-1, new Uint8Array(0))).toBe(0xffffffff);
  });

  it('matches pinned reference values for the forward (MPEG-2 style) table', () => {
    // Values computed from the MapFile.pas:145-154 update loop with seed 5381.
    expect(pmsHash(new Uint8Array([0x61, 0x62, 0x63]))).toBe(1925417367); // "abc"
    expect(pmsHash(new Uint8Array(4))).toBe(2426998797); // four zero bytes
    const seq = new Uint8Array(256);
    for (let i = 0; i < 256; i++) seq[i] = i;
    expect(pmsHash(seq)).toBe(1266979009);
  });

  it('always produces an unsigned 32-bit integer', () => {
    const inputs = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      new Uint8Array(64).fill(0xab),
    ];
    for (const data of inputs) {
      const h = pmsHash(data);
      expect(h >>> 0).toBe(h);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('is sensitive to every byte position', () => {
    const base = new Uint8Array([1, 2, 3, 4]);
    const baseline = pmsHash(base);
    for (let i = 0; i < base.length; i++) {
      const mutated = base.slice();
      mutated[i] = (mutated[i]! + 1) & 0xff;
      expect(pmsHash(mutated)).not.toBe(baseline);
    }
  });

  it('pmsHash is exactly crc32 with the PMS seed over the whole buffer', () => {
    const data = new Uint8Array([5, 4, 3, 2, 1]);
    expect(pmsHash(data)).toBe(crc32(PMS_CRC_SEED, data));
  });
});
