// Kestrel brain unit tests — the wind-hover marksman's pillars, each pinned
// against a hand-built world: plant-in-band (no horizontal input while in the
// band), the tap clock, EMA lead + TRUE 0.135 drop, the closest-approach
// bullet dodge (vertical for shallow rounds, horizontal for steep ones), mag
// hygiene, and the dist=0 degenerate aim case.
//
// The worlds are real sim worlds (createWorld + initSimWorld, map null so
// line of sight is always clear); only positions/velocities/ammo are staged.

import { describe, it, expect } from 'vitest';
import {
  buildWaypoints,
  createWorld,
  initSimWorld,
  type World,
} from '@soldat/sim';
import { createKestrelEngine, KESTREL_DEFAULTS } from './kestrel';
import type { BotEngineContext } from './engine';

const AK_BULLET_SPEED = 24.6;

interface BotSpec {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  team?: number;
  health?: number;
  jets?: number;
}

function makeWorld(seed = 7): World {
  return initSimWorld(createWorld(), { seed });
}

function addBot(world: World, i: number, spec: BotSpec): void {
  const s = world.sprites[i]!;
  s.active = true;
  s.deadMeat = false;
  s.alpha = 255;
  s.team = spec.team ?? 0;
  s.health = spec.health ?? 150;
  s.jetsCount = spec.jets ?? 1000;
  const p = world.spriteParts!;
  p.posX[i] = spec.x;
  p.posY[i] = spec.y;
  p.velocityX[i] = spec.vx ?? 0;
  p.velocityY[i] = spec.vy ?? 0;
}

function addBullet(
  world: World,
  i: number,
  owner: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
): void {
  const b = world.bullets[i]!;
  b.active = true;
  b.owner = owner;
  b.num = i;
  const bp = world.bulletParts!;
  bp.posX[i] = x;
  bp.posY[i] = y;
  bp.velocityX[i] = vx;
  bp.velocityY[i] = vy;
}

interface CtxOpts {
  ammo?: Record<number, number>;
  reloading?: Record<number, boolean>;
}

function makeCtx(world: World, opts: CtxOpts = {}): BotEngineContext {
  return {
    world,
    graph: buildWaypoints({ waypoints: [] }),
    spawns: [{ x: 0, y: 0 }],
    spectate: true,
    ammoOf: (i: number): number => opts.ammo?.[i] ?? 30,
    reloadingOf: (i: number): boolean => opts.reloading?.[i] ?? false,
    magSize: 30,
  };
}

/** Mirror of the brain's two-pass time-of-flight aim (EMA lead + true drop). */
function expectedAim(
  px: number,
  py: number,
  tx: number,
  ty: number,
  emaVX: number,
  emaVY: number,
): { x: number; y: number } {
  const dist = Math.hypot(tx - px, ty - py);
  const tof0 = dist / AK_BULLET_SPEED;
  const px1 = tx + emaVX * tof0;
  const py1 = ty + emaVY * tof0;
  const tof = Math.hypot(px1 - px, py1 - py) / AK_BULLET_SPEED;
  const drop = 0.5 * KESTREL_DEFAULTS.DROP_G * tof * tof;
  return {
    x: Math.round(tx + emaVX * tof - px),
    y: Math.round(ty + emaVY * tof - py - drop),
  };
}

function newBrain() {
  return createKestrelEngine().createBrain();
}

describe('kestrel: plant in the band', () => {
  it('holds zero horizontal input and bobs when the target sits in the band', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 300, y: 0 }); // dist 300 ∈ [BAND_MIN 240, BAND_MAX 430]
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world));
    expect(c.left).toBe(false);
    expect(c.right).toBe(false);
    // Fresh bob cycle opens with a jet pulse (fuel is plentiful).
    expect(c.jetpack).toBe(true);
  });

  it('closes in when beyond BAND_MAX and gives ground inside BAND_MIN', () => {
    const far = makeWorld();
    addBot(far, 1, { x: 0, y: 0 });
    addBot(far, 2, { x: 500, y: 0 });
    newBrain().tick(1, makeCtx(far));
    expect(far.sprites[1]!.control.right).toBe(true);

    const near = makeWorld();
    addBot(near, 1, { x: 0, y: 0 });
    addBot(near, 2, { x: 100, y: 0 });
    newBrain().tick(1, makeCtx(near));
    expect(near.sprites[1]!.control.left).toBe(true);
  });
});

describe('kestrel: fire discipline (tap clock + approach hold)', () => {
  it('fires only on open tap ticks while planted', () => {
    // tapOpen = (clock + botIndex*3) % 7 < 2; botIndex 1.
    const closed = makeWorld();
    addBot(closed, 1, { x: 0, y: 0 });
    addBot(closed, 2, { x: 300, y: 0 });
    closed.mainTickCounter = 0; // (0+3)%7 = 3 → closed
    newBrain().tick(1, makeCtx(closed));
    expect(closed.sprites[1]!.control.fire).toBe(false);

    const open = makeWorld();
    addBot(open, 1, { x: 0, y: 0 });
    addBot(open, 2, { x: 300, y: 0 });
    open.mainTickCounter = 4; // (4+3)%7 = 0 → open
    newBrain().tick(1, makeCtx(open));
    expect(open.sprites[1]!.control.fire).toBe(true);
  });

  it('holds fire while approaching beyond APPROACH_FIRE_DIST but taps inside it', () => {
    // Both targets are beyond BAND_MAX (moving), clock is a tap-open tick.
    const hold = makeWorld();
    addBot(hold, 1, { x: 0, y: 0 });
    addBot(hold, 2, { x: 500, y: 0 }); // > APPROACH_FIRE_DIST 460
    hold.mainTickCounter = 4;
    newBrain().tick(1, makeCtx(hold));
    expect(hold.sprites[1]!.control.fire).toBe(false);

    const tap = makeWorld();
    addBot(tap, 1, { x: 0, y: 0 });
    addBot(tap, 2, { x: 440, y: 0 }); // moving but ≤ 460
    tap.mainTickCounter = 4;
    newBrain().tick(1, makeCtx(tap));
    expect(tap.sprites[1]!.control.fire).toBe(true);
  });
});

