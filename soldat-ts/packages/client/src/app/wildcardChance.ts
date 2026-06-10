// Wildcard CHANCE resolution — every game gets a shot at shotgun play.
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

/** Percent of matches the 'chance' mode arms the shotgun wildcard. */
export const WILDCARD_CHANCE_PCT = 35;

/** Seed-derived roll (Knuth multiplicative hash) — pure and stable. */
export function rollWildcard(seed: number, pct: number = WILDCARD_CHANCE_PCT): boolean {
  const h = Math.imul(seed ^ 0x9e3779b9, 2654435761) >>> 0;
  return h % 100 < pct;
}

/**
 * Resolve a wildcard MODE ('shotgun' | 'none' | 'chance' | undefined) to the
 * per-match armed value the Game accepts ('shotgun' | undefined). Unknown
 * modes resolve to stock — a typo'd param never bricks a match.
 */
export function resolveWildcard(
  mode: string | undefined,
  seed: number,
): string | undefined {
  if (mode === 'shotgun') return 'shotgun';
  if (mode === 'chance') return rollWildcard(seed) ? 'shotgun' : undefined;
  return undefined;
}
