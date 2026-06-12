// "prodigy" engine (prodigy.ts) — the third student: v2 senses (bullet
// threats, reload windows, weapons) and one tick of memory. Shipped weights
// are opaque, so the tests pin weight-independent invariants (thresholds,
// aim magnitude, empty-mag rule, roam, guards), the memory protocol's
// GUARANTEED identities (a tick gap must equal a fresh brain), and — against
// the committed weight set — that history and bullet threats actually reach
// the policy (outputs change when they change).

import { describe, it, expect } from 'vitest';
import type { World } from '@soldat/sim';
import type { BotEngineContext } from './engine';
import { createProdigyEngine, PRODIGY_DEFAULTS } from './prodigy';

// --- Stub world (minimal hand-rolled World; sentinel at index 0) -------------

interface StubBot {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  team?: number;
  health?: number;
  alpha?: number;
  holdedThing?: number;
  active?: boolean;
  deadMeat?: boolean;
  jetsCount?: number;
  onGround?: boolean;
}

interface StubBullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  owner: number;
  active?: boolean;
}

interface StubControl {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  fire: boolean;
  jetpack: boolean;
  reload: boolean;
  mouseAimX: number;
  mouseAimY: number;
}

function makeControl(): StubControl {
  return {
    left: false,
    right: false,
    up: false,
    down: false,
    fire: false,
    jetpack: false,
    reload: false,
    mouseAimX: 0,
    mouseAimY: 0,
  };
}

function makeWorld(bots: StubBot[], tick = 100, bullets: StubBullet[] = []): World {
  const sprites: unknown[] = [{ active: false }];
  const posX = [0];
  const posY = [0];
  const velocityX = [0];
  const velocityY = [0];
  for (const b of bots) {
    sprites.push({
      active: b.active ?? true,
      deadMeat: b.deadMeat ?? false,
      team: b.team ?? 0,
      health: b.health ?? 150,
      alpha: b.alpha ?? 255,
      holdedThing: b.holdedThing ?? 0,
      jetsCount: b.jetsCount ?? 700,
      onGround: b.onGround ?? true,
      control: makeControl(),
    });
    posX.push(b.x ?? 0);
    posY.push(b.y ?? 0);
    velocityX.push(b.vx ?? 0);
    velocityY.push(b.vy ?? 0);
  }
  const bArr: unknown[] = [{ active: false, owner: 0, num: 0 }];
  const bposX = [0];
  const bposY = [0];
  const bvelX = [0];
  const bvelY = [0];
  for (const bl of bullets) {
    const num = bposX.length;
    bArr.push({ active: bl.active ?? true, owner: bl.owner, num });
    bposX.push(bl.x);
    bposY.push(bl.y);
    bvelX.push(bl.vx);
    bvelY.push(bl.vy);
  }
  let seed = 42 >>> 0; // deterministic LCG for roamTick's rng
  const rng = {
    next(): number {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    },
    nextInt(n: number): number {
      return Math.floor(this.next() * n);
    },
  };
  return {
    sprites,
    bullets: bArr,
    mainTickCounter: tick,
    spriteParts: { posX, posY, velocityX, velocityY },
    bulletParts: { posX: bposX, posY: bposY, velocityX: bvelX, velocityY: bvelY },
    rng,
  } as unknown as World;
}

function makeCtx(
  world: World,
  over: Partial<
    Pick<BotEngineContext, 'ammoOf' | 'reloadingOf' | 'weaponOf'>
  > = {},
): BotEngineContext {
  return {
    world,
    graph: { nodes: [], edges: [] },
    spawns: [{ x: 1000, y: 0 }],
    spectate: true,
    ammoOf: () => 30,
    reloadingOf: () => false,
    magSize: 30,
    weaponOf: () => 'AK74',
    ...over,
  } as unknown as BotEngineContext;
}

const controlOf = (world: World, i: number): StubControl =>
  (world.sprites[i] as unknown as { control: StubControl }).control;
const snap = (world: World, i: number): string =>
  JSON.stringify(controlOf(world, i));
const setTick = (world: World, t: number): void => {
  (world as unknown as { mainTickCounter: number }).mainTickCounter = t;
};

const DUEL: StubBot[] = [
  { x: 0, y: 0 },
  { x: 200, y: -50 },
];

describe('createProdigyEngine', () => {
  it("returns id 'prodigy' with the calibrated FIRE_THRESH 0.15 default", () => {
    const engine = createProdigyEngine();
    expect(engine.id).toBe('prodigy');
    expect(engine.tweaks).toEqual(PRODIGY_DEFAULTS);
    expect(engine.tweaks.FIRE_THRESH).toBe(0.15);
  });
});

