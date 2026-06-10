// "pilot" bot engine — the first-principles aerial brain (observation node
// 130: CS-pro play rotated into 2D + vertical).
//
// Where `classic` is a reactive distance-band automaton, pilot is built on
// the principles that make optimized human play work:
//
//   1. POSITIONING BEATS AIM — height is the angle. The pilot fights from
//      above: it climbs until it holds a height advantage, and gives ground
//      vertically rather than horizontally.
//   2. RANGE DISCIPLINE — it keeps the duel inside a chosen band (close
//      enough to hit, far enough that bullets are dodgeable), backing off
//      from brawls instead of face-tanking them.
//   3. MOVEMENT AS COUNTER-PREDICTION — while engaged it strafe-jukes on an
//      rng clock. The classic aim model leads targets assuming constant
//      velocity, so erratic acceleration is literally its counter.
//   4. ENGAGEMENT DISCIPLINE — mag state is tactical state: it reloads on
//      its own terms behind range, disengages while reloading, and re-enters
//      with a full mag.
//   5. MEMORY OVER OMNISCIENCE — when LOS breaks it hunts the last seen
//      position for a few seconds instead of instantly forgetting.
//   6. FUEL ECONOMY — it spends the tank to take height, never to hover dry;
//      below the reserve it perches and lets regen pay for the next climb.
//
// All randomness flows through world.rng (determinism), and the brain's only
// output is the bot's control — same contract as every engine.

import { findTarget } from '@soldat/sim';
import {
  createRoamState,
  roamTick,
  type BotBrain,
  type BotEngine,
  type BotEngineContext,
  type RoamState,
} from './engine';

// --- Tuning -----------------------------------------------------------------
const AK_BULLET_SPEED = 24.6; // px/tick (guns.ts AK74) — lead/drop math
const RANGE_MIN = 200; // px — closer than this: back off
const RANGE_MAX = 420; // px — farther: close in
const FIRE_MAX_DIST = 600; // px — don't waste mag beyond this
const HEIGHT_EDGE_MIN = 50; // px — minimum height advantage worth holding
const HEIGHT_EDGE_MAX = 220; // px — above this, stop climbing (overextended)
const FUEL_RESERVE = 130; // ticks — below this, perch and regen
const FUEL_COMMIT = 260; // ticks — needed to start an attack climb
const JUKE_MIN_TICKS = 18; // strafe-juke clock (rng-rolled per leg)
const JUKE_VAR_TICKS = 26;
const HUNT_MEMORY_TICKS = 240; // ~4 s of last-seen pursuit after losing LOS
const BURST_PERIOD = 14; // ticks — long-range fire discipline cycle
const BURST_OPEN = 5; // ticks of the period spent firing (tap-bursts)
// Ceiling-stall give-up (goal node 150): two pilots each demanding a height
// edge over the other is an unwinnable arms race that ends pinned to the
// ceiling. Burning jet without actually rising for this long means the climb
// is going nowhere — concede the height contest and fight from here.
const STALL_RISE_VY = -0.1; // rising at all = velocityY below this (y is down)
const STALL_TRIGGER = 25; // ticks of jetting-without-rising before giving up
const STALL_COOLDOWN = 180; // ticks (~3 s) with climbing suppressed

class PilotBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  private jukeDir: 1 | -1 = 1;
  private jukeFlipAt = 0;
  private lastSeenX = 0;
  private lastSeenY = 0;
  private lastSeenAt = -1;
  /** Consecutive ticks spent jetting without gaining altitude. */
  private stallTicks = 0;
  /** Climbing is conceded until this tick (ceiling-stall give-up). */
  private noClimbUntil = 0;

  tick(botIndex: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const s = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (s === undefined || parts === null) return;
    const c = s.control;

    this.decide(botIndex, ctx);

    // Ceiling-stall give-up: burning jet without rising means the climb is
    // blocked (geometry, or a symmetric height arms race with another
    // pilot). Concede: cut thrust and stop chasing height for a while —
    // gravity brings the duel back into the arena.
    const vy = parts.velocityY[botIndex] ?? 0;
    if (c.jetpack && vy >= STALL_RISE_VY) {
      this.stallTicks += 1;
    } else {
      this.stallTicks = 0;
    }
    if (this.stallTicks >= STALL_TRIGGER) {
      this.stallTicks = 0;
      this.noClimbUntil = world.mainTickCounter + STALL_COOLDOWN;
      c.jetpack = false;
    }
  }

  private decide(botIndex: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const s = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (s === undefined || parts === null) return;
    const c = s.control;

    // Engines own the whole control each tick (classic's updateBot clears
    // via freeControls; pilot does its own clear, preserving aim like the
    // Pascal convention so spray direction persists between decisions).
    c.left = false;
    c.right = false;
    c.up = false;
    c.down = false;
    c.fire = false;
    c.jetpack = false;
    c.reload = false;

    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const clock = world.mainTickCounter;

    const targetIdx = findTarget(world, botIndex);
    if (targetIdx > 0) {
      this.lastSeenX = parts.posX[targetIdx] ?? 0;
      this.lastSeenY = parts.posY[targetIdx] ?? 0;
      this.lastSeenAt = clock;
      this.engage(botIndex, targetIdx, ctx);
      return;
    }

    // MEMORY: lost LOS recently → hunt the last seen position.
    if (this.lastSeenAt >= 0 && clock - this.lastSeenAt < HUNT_MEMORY_TICKS) {
      if (px < this.lastSeenX - 40) c.right = true;
      else if (px > this.lastSeenX + 40) c.left = true;
      if (
        this.lastSeenY < py - HEIGHT_EDGE_MIN &&
        s.jetsCount > FUEL_RESERVE &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
      return;
    }

    // No target, no memory: patrol like everyone else.
    roamTick(this.roam, botIndex, ctx);
  }

  private engage(botIndex: number, targetIdx: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const s = world.sprites[botIndex]!;
    const c = s.control;
    const parts = world.spriteParts!;
    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const tx = parts.posX[targetIdx] ?? 0;
    const ty = parts.posY[targetIdx] ?? 0;
    const tvx = parts.velocityX[targetIdx] ?? 0;
    const tvy = parts.velocityY[targetIdx] ?? 0;
    const clock = world.mainTickCounter;

    const dx = tx - px;
    const dist = Math.hypot(dx, ty - py);
    const heightEdge = py < ty ? ty - py : -(py - ty); // + = I'm above

    // --- Engagement discipline: the mag decides the mode -------------------
    const ammo = ctx.ammoOf(botIndex);
    const reloading = ctx.reloadingOf(botIndex);
    if (!reloading && ammo === 0) c.reload = true;
    // Proactive reload: safely out of the duel band with a low mag.
    if (!reloading && ammo > 0 && ammo <= 6 && dist > RANGE_MAX) c.reload = true;

    if (reloading) {
      // DISENGAGE: open range away from the threat, keep/take height (going
      // up is safer than running on the floor), never return fire dry.
      if (dx > 0) c.left = true;
      else c.right = true;
      if (s.jetsCount > FUEL_RESERVE && clock >= this.noClimbUntil) {
        c.jetpack = true;
      }
      return;
    }

    // --- Positioning: hold the height edge, keep the range band ------------
    if (
      heightEdge < HEIGHT_EDGE_MIN &&
      s.jetsCount > (heightEdge < 0 ? FUEL_RESERVE : FUEL_COMMIT - 100) &&
      clock >= this.noClimbUntil
    ) {
      // Below or level: climb. Attacking from underneath is a losing duel.
      c.jetpack = true;
    } else if (heightEdge > HEIGHT_EDGE_MAX) {
      // Overextended above the fight: let gravity bring the angle back.
      c.down = true;
    }

    if (dist < RANGE_MIN) {
      // Too close: spread is free for the enemy here — give ground.
      if (dx > 0) c.left = true;
      else c.right = true;
    } else if (dist > RANGE_MAX) {
      if (dx > 0) c.right = true;
      else c.left = true;
    } else {
      // In the band: STRAFE-JUKE on an rng clock — erratic acceleration
      // defeats constant-velocity lead aim.
      if (clock >= this.jukeFlipAt) {
        this.jukeDir = world.rng.nextInt(2) === 0 ? 1 : -1;
        this.jukeFlipAt =
          clock + JUKE_MIN_TICKS + world.rng.nextInt(JUKE_VAR_TICKS);
      }
      if (this.jukeDir > 0) c.right = true;
      else c.left = true;
    }

    // --- Aim: lead with flight prediction + drop compensation --------------
    // Time-of-flight lead (dist / bullet speed) beats classic's fixed
    // 10-tick lead at most ranges. Drop compensation is plain ballistics:
    // the bullet falls ~½·g·tof² over the flight (g = 0.06 px/tick²), so aim
    // that much above the predicted position. (First duel-mode telemetry
    // caught a 60× overshoot here — 0.1% hit rate; the duel paid for itself
    // in its first minute.)
    const tof = dist / AK_BULLET_SPEED;
    const drop = 0.5 * 0.06 * tof * tof;
    const aimX = tx + tvx * tof - px;
    const aimY = ty + tvy * tof - py - drop;
    c.mouseAimX = Math.round(aimX);
    c.mouseAimY = Math.round(aimY);

    // --- Fire discipline ----------------------------------------------------
    if (dist > FIRE_MAX_DIST) return; // out of effective range: hold fire
    if (dist > RANGE_MAX) {
      // Long range: tap-burst so spray bloom recovers between bursts.
      c.fire = clock % BURST_PERIOD < BURST_OPEN;
    } else {
      c.fire = true;
    }
  }
}

export function createPilotEngine(): BotEngine {
  return {
    id: 'pilot',
    strategy: 'FIRST-PRINCIPLES AERIAL — take height, hold the range band, juke, reload behind cover',
    createBrain: (): BotBrain => new PilotBrain(),
  };
}
