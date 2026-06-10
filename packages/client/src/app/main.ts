// Browser entry point for the playable single-player client.
//
// Builds the map renderer + a Game (the sim world + local player), loads a real
// .PMS map (synthetic fallback), then runs an animation-frame loop:
//
//   each frame:
//     1. read keyboard/mouse → sim Control
//     2. set player sprite.control
//     3. game.tick(dt)              — runs the fixed-60Hz sim as needed
//     4. entityRenderer.render()    — draw entities interpolated by framePercent
//     5. camera follows the player
//
// PORT: ClientGame.pas main loop (input → UpdateFrame → render). The map mesh
// render + the camera (MapRenderer) are reused from the Track-C glue.
//
// Real maps: drop Soldat .PMS files into packages/client/public/maps/ — the dev
// server serves them at /maps/<name>.pms. Choose one with the ?map= query param
// (e.g. ?map=ctf_Ash → /maps/ctf_Ash.pms). These files are NOT committed; supply
// your own per the asset-licensing decision (see public/maps/README.md). When
// the fetch fails (offline / no asset present) we fall back to the hand-built
// synthetic scene below so dev still works.

import { PolyType, type MapPolygon, type MapVertex, type PmsMap } from '@soldat/assets';
import { buildMapMesh } from '../render/mapMesh';
import { MapRenderer } from '../render/renderer';
import { EntityRenderer } from '../render/entityRender';
import { InputController } from '../input/input';
import { Hud, type HudState, type HudScores } from '../ui/hud';
import { shouldShowControls, showControlsScreen } from '../ui/controlsScreen';
import { START_HEALTH } from '../ui/helpers';
import { BloodFx, Crosshair } from '../render/fx';
import { resolveWildcard } from './wildcardChance';
import { buildTexturedMap } from '../render/mapTextured';
import { AudioEngine } from '../audio/audio';
import { SoundManager } from '../audio/soundManager';
import { Game, DEFAULT_TUNING, type RoundResult } from './game';
import { buildArena, ARENA_SPAWNS, generateArena } from './arena';
import { fetchAndLoadMap, pickMapUrl } from './loadMap';
import {
  Director,
  SNAP_DIST,
  applyKill,
  ffaScores,
  subjectName,
  type KillBoard,
  type SubjectInfo,
} from './director';
import { MatchRecorder } from './telemetry';
import { engineIds, createEngine } from '../ai';
import { parseTournament, showTournament, resolveVariant, tuningDeltas, type Variant } from './tournament';
import { LeaderboardPanel, TeamScorePanel, type FighterRow } from '../ui/leaderboard';

// ---------------------------------------------------------------------------
// Synthetic map
// ---------------------------------------------------------------------------

/** Build one triangle polygon from three (x, y, [r,g,b,a]) corners. */
function triangle(
  corners: readonly [
    readonly [number, number, readonly [number, number, number, number]],
    readonly [number, number, readonly [number, number, number, number]],
    readonly [number, number, readonly [number, number, number, number]],
  ],
): MapPolygon {
  const mk = (
    c: readonly [number, number, readonly [number, number, number, number]],
  ): MapVertex => {
    const [x, y, color] = c;
    return {
      x,
      y,
      z: 0,
      rhw: 1,
      color: [color[0], color[1], color[2], color[3]] as const,
      u: 0,
      v: 0,
    };
  };
  const v0 = mk(corners[0]);
  const v1 = mk(corners[1]);
  const v2 = mk(corners[2]);
  return {
    vertices: [v0, v1, v2] as const,
    normals: [
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: 1 },
    ] as const,
    polyType: PolyType.Normal,
    textureIndex: 0,
  };
}

/** A handful of coloured triangles forming a tiny test scene. */
function buildSyntheticMap(): PmsMap {
  const polygons: MapPolygon[] = [
    // Red triangle.
    triangle([
      [-300, 200, [255, 60, 60, 255]],
      [-100, 200, [255, 60, 60, 255]],
      [-200, -100, [255, 160, 160, 255]],
    ]),
    // Green triangle.
    triangle([
      [-50, 200, [60, 220, 90, 255]],
      [150, 200, [60, 220, 90, 255]],
      [50, -100, [180, 255, 180, 255]],
    ]),
    // Blue triangle.
    triangle([
      [200, 200, [70, 120, 255, 255]],
      [400, 200, [70, 120, 255, 255]],
      [300, -100, [180, 200, 255, 255]],
    ]),
    // A wide ground quad (two triangles).
    triangle([
      [-400, 240, [40, 40, 50, 255]],
      [400, 240, [40, 40, 50, 255]],
      [-400, 320, [25, 25, 32, 255]],
    ]),
    triangle([
      [400, 240, [40, 40, 50, 255]],
      [400, 320, [25, 25, 32, 255]],
      [-400, 320, [25, 25, 32, 255]],
    ]),
  ];

  return {
    hash: 0,
    version: 0,
    mapName: 'synthetic',
    textures: [],
    bgColorTop: [16, 20, 24, 255] as const,
    bgColorBtm: [8, 10, 12, 255] as const,
    startJet: 0,
    grenadePacks: 0,
    medikits: 0,
    weather: 0,
    steps: 0,
    randomId: 0,
    polygons,
    sectorsDivision: 0,
    sectorsNum: 0,
    sectors: [],
    props: [],
    scenery: [],
    colliders: [],
    spawnpoints: [],
    waypoints: [],
  };
}

// ---------------------------------------------------------------------------
// Spawn selection
// ---------------------------------------------------------------------------

/**
 * Pick a spawn position from the map: first active spawnpoint if present,
 * otherwise a point above the synthetic ground so the player falls onto it.
 */
