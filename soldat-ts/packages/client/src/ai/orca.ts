// "orca" bot engine — the pod hunts the gap. The ninth doctrine.
//
// Two champions wrote the curriculum. The wolf (and the hydra after it)
// proved the TEAM is the unit of selection: three guns on one body win on
// arithmetic. The matador proved the MAGAZINE is the clock that rations
// damage: thirty rounds, then 95 ticks of helplessness, and whoever owns
// those ticks owns the duel. But each champion only learned half. The
// pack brains pick their prey by HEALTH — a number that says how close the
// kill is, not how cheap. The matador reads mag windows — and then dashes
// in alone. The orca's bet: the pod that synchronizes on the enemy's
// RELOAD CLOCK gets three-gun arithmetic precisely when the answer-fire is
// zero. League tape backs it — matador (solo mag-punish) is the only
// engine with a winning record against the hydra; orca is that punish with
// a pod behind it.
//
//   1. ONE CLOCK, ONE PREY — every pod member recomputes the shared prey
//      EVERY TICK from world state alone (stateless, agreement by
//      convention): among enemies visible to ANY pod member, a DISARMED one
//      (reloading, or mag at/below LOW_MAG_OPEN) within WAVE_REACH of the
//      pod centroid beats everything; ties by distance to the centroid.
//      No window open → fall back to the pack classic: lowest health, ties
//      by distance. Per-tick re-evaluation means the pod turns onto a
//      reload the tick it starts — the hydra's shared clock re-checks every
//      30; half a second of free convergence, every window.
//   2. THE WAVE — window open: every healthy pod member inside WAVE_REACH
//      drops the cape and dashes to point-blank, full-auto from WINDOW_AUTO
//      in (bloom is irrelevant against a gun that cannot answer). Three
//      mags against zero is not a trade, it is a harvest. Members out of
//      reach keep their own poke duel instead of sprinting across the map.
//   3. THE EBB — no window: refuse the brawl. Hold the matador poke band
//      (POKE_MIN..POKE_MAX), strafe-juke on an rng clock, cooldown-locked
//      taps with EMA lead and TRUE 0.135 drop. When the prey's mag runs low
//      (STALK_MAG) creep to STALK_DIST so the wave launches from next door.
//      Reload on the off-beat (their mag hot, us out of reach) so our
//      window opens with thirty rounds and theirs opens with none.
//   4. THE WOUNDED SWIM DEEP — the champion's own innovation, adopted with
//      thanks: the pod's lowest-health member under EBB_HEALTH skips the
//      wave and holds a long band (EBB_MIN..EBB_MAX off the enemy centroid,
//      taps to EBB_FIRE_MAX) — outside every published front-gun fire max.
//      A focus function keyed on argmin health starves; their three guns
//      land on full-health orcas at poke range; damage spreads, nobody dies.
//   5. NOTHING SWIMS THROUGH US — the kestrel closest-approach bullet dodge
//      (vertical-first, committed so it doesn't dither). The matador won
//      its hydra matches WITHOUT a dodge; the orca brings one to the rematch.
//   6. READ THE HARDWARE (v2, bought by the shrike spar) — in the band the
//      orca PLANTS and bobs (movement spread is a tax the juke kept paying
//      against planted kestrel guns); a SPAS prey counts as disarmed only
//      while actually RELOADING (four shells in a fan is not an open
//      window), and the wave brakes outside the fan's kill envelope; an
//      orca the wildcard arms with the SPAS closes to fan range and aims
//      with pellet ballistics instead of throwing 14 px/tick confetti from
//      the AK band.
//
// Height doctrine is the matador's (parity, not greed) and the ceiling-
// stall give-up is kept — both failure modes are proven.
//
// Same contract as every engine: output is the bot's control only, all
// randomness through world.rng.

import { findTarget, hasLineOfSight } from '@soldat/sim';
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
// Physics facts of the two guns (weapons/guns.ts), NOT strategy knobs.
const AK_BULLET_SPEED = 24.6; // px/tick — lead/drop math
const SPAS_BULLET_SPEED = 14; // px/tick — pellet lead/drop math

