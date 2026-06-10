// "reaper" bot engine — the dive brawler (goal node 163), designed as the
// COUNTER to pilot's doctrine.
//
// Pilot wins by holding a 200-420px range band with a height edge: at that
// distance its tap-bursts stay accurate, its jukes have time to defeat lead
// aim, and its disengage-reload rhythm never gets interrupted. The counter
// is to DENY the band:
//
//   1. RELENTLESS GAP-CLOSE — the reaper converges at all times. Every tick
//      spent at pilot's preferred range is a tick lost; every tick inside
//      150px is a tick won (spray bloom is free at knife range, and a juke
//      that defeats lead-aim at 300px moves you two degrees at 80px).
//   2. DIVE ENTRY — approach ABOVE the target and fall onto it with jets
//      cut: a diving reaper accelerates under gravity (harder to lead than
//      any juke) and arrives with a full tank for the exit climb.
//   3. KNIFE-RANGE COMMITMENT — inside the kill circle it never retreats:
//      full-auto, push THROUGH the target, reload only on a dry mag. Half
//      measures re-open the range and hand the duel back to the band.
//   4. ERRATIC APPROACH — the run-in crosses pilot's kill band, so the
//      approach jitters on an rng clock (net motion still inbound).
//
// Same contract as every engine: output is the bot's control only, all
// randomness through world.rng.

import { findTarget } from '@soldat/sim';
import {
  createRoamState,
  resolveTweaks,
  roamTick,
  type BotBrain,
  type BotEngine,
  type BotEngineContext,
  type EngineTweaks,
  type RoamState,
} from './engine';

// --- Tuning -----------------------------------------------------------------
// Physics fact of the gun (guns.ts AK74), NOT a strategy knob — stays a const.
const AK_BULLET_SPEED = 24.6; // px/tick — lead/drop math (AK74)