function pickSpawn(map: PmsMap): { x: number; y: number } {
  const sp = map.spawnpoints.find((s) => s.active) ?? map.spawnpoints[0];
  if (sp !== undefined) {
    return { x: sp.x, y: sp.y };
  }
  // Synthetic-map fallback: a bit above the ground quad at y≈240.
  return { x: 0, y: 0 };
}

// ---------------------------------------------------------------------------
// Spectate mode — THE DEFAULT: the game opens on a bot-vs-bot aerial match
// with no human soldier. The action camera follows the most interesting bot,
// the HUD shows live kill counts + feed, and zero input is required.
// `?play` opts into fighting yourself; `?spectate=8` picks the bot count.
// ---------------------------------------------------------------------------

const SPECTATE_QUERY_PARAM = 'spectate';
const PLAY_QUERY_PARAM = 'play';
const SPECTATE_DEFAULT_BOTS = 6;
const SPECTATE_MAX_BOTS = 12;

/**
 * Mode selection. SPECTATE IS THE DEFAULT (goal node 124): the game opens on
 * a bot-vs-bot aerial match. `?play` opts into playing yourself;
 * `?spectate=n` still picks the bot count; `?ai=<engine>` picks the bot
 * brain (decision node 136).
 */
/** Parse 'KEY=V,KEY=V' (the ?tweak-a/?tweak-b format) into a tweak record. */
export function parseTweakParam(raw: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (raw ?? '').split(',')) {
    const [k, v] = part.split('=');
    const num = Number(v);
    if (k !== undefined && k.length > 0 && Number.isFinite(num)) out[k] = num;
  }
  return out;
}

export function parseSpectate(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): {
  spectate: boolean;
  botCount: number;
  aiEngine: string | undefined;
  seed: number;
  teams: boolean | undefined;
  /** CLAUDE ARENA (node 185): per-side brain tweaks + coach names from the
   *  URL, so any tweaked matchup is a shareable, watchable link. */
  tweakA: Record<string, number>;
  tweakB: Record<string, number>;
  coachA: string | undefined;
  coachB: string | undefined;
  /** Generated-arena seed (?arena=N; 0 = canonical Skyreach). */
  arenaSeed: number;
  variant: string | undefined;
  roundSecs: number;
  /** Opt-in wildcard (?wildcard=shotgun); absent = stock loadouts. */
  wildcard: string | undefined;
} {
  const params = new URLSearchParams(search);
  const aiEngine = params.get('ai') ?? undefined;
  // ?seed=N: the sim is deterministic — distinct seeds make distinct matches
  // (the tournament runs four games on four seeds).
  const seedRaw = parseInt(params.get('seed') ?? '', 10);
  const seed = Number.isFinite(seedRaw) ? seedRaw : 1;
  // ?teams forces red-vs-blue on; Game defaults teams ON for mixed engines.
  const teams = params.has('teams') ? true : undefined;
  // ?variant=<name>: named gameplay-tuning variant (tournament.ts VARIANTS;
  // unknown names resolve to baseline at the call site).
  const variant = params.get('variant') ?? undefined;
  // ?round=SECS: timed-round length in SIM seconds (default 10 minutes).
  // Parsed in both modes but only ARMED in spectate (play stays endless).
  const roundRaw = parseInt(params.get('round') ?? '', 10);
  const roundSecs = Number.isFinite(roundRaw) && roundRaw > 0 ? roundRaw : 600;
  // Claude Arena params: per-side tweaks + coach labels.
  const tweakA = parseTweakParam(params.get('tweak-a'));
  const tweakB = parseTweakParam(params.get('tweak-b'));
  const coachA = params.get('coach-a') ?? undefined;
  const coachB = params.get('coach-b') ?? undefined;
  const arenaRaw = parseInt(params.get('arena') ?? '', 10);
  const arenaSeed = Number.isFinite(arenaRaw) && arenaRaw >= 0 ? arenaRaw : 0;
  // ?wildcard=shotgun|none|chance. Fresh PLAY sessions default to the seeded
  // chance roll (every game gets a shot at shotgun play); SPECTATE links
  // without the param stay STOCK — every watch URL recorded before the
  // chance era carries no param and must keep replaying byte-identically.
  const wildcardRaw = params.get('wildcard') ?? undefined;
  if (params.has(PLAY_QUERY_PARAM)) {
    return {
      spectate: false, botCount: 3, aiEngine, seed, teams, variant, roundSecs,
      tweakA, tweakB, coachA, coachB, arenaSeed,
      wildcard: resolveWildcard(wildcardRaw ?? 'chance', seed),
    };
  }
  const n = parseInt(params.get(SPECTATE_QUERY_PARAM) ?? '', 10);
  const botCount =
    Number.isFinite(n) && n >= 2 ? Math.min(n, SPECTATE_MAX_BOTS) : SPECTATE_DEFAULT_BOTS;
  return {
    spectate: true, botCount, aiEngine, seed, teams, variant, roundSecs,
    tweakA, tweakB, coachA, coachB, arenaSeed,
    wildcard: resolveWildcard(wildcardRaw, seed),
  };
}

/**
 * Duel mode: SEVERAL simultaneous bot matches, one per AI engine, each a
 * fully independent game in its own iframe (own renderer, own sim, own
 * telemetry) — honest isolation, no match can perturb another.
 *
 *   ?duel                          → classic vs pilot, side by side
 *   ?duel=pilot,classic            → any two engines (order = position)
 *   ?duel=classic,pilot,pilot,...  → up to 6 in a grid (repeats fine —
 *                                    pilot-vs-pilot mirrors are legal)
 */
const DUEL_MAX_GAMES = 6;

export function parseDuel(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): string[] | null {
  const params = new URLSearchParams(search);
  if (!params.has('duel')) return null;
  const raw = params.get('duel') ?? '';
  const engines = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, DUEL_MAX_GAMES);
  return engines.length >= 2 ? engines : ['classic', 'pilot'];
}