describe('ProdigyBrain — invariants', () => {
  it('thresholds of 0 turn every button on; thresholds of 1 turn every button off', () => {
    const on = makeWorld(DUEL);
    createProdigyEngine({
      FIRE_THRESH: 0,
      MOVE_THRESH: 0,
      UPDOWN_THRESH: 0,
      JET_THRESH: 0,
      RELOAD_THRESH: 0,
    })
      .createBrain()
      .tick(1, makeCtx(on));
    const cOn = controlOf(on, 1);
    expect([cOn.left, cOn.right, cOn.up, cOn.down, cOn.fire, cOn.jetpack, cOn.reload]).toEqual(
      [true, true, true, true, true, true, true],
    );

    const off = makeWorld(DUEL);
    createProdigyEngine({
      FIRE_THRESH: 1,
      MOVE_THRESH: 1,
      UPDOWN_THRESH: 1,
      JET_THRESH: 1,
      RELOAD_THRESH: 1,
    })
      .createBrain()
      .tick(1, makeCtx(off));
    const cOff = controlOf(off, 1);
    expect([
      cOff.left, cOff.right, cOff.up, cOff.down, cOff.fire, cOff.jetpack, cOff.reload,
    ]).toEqual([false, false, false, false, false, false, false]);
  });

  it('engaged aim has magnitude AIM_DIST (within rounding) and rescales with the tweak', () => {
    const world = makeWorld(DUEL);
    createProdigyEngine().createBrain().tick(1, makeCtx(world));
    const c = controlOf(world, 1);
    expect(Math.hypot(c.mouseAimX, c.mouseAimY)).toBeGreaterThan(299);
    expect(Math.hypot(c.mouseAimX, c.mouseAimY)).toBeLessThan(301);

    const scaled = makeWorld(DUEL);
    createProdigyEngine({ AIM_DIST: 100 }).createBrain().tick(1, makeCtx(scaled));
    const cs = controlOf(scaled, 1);
    expect(Math.hypot(cs.mouseAimX, cs.mouseAimY)).toBeGreaterThan(99);
    expect(Math.hypot(cs.mouseAimX, cs.mouseAimY)).toBeLessThan(101);
  });

  it('an empty mag forces reload; an in-progress reload does not double-trigger', () => {
    const world = makeWorld(DUEL);
    createProdigyEngine({ RELOAD_THRESH: 1 })
      .createBrain()
      .tick(1, makeCtx(world, { ammoOf: () => 0 }));
    expect(controlOf(world, 1).reload).toBe(true);

    const busy = makeWorld(DUEL);
    createProdigyEngine({ RELOAD_THRESH: 1 })
      .createBrain()
      .tick(1, makeCtx(busy, { ammoOf: () => 0, reloadingOf: () => true }));
    expect(controlOf(busy, 1).reload).toBe(false);
  });

  it('no enemies → roam fallback (walks toward spawn, never aims)', () => {
    const world = makeWorld([{ x: 0 }]);
    createProdigyEngine().createBrain().tick(1, makeCtx(world));
    const c = controlOf(world, 1);
    expect(c.right).toBe(true);
    expect(c.fire).toBe(false);
    expect(c.mouseAimX).toBe(0);
  });

  it('a missing weaponOf is tolerated (buckets to AK74)', () => {
    const world = makeWorld(DUEL);
    const ctx = makeCtx(world);
    (ctx as unknown as { weaponOf?: unknown }).weaponOf = undefined;
    expect(() => createProdigyEngine().createBrain().tick(1, ctx)).not.toThrow();
    const c = controlOf(world, 1);
    expect(Math.hypot(c.mouseAimX, c.mouseAimY)).toBeGreaterThan(299);
  });

  it('returns before touching controls when spriteParts is null', () => {
    const world = makeWorld(DUEL);
    (world as unknown as { spriteParts: null }).spriteParts = null;
    const c = controlOf(world, 1);
    c.fire = true;
    createProdigyEngine().createBrain().tick(1, makeCtx(world));
    expect(c.fire).toBe(true);
  });

  it('is deterministic: identical worlds and brains produce identical controls', () => {
    const run = (): string => {
      const world = makeWorld(DUEL, 100, [{ x: -150, y: 0, vx: 15, vy: 0, owner: 2 }]);
      createProdigyEngine().createBrain().tick(1, makeCtx(world));
      return snap(world, 1);
    };
    expect(run()).toBe(run());
  });
});

