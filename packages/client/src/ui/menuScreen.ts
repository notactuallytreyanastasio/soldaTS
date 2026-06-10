// Start menu — a full-screen DOM overlay shown ONLY on a bare URL.
//
// GLUE module (no Pascal provenance; the original had a Lazarus lobby, not
// an in-page menu). Same conventions as controlsScreen.ts: plain DOM (not
// PIXI), dark monospace styling, zero per-frame cost. Unlike the controls
// screen there is NO game running underneath — main.ts renders the menu and
// returns early, and every button is a plain navigation to a parameterised
// URL, so the chosen game boots through the ordinary entry path.
//
// The menu exists to answer one ask (goal node 372): "new game" against the
// bots with the bot MODEL picked by hand. One row per registered engine
// (engineIds()), the two learned models badged, plus the old default —
// watching the broadcast — demoted from auto-start to a link.

import { engineIds, createEngine } from '../ai';

/**
 * Query params that mean "the visitor already chose a mode" — any of these
 * present and the menu must NOT appear (every recorded watch URL carries
 * ?spectate; tournament/duel/play links predate the menu). Bare `/` — none
 * of these — is the only menu trigger, so existing URLs behave as before.
 */
const MODE_PARAMS = [
  'play',
  'spectate',
  'duel',
  'tournament',
  'ai',
  'seed',
  'map',
  'arena',
  'variant',
  'wildcard',
  'teams',
  'round',
  'tweak-a',
  'tweak-b',
] as const;

/** True when the URL carries no mode params at all (show the menu). */
export function isBareUrl(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): boolean {
  const params = new URLSearchParams(search);
  return MODE_PARAMS.every((p) => !params.has(p));
}

/** The two learned (trained-from-replay-data) models get a badge + alias. */
const LEARNED_MODELS: Record<string, string> = {
  neural: 'MIMIC',
  disciple: 'DISCIPLE',
};

/** Random int in [1, max] — fine here: menu picks are never recorded. */
function roll(max: number): number {
  return 1 + Math.floor(Math.random() * max);
}

/** Build the /?play URL for a chosen opponent and navigate to it. */
function startGame(engineId: string, wildcard: string): void {
  let url =
    `${window.location.pathname}?play&ai=${encodeURIComponent(engineId)}` +
    `&arena=${roll(999)}&seed=${roll(99999)}`;
  // 'chance' is the play-mode default (parseSpectate) — omit it from the URL.
  if (wildcard !== 'chance') url += `&wildcard=${encodeURIComponent(wildcard)}`;
  window.location.href = url;
}

const ROW_STYLE = [
  'display:flex',
  'align-items:baseline',
  'gap:10px',
  'width:100%',
  'text-align:left',
  'background:#141821',
  'color:#e8e4d8',
  'border:1px solid #2a2f3a',
  'border-radius:6px',
  'padding:8px 14px',
  'cursor:pointer',
  'font-family:inherit',
  'font-size:13px',
].join(';');

