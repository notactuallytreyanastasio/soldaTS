// assetUrl — the public-asset URL resolver. The scheme detection and slash
// handling are pure string logic, tested exhaustively here. The BASE_URL
// prefix itself can't be varied from a test: vitest gives every module its
// own import.meta.env snapshot, so stubbing ours never reaches assetUrl's —
// under vitest's node environment the module always sees BASE_URL '/', which
// is also the documented headless fallback. All expectations below are
// against that '/' base.

import { describe, expect, it } from 'vitest';
import { assetUrl } from './assetUrl';

describe('assetUrl', () => {
  it('passes full URLs through untouched', () => {
    expect(assetUrl('http://example.com/maps/x.pms')).toBe('http://example.com/maps/x.pms');
    expect(assetUrl('https://example.com/sfx/jump.wav')).toBe('https://example.com/sfx/jump.wav');
  });

  it('detects the scheme case-insensitively', () => {
    expect(assetUrl('HTTP://EXAMPLE.COM/x')).toBe('HTTP://EXAMPLE.COM/x');
    expect(assetUrl('HtTpS://example.com/x')).toBe('HtTpS://example.com/x');
  });

  it('accepts any RFC-shaped scheme (letter then letters/digits/+/./-)', () => {
    expect(assetUrl('ws://host/socket')).toBe('ws://host/socket');
    expect(assetUrl('web+app://thing')).toBe('web+app://thing');
    expect(assetUrl('a.b-c+d://x')).toBe('a.b-c+d://x');
  });

  it('a scheme must start with a letter — "1http://" is treated as a path', () => {
    expect(assetUrl('1http://example.com')).toBe('/1http://example.com');
  });

  it('does NOT pass data: URIs through (no "//" after the scheme)', () => {
    // SUSPECT: the doc comment says "Full URLs pass through untouched", but the
    // regex requires '://', so an absolute data: URI gets the base prepended,
    // producing a broken URL. Harmless today (assetUrl is only fed paths), but
    // the actual behavior is asserted here.
    expect(assetUrl('data:image/png;base64,AAAA')).toBe('/data:image/png;base64,AAAA');
  });

  it('strips one leading slash and prepends the base', () => {
    expect(assetUrl('/sfx/jump.wav')).toBe('/sfx/jump.wav');
    expect(assetUrl('sfx/jump.wav')).toBe('/sfx/jump.wav');
  });

  it('root-absolute and relative spellings of a path resolve identically', () => {
    expect(assetUrl('/maps/ctf_Ash.pms')).toBe(assetUrl('maps/ctf_Ash.pms'));
  });

  it('strips only the FIRST leading slash — "//" survives as protocol-relative', () => {
    // Actual behavior: '//cdn/x.wav' → '/' + '/cdn/x.wav' = '//cdn/x.wav'
    // (a protocol-relative URL — the double slash is never collapsed).
    expect(assetUrl('//cdn/x.wav')).toBe('//cdn/x.wav');
  });

  it('empty path resolves to the base itself', () => {
    expect(assetUrl('')).toBe('/');
  });

  it('preserves query strings and fragments', () => {
    expect(assetUrl('/maps/a.pms?v=1#frag')).toBe('/maps/a.pms?v=1#frag');
    expect(assetUrl('https://h/x?a=b#c')).toBe('https://h/x?a=b#c');
  });
});
