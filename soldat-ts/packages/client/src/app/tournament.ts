// Tournament mode (goal node 154): fire up FOUR simultaneous mixed-AI team
// matches, score which engine produces the most dominant fighters, and
// "model more after them" — the next round's rosters are re-weighted toward
// the winning engine (a tiny evolutionary loop over brains).
//
//   ?tournament                          → 4 games of classic,pilot (teams)
//   ?tournament&ai=pilot,classic         → custom per-game roster template
//
// Each game runs in its own iframe with a DIFFERENT seed (the sim is
// deterministic — identical seeds would replay the same match four times).
// A sidebar aggregates every fighter across all games into one displayed
// leaderboard, plus per-engine totals. Press N to start the next (evolved)
// round; `tools/run-tournament.mjs` drives this page headlessly.

import {
  dominance,
  rankFighters,
  type FighterRow,
} from '../ui/leaderboard';
import type { MatchDump } from './telemetry';
import { DEFAULT_TUNING, type GameTuning } from './game';

export const TOURNAMENT_GAMES = 4;
const POLL_MS = 2000;

// --- Gameplay variants (goal node 157) ---------------------------------------
// Each of the 4 tournament games runs a DISTINCT named variant — real tuning
// differences (partial overrides of game.ts DEFAULT_TUNING), not just RNG
// seeds — so a round samples the engines across four different metas.

export interface Variant {
  readonly name: string;
  /** One-line personality shown under the engine banner + in the sidebar. */
  readonly blurb: string;
  readonly tuning: Readonly<Partial<GameTuning>>;
}

export const VARIANTS: readonly Variant[] = [
  { name: 'baseline', blurb: 'stock rules', tuning: {} },
  {
    name: 'high-octane',
    blurb: 'faster fire, snappier reloads, quick respawns',
    tuning: { fireInterval: 4, reloadTicks: 70, respawnTicks: 90, jetRegenPerTick: 5 },
  },
  {
    name: 'thin-air',
    blurb: 'small tank, no air regen — gravity matters',
    tuning: { jetFuelMax: 320, jetAirRegenPerTick: 0, jetRegenPerTick: 5 },
  },
  {
    name: 'marksman',
    blurb: 'laser accuracy, 12-round mags, long reloads',
    tuning: { spreadBase: 0.005, spreadHeatPerShot: 0.004, magSize: 12, reloadTicks: 150, fireInterval: 9 },
  },
];

/** Resolve a variant by name; unknown/undefined → baseline (VARIANTS[0]). */
export function resolveVariant(name: string | undefined): Variant {
  return VARIANTS.find((v) => v.name === name) ?? VARIANTS[0]!;
}

/** Short labels for the knob-turn UI (user: "the turns should be shown"). */
const KNOB_LABELS: Record<keyof GameTuning, string> = {
  fireInterval: 'fire',
  magSize: 'mag',
  reloadTicks: 'reload',
  spreadBase: 'spread',
  spreadHeatPerShot: 'bloom',
  jetFuelMax: 'fuel',
  jetRegenPerTick: 'regen',
  jetAirRegenPerTick: 'airRegen',
  respawnTicks: 'respawn',
};

/**
 * Human-readable knob turns vs stock: 'fire 6→4 · reload 95→70'. Empty
 * string for baseline (no turns). Pure; shown under the engine banner and in
 * the tournament sidebar so every game declares its exact rule tweaks.
 */
export function tuningDeltas(
  tuning: Readonly<Partial<GameTuning>>,
  defaults: Readonly<GameTuning>,
): string {
  return (Object.keys(KNOB_LABELS) as (keyof GameTuning)[])
    .filter((k) => tuning[k] !== undefined && tuning[k] !== defaults[k])
    .map((k) => `${KNOB_LABELS[k]} ${defaults[k]}→${tuning[k]}`)
    .join(' · ');
}

