// Arena CLI tests (src/cli.ts) — goal node 170's entry point.
//
// cli.ts runs main() at import time, so it is exercised the way production
// runs it: a tsx child process (`pnpm arena` = `tsx src/cli.ts`). Each case
// spawns the real CLI and asserts on exit code, stdout/stderr, and the files
// it leaves on disk. Everything points --out at a throwaway tmp dir so no
// real datasets/ are touched, and all sims run with fixed seeds.
//
// Error paths (bad args, bad fighter cards) exit before any match runs, so
// they are cheap; the happy-path fight runs a real 10-second 1v1 twice to
// prove the recorded replay is byte-identical across runs (determinism is
// the whole training-data contract).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { FIGHTER_CARD_SCHEMA } from './fighterCard';

const TSX_BIN = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

/** Run the CLI exactly like `pnpm arena <args>` does. */
function arena(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(TSX_BIN, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 110_000,
    env: { ...process.env, INIT_CWD: undefined as unknown as string },
  });
}

let tmp: string;

function writeCard(
  name: string,
  card: Record<string, unknown>,
): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(card, null, 2));
  return p;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-cli-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('arena --help', () => {
  it('prints usage and exits 0', () => {
    const r = arena(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('soldat arena');
    expect(r.stdout).toContain('--teams');
    expect(r.stdout).toContain('fight <cardA.json> <cardB.json>');
  }, 60_000);
});

describe('arena argument validation (exit 1, helpful stderr, no dataset)', () => {
  it('rejects an unknown engine in --teams', () => {
    const r = arena(['--teams', 'pilot vs nosuchbrain']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown engine 'nosuchbrain'");
    expect(r.stderr).toContain('pilot'); // lists the registered roster
    expect(r.stderr).toContain('--help');
  }, 60_000);

  it('rejects mirror matches in --teams', () => {
    const r = arena(['--teams', 'pilot vs pilot']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/mirror matches/);
  }, 60_000);

  it('rejects non-integer, zero, and negative --matches', () => {
    for (const bad of ['abc', '0', '-2', '2.5']) {
      // --matches=<v> form: parseArgs rejects a bare '-2' as option-like.
      const r = arena(['--teams', 'pilot vs reaper', `--matches=${bad}`]);
      expect(r.status, `--matches ${bad}`).toBe(1);
      expect(r.stderr).toContain(`--matches expects a positive integer, got '${bad}'`);
    }
  }, 120_000);

  it('rejects a bad --seed and a bad --round the same way', () => {
    const seedRun = arena(['--teams', 'pilot vs reaper', '--seed', 'NaN']);
    expect(seedRun.status).toBe(1);
    expect(seedRun.stderr).toContain("--seed expects a positive integer, got 'NaN'");

    const roundRun = arena(['--teams', 'pilot vs reaper', '--round', '0']);
    expect(roundRun.status).toBe(1);
    expect(roundRun.stderr).toContain("--round expects a positive integer, got '0'");
  }, 120_000);

  it('rejects an unknown --variant, listing the known ones', () => {
    const r = arena(['--teams', 'pilot vs reaper', '--variant', 'nosuch']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown variant 'nosuch'");
    expect(r.stderr).toContain('baseline');
  }, 60_000);

  it('rejects an unknown --wildcard mode', () => {
    const r = arena(['--teams', 'pilot vs reaper', '--wildcard', 'lasers']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown wildcard 'lasers'");
  }, 60_000);

  it('rejects --sweep without explicit --teams (league mode)', () => {
    const r = arena(['--sweep', 'a:RANGE_MAX=380,420']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--sweep needs explicit --teams');
  }, 60_000);

  it('SUSPECT: parseArgs syntax errors crash with a raw stack trace, not the friendly arena error', () => {
    // parseArgs (cli.ts:72) runs OUTSIDE main()'s try/catch, so an unknown
    // option or an option-like value ('--matches -2') escapes as an uncaught
    // ERR_PARSE_ARGS_* TypeError — node prints a stack trace instead of the
    // "arena: ... Run 'pnpm arena --help'" message every other bad arg gets.
    // Pinning ACTUAL behavior here; flagged upstream rather than fixed.
    const unknown = arena(['--nope']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('ERR_PARSE_ARGS_UNKNOWN_OPTION');
    expect(unknown.stderr).not.toContain("Run 'pnpm arena --help'");

    const dashValue = arena(['--teams', 'pilot vs reaper', '--matches', '-2']);
    expect(dashValue.status).toBe(1);
    expect(dashValue.stderr).toContain('ERR_PARSE_ARGS_INVALID_OPTION_VALUE');
    expect(dashValue.stderr).not.toContain("Run 'pnpm arena --help'");
  }, 120_000);
});

describe('arena fight — card validation (exit 1 before any sim runs)', () => {
  it('requires exactly two card paths', () => {
    const none = arena(['fight']);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('exactly two fighter-card paths');

    const one = arena(['fight', 'only.json']);
    expect(one.status).toBe(1);
    expect(one.stderr).toContain('exactly two fighter-card paths');
  }, 120_000);

  it('reports a missing card file', () => {
    const a = writeCard('ok-a.json', {
      schema: FIGHTER_CARD_SCHEMA,
      coach: 'TESTA',
      engine: 'pilot',
      tweaks: {},
    });
    const r = arena(['fight', a, path.join(tmp, 'nope.json')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('arena fight:');
    expect(r.stderr).toMatch(/ENOENT|no such file/);
  }, 60_000);

  it('reports malformed JSON', () => {
    const broken = path.join(tmp, 'broken.json');
    fs.writeFileSync(broken, '{ not json');
    const a = writeCard('ok-a2.json', {
      schema: FIGHTER_CARD_SCHEMA,
      coach: 'TESTA',
      engine: 'pilot',
      tweaks: {},
    });
    const r = arena(['fight', broken, a]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('arena fight:');
  }, 60_000);

  it('rejects a wrong schema string', () => {
    const bad = writeCard('bad-schema.json', {
      schema: 'soldat-fighter-card/999',
      coach: 'X',
      engine: 'pilot',
      tweaks: {},
    });
    const ok = writeCard('ok-b.json', {
      schema: FIGHTER_CARD_SCHEMA,
      coach: 'TESTB',
      engine: 'reaper',
      tweaks: {},
    });
    const r = arena(['fight', bad, ok]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`schema must be '${FIGHTER_CARD_SCHEMA}'`);
  }, 60_000);

  it('rejects an unregistered engine on a card', () => {
    const bad = writeCard('bad-engine.json', {
      schema: FIGHTER_CARD_SCHEMA,
      coach: 'X',
      engine: 'nosuchbrain',
      tweaks: {},
    });
    const ok = writeCard('ok-c.json', {
      schema: FIGHTER_CARD_SCHEMA,
      coach: 'TESTB',
      engine: 'reaper',
      tweaks: {},
    });
    const r = arena(['fight', bad, ok]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('engine must be one of');
  }, 60_000);

  it('rejects an unknown knob on a card', () => {
    const bad = writeCard('bad-knob.json', {
      schema: FIGHTER_CARD_SCHEMA,
      coach: 'X',
      engine: 'pilot',
      tweaks: { NOT_A_KNOB: 1 },
    });
    const ok = writeCard('ok-d.json', {
      schema: FIGHTER_CARD_SCHEMA,
      coach: 'TESTB',
      engine: 'reaper',
      tweaks: {},
    });
    const r = arena(['fight', bad, ok]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown knob 'NOT_A_KNOB'");
  }, 60_000);

  it('rejects mirror matches (same engine on both cards)', () => {
    const a = writeCard('mirror-a.json', {
      schema: FIGHTER_CARD_SCHEMA,
      coach: 'A',
      engine: 'pilot',
      tweaks: {},
    });
    const b = writeCard('mirror-b.json', {
      schema: FIGHTER_CARD_SCHEMA,
      coach: 'B',
      engine: 'pilot',
      tweaks: {},
    });
    const r = arena(['fight', a, b]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('mirror matches');
  }, 60_000);
});

describe('arena fight — a real seeded 1v1 (10s round, tmp dataset)', () => {
  let cardA: string;
  let cardB: string;
  let out1: string;
  let out2: string;
  let run1: SpawnSyncReturns<string>;
  let run2: SpawnSyncReturns<string>;

  const fightArgs = (out: string): string[] => [
    'fight',
    cardA,
    cardB,
    '--matches',
    '1',
    '--round',
    '10',
    '--bots',
    '2',
    '--seed',
    '4242',
    '--arena',
    '3',
    '--wildcard',
    'none',
    '--out',
    out,
  ];

  /** The run directory writeRun created under `out` (skips LIVE.json etc.). */
  function runDirOf(out: string): string {
    const dirs = fs
      .readdirSync(out)
      .filter((f) => fs.statSync(path.join(out, f)).isDirectory());
    expect(dirs).toHaveLength(1);
    return path.join(out, dirs[0]!);
  }

  beforeAll(() => {
    cardA = writeCard('fight-a.json', {
      schema: FIGHTER_CARD_SCHEMA,
      coach: 'TESTA',
      engine: 'pilot',
      tweaks: { RANGE_MAX: 500 },
      rationale: 'unit-test card',
    });
    cardB = writeCard('fight-b.json', {
      schema: FIGHTER_CARD_SCHEMA,
      coach: 'TESTB',
      engine: 'reaper',
      tweaks: {},
    });
    out1 = fs.mkdtempSync(path.join(tmp, 'out1-'));
    out2 = fs.mkdtempSync(path.join(tmp, 'out2-'));
    run1 = arena(fightArgs(out1));
    run2 = arena(fightArgs(out2));
  }, 240_000);

  it('exits 0 and narrates the series', () => {
    expect(run1.status, run1.stderr).toBe(0);
    expect(run1.stdout).toContain('CLAUDE ARENA — TESTA (pilot) vs TESTB (reaper)');
    expect(run1.stdout).toContain('1 match(es) · 10s rounds · arena #3');
    expect(run1.stdout).toContain('TESTA: "unit-test card"');
    expect(run1.stdout).toMatch(/match 1\/1 {2}seed 4242/);
    expect(run1.stdout).toMatch(/series: TESTA \d+ — \d+ TESTB/);
  });

  it('prints a WATCH URL carrying seed/round/arena/tweaks/coaches', () => {
    const m = run1.stdout.match(/http:\/\/localhost:5173\/\?\S+/);
    expect(m).not.toBeNull();
    const url = new URL(m![0]!);
    expect(url.searchParams.get('ai')).toBe('pilot,reaper');
    expect(url.searchParams.get('seed')).toBe('4242');
    expect(url.searchParams.get('round')).toBe('10');
    expect(url.searchParams.get('arena')).toBe('3');
    expect(url.searchParams.get('tweak-a')).toBe('RANGE_MAX=500');
    expect(url.searchParams.get('coach-a')).toBe('TESTA');
    expect(url.searchParams.get('coach-b')).toBe('TESTB');
    expect(url.searchParams.has('spectate')).toBe(true);
  });

  it('writes the dataset files into --out', () => {
    const dir = runDirOf(out1);
    expect(path.basename(dir)).toContain('TESTA-pilot-vs-TESTB-reaper');
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual([
      'manifest.json',
      'match-1.events.jsonl.gz',
      'match-1.replay.jsonl.gz',
      'match-1.telemetry.json.gz',
      'summary.json',
    ]);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.teams ?? manifest.matches ?? manifest).toBeDefined();
  });

  it('is deterministic: the recorded replay is byte-identical across runs', () => {
    expect(run2.status, run2.stderr).toBe(0);
    const replay1 = gunzipSync(
      fs.readFileSync(path.join(runDirOf(out1), 'match-1.replay.jsonl.gz')),
    );
    const replay2 = gunzipSync(
      fs.readFileSync(path.join(runDirOf(out2), 'match-1.replay.jsonl.gz')),
    );
    expect(replay1.length).toBeGreaterThan(0);
    expect(replay1.equals(replay2)).toBe(true);

    // Verdict lines match too (same seed -> same winner, kills, ticks).
    const verdict = (s: string): string | undefined =>
      s.split('\n').find((l) => l.includes('match 1/1'));
    expect(verdict(run1.stdout)).toBeDefined();
    expect(verdict(run1.stdout)).toBe(verdict(run2.stdout));
  });
});
