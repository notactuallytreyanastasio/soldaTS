// Pure CLI-argument helpers (goal node 170) — no fs, no process, fully
// unit-tested. cli.ts owns parseArgs/printing/exit codes; everything that can
// throw a user-facing usage error lives here so the messages are testable.

import type { TeamSpec } from './runner';

const TEAMS_USAGE =
  "expected --teams \"<a> vs <b>\" or --teams <a>,<b> (e.g. --teams \"pilot vs reaper\")";

/**
 * Resolve the two team engines from `--teams` plus any positionals (the
 * unquoted `--teams pilot vs reaper` form puts 'vs reaper' in positionals).
 * Default (nothing given) → ['pilot', 'reaper'].
 */
export function parseTeams(
  teamsOpt: string | undefined,
  positionals: readonly string[],
): [string, string] {
  let a: string | undefined;
  let b: string | undefined;
  if (teamsOpt === undefined && positionals.length === 0) {
    return ['pilot', 'reaper'];
  }
  const joined = [teamsOpt ?? '', ...positionals].join(' ').trim();
  const vsMatch = /^(\S+)\s+vs\s+(\S+)$/.exec(joined);
  if (vsMatch !== null) {
    a = vsMatch[1];
    b = vsMatch[2];
  } else if (teamsOpt !== undefined && positionals.length === 0) {
    const parts = teamsOpt.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (parts.length === 2) {
      a = parts[0];
      b = parts[1];
    }
  }
  if (a === undefined || b === undefined) {
    throw new Error(`can't parse teams from '${joined}' — ${TEAMS_USAGE}`);
  }
  if (a === b) {
    throw new Error('mirror matches need engine aliasing — not in this slice');
  }
  return [a, b];
}

/** `['RANGE_MAX=500', ...]` → `{RANGE_MAX: 500, ...}`; throws on malformed. */
export function parseTweaks(list: readonly string[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of list ?? []) {
    const eq = item.indexOf('=');
    const key = eq > 0 ? item.slice(0, eq).trim() : '';
    const value = eq > 0 ? Number(item.slice(eq + 1)) : NaN;
    if (key === '' || !Number.isFinite(value)) {
      throw new Error(`bad tweak '${item}' — KEY=NUMBER expected (e.g. RANGE_MAX=500)`);
    }
    out[key] = value;
  }
  return out;
}

/** Known opt-in wildcards (the match-rule mutators a run may arm). */
export const WILDCARDS = ['shotgun'] as const;

/** Wildcard MODES a run may request: a specific wildcard forced on every
 *  match, 'none' (stock), or 'chance' — each match rolls the seeded chance
 *  (client wildcardChance.ts) so ALL games may incorporate shotgun play. */
export const WILDCARD_MODES = [...WILDCARDS, 'none', 'chance'] as const;

/** Validate --wildcard; absent defaults to 'chance' (every run gets a shot
 *  at shotgun play — pass --wildcard none for guaranteed-stock runs). */
export function parseWildcard(raw: string | undefined): string {
  if (raw === undefined) return 'chance';
  if (!(WILDCARD_MODES as readonly string[]).includes(raw)) {
    throw new Error(`unknown wildcard '${raw}' (known: ${WILDCARD_MODES.join(', ')})`);
  }
  return raw;
}

export interface SweepSpec {
  team: 'a' | 'b';
  key: string;
  values: number[];
}

/** `'a:RANGE_MAX=380,420,460'` → sweep spec; null when undefined; throws on malformed. */
export function parseSweep(spec: string | undefined): SweepSpec | null {
  if (spec === undefined) return null;
  const m = /^([ab]):([^=]+)=(.+)$/.exec(spec);
  if (m === null) {
    throw new Error(`bad sweep '${spec}' — expected a:KEY=v1,v2,... or b:KEY=v1,v2,...`);
  }
  const values = m[3]!.split(',').map((v) => Number(v.trim()));
  if (values.length === 0 || values.some((v) => !Number.isFinite(v))) {
    throw new Error(`bad sweep values in '${spec}' — comma-separated numbers expected`);
  }
  return { team: m[1] as 'a' | 'b', key: m[2]!.trim(), values };
}

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
export function buildRunPlans(args: {
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
}): RunPlan[] {
  const roundTicks = args.roundSeconds * 60;
  const base = (tweakA: Record<string, number>, tweakB: Record<string, number>): [TeamSpec, TeamSpec] => [
    { engine: args.teams[0], ...(Object.keys(tweakA).length > 0 ? { tweaks: tweakA } : {}) },
    { engine: args.teams[1], ...(Object.keys(tweakB).length > 0 ? { tweaks: tweakB } : {}) },
  ];
  if (args.sweep === null) {
    return [
      {
        label: `${args.teams[0]}-vs-${args.teams[1]}`,
        teams: base(args.tweakA, args.tweakB),
        matches: args.matches,
        seedBase: args.seedBase,
        botCount: args.botCount,
        variant: args.variant,
        roundTicks,
        wildcard: args.wildcard,
      },
    ];
  }
  const sweep = args.sweep;
  return sweep.values.map((value) => {
    const tweakA = sweep.team === 'a' ? { ...args.tweakA, [sweep.key]: value } : args.tweakA;
    const tweakB = sweep.team === 'b' ? { ...args.tweakB, [sweep.key]: value } : args.tweakB;
    const label = `${sweep.key}-${value}`;
    return {
      label,
      teams: base(tweakA, tweakB),
      matches: args.matches,
      seedBase: args.seedBase,
      botCount: args.botCount,
      variant: args.variant,
      roundTicks,
      wildcard: args.wildcard,
      runIdSuffix: label,
    };
  });
}
