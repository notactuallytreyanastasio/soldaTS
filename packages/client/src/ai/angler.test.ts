// Angler brain unit tests — the lure doctrine, pinned against hand-built
// worlds: pickLure by lowest ammo with the wounded (ROTATE_BELOW) override,
// the LURE_MIN_CREW gate, the dry-lure LURE_RELOAD_SAFE exception, the
// lure's held-mag knife-only trigger, biter priority in the hunters' shared
// target, hunter reload-in-place, and the weigh-the-catch A/B audit (window
// alternation during calibration, then the net-damage verdict).
//
// Worlds are real sim worlds (createWorld + initSimWorld, map null so line of
// sight is always clear); only positions/health/ammo are staged. All clocks
// are absolute world ticks — the audit windows key off them.

import { describe, it, expect } from 'vitest';
import {
  buildWaypoints,
  createWorld,
  initSimWorld,
  type World,
} from '@soldat/sim';
import { createAnglerEngine, ANGLER_DEFAULTS } from './angler';
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

interface CtxOpts {
  ammo?: Record<number, number>;
  reloading?: Record<number, boolean>;
  weapons?: Record<number, string>;
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
    weaponOf: (i: number): string => opts.weapons?.[i] ?? 'AK74',
  };
}

function newBrain(tweaks?: Record<string, number>) {
  return createAnglerEngine(tweaks).createBrain();
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
  const drop = 0.5 * ANGLER_DEFAULTS.DROP_G * tof * tof;
  return {
    x: Math.round(tx + emaVX * tof - px),
    y: Math.round(ty + emaVY * tof - py - drop),
  };
}

/** Standard crew: three anglers (team 1) facing one enemy (team 2). */
function crewWorld(enemyX = 390): World {
  const world = makeWorld();
  addBot(world, 1, { x: 0, y: 0, team: 1 });
  addBot(world, 2, { x: 20, y: 0, team: 1 });
  addBot(world, 3, { x: 40, y: 0, team: 1 });
  addBot(world, 4, { x: enemyX, y: 0, team: 2 });
  return world;
}

const CREW_AMMO = { 1: 12, 2: 25, 3: 7 }; // bot 3 = lowest mag → the lure

describe('angler: pickLure (who dangles)', () => {
  it('the lowest-ammo member dangles in the band while a hunter walks its slot', () => {
    // Lure-on window (clock 2 → windowIdx 0). Bot 3 dangles: enemy centroid
    // 350 px out sits inside [LURE_NEAR 280, LURE_FAR 460] → zero horizontal
    // input, jet-bob only.
    const world = crewWorld();
    world.mainTickCounter = 2;
    const c3 = world.sprites[3]!.control;
    newBrain().tick(3, makeCtx(world, { ammo: { ...CREW_AMMO } }));
    expect(c3.left).toBe(false);
    expect(c3.right).toBe(false);
    expect(c3.jetpack).toBe(true); // the unleadable vertical bob

    // Same bot in a lure-OFF window (clock 481 → windowIdx 1, calibration
    // alternation): three hunters — bot 3 is the rightmost, so it walks
    // toward the RIGHT bearing slot (enemyX + 380).
    const off = crewWorld();
    off.mainTickCounter = 481;
    newBrain().tick(3, makeCtx(off, { ammo: { ...CREW_AMMO } }));
    expect(off.sprites[3]!.control.right).toBe(true);
  });

  it('the role moves to the LOWEST-HEALTH member when anyone is under ROTATE_BELOW', () => {
    const world = crewWorld();
    world.sprites[1]!.health = 40; // < ROTATE_BELOW 55 — wounded bait
    world.mainTickCounter = 2;
    const ctx = makeCtx(world, { ammo: { ...CREW_AMMO } });
    newBrain().tick(1, ctx);
    newBrain().tick(3, ctx);
    // Wounded lure widens the band (near 280→400): at dCen 390 it backs off.
    expect(world.sprites[1]!.control.left).toBe(true);
    // Bot 3 (lowest ammo, but healthy) hunts: right slot at enemyX + 380.
    expect(world.sprites[3]!.control.right).toBe(true);
  });

  it('disables the lure below LURE_MIN_CREW: everyone hunts', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0, team: 1 });
    addBot(world, 2, { x: 20, y: 0, team: 1 }); // crew of two < LURE_MIN_CREW 3
    addBot(world, 4, { x: 390, y: 0, team: 2 });
    world.mainTickCounter = 2;
    const c2 = world.sprites[2]!.control;
    newBrain().tick(2, makeCtx(world, { ammo: { 1: 12, 2: 7 } }));
    // Lowest mag or not, bot 2 walks the right bearing slot like a hunter.
    expect(c2.right).toBe(true);
  });
});

