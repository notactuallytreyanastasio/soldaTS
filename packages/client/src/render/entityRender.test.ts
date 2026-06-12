// EntityRenderer — interpolation, FFA team assignment, weapon overlays, and
// bullet tracer styling, exercised with hand-rolled pixi.js stubs (no WebGL in
// the node test environment). The gostek modules are stubbed too so the tests
// can read the exact pose options each rendering path computes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BulletStyle,
  WeaponIndex,
  WeaponNum,
  type World,
} from '@soldat/sim';

// ---------------------------------------------------------------------------
// pixi.js stub — recording Graphics/Sprite/Container, controllable Assets
// ---------------------------------------------------------------------------

vi.mock('pixi.js', () => {
  class Container {
    children: unknown[] = [];
    visible = true;
    addChild(c: unknown): unknown {
      this.children.push(c);
      return c;
    }
  }
  class Graphics extends Container {
    calls: Array<{ method: string; args: unknown[] }> = [];
  }
  for (const m of [
    'clear',
    'moveTo',
    'lineTo',
    'stroke',
    'fill',
    'circle',
    'poly',
    'rect',
    'ellipse',
    'arc',
  ]) {
    (Graphics.prototype as unknown as Record<string, unknown>)[m] = function (
      this: Graphics,
      ...args: unknown[]
    ) {
      this.calls.push({ method: m, args });
      return this;
    };
  }
  class FakePoint {
    x = 0;
    y = 0;
    set(x: number, y?: number): void {
      this.x = x;
      this.y = y ?? x;
    }
  }
  class Sprite extends Container {
    texture: unknown;
    rotation = 0;
    anchor = new FakePoint();
    position = new FakePoint();
    scale = new FakePoint();
    constructor(texture?: unknown) {
      super();
      this.texture = texture;
    }
  }
  const Assets = {
    // Tests flip these to drive the SPAS texture load outcome.
    failNextLoad: true,
    loadResult: { __texture: true } as unknown,
    loaded: [] as string[],
    async load(url: string): Promise<unknown> {
      Assets.loaded.push(url);
      if (Assets.failNextLoad) throw new Error('no assets in node tests');
      return Assets.loadResult;
    },
  };
  return { Container, Graphics, Sprite, Assets, Texture: class {} };
});

// Vector gostek — record the pose options instead of drawing limbs.
vi.mock('./gostek', () => {
  const drawGostekCalls: unknown[] = [];
  return {
    drawGostekCalls,
    drawGostek: (_g: unknown, opts: unknown) => {
      drawGostekCalls.push(opts);
    },
  };
});

// Textured gostek — a pool of recording figures.
vi.mock('./gostekTextured', () => {
  class TexturedGostek {
    static instances: TexturedGostek[] = [];
    static async load(): Promise<void> {}
    view = { visible: false };
    updates: Array<Record<string, unknown>> = [];
    constructor() {
      TexturedGostek.instances.push(this);
    }
    async load(): Promise<void> {}
    update(opts: Record<string, unknown>): void {
      this.updates.push(opts);
    }
  }
  return { TexturedGostek };
});

import { Assets } from 'pixi.js';
import * as gostekMock from './gostek';
import { TexturedGostek } from './gostekTextured';
import { EntityRenderer } from './entityRender';

interface Rec {
  calls: Array<{ method: string; args: unknown[] }>;
  visible: boolean;
}
interface FakeSpriteView {
  visible: boolean;
  position: { x: number; y: number };
  scale: { x: number; y: number };
  rotation: number;
}
interface RendererPrivates {
  spriteGfx: Rec;
  bulletGfx: Rec;
  thingGfx: Rec;
  markerGfx: Rec;
  spasPool: (FakeSpriteView | undefined)[];
}
interface FakeTexturedGostek {
  view: { visible: boolean };
  updates: Array<Record<string, unknown>>;
}

const assetsCtl = Assets as unknown as { failNextLoad: boolean; loaded: string[] };
const drawGostekCalls = (gostekMock as unknown as { drawGostekCalls: Array<Record<string, unknown>> })
  .drawGostekCalls;
const texturedInstances = (TexturedGostek as unknown as { instances: FakeTexturedGostek[] })
  .instances;

function privates(r: EntityRenderer): RendererPrivates {
  return r as unknown as RendererPrivates;
}

