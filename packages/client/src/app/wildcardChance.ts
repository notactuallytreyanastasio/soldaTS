// Wildcard CHANCE resolution — every game gets a shot at wildcard play.
//
// GLUE module. The wildcard system shipped opt-in (?wildcard=shotgun /
// --wildcard shotgun); the follow-up ask is that ALL games may roll it.
// The roll must be a pure function of the match seed — never wall-clock,
// never Math.random — so a manifest (config + seed) still fully determines
// every byte of a recorded match, and a replay URL re-rolls identically.
//
// Back-compat contract: entry points choose their default MODE —
//   - arena CLI and fresh ?play sessions default to 'chance'
//   - ?spectate URLs WITHOUT a wildcard param default to 'none', because
//     every watch URL recorded before the chance era carries no param and
//     must keep replaying byte-identically.
//
// THE RIFLE ERA ('rifle' wildcard, Barrett): 'chance' now arms one of TWO
// wildcards. The arming roll itself is UNCHANGED — rollWildcard, the same
// hash, the same 35% — so every old seed arms (or doesn't) exactly as it
// always did. WHICH weapon an armed match gets comes from a SEPARATE hash
// of the seed (pickWildcardWeapon, different mix constants → independent
// bit-stream), deliberately NOT a second draw from the arming hash: reusing
// or re-deriving from the same draw would have re-shuffled the arming
// decisions themselves. Recorded chance-era artifacts stay replayable
// because every recorded watch URL / manifest match carries the RESOLVED
// value ('shotgun'), never the mode — forced-'shotgun' resolution and the
// Game's seed→carrier draw are byte-for-byte untouched.

/** Percent of matches the 'chance' mode arms a wildcard. */
export const WILDCARD_CHANCE_PCT = 35;

/** Seed-derived roll (Knuth multiplicative hash) — pure and stable.
 *  UNCHANGED since the shotgun era: old seeds keep their arming decision. */
export function rollWildcard(seed: number, pct: number = WILDCARD_CHANCE_PCT): boolean {
  const h = Math.imul(seed ^ 0x9e3779b9, 2654435761) >>> 0;
  return h % 100 < pct;
}

/**
 * Which weapon an ARMED 'chance' match gets: 'shotgun' or 'rifle', 50/50.
 * A SEPARATE seeded hash (murmur3-style constants, distinct from the arming
 * hash's golden-ratio xor) so the pick is independent of rollWildcard and the
 * arming decision for every pre-rifle seed is untouched. Pure and stable.
 */
export function pickWildcardWeapon(seed: number): 'shotgun' | 'rifle' {
  const h = Math.imul(seed ^ 0x85ebca6b, 0xc2b2ae35) >>> 0;
  return h % 2 === 0 ? 'shotgun' : 'rifle';
}

/**
 * Resolve a wildcard MODE ('shotgun' | 'rifle' | 'none' | 'chance' |
 * undefined) to the per-match armed value the Game accepts ('shotgun' |
 * 'rifle' | undefined). Unknown modes resolve to stock — a typo'd param
 * never bricks a match.
 */
export function resolveWildcard(
  mode: string | undefined,
  seed: number,
): string | undefined {
  if (mode === 'shotgun' || mode === 'rifle') return mode;
  if (mode === 'chance') return rollWildcard(seed) ? pickWildcardWeapon(seed) : undefined;
  return undefined;
}
