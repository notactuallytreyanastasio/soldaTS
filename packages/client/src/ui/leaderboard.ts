// In-match leaderboard — a displayed, live ranking of every fighter
// (goal node 154). Pure ranking + a thin DOM panel; the caller feeds it
// rows built from the kill board each frame.

export interface FighterRow {
  index: number;
  name: string;
  /** Engine id ('' hides the tag). */
  engine: string;
  /** 1 red / 2 blue / 0 none. */
  team: number;
  kills: number;
  deaths: number;
}

/**
 * Dominance: kills minus half deaths — a fighter that trades 2-for-1 ranks
 * above one that feeds. This is also the tournament's "most dominant
 * fighter" metric, so the in-match board and the tournament agree.
 */
export function dominance(r: Pick<FighterRow, 'kills' | 'deaths'>): number {
  return r.kills - 0.5 * r.deaths;
}

/** Rank rows: dominance desc, kills desc, deaths asc, index asc. */
export function rankFighters(rows: readonly FighterRow[]): FighterRow[] {
  return [...rows].sort(
    (a, b) =>
      dominance(b) - dominance(a) ||
      b.kills - a.kills ||
      a.deaths - b.deaths ||
      a.index - b.index,
  );
}

/** Team accent colors (1 red / 2 blue) — shared by the dots and the MVP panel. */
export const TEAM_DOTS: Record<number, string> = { 1: '#d23c3c', 2: '#4060d2' };

// --- Per-team scoreboard (goal node 157) -------------------------------------
// Every team match carries its own scoreboard naming the winningest killer
// PER TEAM (the RED MVP and the BLUE MVP) plus team kill totals — pure
// computation here, thin DOM panel below.

export interface TeamScore {
  /** 1 red / 2 blue. */
  team: number;
  kills: number;
  /** Winningest killer on the team (null when the team has no fighters). */
  mvp: FighterRow | null;
}

/**
 * Per-team kill totals + MVP. MVP order: kills desc, then dominance desc,
 * then deaths asc, then index asc. Always returns [team1, team2].
 */
export function teamScores(rows: readonly FighterRow[]): [TeamScore, TeamScore] {
  const forTeam = (team: number): TeamScore => {
    const members = rows.filter((r) => r.team === team);
    const mvp =
      [...members].sort(
        (a, b) =>
          b.kills - a.kills ||
          dominance(b) - dominance(a) ||
          a.deaths - b.deaths ||
          a.index - b.index,
      )[0] ?? null;
    return { team, kills: members.reduce((s, r) => s + r.kills, 0), mvp };
  };
  return [forTeam(1), forTeam(2)];
}

/** Fixed top-left panel listing ranked fighters. */
export class LeaderboardPanel {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;

  constructor(title = 'LEADERBOARD') {
    this.root = document.createElement('div');
    this.root.style.cssText = [
      'position:fixed',
      'top:44px',
      'left:12px',
      'z-index:15',
      'min-width:230px',
      'padding:8px 12px',
      'background:rgba(10,12,16,0.62)',
      'border-radius:6px',
      'color:#e8e4d8',
      'font:12px ui-monospace,Menlo,monospace',
      'pointer-events:none',
    ].join(';');
    const head = document.createElement('div');
    head.textContent = title;
    head.style.cssText =
      'font-weight:bold;letter-spacing:0.25em;color:#9aa3b2;margin-bottom:6px';
    this.body = document.createElement('div');
    this.root.append(head, this.body);
    document.body.appendChild(this.root);
  }

  update(rows: readonly FighterRow[]): void {
    const ranked = rankFighters(rows);
    this.body.replaceChildren(
      ...ranked.map((r, at) => {
        const line = document.createElement('div');
        line.style.cssText =
          'display:flex;gap:8px;align-items:center;line-height:1.7';
        const dot = document.createElement('span');
        dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${TEAM_DOTS[r.team] ?? '#666'}`;
        const name = document.createElement('span');
        name.textContent =
          `${at + 1}. ${r.name}` + (r.engine !== '' ? ` [${r.engine}]` : '');
        name.style.cssText = 'flex:1';
        const score = document.createElement('span');
        score.textContent = `${r.kills}/${r.deaths}`;
        score.style.cssText = 'color:#cfd6e4';
        line.append(dot, name, score);
        return line;
      }),
    );
  }

  set visible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }
}

/**
 * Fixed top-center panel (below the HUD score line): per-team total + MVP.
 * One line per team, e.g. `● RED 23 — MVP Alpha [pilot] (9)`.
 *
 * Placement: top-center is free below the pixi teamScoreText (drawn at y≈8·s);
 * the leaderboard owns top-left, the kill feed + FPS own top-right, the engine
 * banner sits bottom:96px center, the hint bottom-left — nothing collides.
 */
export class TeamScorePanel {
  private readonly root: HTMLDivElement;

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = [
      'position:fixed',
      'top:34px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:15',
      'padding:6px 14px',
      'background:rgba(10,12,16,0.62)',
      'border-radius:6px',
      'color:#e8e4d8',
      'font:12px ui-monospace,Menlo,monospace',
      'pointer-events:none',
      'text-align:center',
      'white-space:nowrap',
    ].join(';');
    document.body.appendChild(this.root);
  }

  update(rows: readonly FighterRow[]): void {
    const [red, blue] = teamScores(rows);
    this.root.replaceChildren(
      ...[red, blue].map((t) => {
        const color = TEAM_DOTS[t.team] ?? '#666';
        const line = document.createElement('div');
        line.style.cssText = 'line-height:1.7';
        const dot = document.createElement('span');
        dot.textContent = '●';
        dot.style.cssText = `color:${color};margin-right:6px`;
        const label = document.createElement('span');
        label.textContent = `${t.team === 1 ? 'RED' : 'BLUE'} ${t.kills}`;
        label.style.cssText = `color:${color};font-weight:bold`;
        const mvp = document.createElement('span');
        mvp.textContent =
          t.mvp !== null
            ? ` — MVP ${t.mvp.name}` +
              (t.mvp.engine !== '' ? ` [${t.mvp.engine}]` : '') +
              ` (${t.mvp.kills})`
            : ' — no fighters';
        mvp.style.cssText = 'color:#cfd6e4';
        line.append(dot, label, mvp);
        return line;
      }),
    );
  }

  set visible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }
}
