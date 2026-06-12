import { type Game } from '@soldat/client/headless';
export declare const REPLAY_SCHEMA = "soldat-arena-replay/2";
export interface ReplayControl {
    left: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
    fire: boolean;
    jetpack: boolean;
    reload: boolean;
    /** Aim as a RELATIVE offset from the bot (px, y down) — what brains write. */
    aimX: number;
    aimY: number;
}
/** One JSONL row: the observation a live bot's brain acted on this tick plus
 *  the action it chose. Sampled via Game.onBrainsTicked (post-think, pre-physics). */
export interface ReplayRow {
    tick: number;
    bot: number;
    team: number;
    engine: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    fuel: number;
    hp: number;
    ammo: number;
    reloading: boolean;
    onGround: boolean;
    /** v2: held weapon label ('AK74' | 'SPAS12' | 'BARRETT' | 'ROCKET' |
     *  'RICOCHET' | 'CHAINSAW') — exact, no magazine-size sleuthing. */
    weapon: string;
    /** v2: own spray bloom (radians, 0..0.16), 4 decimals — the heat the
     *  written brains' tap cadence manages, finally visible to students. */
    heat: number;
    /** v2: nearest-incoming-bullet-threat present flag. The winner of the SAME
     *  closest-approach scan the runtime dodge organs run (nearestThreatBullet,
     *  neuralFeaturesV3.ts) over live enemy bullets at the post-think seam.
     *  When true, btx/bty/btvx/btvy carry the bullet's kinematics RELATIVE to
     *  this bot (px and px/tick, 2 decimals); when false they are absent —
     *  rows stay compact, like the kill event's optional weapon tag. */
    btt: boolean;
    btx?: number;
    bty?: number;
    btvx?: number;
    btvy?: number;
    control: ReplayControl;
}
export type ArenaEvent = {
    tick: number;
    type: 'shot';
    bot: number;
} | {
    tick: number;
    type: 'hit';
    attacker: number;
    victim: number;
    damage: number;
} | {
    tick: number;
    type: 'kill';
    killer: number;
    victim: number;
    killerPos: {
        x: number;
        y: number;
    } | null;
    victimPos: {
        x: number;
        y: number;
    };
    dist: number | null;
    /** Killer's weapon label ('AK74' | 'SPAS12'); present only in
     *  wildcard runs so default event streams keep their exact shape. */
    weapon?: string;
};
/**
 * Build the replay row for `botIndex` at `tick`; null when the sprite is
 * missing, inactive, or dead (dead bots emit no rows — a tick gap for a bot
 * means it was dead/respawning).
 */
export declare function buildReplayRow(game: Game, botIndex: number, tick: number): ReplayRow | null;
/** Serialize rows as JSONL: one JSON object per line + trailing newline ('' for none). */
export declare function rowsToJsonl(rows: readonly ReplayRow[]): string;
/** Serialize the event stream as JSONL (same contract as rowsToJsonl). */
export declare function eventsToJsonl(events: readonly ArenaEvent[]): string;
//# sourceMappingURL=replay.d.ts.map