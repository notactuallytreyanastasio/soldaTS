// sounds — the SFX name set and asset manifest. Data-only, but with
// invariants worth pinning: ALL_SOUND_NAMES is derived from the manifest via
// a type assertion (Object.keys as SoundName[]), so these tests are the
// runtime guard the cast skips; every path must follow the on-disk layout
// the AudioEngine fetches (sfx/<name>.wav, radio-* under sfx/radio/); and
// the looping set must stay the three OpenSoldat looped samples.

import { describe, it, expect } from 'vitest';
import { ALL_SOUND_NAMES, LOOPING_SOUNDS, SOUND_MANIFEST } from './sounds';

describe('ALL_SOUND_NAMES', () => {
  it('is exactly the manifest keys, in canonical order', () => {
    expect([...ALL_SOUND_NAMES]).toEqual(Object.keys(SOUND_MANIFEST));
  });

  it('has no duplicates', () => {
    expect(new Set(ALL_SOUND_NAMES).size).toBe(ALL_SOUND_NAMES.length);
  });

  it('covers the full OpenSoldat sample set (163 minus the unused empty.wav)', () => {
    expect(ALL_SOUND_NAMES.length).toBe(162);
  });
});

describe('SOUND_MANIFEST', () => {
  it('every entry maps name → /sfx/<name>.wav (radio-* under /sfx/radio/)', () => {
    for (const name of ALL_SOUND_NAMES) {
      const path = SOUND_MANIFEST[name];
      const expected = name.startsWith('radio-')
        ? `/sfx/radio/${name.slice('radio-'.length)}.wav`
        : `/sfx/${name}.wav`;
      expect(path).toBe(expected);
    }
  });

  it('every path is a root-absolute .wav (the shape assetUrl rebases)', () => {
    for (const name of ALL_SOUND_NAMES) {
      expect(SOUND_MANIFEST[name]).toMatch(/^\/sfx\/(radio\/)?[a-z0-9_-]+\.wav$/);
    }
  });

  it('no two names share a file', () => {
    const paths = Object.values(SOUND_MANIFEST);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('LOOPING_SOUNDS', () => {
  it('is exactly the three OpenSoldat looped samples', () => {
    expect([...LOOPING_SOUNDS].sort()).toEqual(['chainsaw-r', 'flamer', 'rocketz']);
  });

  it('every looping sound exists in the manifest', () => {
    for (const name of LOOPING_SOUNDS) {
      expect(SOUND_MANIFEST[name]).toBeDefined();
    }
  });
});