/** Build the duel view: a grid of labelled iframes, each a spectate match. */
function showDuel(engines: readonly string[]): void {
  document.body.style.cssText = 'margin:0;background:#0a0c10';
  const row = document.createElement('div');
  // 2 per row: flex-wrap keeps pairs side by side and stacks further rows.
  const basis = engines.length > 1 ? 'calc(50% - 1px)' : '100%';
  row.style.cssText =
    'display:flex;flex-wrap:wrap;width:100vw;height:100vh;gap:2px;align-content:stretch';
  for (const engine of engines) {
    const col = document.createElement('div');
    col.style.cssText =
      `flex:1 1 ${basis};display:flex;flex-direction:column;min-width:0;position:relative;` +
      `min-height:${engines.length > 2 ? 'calc(50% - 1px)' : '100%'}`;
    const frame = document.createElement('iframe');
    frame.src = `${window.location.pathname}?spectate&ai=${encodeURIComponent(engine)}`;
    frame.style.cssText = 'flex:1;border:0;width:100%;height:100%';
    col.append(frame);
    row.appendChild(col);
  }
  document.body.appendChild(row);
}

/** Per-engine banner accent so windows are tellable-apart at a glance. */
const ENGINE_COLORS: Record<string, string> = {
  classic: '#ffb347', // amber — the old reflexes
  pilot: '#47d8ff', // cyan — the new aerialist
};

/**
 * Mixed-match scoreboard: total kills per ENGINE group (first two groups map
 * onto the HUD's alpha/bravo). Returns null for uniform matches so the
 * caller falls back to the FFA leader board.
 */
function engineScores(
  game: Game,
  board: KillBoard,
  followed: number,
): HudScores | null {
  const groups = game.engineGroups();
  if (groups.length < 2) return null;
  const totals = new Map<string, number>(groups.map((g) => [g, 0]));
  for (const [idx, k] of board.kills) {
    const g = game.engineOf(idx);
    if (totals.has(g)) totals.set(g, (totals.get(g) ?? 0) + k);
  }
  const a = totals.get(groups[0] ?? '') ?? 0;
  const b = totals.get(groups[1] ?? '') ?? 0;
  const followedGroup = game.engineOf(followed);
  const leadingGroup = a >= b ? groups[0] : groups[1];
  return {
    alpha: a,
    bravo: b,
    playerKills: board.kills.get(followed) ?? 0,
    leading: followedGroup === leadingGroup && a !== b,
    gap: Math.abs(a - b),
  };
}

/** Handle for the match-info card: relabel on hot-swap + follow updates. */
interface InfoCard {
  update(): void;
  setFollowing(name: string, team: number, engine: string): void;
  toggle(): void;
  setMinimal(minimal: boolean): void;
}

const TEAM_COLORS: Record<number, string> = { 1: '#d23c3c', 2: '#4060d2' };

/**
 * The match-info card: which engines are fighting, their strategy, the
 * variant's knob turns, and WHO the camera is following (team-colored).
 *
 * Two layouts so you can always watch the game AND read the info: full-size
 * windows get the big bottom-center banner; small windows (tournament tiles
 * are ~half-screen iframes) get a COMPACT corner card that never covers the
 * action. B (or the i button) toggles it.
 */
/** 'pilot: RANGE_MAX 420→460 · FUEL_RESERVE 130→160' per tweaked side. */
function engineTweakDeltas(game: Game): string {
  const lines: string[] = [];
  for (const id of game.engineGroups()) {
    const resolved = game.resolvedTweaks(id);
    if (resolved === undefined) continue;
    const defaults = createEngine(id).tweaks;
    const diffs = Object.entries(resolved)
      .filter(([k, v]) => defaults[k] !== v)
      .map(([k, v]) => `${k} ${defaults[k]}→${v}`);
    if (diffs.length > 0) lines.push(`${id}: ${diffs.join(' · ')}`);
  }
  return lines.join('   ');
}

