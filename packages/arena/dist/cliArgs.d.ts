import type { TeamSpec } from './runner';
/**
 * Resolve the two team engines from `--teams` plus any positionals (the
 * unquoted `--teams pilot vs reaper` form puts 'vs reaper' in positionals).
 * Default (nothing given) → ['pilot', 'reaper'].
 */
export declare function parseTeams(teamsOpt: string | undefined, positionals: readonly string[]): [string, string] | null;
/** `['RANGE_MAX=500', ...]` → `{RANGE_MAX: 500, ...}`; throws on malformed. */
export declare function parseTweaks(list: readonly string[] | undefined): Record<string, number>;
/** Known opt-in wildcards (the match-rule mutators a run may arm). */
export declare const WILDCARDS: readonly ["shotgun"];
/** Wildcard MODES a run may request: a specific wildcard forced on every
 *  match, 'none' (stock), or 'chance' — each match rolls the seeded chance
 *  (client wildcardChance.ts) so ALL games may incorporate shotgun play. */
export declare const WILDCARD_MODES: readonly ["shotgun", "none", "chance"];
/** Validate --wildcard; absent defaults to 'chance' (every run gets a shot
 *  at shotgun play — pass --wildcard none for guaranteed-stock runs). */
export declare function parseWildcard(raw: string | undefined): string;
export interface SweepSpec {
    team: 'a' | 'b';
    key: string;
    values: number[];
}
/** `'a:RANGE_MAX=380,420,460'` → sweep spec; null when undefined; throws on malformed. */
export declare function parseSweep(spec: string | undefined): SweepSpec | null;
export interface RunPlan {
    label: string;
    teams: [TeamSpec, TeamSpec];
    matches: number;
    seedBase: number;
    botCount: number;
    variant: string;
    roundTicks: number;
    /** Opt-in wildcard ('shotgun') applied to every match of the run. */
    wildcard?: string | undefined;
    runIdSuffix?: string | undefined;
}
/**
 * No sweep → one plan. Sweep → one plan per value with the swept knob layered
 * over that team's base tweaks. ALL plans share the same seedBase (identical
 * seed series per value — the sweep isolates the knob).
 */
export declare function buildRunPlans(args: {
    teams: [string, string];
    tweakA: Record<string, number>;
    tweakB: Record<string, number>;
    sweep: SweepSpec | null;
    matches: number;
    seedBase: number;
    botCount: number;
    variant: string;
    roundSeconds: number;
    wildcard?: string | undefined;
}): RunPlan[];
//# sourceMappingURL=cliArgs.d.ts.map