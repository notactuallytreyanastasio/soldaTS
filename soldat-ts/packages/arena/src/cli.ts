// The arena harness CLI (goal node 170) — run headless bot-vs-bot
// deathmatches and write training datasets. Examples (from soldat-ts/):
//
//   pnpm arena --teams "pilot vs reaper" --matches 8 --round 120 --variant baseline
//   pnpm arena --teams pilot vs reaper --tweak-a RANGE_MAX=500 --tweak-b KILL_RANGE=220
//   pnpm arena --teams pilot vs reaper --sweep a:RANGE_MAX=380,420,460 --matches 4
//
// Wall-clock timing here is PRINT-ONLY: nothing time-based is written into
// the dataset files except manifest.createdAt — determinism lives in runner.ts.

import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { VARIANTS, engineIds } from '@soldat/client/headless';
import { buildRunPlans, parseSweep, parseTeams, parseTweaks, type RunPlan } from './cliArgs';
import { runMatch, type MatchResult } from './runner';
import { buildManifest, makeRunId, writeRun } from './store';

const HELP = `soldat arena — headless bot-vs-bot deathmatches + training datasets

USAGE (from soldat-ts/):
  pnpm arena [options]

OPTIONS:
  --teams "<a> vs <b>"   engines for red (a) and blue (b); also accepts a,b
                         (default: pilot vs reaper)
  --tweak-a KEY=NUM      brain-config override for team a (repeatable)
  --tweak-b KEY=NUM      brain-config override for team b (repeatable)
  --sweep <a|b>:KEY=v1,v2,...
                         run one full set of matches per value of one knob
  --matches N            matches per run (default 4)
  --round SECS           round length in sim-seconds (default 120)
  --bots N               total bots, split evenly (default 6 = 3v3)
  --variant NAME         gameplay variant: ${VARIANTS.map((v) => v.name).join(' | ')}
  --seed N               base seed; match k uses seed+k (default 1337)
  --out DIR              dataset base dir (default soldat-ts/datasets)
  --help                 this text
`;

interface RunOutcome {
  plan: RunPlan;
  results: MatchResult[];
  dir: string;
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: {
      teams: { type: 'string' },
      'tweak-a': { type: 'string', multiple: true },
      'tweak-b': { type: 'string', multiple: true },
      matches: { type: 'string' },
      round: { type: 'string' },
      bots: { type: 'string' },
      variant: { type: 'string' },
      seed: { type: 'string' },
      sweep: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help === true) {
    console.log(HELP);
    return;
  }

