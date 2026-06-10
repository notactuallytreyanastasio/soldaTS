// THE EVALUATION GAUNTLET — the measurement foundation of the bot-training
// program (goal node 427). Every training experiment (imitation, ES
// self-play, future doctrines) is scored against ONE standardized,
// variance-controlled, held-out benchmark instead of ad-hoc 3-match spars on
// a lab arena (the in-sample trap the ladder already exposed: a champion
// that picked its own arena won there and compressed in officials).
//
// This module is the PURE core — spec constants, cell enumeration, per-match
// stat extraction, aggregation, and the paired-comparison statistics (sign
// test + bootstrap CI). tools/evaluate.mjs is the driver that wires this to
// a worker pool and the append-only ledger (tools/eval-ledger.jsonl).
//
// ── RESERVED FOR EVALUATION — DO NOT TRAIN ON THESE ─────────────────────────
// Arena seeds [101, 202, 303, 404, 505] and match seeds 90000+ are HELD OUT.
// Never train, tune, spar, or hill-climb against them; they exist so the
// gauntlet measures generalization, not memorization. (Audited 2026-06-10:
// no tool, trainer, dataset manifest, or ladder fight uses them — evolve.mjs
// trains on arenas [0, 5, 11, 23, 41], the corpus is entirely arenaSeed 0,
// and no recorded match seed reaches 90000.)
//
// ── VARIANCE CONTROL ─────────────────────────────────────────────────────────
// Seeds are a pure function of the cell coordinates (opponent × condition ×
// arena × matchIdx), so every candidate ever gauntleted plays the EXACT same
// matches — common random numbers. With a --baseline, per-cell paired deltas
// (same seed, same opponent, same arena) make small true differences
// detectable in few matches; raw means would need many times the sample.

import {
  NEURAL_SHIPPED_NET,
  createEngine,
  createNeuralEngineWithWeights,
  registerEngine,
  type EngineTweaks,
  type NeuralNet,
} from '@soldat/client/headless';
import { runMatch } from './runner';
import { mulberry32, registerNeuralNet, unflattenNet } from './evolve';

// ---------------------------------------------------------------------------
// The spec — versioned and FROZEN. Changing any of this is EVAL_SPEC_V2:
// scores across spec versions are not comparable.
// ---------------------------------------------------------------------------

export const EVAL_SPEC_V1 = {
  id: 'EVAL_SPEC_V1',
  /** Held-out generated-arena seeds — reserved, never train on these. */
  arenas: [101, 202, 303, 404, 505],
  /** Match seeds are seedBase + cell index — 90000..90359 reserved. */
  seedBase: 90000,
  matchesPerCell: 2,
  roundTicks: 7200, // full official length: 120 s at 60 Hz
  botCount: 6, // 3v3
  /** Loadout conditions: stock + both wildcard guns forced on. */
  conditions: [
    { name: 'stock', wildcard: undefined },
    { name: 'shotgun', wildcard: 'shotgun' },
    { name: 'rifle', wildcard: 'rifle' },
  ],
  /** All hand-written engines at FACTORY DEFAULTS (canonical cards). Learned
   *  engines (neural, disciple) are candidates, never opponents — a learned
   *  opponent would move under the benchmark as training ships weights. */
  opponents: [
    'classic',
    'pilot',
    'reaper',
    'matador',
    'kestrel',
    'wolf',
    'plover',
    'hydra',
    'shrike',
    'cuadrilla',
    'orca',
    'angler',
  ],
} as const;

export interface EvalCell {
  opponent: string;
  condition: string;
  wildcard: string | undefined;
  arenaSeed: number;
  matchIdx: number;
  seed: number;
}

/** Stable identity of a cell — the pairing key for common-random-number
 *  comparisons across candidates. */
export function cellKey(c: EvalCell): string {
  return `${c.opponent}/${c.condition}/a${c.arenaSeed}/m${c.matchIdx}`;
}

/**
 * Enumerate the gauntlet. Full: 12 opp × 3 cond × 5 arenas × 2 = 360 cells.
 * Quick: first arena only (72 cells) — a strict SUBSET of the full gauntlet
 * with identical seeds per cell, so quick results pair exactly with the
 * matching slice of any full run.
 */