function callsOf(g: Rec, method: string): Array<{ method: string; args: unknown[] }> {
  return g.calls.filter((c) => c.method === method);
}

// ---------------------------------------------------------------------------
// World stub
// ---------------------------------------------------------------------------

interface PartsStub {
  posX: Float32Array;
  posY: Float32Array;
  velocityX: Float32Array;
  velocityY: Float32Array;
}

function makeParts(n: number): PartsStub {
  return {
    posX: new Float32Array(n + 1),
    posY: new Float32Array(n + 1),
    velocityX: new Float32Array(n + 1),
    velocityY: new Float32Array(n + 1),
  };
}

interface WorldStub {
  ticks: number;
  sprites: unknown[];
  bullets: unknown[];
  things: unknown[];
  spriteParts: PartsStub | null;
  bulletParts: PartsStub | null;
  thingParts: PartsStub | null;
}

function makeWorld(): WorldStub {
  return {
    ticks: 1,
    sprites: [],
    bullets: [],
    things: [],
    spriteParts: makeParts(40),
    bulletParts: makeParts(260),
    thingParts: makeParts(95),
  };
}

function asWorld(w: WorldStub): World {
  return w as unknown as World;
}

function makeSprite(num: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: true,
    num,
    team: 0,
    direction: 1,
    onGround: true,
    deadMeat: false,
    selWeapon: WeaponIndex.AK74 ?? 1,
    control: { mouseAimX: 10, mouseAimY: 0, fire: false },
    ...over,
  };
}

function makeBullet(num: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: true,
    num,
    style: BulletStyle.PLAIN,
    ownerWeapon: WeaponNum.AK74 ?? 1,
    ricochetCount: 0,
    ...over,
  };
}

