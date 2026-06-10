export declare const FIGHTER_CARD_SCHEMA = "soldat-fighter-card/1";
export interface FighterCard {
    schema: typeof FIGHTER_CARD_SCHEMA;
    /** Who filed this fighter (shown on the banner: 'PILOT (VEGA)'). */
    coach: string;
    /** Registered engine id the coach grabbed. */
    engine: string;
    /** Knob overrides vs the engine's defaults (may be empty). */
    tweaks: Record<string, number>;
    /** The coach's reasoning — tracked with the card, shown in reports. */
    rationale?: string;
}
/**
 * Validate a parsed card; throws with a coach-fixable message. Returns the
 * card narrowed to the right type plus its RESOLVED full config (defaults +
 * tweaks — what the brains will actually run).
 */
export declare function validateCard(raw: unknown): {
    card: FighterCard;
    resolved: Readonly<Record<string, number>>;
};
/** 'KEY=V,KEY=V' — the ?tweak-a/?tweak-b URL format (empty string if none). */
export declare function tweaksToParam(tweaks: Record<string, number>): string;
/**
 * The watch URL: the browser replays the EXACT recorded match (same seed →
 * same deterministic sim), labeled with both coaches and their knob turns.
 */
export declare function buildWatchUrl(base: string, a: FighterCard, b: FighterCard, opts: {
    seed: number;
    roundSecs: number;
    arenaSeed: number;
    wildcard?: string | undefined;
}): string;
//# sourceMappingURL=fighterCard.d.ts.map