// Public-asset URL resolver. The client's runtime assets (maps, textures,
// gostek sprites, sounds) live in public/ and were historically fetched with
// root-absolute paths ('/sfx/jump.wav'), which only works when the app is
// served from the domain root (the dev server, :5173). Deployed under a
// subpath — e.g. the arena snapshot at bobbby.online/arena/play/, built with
// `vite build --base=./` — root-absolute paths 404 against the host site.
//
// assetUrl() prefixes Vite's BASE_URL instead: '/' in dev (no change), './'
// in a relative-base build (resolves against the page URL). Full URLs pass
// through untouched, and plain node (headless tests, the arena CLI) has no
// import.meta.env so it falls back to '/'.
export function assetUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path; // already absolute
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return base + path.replace(/^\//, '');
}
