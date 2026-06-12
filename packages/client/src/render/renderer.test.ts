// MapRenderer — triangle fill (colour averaging + packing), camera math, and
// lifecycle, exercised against hand-rolled pixi.js stubs (the node test
// environment has no WebGL/WebGPU; Application.init is a recording fake).

import { describe, expect, it, vi } from 'vitest';

vi.mock('pixi.js', () => {
  class FakePoint {
    x = 0;
    y = 0;
    setCalls = 0;
    set(x: number, y?: number): void {
      this.x = x;
      this.y = y ?? x;
      this.setCalls++;
    }
  }
  class Container {
    children: unknown[] = [];
    position = new FakePoint();
    scale = new FakePoint();
    addChild(c: unknown): unknown {
      this.children.push(c);
      return c;
    }
    addChildAt(c: unknown, i: number): unknown {
      this.children.splice(i, 0, c);
      return c;
    }
    removeChild(c: unknown): void {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
    }
  }
  class Graphics extends Container {
    calls: Array<{ method: string; args: unknown[] }> = [];
    destroyed = false;
    poly(points: unknown): this {
      this.calls.push({ method: 'poly', args: [points] });
      return this;
    }
    fill(style: unknown): this {
      this.calls.push({ method: 'fill', args: [style] });
      return this;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  class Application {
    static instances: Application[] = [];
    canvas = { __canvas: true };
    stage = new Container();
    renderer = {
      resizeCalls: [] as Array<[number, number]>,
      resize(w: number, h: number): void {
        this.resizeCalls.push([w, h]);
      },
    };
    initOpts: unknown;
    destroyArgs: unknown[] | undefined;
    constructor() {
      Application.instances.push(this);
    }
    async init(opts: unknown): Promise<void> {
      this.initOpts = opts;
    }
    destroy(...args: unknown[]): void {
      this.destroyArgs = args;
    }
  }
  return { Application, Container, Graphics };
});

import { MapRenderer } from './renderer';
import type { MapMesh } from './mapMesh';

interface RecGfx {
  calls: Array<{ method: string; args: unknown[] }>;
  destroyed: boolean;
}
interface FakeApp {
  canvas: unknown;
  stage: { children: unknown[] };
  renderer: { resizeCalls: Array<[number, number]> };
  initOpts: Record<string, unknown>;
  destroyArgs: unknown[] | undefined;
}

function makeRenderer(over: Record<string, unknown> = {}): {
  r: MapRenderer;
  parent: { appended: unknown[] };
} {
  const parent = {
    appended: [] as unknown[],
    appendChild(c: unknown): void {
      this.appended.push(c);
    },
  };
  const r = new MapRenderer({
    container: parent as unknown as HTMLElement,
    ...over,
  });
  return { r, parent };
}

function mapGfx(r: MapRenderer): RecGfx {
  const g = (r as unknown as { mapGfx: RecGfx | undefined }).mapGfx;
  expect(g).toBeDefined();
  return g as RecGfx;
}

function makeMesh(positions: number[], colors: number[], indices: number[]): MapMesh {
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    uvs: new Float32Array(positions.length),
    indices: new Uint32Array(indices),
    polygonCount: Math.floor(indices.length / 3),
  };
}

// ---------------------------------------------------------------------------
// setMap — triangle iteration and colour averaging
// ---------------------------------------------------------------------------

describe('setMap', () => {
  it('fills one polygon per complete triangle with the vertex positions', () => {
    const { r } = makeRenderer();
    const mesh = makeMesh(
      [0, 0, 10, 0, 0, 10],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [0, 1, 2],
    );
    r.setMap(mesh);
    const g = mapGfx(r);
    const polys = g.calls.filter((c) => c.method === 'poly');
    expect(polys.length).toBe(1);
    expect(polys[0]?.args[0]).toEqual([0, 0, 10, 0, 0, 10]);
    const fill = g.calls.find((c) => c.method === 'fill');
    expect(fill?.args[0]).toEqual({ color: 0xffffff, alpha: 1 });
  });

  it('skips a trailing incomplete triangle (loop guard t + 2 < length)', () => {
    const { r } = makeRenderer();
    const mesh = makeMesh(
      [0, 0, 10, 0, 0, 10, 10, 10],
      new Array<number>(16).fill(1),
      [0, 1, 2, 3], // one full triangle + a single dangling index
    );
    r.setMap(mesh);
    expect(mapGfx(r).calls.filter((c) => c.method === 'poly').length).toBe(1);
  });

  it('draws nothing for fewer than three indices', () => {
    const { r } = makeRenderer();
    r.setMap(makeMesh([0, 0, 1, 1], [1, 1, 1, 1, 1, 1, 1, 1], [0, 1]));
    expect(mapGfx(r).calls.length).toBe(0);
  });

  it('averages the three vertex colours into one flat fill', () => {
    const { r } = makeRenderer();
    // r: 0, 0.5, 1 → 0.5; g: 1, 1, 1 → 1; b: 0, 0, 0 → 0; a: 1, 0.5, 0 → 0.5.
    const mesh = makeMesh(
      [0, 0, 10, 0, 0, 10],
      [0, 1, 0, 1, 0.5, 1, 0, 0.5, 1, 1, 0, 0],
      [0, 1, 2],
    );
    r.setMap(mesh);
    const fill = mapGfx(r).calls.find((c) => c.method === 'fill');
    const { color, alpha } = fill?.args[0] as { color: number; alpha: number };
    expect(color).toBe((128 << 16) | (255 << 8) | 0); // round(0.5*255) = 128
    expect(alpha).toBeCloseTo(0.5, 6);
  });

  it('packs and clamps out-of-range colour floats into 0xRRGGBB', () => {
    const { r } = makeRenderer();
    // r avg = 2 → clamps to 255; g avg = -1 → clamps to 0; b avg = 0.
    const mesh = makeMesh(
      [0, 0, 10, 0, 0, 10],
      [2, -1, 0, 1, 2, -1, 0, 1, 2, -1, 0, 1],
      [0, 1, 2],
    );
    r.setMap(mesh);
    const fill = mapGfx(r).calls.find((c) => c.method === 'fill');
    expect((fill?.args[0] as { color: number }).color).toBe(0xff0000);
  });

  it('renders fully transparent black for explicit (0,0,0,0) vertices', () => {
    const { r } = makeRenderer();
    const mesh = makeMesh(
      [0, 0, 10, 0, 0, 10],
      new Array<number>(12).fill(0),
      [0, 1, 2],
    );
    r.setMap(mesh);
    const fill = mapGfx(r).calls.find((c) => c.method === 'fill');
    expect(fill?.args[0]).toEqual({ color: 0x000000, alpha: 0 });
  });

  it('MISSING colour data defaults to opaque white (suspect: masks bad loads)', () => {
    // SUSPECT (review finding): every absent component defaults to 1.0, so a
    // colour buffer that failed to populate renders as solid opaque white
    // instead of failing loudly / rendering transparent. Pinned as-is.
    const { r } = makeRenderer();
    const mesh = makeMesh([0, 0, 10, 0, 0, 10], [], [0, 1, 2]);
    r.setMap(mesh);
    const fill = mapGfx(r).calls.find((c) => c.method === 'fill');
    expect(fill?.args[0]).toEqual({ color: 0xffffff, alpha: 1 });
  });

  it('inserts the map beneath existing world children (index 0)', () => {
    const { r } = makeRenderer();
    const entities = { __entities: true } as unknown as Parameters<typeof r.world.addChild>[0];
    r.world.addChild(entities);
    r.setMap(makeMesh([0, 0, 1, 0, 0, 1], new Array<number>(12).fill(1), [0, 1, 2]));
    expect(r.world.children[0]).toBe(mapGfx(r));
    expect(r.world.children[1]).toBe(entities);
  });

  it('replacing the map destroys and unparents the previous Graphics', () => {
    const { r } = makeRenderer();
    const mesh = makeMesh([0, 0, 1, 0, 0, 1], new Array<number>(12).fill(1), [0, 1, 2]);
    r.setMap(mesh);
    const first = mapGfx(r);
    r.setMap(mesh);
    const second = mapGfx(r);
    expect(second).not.toBe(first);
    expect(first.destroyed).toBe(true);
    expect(r.world.children).toContain(second);
    expect(r.world.children).not.toContain(first);
  });
});

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

describe('camera', () => {
  it('starts at the identity transform', () => {
    const { r } = makeRenderer();
    expect(r.camera).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('panBy accumulates screen deltas and pushes them to the world transform', () => {
    const { r } = makeRenderer();
    r.panBy(10, -5);
    r.panBy(2, 3);
    expect(r.camera.x).toBe(12);
    expect(r.camera.y).toBe(-2);
    expect(r.world.position.x).toBe(12);
    expect(r.world.position.y).toBe(-2);
    expect(r.world.scale.x).toBe(1);
  });

  it('zoomAt keeps the screen point stationary under the pointer', () => {
    const { r } = makeRenderer();
    const screenX = 100;
    const screenY = 50;
    // The world point under the pointer before zooming…
    const beforeX = (screenX - r.camera.x) / r.camera.zoom;
    const beforeY = (screenY - r.camera.y) / r.camera.zoom;
    r.zoomAt(2, screenX, screenY);
    // …must project back to the same screen point after.
    expect(beforeX * r.camera.zoom + r.camera.x).toBeCloseTo(screenX, 6);
    expect(beforeY * r.camera.zoom + r.camera.y).toBeCloseTo(screenY, 6);
    expect(r.camera.zoom).toBe(2);
    expect(r.camera.x).toBe(-100);
    expect(r.camera.y).toBe(-50);
  });

  it('zoomAt composes with an existing pan and zoom', () => {
    const { r } = makeRenderer();
    r.panBy(40, 20);
    r.zoomAt(2, 100, 50);
    const worldX = (100 - 40) / 1;
    const worldY = (50 - 20) / 1;
    expect(worldX * r.camera.zoom + r.camera.x).toBeCloseTo(100, 6);
    expect(worldY * r.camera.zoom + r.camera.y).toBeCloseTo(50, 6);
  });

  it('clamps the zoom to [0.05, 50]', () => {
    const { r } = makeRenderer();
    r.zoomAt(1e9, 0, 0);
    expect(r.camera.zoom).toBe(50);
    r.zoomAt(1e-12, 0, 0);
    expect(r.camera.zoom).toBe(0.05);
  });

  it('returns early (no transform churn) when the clamped zoom is unchanged', () => {
    const { r } = makeRenderer();
    r.zoomAt(1e9, 0, 0); // pinned at the 50 cap
    const setsBefore = (r.world.position as unknown as { setCalls: number }).setCalls;
    const camX = r.camera.x;
    r.zoomAt(2, 123, 456); // still clamped to 50 → no-op
    expect(r.camera.zoom).toBe(50);
    expect(r.camera.x).toBe(camX);
    expect((r.world.position as unknown as { setCalls: number }).setCalls).toBe(setsBefore);
  });

  it('zoomAt with factor 1 is a no-op', () => {
    const { r } = makeRenderer();
    r.panBy(7, 9);
    r.zoomAt(1, 300, 300);
    expect(r.camera).toEqual({ x: 7, y: 9, zoom: 1 });
  });

  it('applyCamera mirrors the camera into world position and scale', () => {
    const { r } = makeRenderer();
    r.camera.x = -33;
    r.camera.y = 44;
    r.camera.zoom = 2.5;
    r.applyCamera();
    expect(r.world.position.x).toBe(-33);
    expect(r.world.position.y).toBe(44);
    expect(r.world.scale.x).toBe(2.5);
    expect(r.world.scale.y).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('init creates the Application, mounts the canvas, and stages the world', async () => {
    const { r, parent } = makeRenderer();
    await r.init();
    expect(r.app).toBeDefined();
    const app = r.app as unknown as FakeApp;
    expect(parent.appended).toContain(app.canvas);
    expect(app.stage.children).toContain(r.world);
    expect(app.initOpts['background']).toBe(0x101418); // default
    expect(app.initOpts['antialias']).toBe(true);
    expect('preference' in app.initOpts).toBe(false);
  });

  it('init honours an explicit background and renderer preference', async () => {
    const { r } = makeRenderer({ background: 0x123456, preference: 'webgl' });
    await r.init();
    const app = r.app as unknown as FakeApp;
    expect(app.initOpts['background']).toBe(0x123456);
    expect(app.initOpts['preference']).toBe('webgl');
  });

  it('resize forwards to the pixi renderer, and is safe before init', async () => {
    const { r } = makeRenderer();
    expect(() => r.resize(800, 600)).not.toThrow(); // no app yet
    await r.init();
    r.resize(800, 600);
    r.resize(1024, 768);
    const app = r.app as unknown as FakeApp;
    expect(app.renderer.resizeCalls).toEqual([
      [800, 600],
      [1024, 768],
    ]);
  });

  it('destroy tears down the app and map graphics and clears references', async () => {
    const { r } = makeRenderer();
    await r.init();
    r.setMap(makeMesh([0, 0, 1, 0, 0, 1], new Array<number>(12).fill(1), [0, 1, 2]));
    const gfx = mapGfx(r);
    const app = r.app as unknown as FakeApp;
    r.destroy();
    expect(gfx.destroyed).toBe(true);
    expect(app.destroyArgs).toEqual([true, { children: true }]);
    expect(r.app).toBeUndefined();
    expect((r as unknown as { mapGfx: unknown }).mapGfx).toBeUndefined();
  });

  it('destroy before init is a no-op', () => {
    const { r } = makeRenderer();
    expect(() => r.destroy()).not.toThrow();
  });
});