function showEngineBanner(
  game: Game,
  variant: Variant,
  coaches: { a: string | undefined; b: string | undefined },
): InfoCard {
  const compact = window.innerWidth < 1000;
  const banner = document.createElement('div');
  banner.style.cssText = compact
    ? [
        'position:fixed',
        'bottom:30px',
        'left:50%',
        'transform:translateX(-50%)',
        'z-index:20',
        'text-align:center',
        'pointer-events:none',
        'font-family:ui-monospace,Menlo,monospace',
        'background:rgba(10,12,16,0.65)',
        'padding:4px 10px',
        'border-radius:6px',
        'max-width:92vw',
      ].join(';')
    : [
        'position:fixed',
        'bottom:96px',
        'left:50%',
        'transform:translateX(-50%)',
        'z-index:20',
        'text-align:center',
        'pointer-events:none',
        'font-family:ui-monospace,Menlo,monospace',
        'text-shadow:0 2px 8px rgba(0,0,0,0.9)',
      ].join(';');
  const name = document.createElement('div');
  name.style.cssText = compact
    ? 'font-size:15px;font-weight:bold;letter-spacing:0.15em'
    : 'font-size:34px;font-weight:bold;letter-spacing:0.35em';
  const tagline = document.createElement('div');
  tagline.style.cssText = `font-size:${compact ? 10 : 12}px;color:#cfd6e4;margin-top:2px;letter-spacing:0.08em`;
  // Variant line: which gameplay-tuning variant this window runs, with its
  // knob turns spelled out. Shown ALWAYS in spectate (baseline included).
  const variantLine = document.createElement('div');
  variantLine.style.cssText = `font-size:${compact ? 10 : 11}px;color:#ffd75e;margin-top:3px;letter-spacing:0.12em`;
  const knobs = tuningDeltas(variant.tuning, DEFAULT_TUNING);
  variantLine.textContent =
    `VARIANT: ${variant.name.toUpperCase()} — ${variant.blurb}` +
    (knobs !== '' ? ` · ${knobs}` : '');
  // Claude Arena line: per-side coach tweaks (the knob turns each coach
  // filed for this fight) — empty when nobody tweaked anything.
  const arenaLine = document.createElement('div');
  arenaLine.style.cssText = `font-size:${compact ? 10 : 11}px;color:#9be07f;margin-top:3px;letter-spacing:0.1em`;
  const deltas = engineTweakDeltas(game);
  arenaLine.textContent = deltas;
  arenaLine.style.display = deltas === '' ? 'none' : '';
  // Following line: who the camera is on, highlighted in their TEAM color.
  const followLine = document.createElement('div');
  followLine.style.cssText = `font-size:${compact ? 11 : 13}px;font-weight:bold;margin-top:3px;letter-spacing:0.12em`;
  banner.append(name, tagline, variantLine, arenaLine, followLine);
  document.body.appendChild(banner);
  const update = (): void => {
    const groups = game.engineGroups();
    // Coach labels (Claude Arena): 'PILOT (VEGA) vs REAPER (OKONKWO)'.
    const labels = groups.map((g, i) => {
      const coach = i === 0 ? coaches.a : coaches.b;
      return coach !== undefined ? `${g.toUpperCase()} (${coach.toUpperCase()})` : g.toUpperCase();
    });
    name.textContent = labels.join(' vs ');
    name.style.color =
      groups.length === 1 ? (ENGINE_COLORS[groups[0] ?? ''] ?? '#ffffff') : '#ffffff';
    tagline.textContent = game.aiStrategy;
  };
  update();
  return {
    update,
    setFollowing: (who, team, engine): void => {
      const teamWord = team === 1 ? 'RED' : team === 2 ? 'BLUE' : '';
      followLine.textContent =
        `▶ FOLLOWING ${who}` +
        (teamWord !== '' ? ` — ${teamWord}` : '') +
        (engine !== '' ? ` · ${engine}` : '');
      followLine.style.color = TEAM_COLORS[team] ?? '#e8e4d8';
    },
    toggle: (): void => {
      banner.style.display = banner.style.display === 'none' ? '' : 'none';
    },
    setMinimal: (minimal: boolean): void => {
      // Clean view: keep ONLY the engine names — drop strategy/variant/follow.
      banner.style.display = '';
      tagline.style.display = minimal ? 'none' : '';
      variantLine.style.display = minimal ? 'none' : '';
      arenaLine.style.display = minimal || arenaLine.textContent === '' ? 'none' : '';
      followLine.style.display = minimal ? 'none' : '';
    },
  };
}

/** Big center-screen winner banner; hidden until round end. */
function makeWinnerBanner(): (r: RoundResult) => void {
  const root = document.createElement('div');
  root.style.cssText = [
    'position:fixed',
    'top:38%',
    'left:50%',
    'transform:translate(-50%,-50%)',
    'z-index:30',
    'text-align:center',
    'pointer-events:none',
    'display:none',
    'font-family:ui-monospace,Menlo,monospace',
    'text-shadow:0 2px 12px rgba(0,0,0,0.95)',
  ].join(';');
  const title = document.createElement('div');
  const sub = document.createElement('div');
  root.append(title, sub);
  document.body.appendChild(root);
  return (r): void => {
    title.textContent =
      r.winnerTeam === 1 ? 'RED WINS' : r.winnerTeam === 2 ? 'BLUE WINS' : 'DRAW';
    title.style.cssText =
      'font-size:56px;font-weight:bold;letter-spacing:0.3em;color:' +
      (r.winnerTeam === 1 ? '#d23c3c' : r.winnerTeam === 2 ? '#4060d2' : '#e8e4d8');
    sub.textContent =
      (r.winnerEngine !== '' ? `${r.winnerEngine.toUpperCase()} · ` : '') +
      `${r.redKills}–${r.blueKills} · ROUND OVER`;
    sub.style.cssText = 'font-size:16px;color:#cfd6e4;margin-top:6px;letter-spacing:0.15em';
    root.style.display = '';
  };
}

