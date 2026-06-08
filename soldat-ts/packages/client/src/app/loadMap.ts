// Map fetching glue: pull a real .PMS file over HTTP and parse it with the
// faithful loader from @soldat/assets.
//
// Place real Soldat .PMS files under packages/client/public/maps/ so the dev
// server serves them at /maps/<name>.pms (see public/maps/README.md). They are
// NOT committed — per the asset-licensing decision, users supply their own
// Soldat install.

import { loadPms, type PmsMap } from '@soldat/assets';

/** Default map served from the local /maps/ directory when none is requested. */
export const DEFAULT_MAP_URL = '/maps/ctf_Ash.pms';

/** Query parameter used to override the map to load (e.g. ?map=ctf_Ash). */
export const MAP_QUERY_PARAM = 'map';

/**
 * Fetch a .PMS file as an ArrayBuffer and parse it via the faithful loader.
 * Throws if the HTTP response is not ok (the caller decides whether to fall
 * back to a synthetic map).
 */
export async function fetchAndLoadMap(url: string): Promise<PmsMap> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch map '${url}': ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  return loadPms(buffer);
}

/**
 * Pick the map URL to load from the page's `?map=` query parameter, falling
 * back to {@link DEFAULT_MAP_URL}. A bare name (no slash, no extension) is
 * resolved under /maps/ with a `.pms` suffix, so `?map=ctf_Ash` →
 * `/maps/ctf_Ash.pms`. A value containing a `/` or ending in `.pms` is used
 * verbatim, allowing absolute or fully-qualified URLs.
 */
export function pickMapUrl(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
  fallback: string = DEFAULT_MAP_URL,
): string {
  const params = new URLSearchParams(search);
  const requested = params.get(MAP_QUERY_PARAM);
  if (requested === null || requested === '') {
    return fallback;
  }
  if (requested.includes('/') || requested.toLowerCase().endsWith('.pms')) {
    return requested;
  }
  return `/maps/${requested}.pms`;
}
