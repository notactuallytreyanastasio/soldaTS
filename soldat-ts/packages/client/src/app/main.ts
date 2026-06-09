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
import { START_HEALTH } from '../ui/helpers';
import { Crosshair } from '../render/fx';
import { Game } from './game';
import { buildArena, ARENA_SPAWNS } from './arena';
import { fetchAndLoadMap, pickMapUrl } from './loadMap';

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
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mount = document.getElementById('app');
  if (mount === null) {
    throw new Error('#app element not found');
  }

  const renderer = new MapRenderer({ container: mount });
  await renderer.init();

  // --- Real .PMS loading, with synthetic fallback -----------------------
  // Try to fetch a real map from /maps/ (URL chosen via ?map=); on any failure
  // (offline, missing asset, parse error) fall back to the synthetic scene.
  const mapUrl = pickMapUrl();
  let map: PmsMap;
  let spawns: readonly { x: number; y: number }[];
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
  // ----------------------------------------------------------------------

  // Draw the static map geometry.
  const mesh = buildMapMesh(map);
  renderer.setMap(mesh);

  // --- Game: sim world + local player + bots ---------------------------
  // A fixed seed keeps the run deterministic across reloads (handy in dev).
  const game = new Game({ seed: 1, spawns, botCount: 3 });
  // Attach the sim collision map so sprites collide with the floor.
  game.loadMap(map);

  // --- Entity renderer: lives inside the camera/world container --------
  // Adding to renderer.world means entity graphics share the map's pan/zoom
  // transform, so world coordinates line up with the map mesh.
  const entityRenderer = new EntityRenderer();
  entityRenderer.playerIndex = game.playerIndex;
  renderer.world.addChild(entityRenderer.container);

  // Crosshair at the aim point (in the world container, follows the camera).
  const crosshair = new Crosshair();
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
  centerCameraOnPlayer();

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
    const control = input.readControl(playerScreenX, playerScreenY);

    // 2. Apply control to the player sprite (the sim reads it during stepWorld).
    player.control = control;

    // Crosshair at the aim point (world coords = COM + relative aim vector).
    crosshair.moveTo(px + control.mouseAimX, py + control.mouseAimY);

    // 3. Advance the simulation by real elapsed time (fixed-step internally).
    game.tick(dt);

    // 4. Render entities, interpolated between ticks by the leftover fraction.
    entityRenderer.render(game.world, game.framePercent);

    // 5. Camera follows the player.
    centerCameraOnPlayer();

    // 6. HUD reflects the local player's live state (screen-fixed).
    const hudState: HudState = {
      health: player.health,
      maxHealth: START_HEALTH,
      jet: player.jetsCountReal,
      maxJet: 100,
      ammo: game.playerAmmo(),
      weaponName: game.playerReloading() ? 'RELOADING…' : 'RIFLE',
      scores: { alpha: 0, bravo: 0, playerKills: 0, leading: false, gap: 0 },
      killFeed: [],
      fps: dt > 0 ? 1 / dt : 0,
    };
    hud.update(hudState);

    if (app !== undefined) {
      requestAnimationFrame(frame);
    }
  };
  requestAnimationFrame(frame);
}

void main();