/** Fixed bottom-left hint so a spectator knows the camera keys. */
function showSpectateHint(): HTMLDivElement {
  const hint = document.createElement('div');
  hint.textContent = 'SPECTATE — ←/→ follow · A auto · E swap brain · M sound · B info · ?play to fight';
  hint.style.cssText = [
    'position:fixed',
    'left:12px',
    'bottom:12px',
    'color:#cfd6e4',
    'font:12px monospace',
    'opacity:0.8',
    'pointer-events:none',
    'z-index:10',
  ].join(';');
  document.body.appendChild(hint);
  return hint;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Duel mode: hand the page over to two side-by-side matches and stop —
  // each iframe boots its own full game through this same entry point.
  const duel = parseDuel();
  if (duel !== null) {
    showDuel(duel);
    return;
  }
  // Tournament mode: 4 mixed-AI team games + an aggregated leaderboard.
  const tournament = parseTournament();
  if (tournament !== null) {
    showTournament(tournament);
    return;
  }

  const mount = document.getElementById('app');
  if (mount === null) {
    throw new Error('#app element not found');
  }

  const renderer = new MapRenderer({ container: mount });
  await renderer.init();

  // --- Real .PMS loading, with synthetic fallback -----------------------
  // Try to fetch a real map from /maps/ (URL chosen via ?map=); on any failure
  // (offline, missing asset, parse error) fall back to the synthetic scene.
  // Mode decides the DEFAULT map: spectate (the startup default) opens on the
  // built-in Skyreach aerial arena — the jetpack-dogfight level the bot match
  // is tuned for — unless ?map= explicitly asks for a stock map. Play mode
  // keeps the stock-map default.
  const {
    spectate, botCount, aiEngine, seed, teams,
    variant: variantName, roundSecs, tweakA, tweakB, coachA, coachB, arenaSeed,
    wildcard,
  } = parseSpectate();
  // Gameplay-tuning variant (tournament tiles each run a different one;
  // unknown/absent names are baseline = stock rules).
  const variant = resolveVariant(variantName);
  const explicitMap = new URLSearchParams(window.location.search).has('map');
  let map: PmsMap;
  let spawns: readonly { x: number; y: number }[];
  if (spectate && !explicitMap) {
    // Generated arena family: ?arena=N rolls a deterministic Skyreach-kin
    // map; 0 (default) is the canonical hand-built layout.
    const gen = generateArena(arenaSeed);
    map = gen.map;
    spawns = gen.spawns;
  } else {
    const mapUrl = pickMapUrl();
    try {
      map = await fetchAndLoadMap(mapUrl);
      const sp = map.spawnpoints.filter((s) => s.active).map((s) => ({ x: s.x, y: s.y }));
      spawns = sp.length > 0 ? sp : ARENA_SPAWNS;
      // eslint-disable-next-line no-console
      console.info(`loaded map '${map.mapName}' from ${mapUrl}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `could not load '${mapUrl}', using the built-in arena instead:`,
        err instanceof Error ? err.message : err,
      );
      map = buildArena();
      spawns = ARENA_SPAWNS;
    }
  }
  // ----------------------------------------------------------------------

  // Draw the static map geometry (flat-colour fallback).
  const mesh = buildMapMesh(map);
  renderer.setMap(mesh);

  // Try to overlay the REAL map texture on top of the flat geometry. If the
  // texture is missing, buildTexturedMap returns an empty container and we keep
  // the flat map. Inserted just above the flat map, below entities.
  try {
    const texturedMap = await buildTexturedMap(map, mesh);
    if (texturedMap.children.length > 0) {
      renderer.world.addChildAt(texturedMap, 1);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('textured map failed, using flat colours:', err);
  }

  // --- Game: sim world + local player + bots ---------------------------
  // A fixed seed keeps the run deterministic across reloads (handy in dev).
  // Round timer: SIM ticks (60 Hz), never wall clock — and only ever armed in
  // spectate mode, so plain ?play stays endless and byte-for-byte unchanged.
  // Claude Arena: side tweaks map onto the side ENGINES (team A = first id
  // in the ?ai list, team B = second). Uniform matches apply tweak-a only.
  const sideIds = (aiEngine ?? 'classic').split(',').map((s) => s.trim());
  const engineTweaks: Record<string, Record<string, number>> = {};
  if (Object.keys(tweakA).length > 0 && sideIds[0] !== undefined) {
    engineTweaks[sideIds[0]] = tweakA;
  }
  if (Object.keys(tweakB).length > 0 && sideIds[1] !== undefined) {
    engineTweaks[sideIds[1]] = tweakB;
  }
  const game = new Game({
    seed,
    spawns,
    botCount,
    spectate,
    aiEngine,
    teams,
    engineTweaks,
    tuning: variant.tuning,
    roundTicks: spectate ? roundSecs * 60 : 0,
    wildcard,
  });
  // Attach the sim collision map so sprites collide with the floor (and, in
  // spectate mode, the map's bot waypoints so targetless bots patrol).
  game.loadMap(map);
  // Spectate-hint element handle (clean view hides it; assigned below).
  let hintEl: HTMLDivElement | null = null;

  // --- Spectate director + scoreboard ------------------------------------
  // The director picks which bot the action camera follows; the kill board
  // (tally + feed) is fed by Game.onKill in BOTH modes (pure display data),
  // though the normal-mode HUD currently keeps its placeholder scores.
  const director = new Director(game.botIndices()[0] ?? game.playerIndex);
  const board: KillBoard = { kills: new Map(), feed: [] };
  // Rotate the name pool by seed: every match fields a distinct squad.
  const nameOf = (i: number): string => subjectName(i, game.playerIndex, seed * 7);

  // --- Match telemetry (spectate only) ------------------------------------
  // Records samples/shots/hits/kills under a versioned JSON schema so agents
  // and tooling can analyze the gameplay math (hit rates, flight patterns,
  // death clusters). Pull via window.__match.dump() (CDP-friendly), save with
  // the T key, analyze with soldat-ts/tools/analyze-match.mjs.
  const recorder = spectate
    ? new MatchRecorder(game, map.mapName, botCount, spectate, variant.name)
    : null;
  if (recorder !== null) {
    (window as unknown as { __match: { dump(): unknown } }).__match = {
      dump: (): unknown => recorder.dump(),
    };
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.code !== 'KeyT') return;
      const blob = new Blob([JSON.stringify(recorder.dump())], {
        type: 'application/json',
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `match-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  const deaths = new Map<number, number>();
  game.onKill = (killer, victim): void => {
    deaths.set(victim, (deaths.get(victim) ?? 0) + 1);
    recorder?.recordKill(killer, victim);
    applyKill(
      board,
      killer,
      victim,
      nameOf,
      spectate ? director.followed : game.playerIndex,
      // Cause = the shooter's current weapon (bots never swap, so the label
      // is exact for them); suicides/world deaths show the victim's own gun.
      game.weaponNameOf(killer > 0 && killer !== victim ? killer : victim),
    );
    director.notifyKill(killer, victim, game.world.mainTickCounter);
  };

  // --- Sound: load sfx, resume audio on first input, play on game events ----
  const audio = new AudioEngine();
  const sound = new SoundManager(audio);
  void sound.load();
  const resumeAudio = (): void => {
    void audio.resume();
  };
  window.addEventListener('pointerdown', resumeAudio, { once: true });
  window.addEventListener('keydown', resumeAudio, { once: true });
  // Sound is MUTED by default (user preference) — M or the button unmutes.
  let muted = true;
  game.onSound = (event, x, y): void => {
    if (muted) return;
    const sp = game.world.spriteParts;
    // The "listener" is whoever the screen is centred on: the followed bot in
    // spectate mode, the local player otherwise.
    const ear = spectate ? director.followed : game.playerIndex;
    const lx = sp?.posX[ear] ?? 0;
    const ly = sp?.posY[ear] ?? 0;
    sound.play(event, x, y, lx, ly);
  };

  // --- Entity renderer: lives inside the camera/world container --------
  // Adding to renderer.world means entity graphics share the map's pan/zoom
  // transform, so world coordinates line up with the map mesh.
  const entityRenderer = new EntityRenderer();
  entityRenderer.playerIndex = game.playerIndex;
  renderer.world.addChild(entityRenderer.container);
  // Load the real Gostek part textures (async); until ready, the vector
  // fallback draws. Don't block the loop on it.
  void entityRenderer.enableTextured().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn('textured Gostek unavailable, using vector figures:', err);
  });

  // --- Blood: cosmetic droplet bursts on bullet impacts ------------------
  // Driven by the sim's onBulletHit observer (notification only — the hook is
  // null in headless/arena runs, so replay determinism is untouched). Lives in
  // the world container ABOVE the entity layer so wounds read over the bodies.
  const blood = new BloodFx();
  renderer.world.addChild(blood.gfx);
  game.world.onBulletHit = (_victim, x, y, vx, vy, damage, fatal): void => {
    blood.spawnHit(x, y, vx, vy, damage, fatal);
  };

  // Crosshair at the aim point (in the world container, follows the camera).
  // Spectators don't aim — hide it entirely in spectate mode.
  const crosshair = new Crosshair();
  crosshair.visible = !spectate;
  renderer.world.addChild(crosshair);

  // --- HUD --------------------------------------------------------------
  // The HUD lives on the app stage (screen-fixed), NOT renderer.world, so it
  // does not pan/zoom with the camera.
  const hud = new Hud();
  const stage = renderer.app?.stage;
  if (stage !== undefined) {
    stage.addChild(hud);
    hud.resize(renderer.app?.canvas.width ?? 0, renderer.app?.canvas.height ?? 0);
  }

  // --- Input -----------------------------------------------------------
  const canvas = renderer.app?.canvas;
  if (canvas === undefined) {
    throw new Error('renderer canvas missing after init()');
  }
  const input = new InputController(canvas);

  // Controls screen: rendered from the same CONTROL_BINDINGS table the input
  // tests verify, shown over the running game until the first keypress.
  // Currently EVERY startup counts as a first start (controlsScreen.ts
  // ALWAYS_SHOW) — the scheme is in flux and the listing must stay exercised.
  // Spectate mode skips it (no input is needed; it would only obscure the
  // match) and shows the camera-key hint instead.
  if (!spectate && shouldShowControls()) {
    showControlsScreen();
  }
  if (spectate) {
    hintEl = showSpectateHint();
  }
  // Match-info card: engines, strategy, knob turns, and who the camera is
  // following — compact in small windows so the game stays watchable.
  const infoCard = spectate
    ? showEngineBanner(game, variant, { a: coachA, b: coachB })
    : null;

  // CLEAN VIEW (H, or a tournament-page broadcast): hide every overlay except
  // the engine names so the shooting is fully visible.
  let cleanMode = false;
  const setClean = (on: boolean): void => {
    cleanMode = on;
    if (leaderboard !== null) leaderboard.visible = !on;
    if (teamPanel !== null) teamPanel.visible = !on;
    if (hintEl !== null) hintEl.style.display = on ? 'none' : '';
    hud.visible = !on; // pixi HUD: score, kill feed, vitals, FPS
    infoCard?.setMinimal(on);
  };
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === 'h') setClean(!cleanMode);
  });
  window.addEventListener('message', (e: MessageEvent) => {
    const data: unknown = e.data;
    if (
      typeof data === 'object' &&
      data !== null &&
      (data as { soldatClean?: string }).soldatClean === 'toggle'
    ) {
      setClean(!cleanMode);
    }
  });

  // Tiny clickable controls (bottom-right corner): sound + info toggles.
  // Keyboard: M mutes/unmutes, B shows/hides the info card — in EVERY mode.
  {
    const strip = document.createElement('div');
    strip.style.cssText =
      'position:fixed;bottom:8px;right:8px;z-index:40;display:flex;gap:6px;font:14px ui-monospace,monospace';
    const mkBtn = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.style.cssText =
        'background:rgba(10,12,16,0.7);color:#e8e4d8;border:1px solid #444;border-radius:4px;padding:3px 8px;cursor:pointer';
      b.addEventListener('click', () => {
        onClick();
        b.blur(); // don't steal Space/arrow keys from the game
      });
      return b;
    };
    const muteBtn = mkBtn('🔇', 'sound (M)', () => {
      muted = !muted;
      muteBtn.textContent = muted ? '🔇' : '🔊';
    });
    strip.appendChild(muteBtn);
    if (infoCard !== null) {
      strip.appendChild(mkBtn('ℹ', 'match info (B)', () => infoCard.toggle()));
    }
    document.body.appendChild(strip);
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key === 'm') {
        muted = !muted;
        muteBtn.textContent = muted ? '🔇' : '🔊';
      } else if (key === 'b') {
        infoCard?.toggle();
      }
    });
  }
  // Displayed leaderboard (L toggles): live K/D ranking of every fighter.
  const leaderboard = spectate ? new LeaderboardPanel() : null;
  // Per-team scoreboard (goal node 157): team kill totals + the RED/BLUE MVP,
  // top-center — every team match (so every tournament tile) carries its own.
  const teamPanel = spectate && game.teamsEnabled ? new TeamScorePanel() : null;
  // Round-end overlay: shown ONCE when the timed round freezes the game.
  const showWinner = spectate ? makeWinnerBanner() : null;
  let roundShown = false;
  const leaderboardRows = (): FighterRow[] =>
    game.botIndices().map((i) => ({
      index: i,
      name: nameOf(i),
      engine: game.engineGroups().length > 1 ? game.engineOf(i) : '',
      team: game.teamOf(i),
      kills: board.kills.get(i) ?? 0,
      deaths: deaths.get(i) ?? 0,
    }));

  const player = game.world.sprites[game.playerIndex];
  if (player === undefined) {
    throw new Error('player sprite missing');
  }

  // --- Camera follow ----------------------------------------------------
  // Centre the world container on the player every frame. With the world
  // container transform = camera, the screen position of a world point (wx, wy)
  // is (wx*zoom + cam.x, wy*zoom + cam.y); to centre the player we solve for
  // cam.x/cam.y given the canvas centre.
  function centerCameraOnPlayer(): void {
    const app = renderer.app;
    if (app === undefined) return;
    const parts = game.world.spriteParts;
    if (parts === null) return;
    const px = parts.posX[game.playerIndex] ?? 0;
    const py = parts.posY[game.playerIndex] ?? 0;
    const zoom = renderer.camera.zoom;
    renderer.camera.x = app.renderer.width / 2 - px * zoom;
    renderer.camera.y = app.renderer.height / 2 - py * zoom;
    // applyCamera is private; panBy(0,0) flushes the camera onto the container.
    renderer.panBy(0, 0);
  }

  // --- Spectator action camera -------------------------------------------
  // The camera follows a SMOOTHED WORLD POINT (camX/camY) lerped toward the
  // followed bot, then camera.x/y are assigned absolutely from it each frame —
  // so the wheel-zoom handler below coexists unchanged (zoom persists, x/y are
  // overwritten exactly as in normal mode). Big subject switches snap instead
  // of smearing across the map.
  let camX = 0;
  let camY = 0;
  {
    const parts = game.world.spriteParts;
    camX = parts?.posX[director.followed] ?? 0;
    camY = parts?.posY[director.followed] ?? 0;
  }
  function spectateCamera(dt: number): void {
    const app = renderer.app;
    if (app === undefined) return;
    const parts = game.world.spriteParts;
    if (parts === null) return;
    const tx = parts.posX[director.followed] ?? 0;
    const ty = parts.posY[director.followed] ?? 0;
    if (director.switched && Math.hypot(tx - camX, ty - camY) > SNAP_DIST) {
      // Cut, don't fly: a cross-map pan reads as disorienting smear.
      camX = tx;
      camY = ty;
    } else {
      // Exponential lerp (~0.25 s time constant) — reads as a broadcast pan.
      const k = 1 - Math.exp(-4 * dt);
      camX += (tx - camX) * k;
      camY += (ty - camY) * k;
    }
    const zoom = renderer.camera.zoom;
    renderer.camera.x = app.renderer.width / 2 - camX * zoom;
    renderer.camera.y = app.renderer.height / 2 - camY * zoom;
    renderer.panBy(0, 0);
  }

  /** SubjectInfo snapshot of every bot for the director's interest scoring. */
  function buildSubjects(): SubjectInfo[] {
    const parts = game.world.spriteParts;
    const raw: { index: number; alive: boolean; x: number; y: number; firing: boolean }[] = [];
    for (const i of game.botIndices()) {
      const s = game.world.sprites[i];
      if (s === undefined) continue;
      raw.push({
        index: i,
        alive: s.active && !s.deadMeat,
        x: parts?.posX[i] ?? 0,
        y: parts?.posY[i] ?? 0,
        firing: s.control.fire,
      });
    }
    return raw.map((r) => {
      let nearest = Infinity;
      for (const o of raw) {
        if (o.index === r.index || !o.alive) continue;
        const d = Math.hypot(o.x - r.x, o.y - r.y);
        if (d < nearest) nearest = d;
      }
      return {
        ...r,
        lastKillTick: director.lastKillTickOf(r.index),
        nearestEnemyDist: nearest,
      };
    });
  }

  // Manual camera override (spectate only). A plain window listener — the
  // InputController's binding table is test-pinned and player input is ignored
  // in spectate anyway, so there is no collision.
  if (spectate) {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      const live = game.botIndices().filter((i) => {
        const s = game.world.sprites[i];
        return s !== undefined && s.active && !s.deadMeat;
      });
      const tick = game.world.mainTickCounter;
      const key = e.key.toLowerCase();
      if (key === 'arrowright' || key === 'n') {
        if (live.length === 0) return;
        const at = live.indexOf(director.followed);
        director.setManual(live[(at + 1) % live.length] ?? director.followed, tick);
      } else if (key === 'arrowleft' || key === 'p') {
        if (live.length === 0) return;
        const at = live.indexOf(director.followed);
        const prev = (at <= 0 ? live.length : at) - 1;
        director.setManual(live[prev] ?? director.followed, tick);
      } else if (key === 'a' || key === '0') {
        director.setAuto();
      } else if (key === 'l') {
        if (leaderboard !== null) leaderboard.visible = !leaderboard.visible;
      } else if (key === 'e') {
        // HOT-SWAP the brains: cycle classic → pilot → ... → MIXED (all
        // engines splitting the bots in one arena) → classic. Sprites,
        // scores, and fuel carry over — only the thinking changes.
        const specs = [...engineIds(), engineIds().join(',')];
        const cur = specs.findIndex(
          (s) => s.split(',').join('+') === game.aiEngineId,
        );
        const next = specs[(cur + 1) % specs.length];
        if (next !== undefined) {
          game.setEngine(next);
          infoCard?.update();
        }
      }
    });
  }

  if (!spectate) {
    centerCameraOnPlayer();
  } else {
    spectateCamera(0);
  }

  // --- Wheel-zoom centred on the cursor (kept from the map viewer) ------
  // Proportional to the actual scroll delta (a fixed 10% per EVENT made
  // trackpads — which fire dozens of small-delta events per gesture —
  // wildly oversensitive). One mouse-wheel notch (|deltaY| ≈ 100) is now a
  // gentle ~4%; the per-event clamp keeps violent flicks civilised.
  canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const clamped = Math.max(-160, Math.min(160, e.deltaY));
      const factor = Math.exp(-clamped * 0.0004);
      renderer.zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
    },
    { passive: false },
  );

  // --- Main loop --------------------------------------------------------
  // Drive the sim + render off the display refresh. dt is real seconds; the
  // Game's accumulator turns it into fixed 60 Hz sim ticks (decoupled render).
  let last = performance.now();
  const frame = (now: number): void => {
    const dt = (now - last) / 1000;
    last = now;

    // 1. Read input. Mouse aim is relative to the player's SCREEN position, so
    //    compute where the player currently draws on the canvas.
    const app = renderer.app;
    const zoom = renderer.camera.zoom;
    const parts = game.world.spriteParts;
    const px = parts !== null ? (parts.posX[game.playerIndex] ?? 0) : 0;
    const py = parts !== null ? (parts.posY[game.playerIndex] ?? 0) : 0;
    const playerScreenX = px * zoom + renderer.camera.x;
    const playerScreenY = py * zoom + renderer.camera.y;
    const control = input.readControl(playerScreenX, playerScreenY, now);

    // 2. Apply control to the player sprite (the sim reads it during stepWorld).
    //    Spectate: the human does not fight — slot 1 is never spawned and its
    //    control is never written.
    if (!spectate) {
      player.control = control;
      // Crosshair at the aim point (world coords = COM + relative aim vector).
      crosshair.moveTo(px + control.mouseAimX, py + control.mouseAimY);
    }

    // 3. Advance the simulation by real elapsed time (fixed-step internally).
    game.tick(dt);
    recorder?.maybeSample();

    // Round end (one-shot): Game.tick() now no-ops (frozen sim), but THIS loop
    // keeps running so the director/HUD/leaderboard render the final state.
    // Paint the winner banner and force a final scoreboard refresh (the %30
    // refresh below stops firing once the sim clock stops).
    if (!roundShown && game.roundResult !== null) {
      roundShown = true;
      showWinner?.(game.roundResult);
      teamPanel?.update(leaderboardRows());
      if (leaderboard !== null) leaderboard.update(leaderboardRows());
    }

    // 4. Render entities, interpolated between ticks by the leftover fraction.
    entityRenderer.render(game.world, game.framePercent);

    // Blood droplets advance on the render clock (visual only, no sim state).
    blood.update(dt);
    blood.draw();

    // 5. Camera: follow the player, or (spectate) the director's pick of the
    //    most interesting bot.
    if (spectate) {
      director.update(buildSubjects(), game.world.mainTickCounter);
      spectateCamera(dt);
    } else {
      centerCameraOnPlayer();
    }

    // 6. HUD (screen-fixed): the local player's live state, or (spectate) the
    //    followed bot's vitals plus the real FFA scoreboard and kill feed.
    let hudState: HudState;
    if (spectate) {
      const followed = director.followed;
      const fs = game.world.sprites[followed];
      hudState = {
        health: fs?.health ?? 0,
        maxHealth: START_HEALTH,
        jet: fs?.jetsCount ?? 0,
        // The match's ACTUAL tank size — variants shrink it (e.g. thin-air).
        maxJet: game.tuning.jetFuelMax,
        ammo: game.ammoOf(followed),
        // The weapon line doubles as the "now watching" label (mixed matches
        // tag the followed bot with its engine).
        weaponName:
          `${nameOf(followed)}` +
          (game.engineGroups().length > 1
            ? ` [${(game.engineOf(followed)[0] ?? '?').toUpperCase()}]`
            : '') +
          ` · ${game.reloadingOf(followed) ? 'RELOADING…' : game.weaponNameOf(followed)}`,
        // Mixed match: the scoreboard becomes ENGINE vs ENGINE — the live
        // answer to "which brain wins" in one shared arena.
        scores: engineScores(game, board, followed) ?? ffaScores(board.kills, followed),
        killFeed: board.feed,
        fps: dt > 0 ? 1 / dt : 0,
      };
    } else {
      hudState = {
        health: player.health,
        maxHealth: START_HEALTH,
        // Live fuel (jetsCount is what applyJetpack burns and regen refills;
        // jetsCountReal is an unused Pascal mirror that never decrements).
        jet: player.jetsCount,
        maxJet: game.tuning.jetFuelMax,
        ammo: game.playerAmmo(),
        // Current weapon (Tab/B swaps AK74 ⇄ SPAS12) — labels match the feed.
        weaponName: game.playerReloading()
          ? 'RELOADING…'
          : game.weaponNameOf(game.playerIndex),
        scores: { alpha: 0, bravo: 0, playerKills: 0, leading: false, gap: 0 },
        killFeed: [],
        fps: dt > 0 ? 1 / dt : 0,
      };
    }
    hud.update(hudState);
    // Leaderboard refresh (cheap, but no need for 120 Hz DOM writes).
    if (leaderboard !== null && game.world.mainTickCounter % 30 === 0) {
      leaderboard.update(leaderboardRows());
      infoCard?.setFollowing(
        nameOf(director.followed),
        game.teamOf(director.followed),
        game.engineOf(director.followed),
      );
      teamPanel?.update(leaderboardRows());
    }

    if (app !== undefined) {
      requestAnimationFrame(frame);
    }
  };
  requestAnimationFrame(frame);
}

// Booting needs a browser; under unit tests (vitest, node environment) this
// module is imported only for its pure exports (parseSpectate/parseDuel).
if (typeof document !== 'undefined') {
  void main();
}
