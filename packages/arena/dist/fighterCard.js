// Fighter cards — the CLAUDE ARENA submission format (goal node 170 /
// action 185). A coach (a Claude Fable instance, a human, eventually a
// trained model wrapper) "logs in" by writing one JSON file: which brain it
// grabs, the knob turns it filed, and why. Two cards = one fight:
//
//   pnpm arena fight fights/vega.json fights/okonkwo.json
//
// The fight runs headlessly (recorded as a training dataset like every
// match) AND prints a WATCH URL — the sim is deterministic per seed, so the
// browser replays the exact same match the dataset recorded, with coach
// names on the banner and each side's knob turns on the info card.
import { createEngine, engineIds } from '@soldat/client/headless';
export const FIGHTER_CARD_SCHEMA = 'soldat-fighter-card/1';
/**
 * Validate a parsed card; throws with a coach-fixable message. Returns the
 * card narrowed to the right type plus its RESOLVED full config (defaults +
 * tweaks — what the brains will actually run).
 */
export function validateCard(raw) {
    if (typeof raw !== 'object' || raw === null) {
        throw new Error('fighter card: not a JSON object');
    }
    const c = raw;
    if (c.schema !== FIGHTER_CARD_SCHEMA) {
        throw new Error(`fighter card: schema must be '${FIGHTER_CARD_SCHEMA}'`);
    }
    if (typeof c.coach !== 'string' || c.coach.trim() === '') {
        throw new Error('fighter card: coach (non-empty string) required');
    }
    if (typeof c.engine !== 'string' || !engineIds().includes(c.engine)) {
        throw new Error(`fighter card: engine must be one of [${engineIds().join(', ')}]`);
    }
    const tweaks = c.tweaks ?? {};
    if (typeof tweaks !== 'object' || Array.isArray(tweaks)) {
        throw new Error('fighter card: tweaks must be an object of KNOB: number');
    }
    const defaults = createEngine(c.engine).tweaks;
    for (const [k, v] of Object.entries(tweaks)) {
        if (!(k in defaults)) {
            throw new Error(`fighter card: unknown knob '${k}' for ${c.engine} (knobs: ${Object.keys(defaults).join(', ')})`);
        }
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            throw new Error(`fighter card: knob '${k}' must be a finite number`);
        }
    }
    // Resolve through the real engine so provenance matches what runs.
    const resolved = createEngine(c.engine, tweaks).tweaks;
    return {
        card: {
            schema: FIGHTER_CARD_SCHEMA,
            coach: c.coach,
            engine: c.engine,
            tweaks,
            ...(c.rationale !== undefined ? { rationale: c.rationale } : {}),
        },
        resolved,
    };
}
/** 'KEY=V,KEY=V' — the ?tweak-a/?tweak-b URL format (empty string if none). */
export function tweaksToParam(tweaks) {
    return Object.entries(tweaks)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
}
/**
 * The watch URL: the browser replays the EXACT recorded match (same seed →
 * same deterministic sim), labeled with both coaches and their knob turns.
 */
export function buildWatchUrl(base, a, b, opts) {
    const params = new URLSearchParams();
    params.set('spectate', '');
    params.set('ai', `${a.engine},${b.engine}`);
    params.set('teams', '');
    params.set('seed', String(opts.seed));
    params.set('round', String(opts.roundSecs));
    if (opts.arenaSeed > 0)
        params.set('arena', String(opts.arenaSeed));
    // Wildcard must ride along: the browser replay only matches the recorded
    // sim when it arms the same carriers from the same seed.
    if (opts.wildcard !== undefined)
        params.set('wildcard', opts.wildcard);
    if (tweaksToParam(a.tweaks) !== '')
        params.set('tweak-a', tweaksToParam(a.tweaks));
    if (tweaksToParam(b.tweaks) !== '')
        params.set('tweak-b', tweaksToParam(b.tweaks));
    params.set('coach-a', a.coach);
    params.set('coach-b', b.coach);
    // URLSearchParams renders flag params as 'spectate=' — harmless to the
    // parser (params.has works), and keeps this builder dead simple.
    return `${base}/?${params.toString()}`;
}
//# sourceMappingURL=fighterCard.js.map