beforeEach(() => {
  drawGostekCalls.length = 0;
  texturedInstances.length = 0;
  assetsCtl.failNextLoad = true;
  assetsCtl.loaded.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Null particle systems
// ---------------------------------------------------------------------------

describe('render with missing particle systems', () => {
  it('returns early (no draws, no throw) when all parts are null', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.spriteParts = null;
    w.bulletParts = null;
    w.thingParts = null;
    expect(() => r.render(asWorld(w), 0.5)).not.toThrow();
    const p = privates(r);
    // Each layer clears, then bails before drawing anything.
    expect(p.thingGfx.calls.map((c) => c.method)).toEqual(['clear']);
    expect(p.bulletGfx.calls.map((c) => c.method)).toEqual(['clear']);
    expect(p.spriteGfx.calls.map((c) => c.method)).toEqual(['clear']);
    expect(drawGostekCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Interpolation (observed through the thing markers: rect at x-6, y-6)
// ---------------------------------------------------------------------------

function thingRectCenter(r: EntityRenderer): [number, number] {
  const rects = callsOf(privates(r).thingGfx, 'rect');
  expect(rects.length).toBe(1);
  const [x, y] = rects[0]?.args as [number, number];
  return [x + 6, y + 6];
}

describe('tick interpolation', () => {
  it('draws at the current position on first sighting, regardless of t', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.things[1] = { active: true, num: 5, team: 0 };
    (w.thingParts as PartsStub).posX[5] = 100;
    (w.thingParts as PartsStub).posY[5] = 200;
    r.render(asWorld(w), 0.75);
    expect(thingRectCenter(r)).toEqual([100, 200]);
  });

  it('lerps prev→cur by framePercent after a new tick', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.things[1] = { active: true, num: 5, team: 0 };
    const parts = w.thingParts as PartsStub;
    parts.posX[5] = 100;
    parts.posY[5] = 200;
    r.render(asWorld(w), 0);

    w.ticks = 2;
    parts.posX[5] = 110;
    parts.posY[5] = 220;
    privates(r).thingGfx.calls.length = 0;
    r.render(asWorld(w), 0.5);
    expect(thingRectCenter(r)).toEqual([105, 210]);
  });

  it('clamps framePercent to [0,1]', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.things[1] = { active: true, num: 5, team: 0 };
    const parts = w.thingParts as PartsStub;
    parts.posX[5] = 100;
    parts.posY[5] = 200;
    r.render(asWorld(w), 0);
    w.ticks = 2;
    parts.posX[5] = 110;
    parts.posY[5] = 220;

    privates(r).thingGfx.calls.length = 0;
    r.render(asWorld(w), -3);
    expect(thingRectCenter(r)).toEqual([100, 200]); // clamped to prev

    privates(r).thingGfx.calls.length = 0;
    r.render(asWorld(w), 7);
    expect(thingRectCenter(r)).toEqual([110, 220]); // clamped to cur
  });

  it('re-rendering within the same tick keeps lerping from the same prev', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.things[1] = { active: true, num: 5, team: 0 };
    const parts = w.thingParts as PartsStub;
    parts.posX[5] = 100;
    parts.posY[5] = 200;
    r.render(asWorld(w), 0);
    w.ticks = 2;
    parts.posX[5] = 110;
    parts.posY[5] = 220;
    r.render(asWorld(w), 0.25);
    // Second frame of the SAME tick: prev must still be (100,200).
    privates(r).thingGfx.calls.length = 0;
    r.render(asWorld(w), 0.75);
    expect(thingRectCenter(r)).toEqual([107.5, 215]);
  });

  it('an inactive frame clears the interp state — no ghost lerp on respawn', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    const thing = { active: true, num: 5, team: 0 };
    w.things[1] = thing;
    const parts = w.thingParts as PartsStub;
    parts.posX[5] = 100;
    parts.posY[5] = 200;
    r.render(asWorld(w), 0);

    thing.active = false;
    privates(r).thingGfx.calls.length = 0;
    r.render(asWorld(w), 0.5);
    expect(callsOf(privates(r).thingGfx, 'rect').length).toBe(0);

    // Reactivate far away on a later tick: must draw AT the new spot, not
    // halfway from the stale pre-despawn position.
    thing.active = true;
    w.ticks = 10;
    parts.posX[5] = 500;
    parts.posY[5] = 600;
    privates(r).thingGfx.calls.length = 0;
    r.render(asWorld(w), 0.5);
    expect(thingRectCenter(r)).toEqual([500, 600]);
  });
});

// ---------------------------------------------------------------------------
// Things — team colours
// ---------------------------------------------------------------------------

describe('thing markers', () => {
  it('colours alpha red, bravo blue, neutral green', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.things[1] = { active: true, num: 1, team: 1 };
    w.things[2] = { active: true, num: 2, team: 2 };
    w.things[3] = { active: true, num: 3, team: 0 };
    r.render(asWorld(w), 0);
    const fills = callsOf(privates(r).thingGfx, 'fill').map(
      (c) => (c.args[0] as { color: number }).color,
    );
    expect(fills).toEqual([0xff4040, 0x4080ff, 0x40d060]);
  });
});

// ---------------------------------------------------------------------------
// Sprites — FFA team split and gostek positioning
// ---------------------------------------------------------------------------

describe('sprite team assignment (vector path)', () => {
  it('keeps real team assignments as-is', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.sprites[1] = makeSprite(1, { team: 2 });
    r.render(asWorld(w), 0);
    expect(drawGostekCalls[0]?.['team']).toBe(2);
  });

  it('in FFA the player is red and bots split by slot parity', () => {
    const r = new EntityRenderer();
    r.playerIndex = 1;
    const w = makeWorld();
    w.sprites[1] = makeSprite(1);
    w.sprites[2] = makeSprite(2);
    w.sprites[3] = makeSprite(3);
    w.sprites[4] = makeSprite(4);
    r.render(asWorld(w), 0);
    const teams = drawGostekCalls.map((c) => c['team']);
    // slot 1 = player → 1; slot 2 even → 1; slot 3 odd → 2; slot 4 even → 1.
    expect(teams).toEqual([1, 1, 2, 1]);
  });

  it('an odd-slot FFA player is still red (playerIndex wins over parity)', () => {
    const r = new EntityRenderer();
    r.playerIndex = 3;
    const w = makeWorld();
    w.sprites[3] = makeSprite(3);
    r.render(asWorld(w), 0);
    expect(drawGostekCalls[0]?.['team']).toBe(1);
  });

  it('vector gostek anchors the COM at y - FOOT_LIFT (10)', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.sprites[1] = makeSprite(1);
    (w.spriteParts as PartsStub).posX[1] = 50;
    (w.spriteParts as PartsStub).posY[1] = 80;
    r.render(asWorld(w), 0);
    expect(drawGostekCalls[0]?.['comX']).toBe(50);
    expect(drawGostekCalls[0]?.['comY']).toBe(70);
  });

  it('a dead sprite renders dimmed and flagged dead', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.sprites[1] = makeSprite(1, { deadMeat: true });
    r.render(asWorld(w), 0);
    expect(drawGostekCalls[0]?.['dead']).toBe(true);
    expect(drawGostekCalls[0]?.['alpha']).toBe(0.45);
  });
});

