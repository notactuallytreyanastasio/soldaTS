// "kestrel" bot engine — the wind-hover marksman, a doctrine derived from the
// fire model itself (game.ts tryFire), not from the other brains.
//
// A kestrel is the falcon that hunts by holding still in the air and striking
// with total precision. The tape says accuracy already decides fights (pilot's
// 44% hit rate beat reaper's 33% every series) — so read what the fire model
// actually taxes and refuse to pay any of it:
//
//   1. AIM IS THE RESOURCE — spread = base + spray bloom + a 0.06 rad penalty
//      whenever |vx| > 3. Every incumbent strafe-jukes WHILE firing and pays
//      that tax on every round. The kestrel PLANTS to shoot: near-zero
//      horizontal velocity, taps synced to the fire cooldown so bloom decays
//      fully between rounds (~85% of full-auto rate at tap accuracy).
//   2. DODGE IN THE FREE AXIS — the movement tax reads |vx| only; vertical
//      speed is spread-free. While planted the kestrel BOBS on jet pulses:
//      constantly accelerating up or down, so constant-velocity lead (and even
//      smoothed lead) meets a target whose vy is stale by fire time. A ~1/3
//      jet duty cycle holds altitude AND nets fuel back (burn 1/tick vs air
//      regen 1/tick on off-ticks).
//   3. SEE THE BULLETS — live rounds are readable world state (world.bullets +
//      world.bulletParts). The kestrel dodges only bullets whose closest
//      approach actually threatens it, instead of paying the move tax on a
//      blind rng clock. No inbound bullet → stand still and shoot straight.
//   4. AIM AT THE TRUTH — lead with an EMA of target velocity (jukes average
//      to their center; straight movers converge in ticks) and compensate drop
//      with the REAL bullet gravity (GRAV 0.06 × 2.25 = 0.135 px/tick² —
//      pilot/reaper/matador all compensate 0.06 and shoot ~7px low at range).
//   5. BAND + MAG HYGIENE — hold a band just outside the incumbents' brawl
//      ranges, reload early behind range, disengage while reloading. Proven
//      pilot fundamentals; no need to relearn them.
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
const AK_BULLET_SPEED = 24.6; // px/tick — lead/drop math

