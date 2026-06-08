// MapRenderer — PixiJS v8 browser glue that draws a triangulated map mesh.
//
// GLUE module: this is the only place pixi.js is touched for map drawing. It
// consumes the Track-C MapMesh contract (positions / colors / uvs / indices)
// and builds a real pixi Geometry + Mesh with a custom per-vertex-color shader,
// then exposes a simple camera (pan / zoom via the stage transform) and a
// resize handler.
//
// Faithful note: OpenSoldat renders the map by filling a vertex buffer of
// per-vertex-coloured triangles and drawing them with the world/projection
// transform (client/GameRendering.pas / MapGraphics.pas). We mirror that here:
// one Mesh, vertex colours straight from the PMS polygons, camera applied as
// the container transform.

import {
  Application,
  Container,
  Geometry,
  GlProgram,
  GpuProgram,
  Mesh,
  Shader,
} from 'pixi.js';
import type { MapMesh } from './mapMesh';

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------
//
// The custom shader mirrors pixi's own default mesh shader so the engine binds
// the global uniforms (projection / world transform) at group(100) and the
// local uniforms (transform / colour / round) at group(101) automatically — see
// GlMeshAdaptor / GpuMeshAdaptor in pixi v8. We add a single extra vertex
// attribute, `aColor`, carrying the per-vertex RGBA from the PMS polygons.

const VERTEX_GLSL = /* glsl */ `
  in vec2 aPosition;
  in vec2 aUV;
  in vec4 aColor;

  out vec4 vColor;
  out vec2 vUV;

  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform vec4 uWorldColorAlpha;

  uniform mat3 uTransformMatrix;
  uniform vec4 uColor;

  void main(void) {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
    vColor = aColor * uColor * uWorldColorAlpha;
  }
`;

const FRAGMENT_GLSL = /* glsl */ `
  in vec4 vColor;
  in vec2 vUV;

  out vec4 finalColor;

  void main(void) {
    finalColor = vColor;
  }
`;

const VERTEX_WGSL = /* wgsl */ `
  struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
  }

  struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
  }

  @group(100) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
  @group(101) @binding(0) var<uniform> localUniforms: LocalUniforms;

  struct VSInput {
    @location(0) aPosition: vec2<f32>,
    @location(1) aUV: vec2<f32>,
    @location(2) aColor: vec4<f32>,
  }

  struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vUV: vec2<f32>,
    @location(1) vColor: vec4<f32>,
  }

  @vertex
  fn main(input: VSInput) -> VSOutput {
    var out: VSOutput;
    let mvp = globalUniforms.uProjectionMatrix
      * globalUniforms.uWorldTransformMatrix
      * localUniforms.uTransformMatrix;
    out.position = vec4<f32>((mvp * vec3<f32>(input.aPosition, 1.0)).xy, 0.0, 1.0);
    out.vUV = input.aUV;
    out.vColor = input.aColor * localUniforms.uColor * globalUniforms.uWorldColorAlpha;
    return out;
  }
`;

const FRAGMENT_WGSL = /* wgsl */ `
  struct FSInput {
    @location(0) vUV: vec2<f32>,
    @location(1) vColor: vec4<f32>,
  }

  @fragment
  fn main(input: FSInput) -> @location(0) vec4<f32> {
    return input.vColor;
  }
`;

/** Build the dual (WebGL + WebGPU) shader used for map triangles. */
function createMapShader(): Shader {
  const glProgram = GlProgram.from({
    name: 'soldat-map',
    vertex: VERTEX_GLSL,
    fragment: FRAGMENT_GLSL,
  });

  const gpuProgram = GpuProgram.from({
    name: 'soldat-map',
    vertex: { source: VERTEX_WGSL, entryPoint: 'main' },
    fragment: { source: FRAGMENT_WGSL, entryPoint: 'main' },
  });

  return new Shader({ glProgram, gpuProgram });
}

/**
 * Build a pixi Geometry from a Track-C {@link MapMesh}. positions/uvs are 2
 * floats per vertex, colors 4 floats per vertex, indices a flat Uint32 list.
 */
function createMapGeometry(mesh: MapMesh): Geometry {
  return new Geometry({
    attributes: {
      aPosition: { buffer: mesh.positions, format: 'float32x2' },
      aUV: { buffer: mesh.uvs, format: 'float32x2' },
      aColor: { buffer: mesh.colors, format: 'float32x4' },
    },
    indexBuffer: mesh.indices,
    topology: 'triangle-list',
  });
}

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

/**
 * Owns a pixi Application, a world {@link Container} (the camera), and the map
 * {@link Mesh}. Call {@link MapRenderer.init} (async) before {@link setMap}.
 */
export class MapRenderer {
  /** The pixi application; undefined until {@link init} resolves. */
  app: Application | undefined;

  /** World container — its transform IS the camera. */
  readonly world: Container = new Container();

  /** Current camera. Mutate via {@link panBy} / {@link zoomAt} then redraw. */
  readonly camera: Camera = { x: 0, y: 0, zoom: 1 };

  private readonly options: MapRendererOptions;
  private shader: Shader | undefined;
  private mesh: Mesh<Geometry, Shader> | undefined;

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
    this.shader = createMapShader();
    this.app = app;
    this.applyCamera();
  }

  /**
   * Replace the drawn map. Builds geometry from the {@link MapMesh} and adds a
   * single {@link Mesh} to the world container.
   */
  setMap(mesh: MapMesh): void {
    if (this.shader === undefined) {
      throw new Error('MapRenderer.setMap called before init()');
    }
    if (this.mesh !== undefined) {
      this.world.removeChild(this.mesh);
      this.mesh.destroy();
      this.mesh = undefined;
    }
    const geometry = createMapGeometry(mesh);
    const drawn = new Mesh<Geometry, Shader>({
      geometry,
      shader: this.shader,
    });
    this.mesh = drawn;
    this.world.addChild(drawn);
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
    // World point under the cursor before zoom must stay under it after.
    const worldX = (screenX - this.camera.x) / prevZoom;
    const worldY = (screenY - this.camera.y) / prevZoom;
    this.camera.zoom = nextZoom;
    this.camera.x = screenX - worldX * nextZoom;
    this.camera.y = screenY - worldY * nextZoom;
    this.applyCamera();
  }

  /** Push the current camera state onto the world container transform. */
  private applyCamera(): void {
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
    this.mesh?.destroy();
    this.shader?.destroy(true);
    this.app?.destroy(true, { children: true });
    this.mesh = undefined;
    this.shader = undefined;
    this.app = undefined;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
