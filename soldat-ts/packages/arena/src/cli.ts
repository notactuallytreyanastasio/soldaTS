// The arena harness CLI (goal node 170) — run headless bot-vs-bot
// deathmatches and write training datasets. Examples (from soldat-ts/):
//
//   pnpm arena --teams "pilot vs reaper" --matches 8 --round 120 --variant baseline
//   pnpm arena --teams pilot vs reaper --tweak-a RANGE_MAX=500 --tweak-b KILL_RANGE=220
//   pnpm arena --teams pilot vs reaper --sweep a:RANGE_MAX=380,420,460 --matches 4
//   pnpm arena fight fights/vega.json fights/okonkwo.json --round 120
//
// Wall-clock timing here is PRINT-ONLY: nothing time-based is written into
// the dataset files except manifest.createdAt — determinism lives in runner.ts.

import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { VARIANTS, engineIds } from '@soldat/client/headless';
import {
  buildRunPlans,
  parseSweep,
  parseTeams,
  parseTweaks,
  parseWildcard,
  WILDCARDS,
  WILDCARD_MODES,
  type RunPlan,
} from './cliArgs';
import { runMatch, type MatchResult } from './runner';
import { buildManifest, makeRunId, writeRun } from './store';
import { buildWatchUrl, validateCard, type FighterCard } from './fighterCard';
import { startLiveFeed } from './live';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
  --wildcard MODE        ${WILDCARD_MODES.join(' | ')} — default 'chance': each match
                         rolls a seeded chance of arming one SPAS-12 carrier
                         per team; 'shotgun' forces it, 'none' is stock
  --seed N               base seed; match k uses seed+k (default 1337)
  --out DIR              dataset base dir (default soldat-ts/datasets)
  --arena N              generated-arena seed (0 = canonical Skyreach)
  --help                 this text