export interface TournamentOptions {
  /** Per-game roster (comma list of engine ids). */
  roster: string;
  /** Round length passed to every game (seconds of SIM time; default 600). */
  roundSecs: number;
  /** Round generation (seeds derive from it; N key increments). */
  gen: number;
}

/** Parse ?tournament[&ai=roster][&round=secs]. */
export function parseTournament(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): TournamentOptions | null {
  const params = new URLSearchParams(search);
  if (!params.has('tournament')) return null;
  const roster = params.get('ai') ?? 'classic,pilot';
  // ?round=SECS overrides the 10-minute default (fast headless verification).
  const roundRaw = parseInt(params.get('round') ?? '', 10);
  const roundSecs = Number.isFinite(roundRaw) && roundRaw > 0 ? roundRaw : 600;
  // ?gen=N: the round generation. Seeds derive from it so "next round" is a
  // FRESH set of matches (the sim is deterministic) with the SAME whole
  // teams — rosters never collapse toward the winner (user correction).
  const genRaw = parseInt(params.get('gen') ?? '', 10);
  const gen = Number.isFinite(genRaw) && genRaw >= 0 ? genRaw : 0;
  return { roster, roundSecs, gen };
}

export interface EngineTotals {
  kills: number;
  deaths: number;
  dom: number;
}

export interface Standings {
  /** Every fighter across every game, ranked by dominance. */
  fighters: (FighterRow & { game: number })[];
  /** Aggregated per engine across all games. */
  engines: Record<string, EngineTotals>;
  /** Engine with the highest dominance total ('' until data arrives). */
  dominant: string;
}

/** Aggregate the standings from each game's telemetry dump (pure). */
export function aggregateStandings(
  dumps: readonly (MatchDump | null)[],
): Standings {
  const fighters: (FighterRow & { game: number })[] = [];
  const engines: Record<string, EngineTotals> = {};
  dumps.forEach((dump, g) => {
    if (dump === null) return;
    for (const [idxStr, s] of Object.entries(dump.derived.perSprite)) {
      const index = Number(idxStr);
      const engine = dump.meta.botEngines[index] ?? '';
      const row: FighterRow & { game: number } = {
        game: g + 1,
        index,
        name: s.name,
        engine,
        team: 0,
        kills: s.kills,
        deaths: s.deaths,
      };
      fighters.push(row);
      if (engine !== '') {
        const t = (engines[engine] ??= { kills: 0, deaths: 0, dom: 0 });
        t.kills += s.kills;
        t.deaths += s.deaths;
        t.dom += dominance(s);
      }
    }
  });
  const ranked = rankFighters(fighters) as (FighterRow & { game: number })[];
  let dominant = '';
  let best = -Infinity;
  for (const [id, t] of Object.entries(engines)) {
    if (t.dom > best) {
      best = t.dom;
      dominant = id;
    }
  }
  return { fighters: ranked, engines, dominant };
}

/**
 * "Model more after them": next-round roster with engine shares proportional
 * to dominance (every engine keeps at least one slot so a comeback stays
 * possible). Returns a full-length comma list — Game assigns engines[b % n],
 * so a list of exactly `slots` entries IS the per-bot assignment.
 */
export function evolveRoster(
  engines: Record<string, EngineTotals>,
  slots = 6,
): string {
  const ids = Object.keys(engines);
  if (ids.length === 0) return 'classic,pilot';
  const floor = ids.map((id) => Math.max(0, engines[id]?.dom ?? 0));
  const total = floor.reduce((a, b) => a + b, 0);
  // No signal yet (or everyone net-negative): keep an even split.
  const shares =
    total <= 0
      ? ids.map(() => slots / ids.length)
      : floor.map((d) => (d / total) * slots);
  // At least one slot each, then round to fit exactly `slots`.
  const counts = shares.map((s) => Math.max(1, Math.round(s)));
  let diff = counts.reduce((a, b) => a + b, 0) - slots;
  while (diff !== 0) {
    // Trim from (or pad onto) the biggest holder — winners absorb rounding.
    const at = counts.indexOf(Math.max(...counts));
    counts[at] = Math.max(1, (counts[at] ?? 1) - Math.sign(diff));
    diff = counts.reduce((a, b) => a + b, 0) - slots;
  }
  const roster: string[] = [];
  ids.forEach((id, i) => {
    for (let n = 0; n < (counts[i] ?? 0); n++) roster.push(id);
  });
  return roster.join(',');
}