describe('kestrel: aim (EMA lead + true ballistic drop)', () => {
  it('compensates the TRUE 0.135 drop on a stationary target', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 300, y: 0 });
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world));
    // tof = 300/24.6 ≈ 12.195 → drop = 0.5·0.135·tof² ≈ 10.04 px.
    expect(c.mouseAimX).toBe(300);
    expect(c.mouseAimY).toBe(-10);
    expect(expectedAim(0, 0, 300, 0, 0, 0)).toEqual({ x: 300, y: -10 });
  });

  it('smooths target velocity with EMA_ALPHA (resets on target switch)', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 300, y: 0, vx: 0 });
    const c = world.sprites[1]!.control;
    const ctx = makeCtx(world);
    const brain = newBrain();
    brain.tick(1, ctx); // target switch: ema = tvx = 0
    expect(c.mouseAimX).toBe(300);

    world.spriteParts!.velocityX[2] = 4; // target accelerates
    world.mainTickCounter = 1;
    brain.tick(1, ctx); // ema = 0 + 0.15·(4 − 0) = 0.6
    const aim = expectedAim(0, 0, 300, 0, 0.6, 0);
    expect(c.mouseAimX).toBe(aim.x);
    expect(c.mouseAimY).toBe(aim.y);
    // The smoothed lead trails the instantaneous one (4 px/tick would be more).
    expect(c.mouseAimX).toBeLessThan(expectedAim(0, 0, 300, 0, 4, 0).x);
  });

  it('produces a finite zero aim when the target shares the bot position (dist 0)', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 0, y: 0 });
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world));
    expect(c.mouseAimX).toBe(0);
    expect(c.mouseAimY).toBe(0);
    expect(Number.isFinite(c.mouseAimX)).toBe(true);
    expect(Number.isFinite(c.mouseAimY)).toBe(true);
  });
});

describe('kestrel: bullet dodge (closest approach)', () => {
  it('jets vertically away from a shallow (horizontal) incoming bullet', () => {
    const world = makeWorld();
    // Low fuel (≤ FUEL_FLOOR 80) suppresses the hover bob, so any jetpack
    // input here can only come from the committed dodge.
    addBot(world, 1, { x: 0, y: 0, jets: 50 });
    addBot(world, 2, { x: 300, y: 0 });
    // Dead-on horizontal round arriving in ~8 ticks (≤ DODGE_HORIZON 26).
    addBullet(world, 1, 2, -200, 0, 24, 0);
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world));
    expect(c.jetpack).toBe(true); // dodgeJet fires even on fumes (jets > 0)
    expect(c.left).toBe(false);
    expect(c.right).toBe(false);
  });

  it('steps horizontally away from a steep (plunging) bullet', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0, jets: 50 });
    addBot(world, 2, { x: 300, y: 0 });
    // Plunging round 30 px to the bot's right: miss is horizontal → step left.
    addBullet(world, 1, 2, 30, -200, 0, 24);
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world));
    expect(c.left).toBe(true);
    expect(c.right).toBe(false);
  });

  it('ignores bullets whose closest approach falls outside DODGE_HORIZON', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0, jets: 50 });
    addBot(world, 2, { x: 300, y: 0 });
    // Same dead-on round but ~41 ticks out (> DODGE_HORIZON 26): not a threat.
    addBullet(world, 1, 2, -1000, 0, 24, 0);
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world));
    expect(c.jetpack).toBe(false);
    expect(c.left).toBe(false);
    expect(c.right).toBe(false);
  });
});

describe('kestrel: mag hygiene', () => {
  it('reloads early when low and safely outside the band', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 500, y: 0 }); // dist > BAND_MAX 430
    newBrain().tick(1, makeCtx(world, { ammo: { 1: 5 } })); // ≤ RELOAD_LOW 6
    expect(world.sprites[1]!.control.reload).toBe(true);
  });

  it('does not reload at 5 rounds while inside the band, but does at 2', () => {
    const inBand = makeWorld();
    addBot(inBand, 1, { x: 0, y: 0 });
    addBot(inBand, 2, { x: 300, y: 0 });
    newBrain().tick(1, makeCtx(inBand, { ammo: { 1: 5 } }));
    expect(inBand.sprites[1]!.control.reload).toBe(false);

    const nearlyDry = makeWorld();
    addBot(nearlyDry, 1, { x: 0, y: 0 });
    addBot(nearlyDry, 2, { x: 300, y: 0 }); // > KNIFE_DIST 170
    newBrain().tick(1, makeCtx(nearlyDry, { ammo: { 1: 2 } }));
    expect(nearlyDry.sprites[1]!.control.reload).toBe(true);
  });

  it('disengages (opens range, climbs, holds fire) while reloading', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 300, y: 0 }); // enemy to the right
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world, { reloading: { 1: true } }));
    expect(c.left).toBe(true); // away from the enemy
    expect(c.jetpack).toBe(true); // cheap height while dark
    expect(c.fire).toBe(false);
  });
});
