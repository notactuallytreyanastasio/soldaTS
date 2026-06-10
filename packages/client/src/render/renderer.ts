// MapRenderer — PixiJS v8 browser glue that draws the map.
//
// GLUE module: the only place pixi.js is touched for map drawing. It consumes
// the Track-C MapMesh contract (positions / colors / uvs / indices) and draws
// each triangle as a filled pixi Graphics polygon, then exposes a simple camera
// (pan / zoom via the world container transform) and a resize handler.
//
// Faithful note: OpenSoldat fills a vertex buffer of per-vertex-coloured
// triangles and draws them with the world/projection transform
// (client/GameRendering.pas / MapGraphics.pas). We mirror the geometry; each
// triangle is filled with the average of its three vertex colours (pixi
// Graphics has no per-vertex gradient — a solid fill is robust and reads fine
// for gameplay; a per-vertex-colour Mesh shader can replace this later).

import { Application, Container, Graphics } from 'pixi.js';
import type { MapMesh } from './mapMesh';

/** Options for constructing a {@link MapRenderer}. */
export interface MapRendererOptions {
  /** Parent DOM element the canvas is mounted into. */
  readonly container: HTMLElement;
  /** Initial background colour (top of the sky), 0xRRGGBB. Default dark grey. */
  readonly background?: number;
  /** Renderer preference; defaults to WebGL→WebGPU auto-detect. */
  readonly preference?: 'webgl' | 'webgpu';
}

/** Simple 2D camera state applied to the world container. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/** Pack three 0..1 colour floats into a 0xRRGGBB integer. */
function rgb(r: number, g: number, b: number): number {
  const ri = Math.max(0, Math.min(255, Math.round(r * 255)));
  const gi = Math.max(0, Math.min(255, Math.round(g * 255)));
  const bi = Math.max(0, Math.min(255, Math.round(b * 255)));
  return (ri << 16) | (gi << 8) | bi;
}

/**
 * Owns a pixi Application, a world {@link Container} (the camera), and the map
 * {@link Graphics}. Call {@link MapRenderer.init} (async) before {@link setMap}.
 */
export class MapRenderer {
  /** The pixi application; undefined until {@link init} resolves. */
  app: Application | undefined;

  /** World container — its transform IS the camera. */
  readonly world: Container = new Container();

  /** Current camera. Mutate via {@link panBy} / {@link zoomAt} then redraw. */
  readonly camera: Camera = { x: 0, y: 0, zoom: 1 };

  private readonly options: MapRendererOptions;
  private mapGfx: Graphics | undefined;

  constructor(options: MapRendererOptions) {
    this.options = options;
  }

  /** Create the pixi Application and mount its canvas. WebGL/WebGPU auto. */
  async init(): Promise<void> {
    const app = new Application();
    await app.init({
      background: this.options.background ?? 0x101418,
      antialias: true,
      resizeTo: this.options.container,
      ...(this.options.preference !== undefined
        ? { preference: this.options.preference }
        : {}),
    });
    this.options.container.appendChild(app.canvas);
    app.stage.addChild(this.world);
    this.app = app;
    this.applyCamera();
  }

  /**
   * Replace the drawn map. Fills each triangle of the {@link MapMesh} with the
   * average of its three vertex colours into a single Graphics.
   */
  setMap(mesh: MapMesh): void {
    if (this.mapGfx !== undefined) {
      this.world.removeChild(this.mapGfx);
      this.mapGfx.destroy();
      this.mapGfx = undefined;
    }
    const g = new Graphics();
    const { positions, colors, indices } = mesh;
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = indices[t] ?? 0;
      const b = indices[t + 1] ?? 0;
      const c = indices[t + 2] ?? 0;
      const ax = positions[a * 2] ?? 0;
      const ay = positions[a * 2 + 1] ?? 0;
      const bx = positions[b * 2] ?? 0;
      const by = positions[b * 2 + 1] ?? 0;
      const cx = positions[c * 2] ?? 0;
      const cy = positions[c * 2 + 1] ?? 0;
      // Average the three vertex colours (rgba, 0..1).
      const r = ((colors[a * 4] ?? 1) + (colors[b * 4] ?? 1) + (colors[c * 4] ?? 1)) / 3;
      const gr = ((colors[a * 4 + 1] ?? 1) + (colors[b * 4 + 1] ?? 1) + (colors[c * 4 + 1] ?? 1)) / 3;
      const bl = ((colors[a * 4 + 2] ?? 1) + (colors[b * 4 + 2] ?? 1) + (colors[c * 4 + 2] ?? 1)) / 3;
      const al = ((colors[a * 4 + 3] ?? 1) + (colors[b * 4 + 3] ?? 1) + (colors[c * 4 + 3] ?? 1)) / 3;
      g.poly([ax, ay, bx, by, cx, cy]).fill({ color: rgb(r, gr, bl), alpha: al });
    }
    this.mapGfx = g;
    // Draw the map beneath everything else added to the world container.
    this.world.addChildAt(g, 0);
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  /** Pan the camera by a screen-space delta (pixels). */
  panBy(dxScreen: number, dyScreen: number): void {
    this.camera.x += dxScreen;
    this.camera.y += dyScreen;
    this.applyCamera();
  }

  /**
   * Zoom centred on a screen-space point (e.g. the cursor), keeping that point
   * stationary under the pointer — the standard wheel-zoom feel.
   */
  zoomAt(factor: number, screenX: number, screenY: number): void {
    const prevZoom = this.camera.zoom;
    const nextZoom = clamp(prevZoom * factor, 0.05, 50);
    if (nextZoom === prevZoom) return;
    const worldX = (screenX - this.camera.x) / prevZoom;
    const worldY = (screenY - this.camera.y) / prevZoom;
    this.camera.zoom = nextZoom;
    this.camera.x = screenX - worldX * nextZoom;
    this.camera.y = screenY - worldY * nextZoom;
    this.applyCamera();
  }

  /** Push the current camera onto the world container transform. */
  applyCamera(): void {
    this.world.position.set(this.camera.x, this.camera.y);
    this.world.scale.set(this.camera.zoom);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Resize the renderer to a width/height (CSS pixels). */
  resize(width: number, height: number): void {
    this.app?.renderer.resize(width, height);
  }

  /** Tear down pixi resources. */
  destroy(): void {
    this.mapGfx?.destroy();
    this.app?.destroy(true, { children: true });
    this.mapGfx = undefined;
    this.app = undefined;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