// --- Round verdict ACROSS games (goal node 157) -------------------------------
// Each game decides its own 10-minute round winner (game.ts decideRoundWinner,
// surfaced via dump().round). The tournament's round winner is the AI engine
// with the most GAME wins; ties break on aggregate dominance.

export interface RoundReport {
  /** True once every game's dump carries a non-null round. */
  done: boolean;
  /** Count of ended games (out of the slots polled). */
  gamesOver: number;
  /** Engine id → number of game wins (draws award nobody). */
  wins: Record<string, number>;
  /** Round champion across games: most game wins, tiebreak aggregate dominance
   *  (engines[id].dom from aggregateStandings), then lexicographic. '' until done. */
  champion: string;
  /** Per game (index-aligned with dumps): null until that game ends. */
  perGame: ({ winnerTeam: number; winnerEngine: string; redKills: number; blueKills: number } | null)[];
}

/** Aggregate per-game round verdicts into the cross-game round report (pure). */
export function roundReport(
  dumps: readonly (MatchDump | null)[],
  engines: Record<string, EngineTotals>,
): RoundReport {
  const perGame = dumps.map((d) => {
    const r = d?.round ?? null;
    if (r === null) return null;
    return {
      winnerTeam: r.winnerTeam,
      winnerEngine: r.winnerEngine,
      redKills: r.redKills,
      blueKills: r.blueKills,
    };
  });
  const wins: Record<string, number> = {};
  for (const g of perGame) {
    if (g === null || g.winnerTeam === 0) continue; // draws award nobody
    wins[g.winnerEngine] = (wins[g.winnerEngine] ?? 0) + 1;
  }
  const gamesOver = perGame.filter((g) => g !== null).length;
  const done = gamesOver === dumps.length && dumps.length > 0;
  let champion = '';
  if (done) {
    champion =
      Object.keys(wins).sort(
        (a, b) =>
          (wins[b] ?? 0) - (wins[a] ?? 0) ||
          (engines[b]?.dom ?? 0) - (engines[a]?.dom ?? 0) ||
          a.localeCompare(b),
      )[0] ?? '';
  }
  return { done, gamesOver, wins, champion, perGame };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

interface MatchWindow {
  dump(): unknown;
}

/** Build the tournament view: 2x2 game grid + live aggregated sidebar. */
export function showTournament(opts: TournamentOptions): void {
  document.body.style.cssText = 'margin:0;background:#0a0c10;color:#e8e4d8';
  const layout = document.createElement('div');
  layout.style.cssText = 'display:flex;width:100vw;height:100vh;gap:2px';

  const grid = document.createElement('div');
  grid.style.cssText =
    'flex:3;display:flex;flex-wrap:wrap;gap:2px;align-content:stretch;min-width:0';
  const frames: HTMLIFrameElement[] = [];
  for (let g = 0; g < TOURNAMENT_GAMES; g++) {
    const frame = document.createElement('iframe');
    // Distinct seeds: the sim is deterministic, identical seeds would play
    // the exact same match four times. Each tile ALSO runs a distinct named
    // gameplay variant (g1=baseline, g2=high-octane, g3=thin-air,
    // g4=marksman) and a timed round of opts.roundSecs sim-seconds.
    frame.src =
      `${window.location.pathname}?spectate&ai=${encodeURIComponent(opts.roster)}` +
      `&teams&seed=${opts.gen * TOURNAMENT_GAMES + g + 2}` +
      `&variant=${encodeURIComponent(VARIANTS[g % VARIANTS.length]!.name)}` +
      `&round=${opts.roundSecs}`;
    frame.style.cssText =
      'flex:1 1 calc(50% - 1px);min-height:calc(50% - 1px);border:0;min-width:0';
    frames.push(frame);
    grid.appendChild(frame);
  }

  const side = document.createElement('div');
  side.style.cssText = [
    'flex:1',
    'min-width:280px',
    'max-width:360px',
    'padding:14px',
    'font:12px ui-monospace,Menlo,monospace',
    'overflow-y:auto',
    'background:#0d1016',
  ].join(';');
  side.innerHTML =
    '<div style="font-weight:bold;letter-spacing:0.25em;font-size:14px">TOURNAMENT</div>' +
    '<div style="color:#9aa3b2;margin:4px 0 10px">4 games · 4 knob variants · red vs blue · 10-min rounds<br>N = next round (same whole teams, fresh seeds)</div>' +
    '<div id="t-round" style="margin-top:10px"></div>' +
    '<div id="t-engines"></div>' +
    '<div id="t-games" style="margin-top:10px"></div>' +
    '<div id="t-board" style="margin-top:10px"></div>';
  layout.append(grid, side);
  document.body.appendChild(layout);

  let standings: Standings = { fighters: [], engines: {}, dominant: '' };
  let round: RoundReport = {
    done: false,
    gamesOver: 0,
    wins: {},
    champion: '',
    perGame: [null, null, null, null],
  };
  /** Latest per-game dumps (for the per-game clock while a game runs). */
  let lastDumps: (MatchDump | null)[] = [];

  const pull = (): void => {
    const dumps = frames.map((f) => {
      try {
        const w = f.contentWindow as (Window & { __match?: MatchWindow }) | null;
        return (w?.__match?.dump() as MatchDump | undefined) ?? null;
      } catch {
        return null;
      }
    });
    lastDumps = dumps;
    standings = aggregateStandings(dumps);
    round = roundReport(dumps, standings.engines);
    render();
  };

  /** mm:ss of a game's sim clock ('—' before its first dump arrives). */
  const gameClock = (g: number): string => {
    const ticks = lastDumps[g]?.durationTicks;
    if (ticks === undefined) return '—';
    const secs = Math.floor(ticks / 60); // 60 Hz sim → sim-seconds
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  };

  const teamWord = (winnerTeam: number): string => {
    const color = winnerTeam === 1 ? '#d23c3c' : '#4060d2';
    const word = winnerTeam === 1 ? 'RED' : winnerTeam === 2 ? 'BLUE' : 'DRAW';
    return winnerTeam === 0 ? word : `<span style="color:${color}">${word}</span>`;
  };

  const render = (): void => {
    const eng = side.querySelector('#t-engines');
    const board = side.querySelector('#t-board');
    const roundEl = side.querySelector('#t-round');
    const games = side.querySelector('#t-games');
    if (eng === null || board === null || roundEl === null || games === null) return;
    // The round banner: progress while games run, the champion once all 4
    // have frozen (most game wins; ties broke on aggregate dominance).
    if (!round.done) {
      roundEl.innerHTML = `<div style="color:#9aa3b2;letter-spacing:0.2em">ROUND — ${round.gamesOver}/4 games finished</div>`;
    } else {
      const winsLine = Object.entries(round.wins)
        .sort((a, b) => b[1] - a[1])
        .map(([id, w]) => `${id} ${w} win${w === 1 ? '' : 's'}`)
        .join(' · ');
      roundEl.innerHTML =
        `<div style="font-size:18px;font-weight:bold;letter-spacing:0.15em;color:#ffd75e">🏆 ROUND WINNER: ${round.champion.toUpperCase()}</div>` +
        `<div style="color:#9aa3b2">${winsLine}</div>`;
    }
    games.innerHTML =
      '<div style="color:#9aa3b2;letter-spacing:0.2em">GAMES</div>' +
      Array.from({ length: TOURNAMENT_GAMES }, (_, g) => {
        const v = VARIANTS[g % VARIANTS.length]!;
        const r = round.perGame[g] ?? null;
        const status =
          r === null
            ? gameClock(g)
            : `${r.redKills}–${r.blueKills} · ${teamWord(r.winnerTeam)}` +
              (r.winnerEngine !== '' ? ` (${r.winnerEngine})` : '');
        // The knob turns, spelled out — every game declares its exact tweaks.
        const knobs = tuningDeltas(v.tuning, DEFAULT_TUNING);
        return (
          `<div style="line-height:1.6">g${g + 1} · ${v.name} · ${status}</div>` +
          (knobs !== ''
            ? `<div style="color:#9aa3b2;font-size:11px;margin:-2px 0 4px 14px">${knobs}</div>`
            : '')
        );
      }).join('');
    eng.innerHTML =
      '<div style="color:#9aa3b2;letter-spacing:0.2em">ENGINES</div>' +
      Object.entries(standings.engines)
        .sort((a, b) => b[1].dom - a[1].dom)
        .map(([id, t]) => {
          const crown = id === standings.dominant ? ' 👑' : '';
          return `<div style="font-size:15px;line-height:1.8"><b>${id.toUpperCase()}</b>${crown} — ${t.kills}K/${t.deaths}D · dom ${t.dom.toFixed(1)}</div>`;
        })
        .join('');
    board.innerHTML =
      '<div style="color:#9aa3b2;letter-spacing:0.2em">TOP FIGHTERS (all games)</div>' +
      standings.fighters
        .slice(0, 14)
        .map(
          (r, i) =>
            `<div style="line-height:1.7">${i + 1}. ${r.name} <span style="color:#9aa3b2">[${r.engine} · g${r.game}]</span> ${r.kills}/${r.deaths}</div>`,
        )
        .join('');
  };

  setInterval(pull, POLL_MS);

  const nextRoundUrl = (): string =>
    `${window.location.pathname}?tournament&ai=${encodeURIComponent(opts.roster)}` +
    `&round=${opts.roundSecs}&gen=${opts.gen + 1}`;

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === 'n') window.location.href = nextRoundUrl();
  });

  // Headless drivers (tools/run-tournament.mjs) read this.
  (window as unknown as { __tournament: unknown }).__tournament = {
    standings: (): Standings => standings,
    round: (): RoundReport => round,
    nextRoundUrl,
    report: (): string => {
      const lines = [
        ...(round.done
          ? [`🏆 ROUND WINNER: ${round.champion} (${round.wins[round.champion] ?? 0} wins)`]
          : []),
        `TOURNAMENT — roster ${opts.roster} × ${TOURNAMENT_GAMES} games`,
        ...Object.entries(standings.engines)
          .sort((a, b) => b[1].dom - a[1].dom)
          .map(
            ([id, t]) =>
              `${id === standings.dominant ? '👑 ' : '   '}${id}: ${t.kills}K/${t.deaths}D dom=${t.dom.toFixed(1)}`,
          ),
        ...Array.from({ length: TOURNAMENT_GAMES }, (_, g) => {
          const variant = VARIANTS[g % VARIANTS.length]!.name;
          const r = round.perGame[g] ?? null;
          if (r === null) return ` g${g + 1} ${variant}: running`;
          const team = r.winnerTeam === 1 ? 'RED' : r.winnerTeam === 2 ? 'BLUE' : 'DRAW';
          return (
            ` g${g + 1} ${variant}: ${team}` +
            (r.winnerEngine !== '' ? ` (${r.winnerEngine})` : '') +
            ` ${r.redKills}–${r.blueKills}`
          );
        }),
        'TOP FIGHTERS:',
        ...standings.fighters
          .slice(0, 10)
          .map(
            (r, i) =>
              ` ${i + 1}. ${r.name} [${r.engine} g${r.game}] ${r.kills}/${r.deaths}`,
          ),
        `NEXT ROUND (same teams, fresh seeds): ${nextRoundUrl()}`,
      ];
      return lines.join('\n');
    },
  };
}
