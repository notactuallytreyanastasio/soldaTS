// Browser entry point: mount the pixi app, load a real .PMS map (falling back
// to a synthetic one when no asset is available), render it, and wire
// drag-to-pan / wheel-zoom.
//
// Real maps: drop Soldat .PMS files into packages/client/public/maps/ — the dev
// server serves them at /maps/<name>.pms. Choose one with the ?map= query param
// (e.g. ?map=ctf_Ash → /maps/ctf_Ash.pms). These files are NOT committed; supply
// your own per the asset-licensing decision (see public/maps/README.md).
// When the fetch fails (offline / no asset present) we fall back to the
// hand-built synthetic scene below so dev still works.

import { PolyType, type MapPolygon, type MapVertex, type PmsMap } from '@soldat/assets';
import { buildMapMesh } from '../render/mapMesh';
import { MapRenderer } from '../render/renderer';
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
  try {
    map = await fetchAndLoadMap(mapUrl);
    // eslint-disable-next-line no-console
    console.info(`loaded map '${map.mapName}' from ${mapUrl}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `could not load '${mapUrl}', using synthetic map instead:`,
      err instanceof Error ? err.message : err,
    );
    map = buildSyntheticMap();
  }
  // ----------------------------------------------------------------------
  const mesh = buildMapMesh(map);
  renderer.setMap(mesh);

  // Centre the camera on the canvas.
  const app = renderer.app;
  if (app !== undefined) {
    renderer.panBy(app.renderer.width / 2, app.renderer.height / 2);
  }

  // --- Input: drag-to-pan -----------------------------------------------
  const canvas = renderer.app?.canvas;
  if (canvas !== undefined) {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (!dragging) return;
      renderer.panBy(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const endDrag = (e: PointerEvent): void => {
      dragging = false;
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    // --- Input: wheel-zoom centred on the cursor ------------------------
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
  }
}

void main();
