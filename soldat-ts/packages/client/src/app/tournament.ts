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

export const TOURNAMENT_GAMES = 4;
const POLL_MS = 2000;

export interface TournamentOptions {
  /** Per-game roster (comma list of engine ids). */
  roster: string;
}

/** Parse ?tournament[&ai=roster]. */
export function parseTournament(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): TournamentOptions | null {
  const params = new URLSearchParams(search);
  if (!params.has('tournament')) return null;
  const roster = params.get('ai') ?? 'classic,pilot';
  return { roster };
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
    // the exact same match four times.
    frame.src =
      `${window.location.pathname}?spectate&ai=${encodeURIComponent(opts.roster)}` +
      `&teams&seed=${g + 2}`;
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
    '<div style="color:#9aa3b2;margin:4px 0 10px">4 games · mixed AIs · red vs blue<br>N = next round (evolve toward the winners)</div>' +
    '<div id="t-engines"></div><div id="t-board" style="margin-top:10px"></div>';
  layout.append(grid, side);
  document.body.appendChild(layout);

  let standings: Standings = { fighters: [], engines: {}, dominant: '' };

  const pull = (): void => {
    const dumps = frames.map((f) => {
      try {
        const w = f.contentWindow as (Window & { __match?: MatchWindow }) | null;
        return (w?.__match?.dump() as MatchDump | undefined) ?? null;
      } catch {
        return null;
      }
    });
    standings = aggregateStandings(dumps);
    render();
  };

  const render = (): void => {
    const eng = side.querySelector('#t-engines');
    const board = side.querySelector('#t-board');
    if (eng === null || board === null) return;
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

  const nextRosterUrl = (): string => {
    const roster = evolveRoster(standings.engines);
    return `${window.location.pathname}?tournament&ai=${encodeURIComponent(roster)}`;
  };

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === 'n') window.location.href = nextRosterUrl();
  });

  // Headless drivers (tools/run-tournament.mjs) read this.
  (window as unknown as { __tournament: unknown }).__tournament = {
    standings: (): Standings => standings,
    nextRosterUrl,
    report: (): string => {
      const lines = [
        `TOURNAMENT — roster ${opts.roster} × ${TOURNAMENT_GAMES} games`,
        ...Object.entries(standings.engines)
          .sort((a, b) => b[1].dom - a[1].dom)
          .map(
            ([id, t]) =>
              `${id === standings.dominant ? '👑 ' : '   '}${id}: ${t.kills}K/${t.deaths}D dom=${t.dom.toFixed(1)}`,
          ),
        'TOP FIGHTERS:',
        ...standings.fighters
          .slice(0, 10)
          .map(
            (r, i) =>
              ` ${i + 1}. ${r.name} [${r.engine} g${r.game}] ${r.kills}/${r.deaths}`,
          ),
        `NEXT ROUND (evolved): ${nextRosterUrl()}`,
      ];
      return lines.join('\n');
    },
  };
}