describe('textured gostek path', () => {
  it('after enableTextured, sprites update a pooled figure instead of vectors', async () => {
    const r = new EntityRenderer();
    await r.enableTextured();
    expect(texturedInstances.length).toBe(12); // GOSTEK_POOL
    expect(privates(r).spriteGfx.visible).toBe(false);

    const w = makeWorld();
    w.sprites[1] = makeSprite(1);
    (w.spriteParts as PartsStub).posX[1] = 50;
    (w.spriteParts as PartsStub).posY[1] = 80;
    r.render(asWorld(w), 0);

    const pooled = texturedInstances[0] as FakeTexturedGostek;
    expect(pooled.view.visible).toBe(true);
    expect(pooled.updates.length).toBe(1);
    expect(drawGostekCalls.length).toBe(0);
    expect(pooled.updates[0]?.['comX']).toBe(50);
    // SUSPECT (review finding): the textured path anchors at y + GOSTEK_Y_OFFSET
    // = y - 8, while the vector fallback anchors at y - FOOT_LIFT = y - 10 —
    // a 2-world-unit vertical jump whenever the paths swap. Pinned as-is.
    expect(pooled.updates[0]?.['comY']).toBe(72);
  });

  it('hides the pooled figure when its sprite goes inactive', async () => {
    const r = new EntityRenderer();
    await r.enableTextured();
    const w = makeWorld();
    const s = makeSprite(1);
    w.sprites[1] = s;
    r.render(asWorld(w), 0);
    const pooled = texturedInstances[0] as FakeTexturedGostek;
    expect(pooled.view.visible).toBe(true);
    s['active'] = false;
    r.render(asWorld(w), 0);
    expect(pooled.view.visible).toBe(false);
  });

  it('a failed SPAS texture load leaves the textured gostek path intact', async () => {
    assetsCtl.failNextLoad = true;
    const r = new EntityRenderer();
    await expect(r.enableTextured()).resolves.toBeUndefined();
    expect(assetsCtl.loaded[0]).toContain('spas12.png');
  });
});

// ---------------------------------------------------------------------------
// Team chevrons
// ---------------------------------------------------------------------------

describe('team chevrons', () => {
  it('draws a red/blue chevron above real-team sprites only', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.sprites[1] = makeSprite(1, { team: 1 });
    w.sprites[2] = makeSprite(2, { team: 2 });
    w.sprites[3] = makeSprite(3, { team: 0 }); // FFA: no chevron
    w.sprites[4] = makeSprite(4, { team: 1, deadMeat: true }); // dead: no chevron
    r.render(asWorld(w), 0);
    const m = privates(r).markerGfx;
    const fills = callsOf(m, 'fill').map((c) => (c.args[0] as { color: number }).color);
    expect(fills).toEqual([0xd23c3c, 0x4060d2]);
    expect(callsOf(m, 'poly').length).toBe(2);
  });

  it('positions the chevron 31..42 units above the head', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.sprites[1] = makeSprite(1, { team: 1 });
    (w.spriteParts as PartsStub).posX[1] = 100;
    (w.spriteParts as PartsStub).posY[1] = 50;
    r.render(asWorld(w), 0);
    const poly = callsOf(privates(r).markerGfx, 'poly')[0];
    expect(poly?.args[0]).toEqual([93, 8, 107, 8, 100, 19]);
  });
});

// ---------------------------------------------------------------------------
// SPAS-12 overlay
// ---------------------------------------------------------------------------