export function gauntletCells(quick = false): EvalCell[] {
  const spec = EVAL_SPEC_V1;
  const arenas = quick ? spec.arenas.slice(0, 1) : [...spec.arenas];
  const cells: EvalCell[] = [];
  for (let o = 0; o < spec.opponents.length; o++) {
    for (let c = 0; c < spec.conditions.length; c++) {
      for (const arenaSeed of arenas) {
        // Index against the FULL arena list so quick seeds match full seeds.
        const a = spec.arenas.indexOf(arenaSeed as (typeof spec.arenas)[number]);
        for (let m = 0; m < spec.matchesPerCell; m++) {
          const cond = spec.conditions[c];
          if (cond === undefined) continue;
          cells.push({
            opponent: spec.opponents[o] ?? '',
            condition: cond.name,
            wildcard: cond.wildcard,
            arenaSeed,
            matchIdx: m,
            seed:
              spec.seedBase +
              ((o * spec.conditions.length + c) * spec.arenas.length + a) * spec.matchesPerCell +
              m,
          });
        }
      }
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Fighter registration — candidates run under ALIAS engine ids ('eval-cand',
// 'eval-base') through the same registry seam evolve uses. The alias is what
// makes "cuadrilla card vs cuadrilla opponent" legal (runMatch rejects true
// mirror ids) and what lets unshipped weight checkpoints fight pre-gate.
// ---------------------------------------------------------------------------

/** Register a fighter-card candidate (engine + card tweaks) under `id`. */
export function registerCardFighter(
  id: string,
  engine: string,
  tweaks: Record<string, number>,
): void {
  registerEngine(id, (extra?: EngineTweaks) => {
    const base = createEngine(engine, { ...tweaks, ...(extra ?? {}) });
    return {
      id,
      strategy: `${base.strategy} [gauntlet alias of ${engine}]`,
      tweaks: base.tweaks,
      createBrain: () => base.createBrain(),
    };
  });
}

/**
 * Parse a weights JSON into a NeuralNet. Accepts: a flat number[] (assumed
 * NEURAL_SHIPPED_NET dims, the evolve flat layout), an evolve checkpoint
 * ({dims, mean}), or an explicit {dims, weights, biases} net.
 */
export function parseWeightsJson(raw: unknown): NeuralNet {
  if (Array.isArray(raw) && raw.every((v) => typeof v === 'number')) {
    return unflattenNet(NEURAL_SHIPPED_NET.dims, raw as number[]);
  }
  const o = raw as { dims?: unknown; mean?: unknown; weights?: unknown; biases?: unknown };
  if (Array.isArray(o?.dims) && Array.isArray(o.mean)) {
    return unflattenNet(o.dims as number[], o.mean as number[]);
  }
  if (Array.isArray(o?.dims) && Array.isArray(o.weights) && Array.isArray(o.biases)) {
    return {
      dims: o.dims as number[],
      weights: o.weights as number[][],
      biases: o.biases as number[][],
    };
  }
  throw new Error(
    'weights JSON: expected a flat number[], an evolve checkpoint {dims, mean}, or {dims, weights, biases}',
  );
}

/** Register an unshipped weight checkpoint as the candidate (neural forward
 *  pass via the registerNeuralNet seam), with the card's tweaks baked in. */
export function registerWeightsFighter(
  id: string,
  raw: unknown,
  tweaks: Record<string, number>,
): void {
  const net = parseWeightsJson(raw);
  if (Object.keys(tweaks).length === 0) {
    registerNeuralNet(id, net);
    return;
  }
  registerEngine(id, (extra?: EngineTweaks) =>
    createNeuralEngineWithWeights(id, net, { ...tweaks, ...(extra ?? {}) }),
  );
}

// ---------------------------------------------------------------------------
// Running one cell — candidate is ALWAYS red (team 1, engine group 0).
// In-memory only: no dataset is written, the corpus and the public board
// never see gauntlet matches.
// ---------------------------------------------------------------------------

export interface CellResult {
  key: string;
  opponent: string;
  condition: string;
  arenaSeed: number;
  seed: number;
  win: 0 | 1;
  draw: 0 | 1;
  killsFor: number;
  killsAgainst: number;
  domFor: number;
  domAgainst: number;
  shots: number; // candidate-team shots fired
  hits: number; // candidate-team damaging hits landed
}

export function runCell(
  fighterId: string,
  cell: EvalCell,
  roundTicks: number = EVAL_SPEC_V1.roundTicks,
): CellResult {
  const result = runMatch({
    arenaSeed: cell.arenaSeed,
    seed: cell.seed,
    roundTicks,
    wildcard: cell.wildcard,
    botCount: EVAL_SPEC_V1.botCount,
    teams: [{ engine: fighterId }, { engine: cell.opponent }],
  });
  const r = result.round;
  let shots = 0;
  let hits = 0;
  for (const b of result.bots) {
    if (b.team !== 1) continue;
    shots += result.telemetry.shotsBy[b.index] ?? 0;
    hits += result.telemetry.hitsBy[b.index] ?? 0;
  }
  return {
    key: cellKey(cell),
    opponent: cell.opponent,
    condition: cell.condition,
    arenaSeed: cell.arenaSeed,
    seed: cell.seed,
    win: r !== null && r.winnerTeam === 1 ? 1 : 0,
    draw: r === null || r.winnerTeam === 0 ? 1 : 0,
    killsFor: r?.redKills ?? 0,
    killsAgainst: r?.blueKills ?? 0,
    domFor: r?.redDom ?? 0,
    domAgainst: r?.blueDom ?? 0,
    shots,
    hits,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface GroupSummary {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  /** Mean (killsFor − killsAgainst) per match — the score's unit. */
  killDiffPerMatch: number;
  kd: number; // ΣkillsFor / max(1, ΣkillsAgainst)
  hitPct: number; // candidate-team hit% (damaging hits / shots)
  domDiffPerMatch: number;
}

export interface GauntletSummary {
  perOpponent: Record<string, GroupSummary>;
  overall: GroupSummary;
  /** GAUNTLET SCORE: mean per-opponent killDiffPerMatch, EQUAL-weighted so
   *  no single opponent (however many cells it has) dominates. */
  score: number;
}

function summarizeGroup(rs: readonly CellResult[]): GroupSummary {
  const n = rs.length;
  let wins = 0;
  let draws = 0;
  let kf = 0;
  let ka = 0;
  let domDiff = 0;
  let shots = 0;
  let hits = 0;
  for (const r of rs) {
    wins += r.win;
    draws += r.draw;
    kf += r.killsFor;
    ka += r.killsAgainst;
    domDiff += r.domFor - r.domAgainst;
    shots += r.shots;
    hits += r.hits;
  }
  return {
    matches: n,
    wins,
    losses: n - wins - draws,
    draws,
    winRate: n > 0 ? wins / n : 0,
    killDiffPerMatch: n > 0 ? (kf - ka) / n : 0,
    kd: ka > 0 ? kf / ka : kf,
    hitPct: shots > 0 ? (100 * hits) / shots : 0,
    domDiffPerMatch: n > 0 ? domDiff / n : 0,
  };
}

export function summarize(results: readonly CellResult[]): GauntletSummary {
  const perOpponent: Record<string, GroupSummary> = {};
  for (const opp of EVAL_SPEC_V1.opponents) {
    const rs = results.filter((r) => r.opponent === opp);
    if (rs.length > 0) perOpponent[opp] = summarizeGroup(rs);
  }
  const opps = Object.values(perOpponent);
  const score =
    opps.length > 0 ? opps.reduce((a, g) => a + g.killDiffPerMatch, 0) / opps.length : 0;
  return { perOpponent, overall: summarizeGroup(results), score };
}

// ---------------------------------------------------------------------------
// Paired comparison (the point of common random numbers)
// ---------------------------------------------------------------------------

export interface PairedDelta {
  key: string;
  opponent: string;
  /** candidate killDiff − baseline killDiff on the SAME seed/opponent/arena. */
  delta: number;
}

/** Match candidate and baseline cells by key; throws on a mismatched set
 *  (paired stats on unpaired data would be silently wrong). */
export function pairedDeltas(
  cand: readonly CellResult[],
  base: readonly CellResult[],
): PairedDelta[] {
  const baseByKey = new Map(base.map((r) => [r.key, r]));
  if (baseByKey.size !== cand.length) {
    throw new Error(`paired: ${cand.length} candidate cells vs ${baseByKey.size} baseline cells`);
  }
  return cand.map((c) => {
    const b = baseByKey.get(c.key);
    if (b === undefined) throw new Error(`paired: baseline missing cell ${c.key}`);
    return {
      key: c.key,
      opponent: c.opponent,
      delta: c.killsFor - c.killsAgainst - (b.killsFor - b.killsAgainst),
    };
  });
}

export interface SignTestResult {
  pos: number;
  neg: number;
  zero: number;
  /** Two-sided exact binomial p-value (ties excluded), clamped to [0,1]. */
  pValue: number;
}

/** Exact two-sided sign test on the deltas (H0: median delta = 0). */
export function signTest(deltas: readonly number[]): SignTestResult {
  let pos = 0;
  let neg = 0;
  let zero = 0;
  for (const d of deltas) {
    if (d > 0) pos++;
    else if (d < 0) neg++;
    else zero++;
  }
  const n = pos + neg;
  if (n === 0) return { pos, neg, zero, pValue: 1 };
  const k = Math.max(pos, neg);
  // P(X >= k), X ~ Binomial(n, 1/2), via log-factorials (n can reach 360).
  const logFact = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) logFact[i] = (logFact[i - 1] ?? 0) + Math.log(i);
  let tail = 0;
  for (let i = k; i <= n; i++) {
    tail += Math.exp((logFact[n] ?? 0) - (logFact[i] ?? 0) - (logFact[n - i] ?? 0) - n * Math.LN2);
  }
  return { pos, neg, zero, pValue: Math.min(1, 2 * tail) };
}

export interface BootstrapCi {
  mean: number;
  lo: number;
  hi: number;
  iters: number;
}

/** Seeded percentile bootstrap 95% CI on the mean delta (deterministic). */
export function bootstrapCi(deltas: readonly number[], iters = 2000, seed = 90001): BootstrapCi {
  const n = deltas.length;
  const mean = n > 0 ? deltas.reduce((a, b) => a + b, 0) / n : 0;
  if (n === 0) return { mean: 0, lo: 0, hi: 0, iters };
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[Math.floor(rng() * n)] ?? 0;
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const at = (q: number): number => means[Math.min(iters - 1, Math.floor(q * iters))] ?? 0;
  return { mean, lo: at(0.025), hi: at(0.975), iters };
}

// ---------------------------------------------------------------------------
// The ledger line — tools/eval-ledger.jsonl is the append-only experiment
// registry. One line per gauntlet invocation.
// ---------------------------------------------------------------------------

export interface FighterIdentity {
  path: string;
  coach: string;
  engine: string;
  tweaks: Record<string, number>;
  /** sha256 (12 hex) of the card file bytes. */
  hash: string;
}

export interface PairedStats {
  cells: number;
  meanDelta: number;
  ci95: [number, number];
  signTest: SignTestResult;
}

export interface LedgerLine {
  ts: string;
  spec: string;
  quick: boolean;
  candidate: FighterIdentity;
  weights: { path: string; hash: string } | null;
  baseline: FighterIdentity | null;
  results: GauntletSummary;
  baselineResults: GauntletSummary | null;
  score: number;
  ci: [number, number] | null;
  paired: PairedStats | null;
  secs: number;
}

export function buildLedgerLine(opts: {
  ts: string;
  quick: boolean;
  candidate: FighterIdentity;
  weights: { path: string; hash: string } | null;
  baseline: FighterIdentity | null;
  results: GauntletSummary;
  baselineResults: GauntletSummary | null;
  paired: PairedStats | null;
  secs: number;
}): LedgerLine {
  return {
    ts: opts.ts,
    spec: EVAL_SPEC_V1.id,
    quick: opts.quick,
    candidate: opts.candidate,
    weights: opts.weights,
    baseline: opts.baseline,
    results: opts.results,
    baselineResults: opts.baselineResults,
    score: opts.results.score,
    ci: opts.paired !== null ? opts.paired.ci95 : null,
    paired: opts.paired,
    secs: opts.secs,
  };
}
