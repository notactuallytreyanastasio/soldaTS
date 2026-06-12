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

/** Every weapon a wildcard may arm, in pick-hash order. THE ORDER IS LOAD-
 *  BEARING for 'chance' resolution (h % length indexes this array) — append
 *  only, never reorder. */
export const WILDCARD_WEAPONS = [
  'shotgun',
  'rifle',
  'rocket',
  'ricochet',
  'chainsaw',
] as const;
export type WildcardWeapon = (typeof WILDCARD_WEAPONS)[number];

/**
 * Which weapon an ARMED 'chance' match gets: an even split over
 * WILDCARD_WEAPONS. A SEPARATE seeded hash (murmur3-style constants, distinct
 * from the arming hash's golden-ratio xor) so the pick is independent of
 * rollWildcard and the ARMING decision for every old seed is untouched.
 * Pure and stable.
 *
 * THE THREE-GUN ERA (rocket/ricochet/chainsaw): the hash is UNCHANGED but the
 * modulus widened 2 → 5, so an old armed seed MAY now pick a different weapon
 * than it did in the 50/50 era. That is acceptable BY DESIGN for the pick
 * (decision: recorded chance-era artifacts are safe regardless, because every
 * recorded manifest match / watch URL carries the RESOLVED weapon, never the
 * mode — replays force that value and never re-roll the pick).
 */
/**
 * Pick weights (decision: surface the spectacle guns). The three projectile/
 * melee wildcards (rocket, ricochet, chainsaw) are drawn 3x as often as the
 * shotgun and rifle, so an armed match is far more likely to show one of them.
 * The order still follows WILDCARD_WEAPONS (append-only); only the effective
 * modulus changed, which is safe for the same reason the 2->5 widening was.
 */
const WILDCARD_PICK_WEIGHTS: Record<WildcardWeapon, number> = {
  shotgun: 1,
  rifle: 1,
  rocket: 3,
  ricochet: 3,
  chainsaw: 3,
};

export function pickWildcardWeapon(seed: number): WildcardWeapon {
  const h = Math.imul(seed ^ 0x85ebca6b, 0xc2b2ae35) >>> 0;
  const bag: WildcardWeapon[] = [];
  for (const w of WILDCARD_WEAPONS) {
    for (let i = 0; i < WILDCARD_PICK_WEIGHTS[w]; i++) bag.push(w);
  }
  return bag[h % bag.length] ?? 'shotgun';
}

/**
 * Resolve a wildcard MODE (a WILDCARD_WEAPONS name | 'none' | 'chance' |
 * undefined) to the per-match armed value the Game accepts (a weapon name |
 * undefined). Unknown modes resolve to stock — a typo'd param never bricks a
 * match.
 */
export function resolveWildcard(
  mode: string | undefined,
  seed: number,
): string | undefined {
  if ((WILDCARD_WEAPONS as readonly string[]).includes(mode ?? '')) return mode;
  if (mode === 'chance') return rollWildcard(seed) ? pickWildcardWeapon(seed) : undefined;
  return undefined;
}