/** Reaper's strategy knobs — every value is tweakable per match (node 170).
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type ReaperConfig = {
  KILL_RANGE: number;
  FIRE_RANGE: number;
  DIVE_HEIGHT: number;
  DIVE_ENTRY_DIST: number;
  JITTER_MIN_TICKS: number;
  JITTER_VAR_TICKS: number;
  JITTER_ODDS: number;
  FUEL_FLOOR: number;
  HUNT_MEMORY_TICKS: number;
  STALL_RISE_VY: number;
  STALL_TRIGGER: number;
  STALL_COOLDOWN: number;
};

export const REAPER_DEFAULTS: Readonly<ReaperConfig> = {
  KILL_RANGE: 180, // px — inside this: committed, full-auto, push through
  FIRE_RANGE: 460, // px — return fire on the run-in (eating pokes for free lost round 1)
  DIVE_HEIGHT: 200, // px — approach ABOVE pilot's preferred height edge
  DIVE_ENTRY_DIST: 260, // px — inside this with height: cut jets and FALL on them
  JITTER_MIN_TICKS: 12, // approach-jitter clock (rng-rolled per leg)
  JITTER_VAR_TICKS: 18,
  JITTER_ODDS: 3, // 1-in-N legs jitter AGAINST the approach direction
  FUEL_FLOOR: 60, // ticks — even a brawler won't strand a bone-dry tank
  HUNT_MEMORY_TICKS: 300, // ~5 s pursuit — reapers chase harder than pilots
  // Ceiling-stall give-up (same failure mode as pilot, node 150): burning jet
  // without rising means the climb is blocked — concede and fight from here.
  STALL_RISE_VY: -0.1,
  STALL_TRIGGER: 25,
  STALL_COOLDOWN: 150,
};

class ReaperBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  private jitterDir: 1 | -1 = 1;
  private jitterFlipAt = 0;
  private lastSeenX = 0;
  private lastSeenY = 0;
  private lastSeenAt = -1;
  private stallTicks = 0;
  private noClimbUntil = 0;

  constructor(private readonly cfg: ReaperConfig) {}

  tick(botIndex: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const s = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (s === undefined || parts === null) return;
    const c = s.control;

    this.decide(botIndex, ctx);

    // Ceiling-stall give-up (see pilot.ts — symmetric arms races end pinned
    // to the slab; concede and let gravity restart the fight).
    const vy = parts.velocityY[botIndex] ?? 0;
    if (c.jetpack && vy >= this.cfg.STALL_RISE_VY) {
      this.stallTicks += 1;
    } else {
      this.stallTicks = 0;
    }
    if (this.stallTicks >= this.cfg.STALL_TRIGGER) {
      this.stallTicks = 0;
      this.noClimbUntil = world.mainTickCounter + this.cfg.STALL_COOLDOWN;
      c.jetpack = false;
    }
  }

  private decide(botIndex: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const s = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (s === undefined || parts === null) return;
    const c = s.control;

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

    // Chase the last sighting hard — a brawler hunts, it doesn't patrol.
    const cfg = this.cfg;
    if (this.lastSeenAt >= 0 && clock - this.lastSeenAt < cfg.HUNT_MEMORY_TICKS) {
      if (px < this.lastSeenX - 30) c.right = true;
      else if (px > this.lastSeenX + 30) c.left = true;
      if (
        this.lastSeenY < py - 40 &&
        s.jetsCount > cfg.FUEL_FLOOR &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
      return;
    }

    roamTick(this.roam, botIndex, ctx);
  }

  private engage(botIndex: number, targetIdx: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const cfg = this.cfg;
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
    const above = ty - py; // + = I'm above the target
    const inbound: 1 | -1 = dx > 0 ? 1 : -1;

    // Mag discipline, brawler edition: reload ONLY when dry. Anything else
    // is time spent not closing.
    if (!ctx.reloadingOf(botIndex) && ctx.ammoOf(botIndex) === 0) {
      c.reload = true;
    }

    // --- Movement: converge, always ---------------------------------------
    if (dist <= cfg.KILL_RANGE) {
      // COMMITTED: push THROUGH the target — overshooting keeps the fight at
      // zero range and forces the disengager to spend fuel, not us.
      if (inbound > 0) c.right = true;
      else c.left = true;
      if (above < -30 && s.jetsCount > cfg.FUEL_FLOOR && clock >= this.noClimbUntil) {
        c.jetpack = true; // below them: jet up into their feet
      }
    } else {
      // APPROACH: net motion inbound with rng jitter so the run-in across
      // the enemy's kill band doesn't track a straight, leadable line.
      if (clock >= this.jitterFlipAt) {
        this.jitterDir =
          world.rng.nextInt(cfg.JITTER_ODDS) === 0 ? (-inbound as 1 | -1) : inbound;
        this.jitterFlipAt =
          clock + cfg.JITTER_MIN_TICKS + world.rng.nextInt(cfg.JITTER_VAR_TICKS);
      }
      if (this.jitterDir > 0) c.right = true;
      else c.left = true;

      // DIVE GEOMETRY: hold DIVE_HEIGHT above the target on the way in; once
      // close, cut the jets and fall onto them (gravity is the best juke).
      const wantHeight = above < cfg.DIVE_HEIGHT - 40;
      const diving = dist <= cfg.DIVE_ENTRY_DIST && above >= 40;
      if (
        !diving &&
        wantHeight &&
        s.jetsCount > cfg.FUEL_FLOOR &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
      // (diving: no jets, no down — freefall converges by itself.)
    }

    // --- Aim: time-of-flight lead + ballistic drop (short flights → tiny) --
    const tof = dist / AK_BULLET_SPEED;
    const drop = 0.5 * 0.06 * tof * tof;
    c.mouseAimX = Math.round(tx + tvx * tof - px);
    c.mouseAimY = Math.round(ty + tvy * tof - py - drop);

    // --- Fire: never on the long run-in, always inside the circle ----------
    if (dist <= cfg.FIRE_RANGE) {
      c.fire = true; // bloom is irrelevant where the reaper fights
    }
  }
}

export function createReaperEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('reaper', REAPER_DEFAULTS, tweaks);
  return {
    id: 'reaper',
    strategy:
      'DIVE BRAWLER — close the gap, drop from above, fight at knife range, never retreat',
    tweaks: cfg,
    createBrain: (): BotBrain => new ReaperBrain(cfg),
  };
}
