export interface LiveSide {
    coach: string;
    engine: string;
    tweaks: Readonly<Record<string, number>>;
    rationale?: string | undefined;
}
export interface LiveMatchRow {
    n: number;
    seed: number;
    /** 0 = draw, 1 = red (side A), 2 = blue (side B). */
    winnerTeam: number;
    winnerCoach: string | null;
    redKills: number;
    blueKills: number;
    ticks: number;
    wallSecs: number;
}
export interface LiveFeed {
    matchDone(row: LiveMatchRow): void;
    finish(extra: {
        dataset?: string;
        watchUrl?: string;
    }): void;
}
/**
 * Open the live feed for one series. Each update rewrites LIVE.json
 * atomically (tmp + rename) so the watcher never reads a torn file. All
 * writes are best-effort: a broken disk must never kill a fight.
 */
export declare function startLiveFeed(datasetsDir: string, init: {
    arenaSeed: number;
    roundSecs: number;
    matchesPlanned: number;
    red: LiveSide;
    blue: LiveSide;
}): LiveFeed;
//# sourceMappingURL=live.d.ts.map