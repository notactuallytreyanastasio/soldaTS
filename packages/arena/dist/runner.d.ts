import { type GameTuning, type MatchDump, type RoundResult } from '@soldat/client/headless';
import { type ArenaEvent } from './replay';
export interface TeamSpec {
    engine: string;
    tweaks?: Record<string, number> | undefined;
}
export interface MatchConfig {
    /** Generated-arena seed (0/omitted = the canonical hand-built Skyreach).
     *  Deterministic: the seed IS the map's identity in the manifest. */
    arenaSeed?: number | undefined;
    seed: number;
    /** [0] = red (team 1), [1] = blue (team 2) — Game.teamFor maps engine
     *  group 0 → red, group 1 → blue. */
    teams: readonly [TeamSpec, TeamSpec];
    botCount?: number;
    variant?: string;
    roundTicks?: number;
    maxTicks?: number;
    /** Wildcard MODE: 'shotgun' forces one SPAS-12 carrier per team (picked
     *  deterministically from `seed` by the Game); 'chance' rolls the seeded
     *  per-match chance; 'none'/omitted = stock loadouts. */
    wildcard?: string | undefined;
}
export interface MatchBotInfo {
    index: number;
    name: string;
    engine: string;
    team: number;
}
export interface MatchResult {
    seed: number;
    /** The wildcard this match actually ran with (null = stock) — the resolved
     *  value, not the requested mode ('chance' resolves per seed). */
    wildcard: string | null;
    ticks: number;
    round: RoundResult | null;
    telemetry: MatchDump;
    replayJsonl: string;
    events: ArenaEvent[];
    bots: MatchBotInfo[];
    tuning: GameTuning;
    /** Per team, the FULL config each side's brains ran with. */
    resolvedTweaks: [Record<string, number>, Record<string, number>];
}
/** Run one complete headless deathmatch; throws on invalid team specs. */
export declare function runMatch(config: MatchConfig): MatchResult;
//# sourceMappingURL=runner.d.ts.map