/** Render the start menu (caller has verified the URL is bare). */
export function showMenuScreen(): void {
  document.body.style.cssText = 'margin:0;background:#0a0c10';
  const overlay = document.createElement('div');
  overlay.id = 'menu-screen';
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:1000',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'background:#0a0c10',
    'color:#e8e4d8',
    'font-family:ui-monospace,Menlo,monospace',
    'user-select:none',
    'overflow-y:auto',
    'padding:32px 16px',
    'box-sizing:border-box',
  ].join(';');

  const title = document.createElement('div');
  title.textContent = 'SOLDAT';
  title.style.cssText =
    'font-size:42px;font-weight:bold;letter-spacing:0.5em;color:#fff;margin-bottom:6px;text-shadow:0 2px 12px rgba(0,0,0,0.9)';
  const subtitle = document.createElement('div');
  subtitle.textContent = 'NEW GAME — pick your opponent';
  subtitle.style.cssText =
    'font-size:14px;letter-spacing:0.25em;color:#ffd75e;margin-bottom:20px';
  overlay.append(title, subtitle);

  const column = document.createElement('div');
  column.style.cssText =
    'display:flex;flex-direction:column;gap:6px;width:min(720px,94vw)';
  overlay.appendChild(column);

  // --- Options row: wildcard loadout selector ----------------------------
  const optionsRow = document.createElement('div');
  optionsRow.style.cssText =
    'display:flex;align-items:center;gap:8px;font-size:12px;color:#9aa3b2;margin-bottom:8px';
  const optLabel = document.createElement('span');
  optLabel.textContent = 'WILDCARD LOADOUT:';
  const wildcardSelect = document.createElement('select');
  wildcardSelect.style.cssText =
    'background:#141821;color:#e8e4d8;border:1px solid #2a2f3a;border-radius:4px;padding:3px 6px;font-family:inherit;font-size:12px';
  for (const [value, label] of [
    ['chance', 'chance (seeded roll — the default)'],
    ['shotgun', 'shotgun (one SPAS12 carrier per team)'],
    ['rifle', 'rifle (one Barrett carrier per team)'],
    ['rocket', 'rocket (one M79 launcher per team)'],
    ['ricochet', 'ricochet (one wall-bouncing carbine per team)'],
    ['chainsaw', 'chainsaw (one melee saw per team)'],
    ['none', 'none (stock AK74 loadouts)'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    wildcardSelect.appendChild(opt);
  }
  optionsRow.append(optLabel, wildcardSelect);
  column.appendChild(optionsRow);

  // --- One row per registered bot engine ---------------------------------
  for (const id of engineIds()) {
    const engine = createEngine(id);
    const row = document.createElement('button');
    row.style.cssText = ROW_STYLE;
    row.addEventListener('mouseenter', () => (row.style.borderColor = '#ffd75e'));

    const name = document.createElement('span');
    const alias = LEARNED_MODELS[id];
    name.textContent =
      alias !== undefined && alias !== id.toUpperCase()
        ? `${id.toUpperCase()} “${alias}”`
        : id.toUpperCase();
    name.style.cssText =
      'font-weight:bold;font-size:14px;color:#fff;white-space:nowrap';
    row.appendChild(name);
    if (alias !== undefined) {
      const badge = document.createElement('span');
      badge.textContent = 'LEARNED';
      badge.style.cssText = [
        'font-size:9px',
        'font-weight:bold',
        'letter-spacing:0.15em',
        'color:#0a0c10',
        'background:#9be07f',
        'border-radius:3px',
        'padding:1px 6px',
        'white-space:nowrap',
      ].join(';');
      row.appendChild(badge);
    }
    const blurb = document.createElement('span');
    blurb.textContent = engine.strategy;
    blurb.style.cssText =
      'color:#9aa3b2;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1';
    row.appendChild(blurb);
    // Mouseover shows the WHOLE doctrine: the ellipsized one-liner unwraps
    // inline (instant, unlike the native title tooltip's hover delay).
    row.addEventListener('mouseenter', () => {
      blurb.style.whiteSpace = 'normal'; // gold border via the handler above
    });
    row.addEventListener('mouseleave', () => {
      row.style.borderColor = '#2a2f3a';
      blurb.style.whiteSpace = 'nowrap';
    });
    row.addEventListener('click', () => startGame(id, wildcardSelect.value));
    column.appendChild(row);
  }

  // --- Random opponent ----------------------------------------------------
  const randomBtn = document.createElement('button');
  randomBtn.style.cssText =
    ROW_STYLE + ';justify-content:center;border-color:#3a4154;margin-top:4px';
  randomBtn.textContent = '🎲 RANDOM OPPONENT';
  randomBtn.addEventListener('click', () => {
    const ids = engineIds();
    const pick = ids[Math.floor(Math.random() * ids.length)];
    if (pick !== undefined) startGame(pick, wildcardSelect.value);
  });
  column.appendChild(randomBtn);

  // --- Watch the broadcast (the old bare-URL default, now opt-in) ----------
  const watch = document.createElement('a');
  watch.href = `${window.location.pathname}?spectate`;
  watch.textContent = '📺 WATCH THE BROADCAST — bot-vs-bot, no input needed';
  watch.style.cssText =
    ROW_STYLE +
    ';justify-content:center;text-decoration:none;color:#47d8ff;border-color:#1f3a44;margin-top:10px';
  column.appendChild(watch);

  // --- Footer: monitor link + controls note --------------------------------
  const footer = document.createElement('div');
  footer.style.cssText =
    'margin-top:18px;font-size:11px;color:#9aa3b2;text-align:center;line-height:1.7';
  const monitor = document.createElement('a');
  monitor.href = 'http://localhost:8901';
  monitor.textContent = 'arena monitor :8901';
  monitor.style.cssText = 'color:#9be07f';
  const controls = document.createElement('div');
  controls.textContent =
    'CONTROLS — W jump · A/D move · Shift jet · IJKL aim · Space fire · Tab/B swap · R reload';
  footer.append(monitor, controls);
  overlay.appendChild(footer);

  document.body.appendChild(overlay);
}
