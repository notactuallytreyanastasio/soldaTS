import type { Game } from '@soldat/client/headless';
export declare const REPLAY_SCHEMA = "soldat-arena-replay/1";
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