/** Kestrel's strategy knobs — every value is tweakable per match.
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type KestrelConfig = {
  BAND_MIN: number;
  BAND_MAX: number;
  FIRE_MAX_DIST: number;
  APPROACH_FIRE_DIST: number;
  KNIFE_DIST: number;
  TAP_PERIOD: number;
  TAP_OPEN: number;
  EMA_ALPHA: number;
  DROP_G: number;
  BOB_UP_TICKS: number;
  BOB_DOWN_MIN: number;
  BOB_DOWN_VAR: number;
  DODGE_HORIZON: number;
  DANGER_RADIUS: number;
  DODGE_COMMIT: number;
  HEIGHT_SLACK: number;
  FUEL_FLOOR: number;
  RELOAD_LOW: number;
  HUNT_MEMORY_TICKS: number;
  STALL_RISE_VY: number;
  STALL_TRIGGER: number;
  STALL_COOLDOWN: number;
};

export const KESTREL_DEFAULTS: Readonly<KestrelConfig> = {
  BAND_MIN: 240, // px — closer: give ground (their bloom stops mattering)
  BAND_MAX: 430, // px — farther: close in (sit outside pilot's 360 brawl cap)
  FIRE_MAX_DIST: 600, // px — beyond this, hold fire entirely
  APPROACH_FIRE_DIST: 460, // px — taps allowed while repositioning inside this
  KNIFE_DIST: 170, // px — inside: fire every open tick and back out
  TAP_PERIOD: 7, // ticks — tap clock (fire cooldown is 6; 7 absorbs phase slip)
  TAP_OPEN: 2, // fire ticks per period (bloom decays 0.05/idle-tick — stays ~0)
  EMA_ALPHA: 0.15, // per-tick velocity smoothing (jukes average to center)
  DROP_G: 0.135, // px/tick² — TRUE bullet gravity (GRAV 0.06 × 2.25)
  BOB_UP_TICKS: 12, // jet-pulse length of the hover bob
  BOB_DOWN_MIN: 18, // fall phase length (rng-rolled per cycle)
  BOB_DOWN_VAR: 14,
  DODGE_HORIZON: 26, // ticks — only bullets arriving within this are threats
  DANGER_RADIUS: 56, // px — closest-approach distance that triggers a dodge
  DODGE_COMMIT: 6, // ticks — hold a dodge so it doesn't dither tick-to-tick
  HEIGHT_SLACK: 110, // px — fight level happily; fix only deep height deficits
  FUEL_FLOOR: 80, // ticks — below this: no bob/climb, let regen pay
  RELOAD_LOW: 6, // rounds — reload early once safely outside the band
  HUNT_MEMORY_TICKS: 240, // ~4 s of last-seen pursuit after losing LOS
  // Ceiling-stall give-up (proven failure mode, see pilot.ts node 150).
  STALL_RISE_VY: -0.1,
  STALL_TRIGGER: 25,
  STALL_COOLDOWN: 180,
};

class KestrelBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  private lastSeenX = 0;
  private lastSeenY = 0;
  private lastSeenAt = -1;
  /** EMA of the current target's velocity (pillar 4); reset on target switch. */
  private emaVX = 0;
  private emaVY = 0;
  private emaTarget = 0;
  /** Hover-bob phase: jetting until bobJetUntil, then falling until bobFallUntil. */
  private bobJetUntil = 0;
  private bobFallUntil = 0;
  /** Committed dodge (pillar 3): horizontal sign, vertical intent, expiry. */
  private dodgeX: 1 | 0 | -1 = 0;
  private dodgeJet: 1 | 0 | -1 = 0; // 1 = jet up, -1 = cut jets and fall
  private dodgeUntil = 0;
  private stallTicks = 0;
  private noClimbUntil = 0;

  constructor(private readonly cfg: KestrelConfig) {}

  tick(botIndex: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const s = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (s === undefined || parts === null) return;
    const c = s.control;

    this.decide(botIndex, ctx);

    // Ceiling-stall give-up (see pilot.ts — symmetric height arms races end
    // pinned to the slab; concede and let gravity restart the fight).
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

    // Pillar 3 first: bullet threats override everything else's movement.
    this.scanBullets(botIndex, ctx);

    const targetIdx = findTarget(world, botIndex);
    if (targetIdx > 0) {
      this.lastSeenX = parts.posX[targetIdx] ?? 0;
      this.lastSeenY = parts.posY[targetIdx] ?? 0;
      this.lastSeenAt = clock;
      this.engage(botIndex, targetIdx, ctx);
    } else if (
      this.lastSeenAt >= 0 &&
      clock - this.lastSeenAt < this.cfg.HUNT_MEMORY_TICKS
    ) {
      // MEMORY: lost LOS recently → hunt the last seen position.
      if (px < this.lastSeenX - 40) c.right = true;
      else if (px > this.lastSeenX + 40) c.left = true;
      if (
        this.lastSeenY < py - this.cfg.HEIGHT_SLACK &&
        s.jetsCount > this.cfg.FUEL_FLOOR &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
    } else {
      roamTick(this.roam, botIndex, ctx);
    }

    // Apply the committed dodge LAST: survival movement beats positioning.
    if (clock < this.dodgeUntil) {
      if (this.dodgeX !== 0) {
        c.left = this.dodgeX < 0;
        c.right = this.dodgeX > 0;
      }
      if (this.dodgeJet > 0 && s.jetsCount > 0) c.jetpack = true;
      else if (this.dodgeJet < 0) c.jetpack = false;
    }
  }

  /** Closest-approach scan over live enemy bullets; commits a dodge if any
   *  round passes inside DANGER_RADIUS within DODGE_HORIZON ticks. */
  private scanBullets(botIndex: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const cfg = this.cfg;
    const clock = world.mainTickCounter;
    if (clock < this.dodgeUntil) return; // ride out the committed dodge
    const bp = world.bulletParts;
    const parts = world.spriteParts;
    if (bp === null || parts === null) return;
    const me = world.sprites[botIndex];
    if (me === undefined) return;
    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;

    let worstMissX = 0;
    let worstMissY = 0;
    let worstVX = 0;
    let worstVY = 0;
    let worstMiss = cfg.DANGER_RADIUS;
    for (let i = 1; i < world.bullets.length; i++) {
      const b = world.bullets[i];
      if (b === undefined || !b.active) continue;
      if (b.owner === botIndex) continue;
      const owner = world.sprites[b.owner];
      if (owner !== undefined && me.team > 0 && owner.team === me.team) continue;
      const rx = (bp.posX[b.num] ?? 0) - px;
      const ry = (bp.posY[b.num] ?? 0) - py;
      const vx = bp.velocityX[b.num] ?? 0;
      const vy = bp.velocityY[b.num] ?? 0;
      const v2 = vx * vx + vy * vy;
      if (v2 < 1e-6) continue;
      const tStar = -(rx * vx + ry * vy) / v2;
      if (tStar <= 0 || tStar > cfg.DODGE_HORIZON) continue;
      const mx = rx + vx * tStar;
      const my = ry + vy * tStar;
      const miss = Math.hypot(mx, my);
      if (miss < worstMiss) {
        worstMiss = miss;
        worstMissX = mx;
        worstMissY = my;
        worstVX = vx;
        worstVY = vy;
      }
    }

    if (worstMiss >= cfg.DANGER_RADIUS) return;
    // Dodge PERPENDICULAR to the bullet's path, in the axis that escapes it.
    // Band bullets fly mostly horizontally, so the perpendicular is VERTICAL —
    // which the move-spread tax doesn't read. Stepping sideways against a
    // horizontal bullet barely changes the miss AND taxes every shot fired
    // during the dodge (match 1 vs VEGA: triple full-auto kept the old
    // horizontal dodge live nonstop and burned the whole plant edge).
    this.dodgeX = 0;
    this.dodgeJet = 0;
    if (Math.abs(worstVX) >= Math.abs(worstVY)) {
      // Shallow bullet → vertical escape. Passing below (or dead-on) → jet
      // up; the incumbents compensate drop at 0.06 against real 0.135, so
      // their rounds arrive LOW — rising widens their systematic miss.
      this.dodgeJet = worstMissY >= -8 ? 1 : -1;
    } else {
      // Steep bullet (a diver's plunge fire) → horizontal step away.
      if (Math.abs(worstMissX) < 4) {
        this.dodgeX = world.rng.nextInt(2) === 0 ? 1 : -1;
      } else {
        this.dodgeX = worstMissX > 0 ? -1 : 1;
      }
    }
    this.dodgeUntil = clock + cfg.DODGE_COMMIT;
  }

  /** Tap clock (pillar 1): staggered per bot so a team keeps rolling pressure. */
  private tapOpen(clock: number, botIndex: number): boolean {
    const cfg = this.cfg;
    return (clock + botIndex * 3) % cfg.TAP_PERIOD < cfg.TAP_OPEN;
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
    const heightEdge = ty - py; // + = I'm above the target

    // --- Pillar 4: smoothed lead — EMA the target's velocity ----------------
    if (this.emaTarget !== targetIdx) {
      this.emaTarget = targetIdx;
      this.emaVX = tvx;
      this.emaVY = tvy;
    } else {
      this.emaVX += cfg.EMA_ALPHA * (tvx - this.emaVX);
      this.emaVY += cfg.EMA_ALPHA * (tvy - this.emaVY);
    }

    // --- Mag hygiene ---------------------------------------------------------
    const ammo = ctx.ammoOf(botIndex);
    const reloading = ctx.reloadingOf(botIndex);
    if (!reloading && ammo === 0) c.reload = true;
    if (!reloading && ammo > 0) {
      // Reload early on MY terms: safely behind the band, or nearly dry.
      if (
        (ammo <= cfg.RELOAD_LOW && dist > cfg.BAND_MAX) ||
        (ammo <= 2 && dist > cfg.KNIFE_DIST)
      ) {
        c.reload = true;
      }
    }

    if (reloading) {
      // DISENGAGE: open range, take cheap height, never linger planted.
      if (dx > 0) c.left = true;
      else c.right = true;
      if (s.jetsCount > cfg.FUEL_FLOOR && clock >= this.noClimbUntil) {
        c.jetpack = true;
      }
      return;
    }

    // --- Movement: plant in the band, bob in the free axis ------------------
    const planted = dist >= cfg.BAND_MIN && dist <= cfg.BAND_MAX;
    if (dist > cfg.BAND_MAX) {
      // Close in. Fix only DEEP height deficits — no altitude vanity.
      if (dx > 0) c.right = true;
      else c.left = true;
      if (
        heightEdge < -cfg.HEIGHT_SLACK &&
        s.jetsCount > cfg.FUEL_FLOOR &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
    } else if (dist < cfg.BAND_MIN) {
      // Too close: give ground. The shorter the range, the less their bloom
      // costs them — re-open the gap where tap accuracy is the whole game.
      if (dx > 0) c.left = true;
      else c.right = true;
    } else {
      // PLANTED (pillars 1+2): no horizontal input — |vx| decays under the
      // move-spread threshold — and a jet-pulse bob so vy never sits still.
      if (s.jetsCount > cfg.FUEL_FLOOR && clock >= this.noClimbUntil) {
        if (heightEdge < -cfg.HEIGHT_SLACK) {
          c.jetpack = true; // deep below: spend the bob budget on climbing
        } else {
          if (clock >= this.bobFallUntil) {
            // New cycle: jet phase, then an rng-rolled fall phase.
            this.bobJetUntil = clock + cfg.BOB_UP_TICKS;
            this.bobFallUntil =
              this.bobJetUntil + cfg.BOB_DOWN_MIN + world.rng.nextInt(cfg.BOB_DOWN_VAR);
          }
          c.jetpack = clock < this.bobJetUntil;
        }
      }
    }

    // --- Aim: EMA lead, two-pass time-of-flight, TRUE ballistic drop --------
    const tof0 = dist / AK_BULLET_SPEED;
    const px1 = tx + this.emaVX * tof0;
    const py1 = ty + this.emaVY * tof0;
    const tof = Math.hypot(px1 - px, py1 - py) / AK_BULLET_SPEED;
    const drop = 0.5 * cfg.DROP_G * tof * tof;
    c.mouseAimX = Math.round(tx + this.emaVX * tof - px);
    c.mouseAimY = Math.round(ty + this.emaVY * tof - py - drop);

    // --- Fire discipline: always tap (full-auto never beats the tap clock) --
    if (dist > cfg.FIRE_MAX_DIST) return;
    if (!planted && dist > cfg.APPROACH_FIRE_DIST) return; // moving + far: hold
    c.fire = this.tapOpen(clock, botIndex);
  }
}

export function createKestrelEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('kestrel', KESTREL_DEFAULTS, tweaks);
  return {
    id: 'kestrel',
    strategy:
      'WIND-HOVER MARKSMAN — plant to shoot (movement spread is a tax), bob in the untaxed vertical axis, dodge the bullets you can see, lead with smoothed velocity and true drop',
    tweaks: cfg,
    createBrain: (): BotBrain => new KestrelBrain(cfg),
  };
}
