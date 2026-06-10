// Render the PMS map with its real tiled texture instead of flat vertex colors.
//
// Soldat maps reference a single texture filename (PmsMap.textures[0], e.g.
// "riverbed.bmp"); polygons carry per-vertex UVs that exceed 0..1 and rely on
// GFX_REPEAT wrapping to tile across large polygons (MapGraphics.pas:279
// GfxTextureWrap(..., GFX_REPEAT, GFX_REPEAT)). We load that texture from
// /textures/<name>, set its source to repeat, and draw the MapMesh as a single
// pixi built-in textured Mesh (default TextureShader — NO custom GLSL/WGSL).
//
// The extracted assets are all .png even when the map names a .bmp/.jpg, so we
// strip the original extension and try .png, then .bmp, then .jpg.
//
// PORT: client/MapGraphics.pas (LoadMapTexture + vertex buffer / texture apply)

import { Assets, Container, Mesh, MeshGeometry, Texture } from 'pixi.js';
import { assetUrl } from '../app/assetUrl';
import type { MapMesh } from './mapMesh';

/**
 * Minimal shape of a parsed PMS map needed to resolve the map texture.
 * Matches `@soldat/assets` PmsMap: `textures[0]` is the texture filename
 * (MapFile.pas:284-290 stores a single texture name in Textures[0]).
 */
export interface PmsMapLike {
  textures: readonly string[];
}

/** Base URL where extracted map textures are served (BASE_URL-aware). */
const TEXTURE_BASE = assetUrl('/textures/');

/** Extensions to probe, in priority order. Assets are .png even if the map names .bmp/.jpg. */
const TEXTURE_EXTENSIONS = ['png', 'bmp', 'jpg'] as const;

/**
 * Strip any directory part and file extension from a PMS texture name, leaving
 * the bare stem. e.g. "riverbed.bmp" -> "riverbed", "edges/foo.bmp" -> "edges/foo".
 */
export function textureNameStem(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name; // no extension (or leading dot) — keep as-is
  return name.slice(0, dot);
}

/**
 * Ordered list of candidate URLs to try for a PMS texture name. The original
 * extension is discarded and each known extension is appended to the stem.
 *
 * Pure (no pixi/DOM) so it is unit-testable.
 */
export function textureUrlCandidates(name: string): string[] {
  const stem = textureNameStem(name);
  return TEXTURE_EXTENSIONS.map((ext) => `${TEXTURE_BASE}${stem}.${ext}`);
}

/** Resolve the texture name from a PmsMap (Textures[0]); undefined if none. */
export function mapTextureName(map: PmsMapLike): string | undefined {
  const first = map.textures[0];
  if (first === undefined || first.length === 0) return undefined;
  return first;
}

/**
 * Try each candidate URL via Assets.load until one resolves to a Texture.
 * Returns undefined if all candidates fail (caller keeps the flat map).
 */
async function loadFirstTexture(candidates: readonly string[]): Promise<Texture | undefined> {
  for (const url of candidates) {
    try {
      const tex: Texture = await Assets.load<Texture>(url);
      // Assets.load can resolve to a placeholder on some failures; guard width.
      if (tex.source.width > 0 && tex.source.height > 0) {
        return tex;
      }
    } catch {
      // try next extension
    }
  }
  return undefined;
}

/**
 * Build a Container holding a single textured Mesh for the whole map.
 *
 * Resolves the texture from `map.textures[0]` (probing .png/.bmp/.jpg under
 * /textures/), sets the source to repeat so out-of-range UVs tile, and builds a
 * pixi built-in `Mesh` (MeshGeometry positions + uvs + indices, default
 * TextureShader). Per-vertex colors from the MapMesh are NOT applied (the
 * default mesh shader supports only a single tint); the plain tiled texture is
 * the intended fallback per the task contract.
 *
 * If the texture cannot be loaded the returned Container is empty — the caller
 * detects this (childless) and keeps the flat color map.
 */
export async function buildTexturedMap(map: PmsMapLike, mesh: MapMesh): Promise<Container> {
  const container = new Container();
  container.label = 'map-textured';

  const name = mapTextureName(map);
  if (name === undefined) {
    // No texture name — nothing to draw, caller falls back to flat map.
    return container;
  }

  const texture = await loadFirstTexture(textureUrlCandidates(name));
  if (texture === undefined) {
    return container;
  }

  // Tile the texture: Soldat UVs routinely exceed 0..1 (MapGraphics GFX_REPEAT).
  texture.source.addressMode = 'repeat';

  // pixi's default mesh shader requires uvs at least as long as positions.
  const geometry = new MeshGeometry({
    positions: mesh.positions,
    uvs: mesh.uvs,
    indices: mesh.indices,
  });

  const textured = new Mesh({ geometry, texture });
  textured.label = 'map-textured-mesh';
  container.addChild(textured);

  return container;
}