describe('angler: the lure', () => {
  it('a DRY lure reloads only beyond LURE_RELOAD_SAFE of the nearest enemy', () => {
    const far = crewWorld(800); // bot 3 → enemy = 760 px > 700
    far.mainTickCounter = 2;
    newBrain().tick(3, makeCtx(far, { ammo: { ...CREW_AMMO, 3: 0 } }));
    expect(far.sprites[3]!.control.reload).toBe(true);

    const near = crewWorld(440); // bot 3 → enemy = 400 px < 700
    near.mainTickCounter = 2;
    newBrain().tick(3, makeCtx(near, { ammo: { ...CREW_AMMO, 3: 0 } }));
    expect(near.sprites[3]!.control.reload).toBe(false); // bait stays dangled
  });

  it('holds the last LURE_HOLD_AT rounds for knife range only', () => {
    // At 400 px the held mag never fires, whatever the tap clock says.
    const farWorld = crewWorld(440);
    const farCtx = makeCtx(farWorld, { ammo: { ...CREW_AMMO, 3: 3 } });
    const farBrain = newBrain();
    let fired = false;
    for (let t = 0; t < 12; t++) {
      farWorld.mainTickCounter = t;
      farBrain.tick(3, farCtx);
      if (farWorld.sprites[3]!.control.fire) fired = true;
    }
    expect(fired).toBe(false);

    // Inside KNIFE_DIST the held rounds bite back (auto trigger) while the
    // lure kites away from the committed chaser.
    const knife = crewWorld(190); // bot 3 → enemy = 150 px ≤ 170
    knife.mainTickCounter = 2;
    const c3 = knife.sprites[3]!.control;
    newBrain().tick(3, makeCtx(knife, { ammo: { ...CREW_AMMO, 3: 3 } }));
    expect(c3.fire).toBe(true);
    expect(c3.left).toBe(true); // pure-away kite (biter inside KITE_DRAG_MIN)
  });
});

describe('angler: the hunters', () => {
  it('prioritizes BITERS (closing on the lure) over a weaker non-biter', () => {
    const world = crewWorld();
    world.sprites[4]!.health = 50; // tempting kill-secure target...
    addBot(world, 5, { x: 300, y: 100, team: 2, vx: -3, vy: -1 }); // ...but THIS
    // one is diving at the lure (closing speed ≈ 3.2 px/tick > CHASE_VMIN).
    world.mainTickCounter = 2;
    const c1 = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world, { ammo: { ...CREW_AMMO } }));
    const aim = expectedAim(0, 0, 300, 100, -3, -1); // EMA_ALPHA 1: lead = velocity
    expect(c1.mouseAimX).toBe(aim.x);
    expect(c1.mouseAimY).toBe(aim.y);
    expect(c1.mouseAimX).not.toBe(390); // NOT the wounded non-biter
  });

  it('falls back to lowest health when no lure exists (biters need a lure)', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0, team: 1 });
    addBot(world, 2, { x: 20, y: 0, team: 1 }); // crew of two → lure disabled
    addBot(world, 4, { x: 390, y: 0, team: 2, health: 50 });
    addBot(world, 5, { x: 300, y: 100, team: 2, vx: -3, vy: -1 });
    world.mainTickCounter = 2;
    const c1 = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world, { ammo: { 1: 12, 2: 25 } }));
    expect(c1.mouseAimX).toBe(390); // kill-secure: the wounded enemy
  });

  it('reloads RARELY and IN PLACE (≤ SELF_RELOAD_AT, planted in the slot)', () => {
    const world = crewWorld();
    world.mainTickCounter = 2;
    const c1 = world.sprites[1]!.control;
    // Bot 1's left slot is 390−380=10, and it stands at 0: already in slot.
    newBrain().tick(1, makeCtx(world, { ammo: { 1: 5, 2: 25, 3: 2 } }));
    expect(c1.reload).toBe(true);
    expect(c1.left).toBe(false); // no fleeing reloader — the v2 lesson
    expect(c1.right).toBe(false);
  });
});

describe('angler: weigh-the-catch A/B audit', () => {
  // Drive the audit through its calibration windows by ticking the same
  // brain at chosen absolute clocks and staging health drops between ticks.
  function runAudit(world: World, ctx: BotEngineContext, lureModeWins: boolean) {
    const brain = newBrain();
    const c3 = world.sprites[3]!.control;

    world.mainTickCounter = 0; // window 0 (lure ON): baseline health capture
    brain.tick(3, ctx);
    if (lureModeWins) world.sprites[4]!.health -= 50; // enemy bleeds on the lure's watch
    else world.sprites[1]!.health -= 50; // crew bleeds on the lure's watch
    world.mainTickCounter = 1;
    brain.tick(3, ctx);

    if (lureModeWins) world.sprites[1]!.health -= 50; // crew bleeds in hunt mode
    else world.sprites[4]!.health -= 50; // enemy bleeds in hunt mode
    world.mainTickCounter = 481; // window 1 (lure OFF)
    brain.tick(3, ctx);

    // Past AB_WINDOWS·AUDIT_WINDOW = 1920 ticks AND a LURE_RETARGET multiple,
    // so the verdict re-picks the role.
    world.mainTickCounter = 1980;
    brain.tick(3, ctx);
    return c3;
  }

  it('commits to the lure when its windows out-earn the hunt windows', () => {
    const world = crewWorld();
    const c3 = runAudit(world, makeCtx(world, { ammo: { ...CREW_AMMO } }), true);
    // Verdict: lure net +50 beats hunt net −50 → bot 3 keeps dangling.
    expect(c3.left).toBe(false);
    expect(c3.right).toBe(false);
    expect(c3.jetpack).toBe(true);
  });

  it('cuts bait when the hunt windows out-earn the lure windows', () => {
    const world = crewWorld();
    const c3 = runAudit(world, makeCtx(world, { ammo: { ...CREW_AMMO } }), false);
    // Verdict: hunt wins → the lure converts to a third hunter and walks
    // its right bearing slot.
    expect(c3.right).toBe(true);
  });
});