describe('ProdigyBrain — one tick of memory', () => {
  it('a tick GAP resets history: gapped brain equals a fresh brain at the same tick', () => {
    // Brain A ticks at 100, then the clock jumps to 103 (death/respawn gap).
    const w1 = makeWorld(DUEL, 100);
    const brain = createProdigyEngine().createBrain();
    brain.tick(1, makeCtx(w1));
    setTick(w1, 103);
    brain.tick(1, makeCtx(w1));

    // Brain B never saw tick 100: same world state, first tick at 103.
    const w2 = makeWorld(DUEL, 103);
    createProdigyEngine().createBrain().tick(1, makeCtx(w2));

    expect(snap(w1, 1)).toBe(snap(w2, 1));
  });

  it('CONSECUTIVE ticks feed real history: outputs diverge from a fresh brain (committed weights)', () => {
    const w1 = makeWorld(DUEL, 100);
    const brain = createProdigyEngine().createBrain();
    brain.tick(1, makeCtx(w1));
    setTick(w1, 101);
    brain.tick(1, makeCtx(w1));

    const w2 = makeWorld(DUEL, 101);
    createProdigyEngine().createBrain().tick(1, makeCtx(w2));

    // The history block (prev velocity + prev aim unit vector) is non-zero on
    // the consecutive path and zero on the fresh path; with the committed
    // weight set that visibly changes the decision.
    expect(snap(w1, 1)).not.toBe(snap(w2, 1));
  });

  it('roaming still advances the memory clock (no false gap on re-engagement)', () => {
    // Brain A roams at tick 100 (enemy hidden), enemy appears at 101: the
    // consecutive-history path must be taken — assert by mirroring a brain
    // whose tick-100 world was identical-but-engaged... simplest guaranteed
    // check: roam→engage at +1 must NOT equal fresh-engage (history present),
    // while roam→engage after a gap MUST equal fresh-engage.
    const engageFresh = (): string => {
      const w = makeWorld(DUEL, 101);
      createProdigyEngine().createBrain().tick(1, makeCtx(w));
      return snap(w, 1);
    };

    // Gap variant: roam at 90, engage at 101 → gap → equals fresh.
    const wGap = makeWorld([{ x: 0, vx: 5 }], 90);
    const gapBrain = createProdigyEngine().createBrain();
    gapBrain.tick(1, makeCtx(wGap));
    const wGapDuel = makeWorld(DUEL, 101);
    gapBrain.tick(1, makeCtx(wGapDuel));
    expect(snap(wGapDuel, 1)).toBe(engageFresh());

    // Consecutive variant: roam at 100 with non-zero velocity, engage at 101
    // → history carries vx → differs from fresh (committed weights).
    const wRoam = makeWorld([{ x: 0, vx: 5 }], 100);
    const brain = createProdigyEngine().createBrain();
    brain.tick(1, makeCtx(wRoam));
    const wDuel = makeWorld(DUEL, 101);
    brain.tick(1, makeCtx(wDuel));
    expect(snap(wDuel, 1)).not.toBe(engageFresh());
  });
});

describe('ProdigyBrain — bullet threat sense', () => {
  const engage = (bullets: StubBullet[], bots: StubBot[] = DUEL): string => {
    const world = makeWorld(bots, 100, bullets);
    createProdigyEngine().createBrain().tick(1, makeCtx(world));
    return snap(world, 1);
  };

  it('an incoming enemy bullet changes the decision (committed weights)', () => {
    const calm = engage([]);
    const underFire = engage([{ x: -150, y: 0, vx: 15, vy: 0, owner: 2 }]);
    expect(underFire).not.toBe(calm);
  });

  it('its OWN bullets are never a threat', () => {
    const calm = engage([]);
    const ownShot = engage([{ x: -150, y: 0, vx: 15, vy: 0, owner: 1 }]);
    expect(ownShot).toBe(calm);
  });

  it('inactive bullets are ignored', () => {
    const calm = engage([]);
    const dud = engage([{ x: -150, y: 0, vx: 15, vy: 0, owner: 2, active: false }]);
    expect(dud).toBe(calm);
  });

  it("in team play a TEAMMATE's bullet is not a threat", () => {
    const roster: StubBot[] = [
      { x: 0, y: 0, team: 1 },
      { x: 400, y: 0, team: 1 }, // teammate (bullet owner)
      { x: 200, y: -50, team: 2 }, // enemy
    ];
    const calm = engage([], roster);
    const friendly = engage([{ x: -150, y: 0, vx: 15, vy: 0, owner: 2 }], roster);
    expect(friendly).toBe(calm);
  });

  it('a receding bullet does not qualify as a threat', () => {
    const calm = engage([]);
    const receding = engage([{ x: 150, y: 0, vx: 15, vy: 0, owner: 2 }]);
    expect(receding).toBe(calm);
  });
});