describe('SPAS-12 weapon overlay', () => {
  it('falls back to a vector barrel + pump when no texture is loaded', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.sprites[1] = makeSprite(1, { selWeapon: WeaponIndex.SPAS12 });
    r.render(asWorld(w), 0);
    const strokes = callsOf(privates(r).markerGfx, 'stroke').map(
      (c) => (c.args[0] as { color: number }).color,
    );
    expect(strokes).toContain(0x2e2a26); // barrel
    expect(strokes).toContain(0x8a5a2b); // wooden pump
    expect(privates(r).spasPool[1]).toBeUndefined();
  });

  it('uses the real sprite when the texture loaded, at hand height y-14', async () => {
    assetsCtl.failNextLoad = false;
    const r = new EntityRenderer();
    await r.enableTextured();
    const w = makeWorld();
    w.sprites[1] = makeSprite(1, {
      selWeapon: WeaponIndex.SPAS12,
      control: { mouseAimX: 20, mouseAimY: 0, fire: false },
    });
    const parts = w.spriteParts as PartsStub;
    parts.posX[1] = 100;
    parts.posY[1] = 50;
    r.render(asWorld(w), 0);
    const view = privates(r).spasPool[1] as FakeSpriteView;
    expect(view.visible).toBe(true);
    expect(view.position.x).toBe(100);
    expect(view.position.y).toBe(36); // y - SPAS_HAND_LIFT(14)
    // Aim (120,50) from hand (100,36): angle = atan2(14, 20).
    expect(view.rotation).toBeCloseTo(Math.atan2(14, 20), 6);
    expect(view.scale.y).toBeCloseTo(0.55, 6); // aiming right: no flip
  });

  it('flips across the barrel axis when aiming left', async () => {
    assetsCtl.failNextLoad = false;
    const r = new EntityRenderer();
    await r.enableTextured();
    const w = makeWorld();
    w.sprites[1] = makeSprite(1, {
      selWeapon: WeaponIndex.SPAS12,
      direction: -1,
      control: { mouseAimX: -20, mouseAimY: 0, fire: false },
    });
    r.render(asWorld(w), 0);
    const view = privates(r).spasPool[1] as FakeSpriteView;
    expect(view.scale.y).toBeCloseTo(-0.55, 6);
  });

  it('hides the overlay sprite when the carrier swaps off the SPAS', async () => {
    assetsCtl.failNextLoad = false;
    const r = new EntityRenderer();
    await r.enableTextured();
    const w = makeWorld();
    const s = makeSprite(1, { selWeapon: WeaponIndex.SPAS12 });
    w.sprites[1] = s;
    r.render(asWorld(w), 0);
    expect((privates(r).spasPool[1] as FakeSpriteView).visible).toBe(true);
    s['selWeapon'] = WeaponIndex.AK74;
    r.render(asWorld(w), 0);
    expect((privates(r).spasPool[1] as FakeSpriteView).visible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bullets — tracer styles
// ---------------------------------------------------------------------------

function bulletStrokeColors(r: EntityRenderer): number[] {
  return callsOf(privates(r).bulletGfx, 'stroke').map(
    (c) => (c.args[0] as { color: number }).color,
  );
}

describe('bullet tracers', () => {
  it('a stationary bullet draws a dot but NO tracer (zero-length guard)', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.bullets[1] = makeBullet(1);
    const parts = w.bulletParts as PartsStub;
    parts.posX[1] = 30;
    parts.posY[1] = 40;
    r.render(asWorld(w), 0);
    const g = privates(r).bulletGfx;
    expect(callsOf(g, 'moveTo').length).toBe(0);
    expect(callsOf(g, 'stroke').length).toBe(0);
    const circle = callsOf(g, 'circle')[0];
    expect(circle?.args).toEqual([30, 40, 2]); // BULLET_RADIUS, finite coords
  });

  it('a plain round gets a 6-unit pale-yellow tail behind its velocity', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.bullets[1] = makeBullet(1);
    const parts = w.bulletParts as PartsStub;
    parts.posX[1] = 100;
    parts.posY[1] = 50;
    parts.velocityX[1] = 10; // moving right → unit (1,0)
    r.render(asWorld(w), 0);
    const g = privates(r).bulletGfx;
    expect(callsOf(g, 'moveTo')[0]?.args).toEqual([94, 50]);
    expect(callsOf(g, 'lineTo')[0]?.args).toEqual([100, 50]);
    expect(bulletStrokeColors(r)).toEqual([0xfff0a0]);
  });

  it('a Barrett round gets the long ice-bright streak', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.bullets[1] = makeBullet(1, { ownerWeapon: WeaponNum.BARRETT });
    const parts = w.bulletParts as PartsStub;
    parts.posX[1] = 100;
    parts.velocityX[1] = 55;
    r.render(asWorld(w), 0);
    const g = privates(r).bulletGfx;
    expect(callsOf(g, 'moveTo')[0]?.args).toEqual([70, 0]); // tail = 30
    expect(bulletStrokeColors(r)).toEqual([0xd8f4ff]);
    const dot = callsOf(g, 'fill')[0];
    expect((dot?.args[0] as { color: number }).color).toBe(0xf2fbff);
  });

  it('shotgun pellets get the stubby hot streak', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.bullets[1] = makeBullet(1, { style: BulletStyle.SHOTGUN });
    const parts = w.bulletParts as PartsStub;
    parts.velocityX[1] = 14;
    r.render(asWorld(w), 0);
    const g = privates(r).bulletGfx;
    expect(callsOf(g, 'moveTo')[0]?.args).toEqual([-3.5, 0]); // tail = 3.5
    expect(bulletStrokeColors(r)).toEqual([0xffa24a]);
  });

  it('ricochet tracers walk the bounce palette and clamp past the end', () => {
    const palette = [0xb6ff7a, 0x5cf2c4, 0x4fc9ff, 0x9a8cff, 0xff7ad9];
    for (const [count, expected] of [
      [0, palette[0]],
      [2, palette[2]],
      [4, palette[4]],
      [99, palette[4]], // beyond the array → clamped to the terminal magenta
    ] as Array<[number, number]>) {
      const r = new EntityRenderer();
      const w = makeWorld();
      w.bullets[1] = makeBullet(1, {
        ownerWeapon: WeaponNum.RICOCHET,
        ricochetCount: count,
      });
      (w.bulletParts as PartsStub).velocityX[1] = 20;
      r.render(asWorld(w), 0);
      expect(bulletStrokeColors(r), `bounce ${count}`).toEqual([expected]);
    }
  });

  it('chainsaw blade bullets draw sparks only — never a tracer', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.ticks = 3;
    w.bullets[1] = makeBullet(1, { style: BulletStyle.KNIFE });
    const parts = w.bulletParts as PartsStub;
    parts.posX[1] = 10;
    parts.posY[1] = 20;
    parts.velocityX[1] = 5;
    r.render(asWorld(w), 0);
    const g = privates(r).bulletGfx;
    expect(callsOf(g, 'moveTo').length).toBe(0);
    expect(callsOf(g, 'stroke').length).toBe(0);
    expect(callsOf(g, 'circle').length).toBe(3); // three deterministic sparks
    const colors = callsOf(g, 'fill').map((c) => (c.args[0] as { color: number }).color);
    expect(colors).toEqual([0xfff2b0, 0xffb24a, 0xffb24a]);
  });

  it('M79 rockets draw the fat ember streak plus an exhaust dot', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    w.bullets[1] = makeBullet(1, { style: BulletStyle.M79 });
    const parts = w.bulletParts as PartsStub;
    parts.posX[1] = 100;
    parts.velocityX[1] = 10;
    r.render(asWorld(w), 0);
    const g = privates(r).bulletGfx;
    expect(callsOf(g, 'moveTo')[0]?.args).toEqual([88, 0]); // tail = 12
    expect(bulletStrokeColors(r)).toEqual([0xff8a3c]);
    expect(callsOf(g, 'circle').length).toBe(2); // rocket body + exhaust
  });

  it('inactive bullets draw nothing and drop their interp state', () => {
    const r = new EntityRenderer();
    const w = makeWorld();
    const b = makeBullet(1);
    w.bullets[1] = b;
    const parts = w.bulletParts as PartsStub;
    parts.posX[1] = 100;
    r.render(asWorld(w), 0);
    b['active'] = false;
    privates(r).bulletGfx.calls.length = 0;
    r.render(asWorld(w), 0.5);
    expect(callsOf(privates(r).bulletGfx, 'circle').length).toBe(0);
    // Respawn in the same slot far away: no lerp from the stale position.
    b['active'] = true;
    w.ticks = 9;
    parts.posX[1] = 400;
    privates(r).bulletGfx.calls.length = 0;
    r.render(asWorld(w), 0.5);
    expect(callsOf(privates(r).bulletGfx, 'circle')[0]?.args).toEqual([400, 0, 2]);
  });
});