CLAUDE ARENA:
  pnpm arena fight <cardA.json> <cardB.json> [--matches N --round S --seed N --arena N]
                         two fighter cards (see ARENA.md) face off; the match
                         is recorded as a dataset AND printed as a WATCH URL
                         that replays it in the browser, coach names on the
                         banner. Card schema: soldat-fighter-card/1.
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
      wildcard: { type: 'string' },
      seed: { type: 'string' },
      sweep: { type: 'string' },
      out: { type: 'string' },
      arena: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help === true) {
    console.log(HELP);
    return;
  }

  // CLAUDE ARENA: `fight cardA.json cardB.json` — two coaches face off.
  if (positionals[0] === 'fight') {
    fight(positionals.slice(1), values);
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
      wildcard: parseWildcard(values.wildcard),
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
    // Play-by-play baked into the runtime (engine names stand in for coaches).
    const live = startLiveFeed(outDir, {
      arenaSeed: 0,
      roundSecs: plan.roundTicks / 60,
      matchesPlanned: plan.matches,
      red: { coach: plan.teams[0].engine, engine: plan.teams[0].engine, tweaks: plan.teams[0].tweaks ?? {} },
      blue: { coach: plan.teams[1].engine, engine: plan.teams[1].engine, tweaks: plan.teams[1].tweaks ?? {} },
    });
    for (let k = 0; k < plan.matches; k++) {
      const seed = plan.seedBase + k;
      const t0 = performance.now();
      const result = runMatch({
        seed,
        teams: plan.teams,
        botCount: plan.botCount,
        variant: plan.variant,
        roundTicks: plan.roundTicks,
        wildcard: plan.wildcard,
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
      live.matchDone({
        n: k + 1,
        seed,
        winnerTeam: round?.winnerTeam ?? 0,
        winnerCoach: round?.winnerEngine ?? null,
        redKills: round?.redKills ?? 0,
        blueKills: round?.blueKills ?? 0,
        ticks: result.ticks,
        wallSecs: Number(secs),
      });
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
        wildcard: plan.wildcard,
        cli: cliLine,
      }),
      results,
    );
    outcomes.push({ plan, results, dir });
    live.finish({ dataset: dir });

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

/** The Claude Arena fight runner: two fighter cards in, dataset + watch URL out. */
function fight(
  cardPaths: readonly string[],
  values: {
    matches?: string | undefined;
    round?: string | undefined;
    bots?: string | undefined;
    seed?: string | undefined;
    arena?: string | undefined;
    out?: string | undefined;
    wildcard?: string | undefined;
  },
): void {
  if (cardPaths.length !== 2) {
    console.error('arena fight: exactly two fighter-card paths required (see ARENA.md)');
    process.exitCode = 1;
    return;
  }
  let a: FighterCard;
  let b: FighterCard;
  // pnpm runs this with cwd = packages/arena; resolve card paths against the
  // directory the user actually typed the command from.
  const userCwd = process.env['INIT_CWD'] ?? process.cwd();
  try {
    a = validateCard(JSON.parse(readFileSync(path.resolve(userCwd, cardPaths[0]!), 'utf8'))).card;
    b = validateCard(JSON.parse(readFileSync(path.resolve(userCwd, cardPaths[1]!), 'utf8'))).card;
  } catch (err) {
    console.error(`arena fight: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  if (a.engine === b.engine) {
    console.error('arena fight: mirror matches need engine aliasing (next slice) — pick different engines');
    process.exitCode = 1;
    return;
  }
  const matches = Math.max(1, parseInt(values.matches ?? '1', 10) || 1);
  const roundSecs = Math.max(10, parseInt(values.round ?? '120', 10) || 120);
  const botCount = Math.max(2, parseInt(values.bots ?? '6', 10) || 6);
  const seedBase = parseInt(values.seed ?? '1337', 10) || 1337;
  const arenaSeed = Math.max(0, parseInt(values.arena ?? '0', 10) || 0);
  let wildcard: string | undefined;
  try {
    wildcard = parseWildcard(values.wildcard);
  } catch (err) {
    console.error(`arena fight: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  const outDir =
    values.out ?? fileURLToPath(new URL('../../../datasets', import.meta.url));

  console.log(
    `CLAUDE ARENA — ${a.coach} (${a.engine}) vs ${b.coach} (${b.engine}) · ` +
      `${matches} match(es) · ${roundSecs}s rounds · arena #${arenaSeed}` +
      ` · wildcard ${wildcard}`,
  );
  if (a.rationale !== undefined) console.log(`  ${a.coach}: "${a.rationale}"`);
  if (b.rationale !== undefined) console.log(`  ${b.coach}: "${b.rationale}"`);

  // Play-by-play baked into the runtime: the broadcast watcher polls the
  // datasets dir, so LIVE.json puts this series on the site as it runs.
  const live = startLiveFeed(outDir, {
    arenaSeed,
    roundSecs,
    matchesPlanned: matches,
    red: { coach: a.coach, engine: a.engine, tweaks: a.tweaks ?? {}, rationale: a.rationale },
    blue: { coach: b.coach, engine: b.engine, tweaks: b.tweaks ?? {}, rationale: b.rationale },
  });

  const results: MatchResult[] = [];
  for (let k = 0; k < matches; k++) {
    const seed = seedBase + k;
    const started = performance.now();
    const result = runMatch({
      seed,
      arenaSeed,
      botCount,
      roundTicks: roundSecs * 60,
      wildcard,
      teams: [
        { engine: a.engine, tweaks: a.tweaks },
        { engine: b.engine, tweaks: b.tweaks },
      ],
    });
    results.push(result);
    const r = result.round;
    const wallSecs = (performance.now() - started) / 1000;
    const verdict =
      r === null
        ? 'cap'
        : r.winnerTeam === 1
          ? `${a.coach} wins (${r.redKills}-${r.blueKills})`
          : r.winnerTeam === 2
            ? `${b.coach} wins (${r.blueKills}-${r.redKills})`
            : `draw (${r.redKills}-${r.blueKills})`;
    console.log(
      `  match ${k + 1}/${matches}  seed ${seed}  ${verdict}  ${wallSecs.toFixed(1)}s`,
    );
    live.matchDone({
      n: k + 1,
      seed,
      winnerTeam: r?.winnerTeam ?? 0,
      winnerCoach: r?.winnerTeam === 1 ? a.coach : r?.winnerTeam === 2 ? b.coach : null,
      redKills: r?.redKills ?? 0,
      blueKills: r?.blueKills ?? 0,
      ticks: result.ticks,
      wallSecs: Number(wallSecs.toFixed(2)),
    });
  }

  const runId = makeRunId(`${a.coach}-${a.engine}`, `${b.coach}-${b.engine}`);
  const manifest = buildManifest({
    runId,
    botCount,
    roundTicks: roundSecs * 60,
    maxTicks: roundSecs * 60 + 600,
    variantName: 'baseline',
    wildcard,
    teams: [
      { engine: a.engine, tweaks: a.tweaks },
      { engine: b.engine, tweaks: b.tweaks },
    ],
    results,
    cli: process.argv.slice(2).join(' '),
  });
  const dir = writeRun(outDir, runId, manifest, results);
  console.log(`  dataset: ${dir}`);

  const aWins = results.filter((x) => x.round?.winnerTeam === 1).length;
  const bWins = results.filter((x) => x.round?.winnerTeam === 2).length;
  console.log(`  series: ${a.coach} ${aWins} — ${bWins} ${b.coach}`);
  console.log('');
  console.log('  WATCH (replays the exact match-1 sim in the browser — pnpm play first):');
  const watchUrl = buildWatchUrl('http://localhost:5173', a, b, {
    seed: seedBase, roundSecs, arenaSeed,
    wildcard: results[0]?.wildcard ?? undefined,
  });
  console.log(`  ${watchUrl}`);
  live.finish({ dataset: dir, watchUrl });
}
