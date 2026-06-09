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
import { Hud, type HudState } from '../ui/hud';
import { shouldShowControls, showControlsScreen } from '../ui/controlsScreen';
import { START_HEALTH } from '../ui/helpers';
import { Crosshair } from '../render/fx';
import { buildTexturedMap } from '../render/mapTextured';
import { AudioEngine } from '../audio/audio';
import { SoundManager } from '../audio/soundManager';
import { Game, JET_FUEL_MAX } from './game';
import { buildArena, ARENA_SPAWNS } from './arena';
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
export function parseSpectate(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): { spectate: boolean; botCount: number; aiEngine: string | undefined } {
  const params = new URLSearchParams(search);
  const aiEngine = params.get('ai') ?? undefined;
  if (params.has(PLAY_QUERY_PARAM)) {
    return { spectate: false, botCount: 3, aiEngine };
  }
  const n = parseInt(params.get(SPECTATE_QUERY_PARAM) ?? '', 10);
  const botCount =
    Number.isFinite(n) && n >= 2 ? Math.min(n, SPECTATE_MAX_BOTS) : SPECTATE_DEFAULT_BOTS;
  return { spectate: true, botCount, aiEngine };
}

/**
 * Duel mode (?duel or ?duel=classic,pilot): TWO simultaneous bot matches side
 * by side, one per AI engine, each a fully independent game in its own
 * iframe (own renderer, own sim, own telemetry). The cheapest possible "turn
 * on 2 games at once and watch each of them play" — and honest isolation:
 * neither match can perturb the other.
 */
export function parseDuel(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): [string, string] | null {
  const params = new URLSearchParams(search);
  if (!params.has('duel')) return null;
  const raw = params.get('duel') ?? '';
  const [a, b] = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return [a ?? 'classic', b ?? 'pilot'];
}

/** Build the duel split view: two labelled iframes, each a spectate match. */
function showDuel(engines: [string, string]): void {
  document.body.style.cssText = 'margin:0;background:#0a0c10';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;width:100vw;height:100vh;gap:2px';
  for (const engine of engines) {
    const col = document.createElement('div');
    col.style.cssText =
      'flex:1;display:flex;flex-direction:column;min-width:0;position:relative';
    const label = document.createElement('div');
    label.textContent = `ENGINE: ${engine.toUpperCase()}`;
    label.style.cssText = [
      'position:absolute',
      'top:8px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:10',
      'color:#fff',
      'font:bold 14px ui-monospace,monospace',
      'letter-spacing:0.2em',
      'background:rgba(10,12,16,0.6)',
      'padding:4px 12px',
      'border-radius:4px',
      'pointer-events:none',
    ].join(';');
    const frame = document.createElement('iframe');
    frame.src = `${window.location.pathname}?spectate&ai=${encodeURIComponent(engine)}`;
    frame.style.cssText = 'flex:1;border:0;width:100%;height:100%';
    col.append(label, frame);
    row.appendChild(col);
  }
  document.body.appendChild(row);
}

/** Fixed bottom-left hint so a spectator knows the camera keys. */
function showSpectateHint(engineLabel: string): void {
  const hint = document.createElement('div');
  hint.textContent = `SPECTATE [${engineLabel}] — ←/→ follow · A auto · ?play to fight · ?duel to race engines`;
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
  const { spectate, botCount, aiEngine } = parseSpectate();
  const explicitMap = new URLSearchParams(window.location.search).has('map');
  let map: PmsMap;
  let spawns: readonly { x: number; y: number }[];
  if (spectate && !explicitMap) {
    map = buildArena();
    spawns = ARENA_SPAWNS;
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
  const game = new Game({ seed: 1, spawns, botCount, spectate, aiEngine });
  // Attach the sim collision map so sprites collide with the floor (and, in
  // spectate mode, the map's bot waypoints so targetless bots patrol).
  game.loadMap(map);

  // --- Spectate director + scoreboard ------------------------------------
  // The director picks which bot the action camera follows; the kill board
  // (tally + feed) is fed by Game.onKill in BOTH modes (pure display data),
  // though the normal-mode HUD currently keeps its placeholder scores.
  const director = new Director(game.botIndices()[0] ?? game.playerIndex);
  const board: KillBoard = { kills: new Map(), feed: [] };
  const nameOf = (i: number): string => subjectName(i, game.playerIndex);

  // --- Match telemetry (spectate only) ------------------------------------
  // Records samples/shots/hits/kills under a versioned JSON schema so agents
  // and tooling can analyze the gameplay math (hit rates, flight patterns,
  // death clusters). Pull via window.__match.dump() (CDP-friendly), save with
  // the T key, analyze with soldat-ts/tools/analyze-match.mjs.
  const recorder = spectate
    ? new MatchRecorder(game, map.mapName, botCount, spectate)
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

  game.onKill = (killer, victim): void => {
    recorder?.recordKill(killer, victim);
    applyKill(
      board,
      killer,
      victim,
      nameOf,
      spectate ? director.followed : game.playerIndex,
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
  game.onSound = (event, x, y): void => {
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
    showSpectateHint(game.aiEngineId);
  }

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
      }
    });
  }

  if (!spectate) {
    centerCameraOnPlayer();
  } else {
    spectateCamera(0);
  }

  // --- Wheel-zoom centred on the cursor (kept from the map viewer) ------
  canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
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

    // 4. Render entities, interpolated between ticks by the leftover fraction.
    entityRenderer.render(game.world, game.framePercent);

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
        maxJet: JET_FUEL_MAX,
        ammo: game.ammoOf(followed),
        // The weapon line doubles as the "now watching" label.
        weaponName: `${nameOf(followed)} · ${game.reloadingOf(followed) ? 'RELOADING…' : 'RIFLE'}`,
        scores: ffaScores(board.kills, followed),
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
        maxJet: JET_FUEL_MAX,
        ammo: game.playerAmmo(),
        weaponName: game.playerReloading() ? 'RELOADING…' : 'RIFLE',
        scores: { alpha: 0, bravo: 0, playerKills: 0, leading: false, gap: 0 },
        killFeed: [],
        fps: dt > 0 ? 1 / dt : 0,
      };
    }
    hud.update(hudState);

    if (app !== undefined) {
      requestAnimationFrame(frame);
    }
  };
  requestAnimationFrame(frame);
}

void main();