/** Orca's strategy knobs — every value is tweakable per match.
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type OrcaConfig = {
  POKE_MIN: number;
  POKE_MAX: number;
  FIRE_MAX_DIST: number;
  AUTO_RANGE: number;
  WINDOW_AUTO: number;
  PUNISH_RANGE: number;
  LOW_MAG_OPEN: number;
  WAVE_REACH: number;
  STALK_MAG: number;
  STALK_DIST: number;
  SELF_RELOAD_AT: number;
  EBB_HEALTH: number;
  EBB_MIN: number;
  EBB_MAX: number;
  EBB_FIRE_MAX: number;
  EBB_STUCK_TICKS: number;
  SPAS_STANDOFF: number;
  SPAS_FIRE_MAX: number;
  SPAS_AUTO: number;
  SPAS_STALK: number;
  FAN_RESPECT: number;
  EMA_ALPHA: number;
  DROP_G: number;
  TAP_PERIOD: number;
  TAP_OPEN: number;
  JUKE_MIN_TICKS: number;
  JUKE_VAR_TICKS: number;
  BOB_UP_TICKS: number;
  BOB_DOWN_MIN: number;
  BOB_DOWN_VAR: number;
  DODGE_HORIZON: number;
  DANGER_RADIUS: number;
  DODGE_COMMIT: number;
  LEVEL_BAND: number;
  HEIGHT_CAP: number;
  FUEL_RESERVE: number;
  FUEL_PUNISH_MIN: number;
  HUNT_MEMORY_TICKS: number;
  STALL_RISE_VY: number;
  STALL_TRIGGER: number;
  STALL_COOLDOWN: number;
};

export const ORCA_DEFAULTS: Readonly<OrcaConfig> = {
  POKE_MIN: 380, // px — hot-mag floor: outside typical full-auto bands, give ground inside
  POKE_MAX: 520, // px — farther: drift in (stay a live threat, keep the wave reachable)
  FIRE_MAX_DIST: 620, // px — beyond this, hold fire entirely (front guns)
  AUTO_RANGE: 230, // px — full-auto only inside this when no window (bloom is fatal farther)
  WINDOW_AUTO: 360, // px — window open: full-auto from here in (arrive WITH the mag —
  // spraying the whole dash feeds bloom at range and lands empty)
  PUNISH_RANGE: 120, // px — the wave dashes to this distance and stays
  LOW_MAG_OPEN: 4, // rounds — enemy AK mag at/below this opens the window early
  WAVE_REACH: 560, // px — windows farther than this don't move the pod (a 760px dash
  // under planted kestrel taps donated the approach; arrive alive instead)
  STALK_MAG: 11, // rounds — enemy mag at/below this starts the creep to STALK_DIST
  STALK_DIST: 250, // px — stalk standoff: the wave must launch from next door, not the band
  SELF_RELOAD_AT: 9, // rounds — off-beat reload threshold (only safe + their mag hot)
  EBB_HEALTH: 55, // health (of 150) — pod's argmin under this swims deep (skips the wave)
  EBB_MIN: 600, // px off the ENEMY centroid — outside published prey radii / front fire maxes
  EBB_MAX: 760, // px — farther: drift back toward the fight
  EBB_FIRE_MAX: 700, // px — the deep swimmer's planted taps reach this far
  EBB_STUCK_TICKS: 30, // ticks of no horizontal progress while opening range = climb out
  SPAS_STANDOFF: 330, // px — never brake the wave inside a SPAS prey's fan envelope
  SPAS_FIRE_MAX: 480, // px — own-SPAS: beyond this the pellets are halved rainbow, hold
  SPAS_AUTO: 300, // px — own-SPAS: full pulls inside the fan's kill envelope
  SPAS_STALK: 260, // px — own-SPAS standoff: live at the envelope's edge, not the AK band
  FAN_RESPECT: 360, // px — an ARMED enemy fan inside this overrides the prey: open
  // range and hose the carrier (the silent dive killed the v2 spar's shotgun games)
  EMA_ALPHA: 0.2, // per-tick velocity smoothing — bobbers and jukers average to center
  DROP_G: 0.135, // px/tick² — TRUE bullet gravity (GRAV 0.06 × 2.25)
  TAP_PERIOD: 6, // ticks — tap clock locked to the fire cooldown
  TAP_OPEN: 1, // one shot per period = max volume at zero bloom
  JUKE_MIN_TICKS: 0, // >0: strafe-juke in band on this rng clock instead of planting.
  // 0 (default): PLANT — the juke paid movement spread on every tap and the
  // planted shrike guns out-traded it 6-1-2 in the spar.
  JUKE_VAR_TICKS: 22,
  BOB_UP_TICKS: 12, // jet-pulse length of the planted hover bob (the untaxed axis)
  BOB_DOWN_MIN: 18, // fall phase length (rng-rolled per cycle)
  BOB_DOWN_VAR: 14,
  DODGE_HORIZON: 26, // ticks — only bullets arriving within this are threats
  DANGER_RADIUS: 56, // px — closest-approach distance that triggers a dodge
  DODGE_COMMIT: 6, // ticks — hold a dodge so it doesn't dither
  LEVEL_BAND: 50, // px — climb only when more than this below the target
  HEIGHT_CAP: 200, // px — never chase height past this edge (no ceiling races)
  FUEL_RESERVE: 110, // ticks — below this, no positional climbing; let regen pay
  FUEL_PUNISH_MIN: 40, // ticks — wave dashes still fly on fumes (mostly horizontal)
  HUNT_MEMORY_TICKS: 240, // ~4 s of last-seen pursuit after losing all eyes
  // Ceiling-stall give-up (proven failure mode, see pilot.ts node 150).
  STALL_RISE_VY: -0.1,
  STALL_TRIGGER: 25,
  STALL_COOLDOWN: 180,
};

class OrcaBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  private lastSeenX = 0;
  private lastSeenY = 0;
  private lastSeenAt = -1;
  /** EMA of the current gun target's velocity; reset on target switch. */
  private emaVX = 0;
  private emaVY = 0;
  private emaTarget = 0;
  /** In-band strafe-juke clock (used only when JUKE_MIN_TICKS > 0). */
  private jukeDir: 1 | -1 = 1;
  private jukeFlipAt = 0;
  /** Planted hover-bob phase clocks (the default band motion). */
  private bobJetUntil = 0;
  private bobFallUntil = 0;
  /** Committed bullet dodge. */
  private dodgeX: 1 | 0 | -1 = 0;
  private dodgeJet: 1 | 0 | -1 = 0;
  private dodgeUntil = 0;
  /** Deep-swim corner handling: climb out when fleeing into geometry. */
  private fleeStuck = 0;
  private stallTicks = 0;
  private noClimbUntil = 0;

  constructor(private readonly cfg: OrcaConfig) {}

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

  /** Pillar 6: the hardware check (absent host context = everyone on AK74). */
  private holdsSpas(idx: number, ctx: BotEngineContext): boolean {
    return ctx.weaponOf?.(idx) === 'SPAS12';
  }

  /** Nearest ARMED enemy SPAS carrier with line of sight inside FAN_RESPECT —
   *  the one threat that outranks the shared prey. A carrier mid-reload or
   *  dry is just a target; one with shells is a dive about to happen. */
  private fanThreat(botIndex: number, ctx: BotEngineContext): number {
    const { world } = ctx;
    const cfg = this.cfg;
    const self = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (self === undefined || parts === null) return 0;
    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const respectSq = cfg.FAN_RESPECT * cfg.FAN_RESPECT;
    let best = 0;
    let bestD = Infinity;
    for (let e = 1; e < world.sprites.length; e++) {
      if (e === botIndex) continue;
      const o = world.sprites[e];
      if (o === undefined || !o.active || o.deadMeat) continue;
      if (self.team > 0 && o.team === self.team) continue;
      if (o.alpha !== 255 && o.holdedThing === 0) continue;
      if (!this.holdsSpas(e, ctx)) continue;
      if (ctx.reloadingOf(e) || ctx.ammoOf(e) <= 0) continue;
      const ex = parts.posX[e] ?? 0;
      const ey = parts.posY[e] ?? 0;
      const dx = ex - px;
      const dy = ey - py;
      const d = dx * dx + dy * dy;
      if (d > respectSq || d >= bestD) continue;
      if (!hasLineOfSight(world, { x: px, y: py }, { x: ex, y: ey })) continue;
      bestD = d;
      best = e;
    }
    return best;
  }

  /** Band motion: plant-and-bob by default (vertical is the untaxed axis);
   *  strafe-juke only when the JUKE_MIN_TICKS knob asks for it. */
  private bandMotion(botIndex: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const cfg = this.cfg;
    const s = world.sprites[botIndex]!;
    const c = s.control;
    const clock = world.mainTickCounter;
    if (cfg.JUKE_MIN_TICKS > 0) {
      if (clock >= this.jukeFlipAt) {
        this.jukeDir = world.rng.nextInt(2) === 0 ? 1 : -1;
        this.jukeFlipAt =
          clock + cfg.JUKE_MIN_TICKS + world.rng.nextInt(cfg.JUKE_VAR_TICKS);
      }
      if (this.jukeDir > 0) c.right = true;
      else c.left = true;
      return;
    }
    if (s.jetsCount > cfg.FUEL_RESERVE && clock >= this.noClimbUntil) {
      if (clock >= this.bobFallUntil) {
        this.bobJetUntil = clock + cfg.BOB_UP_TICKS;
        this.bobFallUntil =
          this.bobJetUntil + cfg.BOB_DOWN_MIN + world.rng.nextInt(cfg.BOB_DOWN_VAR);
      }
      c.jetpack = clock < this.bobJetUntil;
    }
  }

  /** Living pod members (self included), ascending sprite index. */
  private podOf(botIndex: number, ctx: BotEngineContext): number[] {
    const { world } = ctx;
    const self = world.sprites[botIndex];
    if (self === undefined || self.team === 0) return [botIndex]; // FFA: a lone orca
    const pod: number[] = [];
    for (let i = 1; i < world.sprites.length; i++) {
      const s = world.sprites[i];
      if (s === undefined || !s.active || s.deadMeat) continue;
      if (s.team === self.team) pod.push(i);
    }
    return pod.length > 0 ? pod : [botIndex];
  }

  /** Pillar 4: who swims deep — STATELESS argmin health (ties by index),
   *  only when wounded below EBB_HEALTH and the pod can cover the front. */
  private deepOf(pod: readonly number[], ctx: BotEngineContext): number {
    if (pod.length < 2) return 0; // a lone orca has no pod to hide behind
    const { world } = ctx;
    let deep = 0;
    let low = Infinity;
    for (const i of pod) {
      const h = world.sprites[i]?.health ?? Infinity;
      if (h < low) {
        low = h;
        deep = i;
      }
    }
    return low < this.cfg.EBB_HEALTH ? deep : 0;
  }

  /** Pillar 1: the shared prey, recomputed stateless EVERY tick. A disarmed
   *  enemy (reloading / near-dry mag) within WAVE_REACH of the pod centroid
   *  beats everything; otherwise lowest health. Ties by centroid distance,
   *  then index — every pod member computes the same answer. */
  private pickPrey(botIndex: number, pod: readonly number[], ctx: BotEngineContext): number {
    const { world } = ctx;
    const cfg = this.cfg;
    const self = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (self === undefined || parts === null) return 0;
    let cx = 0;
    let cy = 0;
    for (const w of pod) {
      cx += parts.posX[w] ?? 0;
      cy += parts.posY[w] ?? 0;
    }
    cx /= pod.length;
    cy /= pod.length;
    const reachSq = cfg.WAVE_REACH * cfg.WAVE_REACH;

    let open = 0; // best disarmed prey (tier 0)
    let openD = Infinity;
    let fallback = 0; // best by health IN REACH (tier 1)
    let fbHealth = Infinity;
    let fbD = Infinity;
    let far = 0; // best by health beyond reach (tier 2 — never chase a
    let farHealth = Infinity; // withdrawn anchor past healthy guns)
    let farD = Infinity;
    for (let e = 1; e < world.sprites.length; e++) {
      if (e === botIndex) continue;
      const o = world.sprites[e];
      if (o === undefined || !o.active || o.deadMeat) continue;
      if (self.team > 0 && o.team === self.team) continue;
      if (o.alpha !== 255 && o.holdedThing === 0) continue;
      const ex = parts.posX[e] ?? 0;
      const ey = parts.posY[e] ?? 0;
      let seen = false;
      for (const w of pod) {
        const wx = parts.posX[w] ?? 0;
        const wy = parts.posY[w] ?? 0;
        if (hasLineOfSight(world, { x: wx, y: wy }, { x: ex, y: ey })) {
          seen = true;
          break;
        }
      }
      if (!seen) continue;
      const dx = ex - cx;
      const dy = ey - cy;
      const d = dx * dx + dy * dy;
      // A SPAS carrier is only disarmed while actually RELOADING — four
      // shells left in a fan is not an open window.
      const disarmed =
        ctx.reloadingOf(e) ||
        (!this.holdsSpas(e, ctx) && ctx.ammoOf(e) <= cfg.LOW_MAG_OPEN);
      if (disarmed && d <= reachSq && d < openD) {
        openD = d;
        open = e;
      }
      if (d <= reachSq) {
        if (o.health < fbHealth || (o.health === fbHealth && d < fbD)) {
          fbHealth = o.health;
          fbD = d;
          fallback = e;
        }
      } else if (o.health < farHealth || (o.health === farHealth && d < farD)) {
        farHealth = o.health;
        farD = d;
        far = e;
      }
    }
    // A wounded enemy parked beyond the fight (the hydra's anchor, the
    // cuadrilla's reserve) cannot drag the pod past healthy guns.
    if (open > 0) return open;
    return fallback > 0 ? fallback : far;
  }

  /** Centroid of living enemies, or null when none remain. */
  private enemyCentroid(
    botIndex: number,
    ctx: BotEngineContext,
  ): { x: number; y: number } | null {
    const { world } = ctx;
    const self = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (self === undefined || parts === null) return null;
    let x = 0;
    let y = 0;
    let n = 0;
    for (let e = 1; e < world.sprites.length; e++) {
      if (e === botIndex) continue;
      const o = world.sprites[e];
      if (o === undefined || !o.active || o.deadMeat) continue;
      if (self.team > 0 && o.team === self.team) continue;
      x += parts.posX[e] ?? 0;
      y += parts.posY[e] ?? 0;
      n += 1;
    }
    return n > 0 ? { x: x / n, y: y / n } : null;
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

    const clock = world.mainTickCounter;
    const cfg = this.cfg;
    const pod = this.podOf(botIndex, ctx);

    // Pillar 5: bullet threats override everything else's movement.
    this.scanBullets(botIndex, ctx);

    const prey = this.pickPrey(botIndex, pod, ctx);
    const deep = this.deepOf(pod, ctx);

    if (deep === botIndex) {
      this.deepTick(botIndex, prey, ctx);
    } else if (prey > 0) {
      this.engage(botIndex, prey, ctx);
    } else if (
      this.lastSeenAt >= 0 &&
      clock - this.lastSeenAt < cfg.HUNT_MEMORY_TICKS
    ) {
      const px = parts.posX[botIndex] ?? 0;
      const py = parts.posY[botIndex] ?? 0;
      if (px < this.lastSeenX - 40) c.right = true;
      else if (px > this.lastSeenX + 40) c.left = true;
      if (
        this.lastSeenY < py - cfg.LEVEL_BAND &&
        s.jetsCount > cfg.FUEL_RESERVE &&
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

  /** Pillar 4: the wounded swims deep — hold a long band off the ENEMY
   *  centroid, outside every front gun's fire max, and keep tap-sniping. */
  private deepTick(botIndex: number, prey: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const cfg = this.cfg;
    const s = world.sprites[botIndex]!;
    const c = s.control;
    const parts = world.spriteParts!;
    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const clock = world.mainTickCounter;

    const ecen = this.enemyCentroid(botIndex, ctx);
    if (ecen === null) {
      roamTick(this.roam, botIndex, ctx);
      return;
    }
    const d = Math.hypot(px - ecen.x, py - ecen.y);

    // Mag hygiene at range: reload freely — distance IS the safety.
    const ammo = ctx.ammoOf(botIndex);
    if (!ctx.reloadingOf(botIndex) && (ammo === 0 || ammo <= cfg.SELF_RELOAD_AT)) {
      c.reload = true;
    }

    if (d < cfg.EBB_MIN) {
      // Open range away from the enemy centroid; climb out when geometry
      // blocks the run (height is escape the chasers must pay fuel for).
      if (px >= ecen.x) c.right = true;
      else c.left = true;
      const vx = parts.velocityX[botIndex] ?? 0;
      if (Math.abs(vx) < 0.3) this.fleeStuck += 1;
      else this.fleeStuck = 0;
      if (
        (this.fleeStuck > cfg.EBB_STUCK_TICKS || d < cfg.EBB_MIN - 150) &&
        s.jetsCount > cfg.FUEL_PUNISH_MIN &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
    } else if (d > cfg.EBB_MAX) {
      // Too far to contribute: drift back toward the fight.
      if (px < ecen.x - 40) c.right = true;
      else if (px > ecen.x + 40) c.left = true;
    } else {
      // In the band: planted bob (or juke if the knob asks) while taps fly.
      this.bandMotion(botIndex, ctx);
    }

    // The deep gun: the shared prey when visible, else whatever findTarget
    // offers — long planted taps are free damage.
    const gun =
      prey > 0 &&
      hasLineOfSight(
        world,
        { x: px, y: py },
        { x: parts.posX[prey] ?? 0, y: parts.posY[prey] ?? 0 },
      )
        ? prey
        : findTarget(world, botIndex);
    if (gun > 0) {
      const deepMax = this.holdsSpas(botIndex, ctx) ? cfg.SPAS_FIRE_MAX : cfg.EBB_FIRE_MAX;
      this.aimAndFire(botIndex, gun, ctx, deepMax, 0);
    }
  }

  /** Pillar 5: closest-approach scan over live enemy bullets (vertical-first
   *  response — band bullets fly flat, the perpendicular is the untaxed axis;
   *  drop under-compensators shoot LOW, so rising widens their miss). */
  private scanBullets(botIndex: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const cfg = this.cfg;
    const clock = world.mainTickCounter;
    if (clock < this.dodgeUntil) return;
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
    this.dodgeX = 0;
    this.dodgeJet = 0;
    if (Math.abs(worstVX) >= Math.abs(worstVY)) {
      this.dodgeJet = worstMissY >= -8 ? 1 : -1;
    } else if (Math.abs(worstMissX) < 4) {
      this.dodgeX = world.rng.nextInt(2) === 0 ? 1 : -1;
    } else {
      this.dodgeX = worstMissX > 0 ? -1 : 1;
    }
    this.dodgeUntil = clock + cfg.DODGE_COMMIT;
  }

  /** Tap clock staggered per bot so the pod keeps rolling pressure. */
  private tapOpen(clock: number, botIndex: number): boolean {
    const cfg = this.cfg;
    return (clock + botIndex * 3) % cfg.TAP_PERIOD < cfg.TAP_OPEN;
  }

  /** EMA lead + two-pass time-of-flight + TRUE drop, then the trigger:
   *  full-auto inside `autoDist` (0 = never), cooldown-locked taps beyond. */
  private aimAndFire(
    botIndex: number,
    targetIdx: number,
    ctx: BotEngineContext,
    fireMax: number,
    autoDist: number,
  ): void {
    const { world } = ctx;
    const cfg = this.cfg;
    const s = world.sprites[botIndex]!;
    const c = s.control;
    const parts = world.spriteParts!;
    if (targetIdx <= 0) return;
    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const tx = parts.posX[targetIdx] ?? 0;
    const ty = parts.posY[targetIdx] ?? 0;
    const tvx = parts.velocityX[targetIdx] ?? 0;
    const tvy = parts.velocityY[targetIdx] ?? 0;
    const dist = Math.hypot(tx - px, ty - py);

    if (this.emaTarget !== targetIdx) {
      this.emaTarget = targetIdx;
      this.emaVX = tvx;
      this.emaVY = tvy;
    } else {
      this.emaVX += cfg.EMA_ALPHA * (tvx - this.emaVX);
      this.emaVY += cfg.EMA_ALPHA * (tvy - this.emaVY);
    }

    // Ballistics follow the gun in hand: SPAS pellets crawl at 14 px/tick.
    const speed = this.holdsSpas(botIndex, ctx) ? SPAS_BULLET_SPEED : AK_BULLET_SPEED;
    const tof0 = dist / speed;
    const px1 = tx + this.emaVX * tof0;
    const py1 = ty + this.emaVY * tof0;
    const tof = Math.hypot(px1 - px, py1 - py) / speed;
    const drop = 0.5 * cfg.DROP_G * tof * tof;
    c.mouseAimX = Math.round(tx + this.emaVX * tof - px);
    c.mouseAimY = Math.round(ty + this.emaVY * tof - py - drop);

    if (ctx.reloadingOf(botIndex)) return;
    if (dist > fireMax) return;
    if (!hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty })) return;
    if (dist <= autoDist) c.fire = true;
    else c.fire = this.tapOpen(world.mainTickCounter, botIndex);
  }

  /** Pillars 1-3: the shared prey duel — wave when the window is open,
   *  stalk when it's about to, hold the poke band while their mag is hot. */
  private engage(botIndex: number, preyIdx: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const cfg = this.cfg;
    const s = world.sprites[botIndex]!;
    const c = s.control;
    const parts = world.spriteParts!;
    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const tx = parts.posX[preyIdx] ?? 0;
    const ty = parts.posY[preyIdx] ?? 0;
    const clock = world.mainTickCounter;

    const dx = tx - px;
    const dist = Math.hypot(dx, ty - py);
    const heightEdge = ty - py; // + = I'm above the prey

    if (hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty })) {
      this.lastSeenX = tx;
      this.lastSeenY = ty;
      this.lastSeenAt = clock;
    }

    // The window and the stalk — the enemy's mag clock, read every tick.
    // Hardware-aware (pillar 6): a SPAS prey only opens while RELOADING, the
    // wave brakes outside its fan, and there is no stalk into fan range.
    const meSpas = this.holdsSpas(botIndex, ctx);
    const preySpas = this.holdsSpas(preyIdx, ctx);
    const windowOpen =
      ctx.reloadingOf(preyIdx) ||
      (!preySpas && ctx.ammoOf(preyIdx) <= cfg.LOW_MAG_OPEN);
    const inWave = windowOpen && dist <= cfg.WAVE_REACH;
    const punishStop = preySpas ? cfg.SPAS_STANDOFF : cfg.PUNISH_RANGE;
    const stalking =
      !windowOpen && !preySpas && ctx.ammoOf(preyIdx) <= cfg.STALK_MAG;

    // Own mag on the off-beat: reload in the calm so OUR window never opens
    // under pressure; never volunteer a dry mag into an opening window.
    const ammo = ctx.ammoOf(botIndex);
    const reloading = ctx.reloadingOf(botIndex);
    if (!reloading && ammo === 0) c.reload = true;
    if (!reloading && ammo > 0 && ammo <= cfg.SELF_RELOAD_AT && !windowOpen && !stalking && dist > cfg.POKE_MIN) {
      // Safe means safe from EVERYONE: a pack that hunts reload windows
      // (ours is not the only one anymore) watches all six mags — never
      // open a window with any enemy gun inside the band.
      const nearest = findTarget(world, botIndex);
      let nearestDist = Infinity;
      if (nearest > 0) {
        const nx = parts.posX[nearest] ?? 0;
        const ny = parts.posY[nearest] ?? 0;
        nearestDist = Math.hypot(nx - px, ny - py);
      }
      if (nearestDist > cfg.POKE_MIN) c.reload = true;
    }

    if (reloading) {
      // Caught mid-reload: open range, take what height is cheap, stay dark.
      if (dx > 0) c.left = true;
      else c.right = true;
      if (s.jetsCount > cfg.FUEL_RESERVE && clock >= this.noClimbUntil) {
        c.jetpack = true;
      }
      return;
    }

    // THE FAN COMES FIRST: an armed enemy SPAS inside FAN_RESPECT outranks
    // the shared prey — it has to close to its kill envelope to matter, so
    // back away from IT (not the prey) and hose it on the way in.
    if (!meSpas) {
      const fan = this.fanThreat(botIndex, ctx);
      if (fan > 0) {
        const fx = parts.posX[fan] ?? 0;
        if (fx > px) c.left = true;
        else c.right = true;
        if (
          (parts.posY[fan] ?? 0) < py - cfg.LEVEL_BAND &&
          s.jetsCount > cfg.FUEL_PUNISH_MIN &&
          clock >= this.noClimbUntil
        ) {
          c.jetpack = true; // the dive comes from above — don't sit under it
        }
        this.aimAndFire(botIndex, fan, ctx, cfg.FIRE_MAX_DIST, cfg.AUTO_RANGE);
        return;
      }
    }

    // --- Movement -----------------------------------------------------------
    if (meSpas) {
      // OWN-SPAS: the AK band wastes the fan. Live at the envelope's edge —
      // close to SPAS_STALK regardless of their mag, bob there, fire inside
      // the kill envelope only. The pod's AK guns keep the band honest.
      // When a window opens, the carrier IS the wave: six shells into a gun
      // that cannot answer is the best trade on the field.
      const diving = inWave && !preySpas;
      const spasStop = diving ? cfg.PUNISH_RANGE : cfg.SPAS_STALK;
      if (dist > spasStop) {
        if (dx > 0) c.right = true;
        else c.left = true;
      } else if (!diving) {
        this.bandMotion(botIndex, ctx);
      }
      if (
        heightEdge < -cfg.LEVEL_BAND &&
        s.jetsCount > cfg.FUEL_PUNISH_MIN &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
    } else if (inWave) {
      // THE WAVE: their gun is down and the pod is close. Dash to point-blank
      // and stay — every tick inside the window is free damage, times three.
      // (Point-blank means OUTSIDE the fan when the prey holds a SPAS — it
      // finishes that reload with six fresh shells.)
      if (dist > punishStop) {
        if (dx > 0) c.right = true;
        else c.left = true;
      }
      if (heightEdge < -30 && s.jetsCount > cfg.FUEL_PUNISH_MIN && clock >= this.noClimbUntil) {
        c.jetpack = true;
      }
    } else if (stalking) {
      // THE STALK: their mag is running out. Creep to striking distance so
      // the wave launches from next door, not from the band.
      if (dist > cfg.STALK_DIST) {
        if (dx > 0) c.right = true;
        else c.left = true;
      } else {
        this.bandMotion(botIndex, ctx);
      }
      if (
        heightEdge < -cfg.LEVEL_BAND &&
        s.jetsCount > cfg.FUEL_PUNISH_MIN &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
    } else {
      // HOT MAG: refuse the duel. Hold the poke band, plant, tap.
      if (dist < cfg.POKE_MIN) {
        if (dx > 0) c.left = true;
        else c.right = true;
      } else if (dist > cfg.POKE_MAX) {
        if (dx > 0) c.right = true;
        else c.left = true;
      } else {
        this.bandMotion(botIndex, ctx);
      }

      // Height parity, not height greed.
      if (
        heightEdge < -cfg.LEVEL_BAND &&
        s.jetsCount > cfg.FUEL_RESERVE &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true; // erase the deficit — never duel from the pit
      } else if (heightEdge > cfg.HEIGHT_CAP) {
        c.down = true; // overextended above: let gravity spend instead of fuel
      }
    }

    // --- Gun ------------------------------------------------------------------
    // The shared prey when shootable, else the nearest visible threat — a bot
    // that walks toward its prey while an un-focused enemy shoots it for free
    // is the lesson every pack brain before this one paid for.
    const fireMax = meSpas ? cfg.SPAS_FIRE_MAX : cfg.FIRE_MAX_DIST;
    const autoDist = meSpas
      ? cfg.SPAS_AUTO
      : inWave
        ? cfg.WINDOW_AUTO
        : cfg.AUTO_RANGE;
    const preyShootable =
      dist <= fireMax && hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty });
    if (preyShootable) {
      this.aimAndFire(botIndex, preyIdx, ctx, fireMax, autoDist);
    } else {
      const seen = findTarget(world, botIndex);
      if (seen > 0) this.aimAndFire(botIndex, seen, ctx, fireMax, autoDist);
    }
  }
}

export function createOrcaEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('orca', ORCA_DEFAULTS, tweaks);
  return {
    id: 'orca',
    strategy:
      'THE POD HUNTS THE GAP — shared prey picked by mag vulnerability, three-gun wave the tick a reload starts, poke bands while their mags are hot',
    tweaks: cfg,
    createBrain: (): BotBrain => new OrcaBrain(cfg),
  };
}
