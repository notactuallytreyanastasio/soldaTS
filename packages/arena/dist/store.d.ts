import type { GameTuning } from '@soldat/client/headless';
import type { MatchResult, TeamSpec } from './runner';
export declare const MANIFEST_SCHEMA = "soldat-arena-replay/1";
export declare const SUMMARY_SCHEMA = "soldat-arena-summary/1";
export interface TeamManifest {
    team: 1 | 2;
    engine: string;
    /** What the caller asked for ({} if none). */
    requestedTweaks: Record<string, number>;
    /** FULL config the brains ran with (defaults + applied tweaks). */
    resolvedTweaks: Record<string, number>;
}
export interface RunManifest {
    schema: typeof MANIFEST_SCHEMA;
    runId: string;
    createdAt: string;
    gitRev: string;
    map: 'Skyreach';
    botCount: number;
    roundTicks: number;
    maxTicks: number;
    variant: {
        name: string;
        tuning: GameTuning;
    };
    /** Wildcard MODE the run was requested with ('shotgun'|'chance'), null
     *  when stock — per-match RESOLVED values live on matches[].wildcard. */
    wildcard: string | null;
    teams: [TeamManifest, TeamManifest];
    matches: {
        n: number;
        seed: number;
        /** Wildcard this match actually ran ('shotgun' | null) — 'chance' runs
         *  resolve per seed, so matches within one run may differ. */
        wildcard?: string | null;
        files: {
            replay: string;
            telemetry: string;
            events: string;
        };
    }[];
    /** process.argv.slice(2).join(' ') when run from cli.ts, else null. */
    cli: string | null;
}
export interface RunSummary {
    schema: typeof SUMMARY_SCHEMA;
    matches: {
        n: number;
        seed: number;
        ticks: number;
        winnerTeam: 0 | 1 | 2;
        winnerEngine: string;
        redKills: number;
        blueKills: number;
        redDom: number;
        blueDom: number;
    }[];
    standings: {
        red: {
            engine: string;
            wins: number;
            kills: number;
            deaths: number;
            dominance: number;
        };
        blue: {
            engine: string;
            wins: number;
            kills: number;
            deaths: number;
            dominance: number;
        };
        draws: number;
        /** Engine id with more wins; kills tiebreak; '' on a dead tie. */
        winner: string;
    };
    /** Summed across matches, kills desc. */
    bots: {
        name: string;
        engine: string;
        team: number;
        kills: number;
        deaths: number;
        shots: number;
        hits: number;
        hitRate: number;
    }[];
}
/** `YYYYMMDD-HHMMSS-<a>-vs-<b>[-<suffix>]` (UTC; `now` injectable for tests). */
export declare function makeRunId(teamA: string, teamB: string, suffix?: string, now?: Date): string;
/** `git rev-parse HEAD` from this file's directory; 'unknown' on any failure. */
export declare function gitRev(): string;
export interface ManifestArgs {
    runId: string;
    teams: readonly [TeamSpec, TeamSpec];
    results: readonly MatchResult[];
    variantName: string;
    botCount: number;
    roundTicks: number;
    maxTicks: number;
    wildcard?: string | undefined;
    cli?: string | null;
    now?: Date;
}
/** Build the run manifest (pure apart from gitRev's subprocess). */
export declare function buildManifest(args: ManifestArgs): RunManifest;
/** Aggregate standings across matches (pure). */
export declare function buildSummary(results: readonly MatchResult[]): RunSummary;
/**
 * Write one run directory: per-match replay (gzipped), telemetry, events,
 * plus manifest.json and summary.json. Returns the absolute run directory.
 */
export declare function writeRun(baseDir: string, runId: string, manifest: RunManifest, results: readonly MatchResult[]): string;
//# sourceMappingURL=store.d.ts.map