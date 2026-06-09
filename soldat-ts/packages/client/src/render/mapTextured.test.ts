// Pure tests for the texture-name -> URL candidate resolution. No pixi/DOM.

import { describe, expect, it } from 'vitest';
import {
  mapTextureName,
  textureNameStem,
  textureUrlCandidates,
} from './mapTextured';

describe('textureNameStem', () => {
  it('strips a .bmp extension', () => {
    expect(textureNameStem('riverbed.bmp')).toBe('riverbed');
  });

  it('strips a .jpg extension', () => {
    expect(textureNameStem('drysand.jpg')).toBe('drysand');
  });

  it('preserves a directory prefix while stripping the extension', () => {
    expect(textureNameStem('edges/default.bmp')).toBe('edges/default');
  });

  it('leaves a name with no extension unchanged', () => {
    expect(textureNameStem('riverbed')).toBe('riverbed');
  });

  it('does not strip a leading dot (dotfile-like name)', () => {
    expect(textureNameStem('.hidden')).toBe('.hidden');
  });
});

describe('textureUrlCandidates', () => {
  it('produces png, bmp, jpg candidates under /textures/ in priority order', () => {
    expect(textureUrlCandidates('riverbed.bmp')).toEqual([
      '/textures/riverbed.png',
      '/textures/riverbed.bmp',
      '/textures/riverbed.jpg',
    ]);
  });

  it('prefers .png first even when the map names a different extension', () => {
    const first = textureUrlCandidates('Kamibeach.jpg')[0];
    expect(first).toBe('/textures/Kamibeach.png');
  });

  it('keeps subdirectories in the candidate paths', () => {
    expect(textureUrlCandidates('edges/foo.bmp')).toEqual([
      '/textures/edges/foo.png',
      '/textures/edges/foo.bmp',
      '/textures/edges/foo.jpg',
    ]);
  });
});

describe('mapTextureName', () => {
  it('returns the first texture entry', () => {
    expect(mapTextureName({ textures: ['riverbed.bmp'] })).toBe('riverbed.bmp');
  });

  it('returns undefined when there are no textures', () => {
    expect(mapTextureName({ textures: [] })).toBeUndefined();
  });

  it('returns undefined for an empty texture name', () => {
    expect(mapTextureName({ textures: [''] })).toBeUndefined();
  });
});