  const intArg = (raw: string | undefined, name: string, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`--${name} expects a positive integer, got '${raw}'`);
    }
    return n;
  };

  let plans: RunPlan[];
  let variant: string;
  try {
    const teams = parseTeams(values.teams, positionals);
    for (const id of teams) {
      if (!engineIds().includes(id)) {
        throw new Error(`unknown engine '${id}' (registered: ${engineIds().join(', ')})`);
      }
    }
    variant = values.variant ?? 'baseline';
    if (!VARIANTS.some((v) => v.name === variant)) {
      throw new Error(
        `unknown variant '${variant}' (known: ${VARIANTS.map((v) => v.name).join(', ')})`,
      );
    }
    plans = buildRunPlans({
      teams,
      tweakA: parseTweaks(values['tweak-a']),
      tweakB: parseTweaks(values['tweak-b']),
      sweep: parseSweep(values.sweep),
      matches: intArg(values.matches, 'matches', 4),
      seedBase: intArg(values.seed, 'seed', 1337),
      botCount: intArg(values.bots, 'bots', 6),
      variant,
      roundSeconds: intArg(values.round, 'round', 120),
    });
  } catch (err) {
    console.error(`arena: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`Run 'pnpm arena --help' for usage.`);
    process.exitCode = 1;
    return;
  }

  // Default out dir resolves relative to THIS FILE (pnpm --filter runs with
  // cwd = packages/arena), landing on soldat-ts/datasets regardless of cwd.
  const outDir = values.out ?? fileURLToPath(new URL('../../../datasets', import.meta.url));
  const cliLine = process.argv.slice(2).join(' ');

  const outcomes: RunOutcome[] = [];
  for (const plan of plans) {
    const results: MatchResult[] = [];
    console.log(
      `\n[${plan.label}] ${plan.teams[0].engine} (red) vs ${plan.teams[1].engine} (blue)` +
        ` · ${plan.matches} matches · ${plan.roundTicks / 60}s rounds · variant ${plan.variant}`,
    );
    for (let k = 0; k < plan.matches; k++) {
      const seed = plan.seedBase + k;
      const t0 = performance.now();
      const result = runMatch({
        seed,
        teams: plan.teams,
        botCount: plan.botCount,
        variant: plan.variant,
        roundTicks: plan.roundTicks,
      });
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      const round = result.round;
      const verdict =
        round === null
          ? 'no verdict (cap hit)'
          : round.winnerTeam === 0
            ? `draw (red ${round.redKills} – ${round.blueKills} blue)`
            : `winner ${round.winnerEngine} (red ${round.redKills} – ${round.blueKills} blue)`;
      const rowCount = result.replayJsonl.length === 0 ? 0 : result.replayJsonl.trimEnd().split('\n').length;
      console.log(
        `[${plan.label}] match ${k + 1}/${plan.matches}  seed ${seed}  ${verdict}` +
          `  ticks ${result.ticks}  ${secs}s  rows ${rowCount}`,
      );
      results.push(result);
    }

    const runId = makeRunId(plan.teams[0].engine, plan.teams[1].engine, plan.runIdSuffix);
    const dir = writeRun(
      outDir,
      runId,
      buildManifest({
        runId,
        teams: plan.teams,
        results,
        variantName: plan.variant,
        botCount: plan.botCount,
        roundTicks: plan.roundTicks,
        maxTicks: plan.roundTicks + 600,
        cli: cliLine,
      }),
      results,
    );
    outcomes.push({ plan, results, dir });

    // Per-run standings.
    const wins = { red: 0, blue: 0 };
    const kills = { red: 0, blue: 0 };
    const dom = { red: 0, blue: 0 };
    for (const r of results) {
      if (r.round?.winnerTeam === 1) wins.red += 1;
      else if (r.round?.winnerTeam === 2) wins.blue += 1;
      kills.red += r.round?.redKills ?? 0;
      kills.blue += r.round?.blueKills ?? 0;
      dom.red += r.round?.redDom ?? 0;
      dom.blue += r.round?.blueDom ?? 0;
    }
    console.log(
      `[${plan.label}] standings: ${plan.teams[0].engine} ${wins.red}W ${kills.red}K dom ${dom.red.toFixed(1)}` +
        ` | ${plan.teams[1].engine} ${wins.blue}W ${kills.blue}K dom ${dom.blue.toFixed(1)}`,
    );
    console.log(`[${plan.label}] dataset: ${dir}`);
  }

  // Sweep epilogue: the knob's effect at a glance.
  if (outcomes.length > 1) {
    console.log('\nSWEEP SUMMARY  (value · red wins · blue wins · red kills · blue kills)');
    for (const o of outcomes) {
      let redWins = 0;
      let blueWins = 0;
      let redKills = 0;
      let blueKills = 0;
      for (const r of o.results) {
        if (r.round?.winnerTeam === 1) redWins += 1;
        else if (r.round?.winnerTeam === 2) blueWins += 1;
        redKills += r.round?.redKills ?? 0;
        blueKills += r.round?.blueKills ?? 0;
      }
      console.log(
        `  ${o.plan.label.padEnd(20)} red ${redWins}W  blue ${blueWins}W  red ${redKills}K  blue ${blueKills}K`,
      );
    }
  }
}

main();
