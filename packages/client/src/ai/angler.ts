// "angler" bot engine — the lure that fishes the meta, the thirteenth doctrine.
//
// The modern doctrines (cuadrilla, orca) won the belt by keying target
// selection — and their strongest play, the all-in pass/wave — off the
// enemy's PUBLISHED mag state: a reloading or near-dry enemy is "open" and
// the whole crew converges. The angler weaponizes that arithmetic instead
// of defending against it:
//
//   1. THE LURE — one crew member deliberately burns its mag down to a held
//      floor (LURE_HOLD_AT rounds) and then NEVER reloads. To every
//      mag-keyed selector on the field it reads "open" forever: the bait
//      cannot be un-dangled. It hangs at the edge of the enemy's reach,
//      kites when they commit, and jet-bobs constantly — vertical
//      ACCELERATION is the one motion an instantaneous linear lead cannot
//      predict, and the lure barely shoots, so it never pays movement
//      spread it needs back.
//   2. THE GALLERY — passing/waving enemies are constant-velocity dashers,
//      the exact target class EMA-1 lead + true drop hits perfectly. The
//      two hunters hold planted crossfire bearings (plant + bob, zero
//      movement spread — the v2 title lesson) and prioritize BITERS:
//      enemies with closing velocity toward the lure. The enemy's best
//      play becomes a shooting gallery.
//   3. CUT BAIT — a deterministic audit watches whether the bait is taken
//      (closing-velocity ticks vs lure-open ticks per window). Doctrines
//      that key on health, not mags (wolf), ignore the lure — so if the
//      bite ratio stays under BITE_RATIO for a window, the lure converts
//      to a third hunter, and the angler degrades to a proven pack brain.
//      Re-arms a probe window periodically in case the enemy's behavior
//      shifts. All counters derive from shared world state, so the crew
//      agrees without a channel.
//   4. WOUNDED BAIT — when a crew member drops below ROTATE_BELOW, the
//      lure role moves to the LOWEST-HEALTH member instead of the
//      lowest-ammo one: a wounded AND open target is the convergence point
//      of every published selector on the ladder (kill-secure keys health,
//      windows key mags) — maximum bait, and the kiting band doubles as
//      the hydra's survival withdrawal.
//   5. THE HUNTERS keep the champion's proven kit: one shared target on a
//      clock (open beats armed, then lowest health), crossfire side slots
//      (no top slot), stalk-tighten on a draining mag, the crew-wide pass
//      inside PASS_REACH with WINDOW_AUTO bloom discipline, SPAS fan
//      respect, reload RARELY (5 rounds) and IMMEDIATELY in place.
//
// Gunnery is the proven kestrel kit: taps locked to the 6-tick cooldown,
// EMA lead (instantaneous by default — it won every sweep), two-pass time
// of flight, TRUE 0.135 drop, closest-approach bullet dodge, shotgun-aware
// ballistics (SPAS shells 14 px/tick, AK 24.6).
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
// Physics facts of the guns (guns.ts), NOT strategy knobs — stay consts.
const AK_BULLET_SPEED = 24.6; // px/tick — lead/drop math
const SPAS_BULLET_SPEED = 14; // px/tick — wildcard shells fly slower

/** Angler's strategy knobs — every value is tweakable per match.
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type AnglerConfig = {
  // -- The lure ---------------------------------------------------------
  LURE_MODE: number;
  LURE_MIN_CREW: number;
  LURE_RETARGET: number;
  LURE_HOLD_AT: number;
  LURE_NEAR: number;
  LURE_FAR: number;
  LURE_KITE: number;
  LURE_BAIL: number;
  LURE_RELOAD_SAFE: number;
  LURE_BOB_UP: number;
  LURE_BOB_DOWN_MIN: number;
  LURE_BOB_DOWN_VAR: number;
  // -- Weigh-the-catch A/B audit ------------------------------------------
  AUDIT_WINDOW: number;
  AB_WINDOWS: number;
  KITE_DRAG_MIN: number;
  CHASE_VMIN: number;
  CHASE_NEAR: number;
  // -- The hunters (champion kit) ----------------------------------------
  HUNT_RETARGET: number;
  HUNT_RADIUS: number;
  LOW_MAG_OPEN: number;
  STALK_MAG: number;
  BEARING_OFF: number;
  STALK_DIST: number;
  PUNISH_RANGE: number;
  WINDOW_AUTO: number;
  AUTO_RANGE: number;
  KNIFE_DIST: number;
  GIVE_GROUND: number;
  FAN_GIVE: number;
  FIRE_MAX_DIST: number;
  X_SLACK: number;
  COHESION_DIST: number;
  PASS_REACH: number;
  ROTATE_BELOW: number;
  SELF_RELOAD_AT: number;
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
  LEVEL_BAND: number;
  HEIGHT_CAP: number;
  FUEL_RESERVE: number;
  FUEL_PUNISH_MIN: number;
  HUNT_MEMORY_TICKS: number;
  STALL_RISE_VY: number;
  STALL_TRIGGER: number;
  STALL_COOLDOWN: number;
};

export const ANGLER_DEFAULTS: Readonly<AnglerConfig> = {
  // -- The lure ---------------------------------------------------------
  LURE_MODE: 1, // 0 disables the lure entirely (three hunters)
  LURE_MIN_CREW: 3, // donating a gun to bait needs two left to shoot it
  LURE_RETARGET: 60, // ticks — shared role re-evaluation clock
  LURE_HOLD_AT: 4, // rounds — burn to here, then HOLD: at/below the common
  // LOW_MAG_OPEN the lure reads "open" to every mag-keyed selector, forever
  LURE_NEAR: 280, // px from enemy centroid — don't dangle closer than this
  LURE_FAR: 460, // px — drift back in beyond this (stay inside their
  // selection radius ~550 so the bait never leaves the menu)
  LURE_KITE: 310, // px — nearest enemy inside this: kite away (drag the
  // pass across the planted guns)
  LURE_BAIL: 45, // health — below this widen the band (survive; a wounded
  // open lure is still on every menu)
  LURE_RELOAD_SAFE: 700, // px — a DRY lure may reload only beyond this of
  // the nearest enemy (then burns back down to the hold)
  LURE_BOB_UP: 10, // ticks — short jet pulses: constant vertical
  LURE_BOB_DOWN_MIN: 12, // acceleration changes are what linear lead misses
  LURE_BOB_DOWN_VAR: 10,
  // -- Weigh-the-catch A/B audit ------------------------------------------
  // The brain runs its own controlled experiment: alternate lure-on /
  // lure-off windows, score each mode by NET DAMAGE (enemy health lost
  // minus crew health lost), then commit to the winning mode. "Do they
  // bite" is the wrong question — a pass that kills the lure faster than
  // the gallery kills the pass is a bite we don't want.
  AUDIT_WINDOW: 480, // ticks (8 s) — experiment window length
  AB_WINDOWS: 4, // calibration windows (on/off alternating) before committing
  KITE_DRAG_MIN: 220, // px — while the nearest biter is beyond this, the
  // kiting lure runs TOWARD its planted guns (drag the chase across the
  // crossfire); inside it, pure away (survival)
  CHASE_VMIN: 0.7, // px/tick closing speed toward the lure that marks a
  // hunter-priority BITER
  CHASE_NEAR: 620, // px — only enemies within this of the lure count as biters
  // -- The hunters (champion kit, v2 lessons baked) ------------------------
  HUNT_RETARGET: 30, // ticks — shared target re-evaluation clock
  HUNT_RADIUS: 550, // px — enemies beyond this of the crew centroid don't
  // drag the hunters (anti-anchor)
  LOW_MAG_OPEN: 4, // rounds — target mag at/below this opens the window
  STALK_MAG: 11, // rounds — target mag at/below this tightens to stalk range
  BEARING_OFF: 380, // px — hot-mag bearing slot offset
  STALK_DIST: 250, // px — stalk slot offset: the pass launches from close
  PUNISH_RANGE: 120, // px — dash to this distance during an open window
  WINDOW_AUTO: 360, // px — window full-auto from here in (arrive WITH the mag)
  AUTO_RANGE: 230, // px — otherwise full-auto only inside this
  KNIFE_DIST: 170, // px — inside: fire every open tick regardless of phase
  GIVE_GROUND: 240, // px — hot-mag target closer than this: back out
  FAN_GIVE: 330, // px — an ARMED SPAS target gets this much ground instead
  FIRE_MAX_DIST: 620, // px — beyond this, hold fire entirely
  X_SLACK: 40, // px — horizontal deadband around the slot
  COHESION_DIST: 380, // px — nearest hunter farther: regroup first (hot mag only)
  PASS_REACH: 560, // px — windows farther than this from the hunters'
  // centroid don't launch the pass (no forged-mag bait drags US)
  ROTATE_BELOW: 55, // health — below this the lure role moves to lowest health
  SELF_RELOAD_AT: 5, // rounds — reload RARELY and IMMEDIATELY in place (the
  // probe-falsified v2 lesson: a fleeing reloader donates the approach)
  TAP_PERIOD: 6, // ticks — tap clock locked to the fire cooldown
  TAP_OPEN: 1, // one shot per period = full volume at zero bloom
  EMA_ALPHA: 1, // instantaneous lead — won every sweep on the ladder
  DROP_G: 0.135, // px/tick² — TRUE bullet gravity (GRAV 0.06 × 2.25)
  BOB_UP_TICKS: 12, // planted hover bob (untaxed vertical axis)
  BOB_DOWN_MIN: 18,
  BOB_DOWN_VAR: 14,
  DODGE_HORIZON: 26, // ticks — only bullets arriving within this are threats
  DANGER_RADIUS: 56, // px — closest-approach distance that triggers a dodge
  DODGE_COMMIT: 6, // ticks — hold a dodge so it doesn't dither
  LEVEL_BAND: 50, // px — climb only when more than this below the slot/target
  HEIGHT_CAP: 200, // px — never chase height past this edge
  FUEL_RESERVE: 110, // ticks — below this, no positional climbing
  FUEL_PUNISH_MIN: 40, // ticks — punish dashes still fly on fumes
  HUNT_MEMORY_TICKS: 240, // ~4 s of last-seen pursuit
  // Ceiling-stall give-up (proven failure mode, see pilot.ts node 150).
  STALL_RISE_VY: -0.1,
  STALL_TRIGGER: 25,
  STALL_COOLDOWN: 180,
};

class AnglerBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  private target = 0;
  private lure = 0;
  private lastSeenX = 0;
  private lastSeenY = 0;
  private lastSeenAt = -1;
  /** EMA of the current gun target's velocity; reset on target switch. */
  private emaVX = 0;
  private emaVY = 0;
  private emaTarget = 0;
  /** Planted hover-bob phase clocks. */
  private bobJetUntil = 0;
  private bobFallUntil = 0;
  /** Committed bullet dodge. */
  private dodgeX: 1 | 0 | -1 = 0;
  private dodgeJet: 1 | 0 | -1 = 0;
  private dodgeUntil = 0;
  /** Weigh-the-catch A/B audit (lockstep across the crew — every brain
   *  derives identical values from shared world state each tick). */
  private lureLive = true;
  private netByMode: [number, number] = [0, 0]; // [lure, hunt] net damage
  private ticksByMode: [number, number] = [0, 0];
  private readonly prevHealth = new Map<number, number>();
  private fleeStuck = 0;
  private stallTicks = 0;
  private noClimbUntil = 0;

  constructor(private readonly cfg: AnglerConfig) {}

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

  /** Muzzle speed of whatever this sprite carries (shotgun wildcard aware). */
  private speedOf(index: number, ctx: BotEngineContext): number {
    return ctx.weaponOf?.(index) === 'SPAS12' ? SPAS_BULLET_SPEED : AK_BULLET_SPEED;
  }

  /** Living crew (self included), ascending sprite index. */
  private crewOf(botIndex: number, ctx: BotEngineContext): number[] {
    const { world } = ctx;
    const self = world.sprites[botIndex];
    if (self === undefined || self.team === 0) return [botIndex]; // FFA: crew of one
    const crew: number[] = [];
    for (let i = 1; i < world.sprites.length; i++) {
      const s = world.sprites[i];
      if (s === undefined || !s.active || s.deadMeat) continue;
      if (s.team === self.team) crew.push(i);
    }
    return crew.length > 0 ? crew : [botIndex];
  }

  /** Living enemies, ascending sprite index. */
  private enemiesOf(botIndex: number, ctx: BotEngineContext): number[] {
    const { world } = ctx;
    const self = world.sprites[botIndex];
    const out: number[] = [];
    if (self === undefined) return out;
    for (let e = 1; e < world.sprites.length; e++) {
      if (e === botIndex) continue;
      const o = world.sprites[e];
      if (o === undefined || !o.active || o.deadMeat) continue;
      if (self.team > 0 && o.team === self.team) continue;
      if (o.alpha !== 255 && o.holdedThing === 0) continue;
      out.push(e);
    }
    return out;
  }

  /** Who dangles: lowest ammo (ties by index) — whoever ran low is already
   *  "open" on the enemy's menu, so they take the role; everyone else
   *  reloads fat. When anyone is wounded below ROTATE_BELOW the role moves
   *  to LOWEST HEALTH instead: wounded + open is the convergence point of
   *  every published selector (kill-secure keys health, windows key mags).
   *  Stateless from shared world state — the crew agrees by convention. */
  private pickLure(crew: readonly number[], ctx: BotEngineContext): number {
    const cfg = this.cfg;
    if (cfg.LURE_MODE <= 0 || !this.lureLive) return 0;
    if (crew.length < cfg.LURE_MIN_CREW) return 0;
    const { world } = ctx;
    let lowHealth = Infinity;
    let byHealth = 0;
    let lowAmmo = Infinity;
    let byAmmo = 0;
    for (const i of crew) {
      const h = world.sprites[i]?.health ?? Infinity;
      if (h < lowHealth) {
        lowHealth = h;
        byHealth = i;
      }
      // A RELOADING hunter's transient ammo reading must not steal the
      // role — handoffs mid-burn reset the dangle and donate the doctrine.
      if (ctx.reloadingOf(i)) continue;
      const a = ctx.ammoOf(i);
      if (a < lowAmmo) {
        lowAmmo = a;
        byAmmo = i;
      }
    }
    if (lowHealth < cfg.ROTATE_BELOW) return byHealth;
    // Stickiness: a lure already dangling at the hold keeps the role.
    if (
      this.lure > 0 &&
      crew.includes(this.lure) &&
      !ctx.reloadingOf(this.lure) &&
      ctx.ammoOf(this.lure) <= cfg.LURE_HOLD_AT
    ) {
      return this.lure;
    }
    return byAmmo;
  }

  /** A bite: any enemy near the lure with closing velocity toward it. Also
   *  marks hunter-priority BITERS — passing dashers are constant-velocity
   *  targets, the class EMA-1 lead hits perfectly. */
  private isBiter(e: number, lureIdx: number, ctx: BotEngineContext): boolean {
    const parts = ctx.world.spriteParts;
    if (parts === null || lureIdx <= 0) return false;
    const lx = parts.posX[lureIdx] ?? 0;
    const ly = parts.posY[lureIdx] ?? 0;
    const ex = parts.posX[e] ?? 0;
    const ey = parts.posY[e] ?? 0;
    const dx = lx - ex;
    const dy = ly - ey;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6 || d > this.cfg.CHASE_NEAR) return false;
    const vx = parts.velocityX[e] ?? 0;
    const vy = parts.velocityY[e] ?? 0;
    return (vx * dx + vy * dy) / d > this.cfg.CHASE_VMIN;
  }

  /** The hunters' shared target. BITERS first (lowest health among them),
   *  then the champion's pick: open beats armed, then lowest health, within
   *  HUNT_RADIUS of the crew centroid; nearest-to-centroid fallback beyond. */
  private pickTarget(
    botIndex: number,
    crew: readonly number[],
    lureIdx: number,
    ctx: BotEngineContext,
  ): number {
    const { world } = ctx;
    const cfg = this.cfg;
    const parts = world.spriteParts;
    if (parts === null) return 0;
    let cx = 0;
    let cy = 0;
    for (const w of crew) {
      cx += parts.posX[w] ?? 0;
      cy += parts.posY[w] ?? 0;
    }
    cx /= crew.length;
    cy /= crew.length;

    const radiusSq = cfg.HUNT_RADIUS * cfg.HUNT_RADIUS;
    let best = 0;
    let bestBiter = false;
    let bestOpen = false;
    let bestHealth = Infinity;
    let bestD = Infinity;
    let farBest = 0;
    let farBestD = Infinity;
    for (const e of this.enemiesOf(botIndex, ctx)) {
      const ex = parts.posX[e] ?? 0;
      const ey = parts.posY[e] ?? 0;
      let seen = false;
      for (const w of crew) {
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
      if (d > radiusSq) {
        if (d < farBestD) {
          farBest = e;
          farBestD = d;
        }
        continue;
      }
      const o = world.sprites[e]!;
      const biter = this.isBiter(e, lureIdx, ctx);
      const open = ctx.reloadingOf(e) || ctx.ammoOf(e) <= cfg.LOW_MAG_OPEN;
      const better =
        (biter && !bestBiter) ||
        (biter === bestBiter &&
          ((open && !bestOpen) ||
            (open === bestOpen &&
              (o.health < bestHealth || (o.health === bestHealth && d < bestD)))));
      if (better) {
        best = e;
        bestBiter = biter;
        bestOpen = open;
        bestHealth = o.health;
        bestD = d;
      }
    }
    return best > 0 ? best : farBest;
  }

  /** Centroid of living enemies, or null when none remain. */
  private enemyCentroid(
    botIndex: number,
    ctx: BotEngineContext,
  ): { x: number; y: number } | null {
    const parts = ctx.world.spriteParts;
    if (parts === null) return null;
    let x = 0;
    let y = 0;
    let n = 0;
    for (const e of this.enemiesOf(botIndex, ctx)) {
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
    const crew = this.crewOf(botIndex, ctx);

    // Bullet threats override everything else's movement (kestrel pillar).
    this.scanBullets(botIndex, ctx);

    // --- Weigh the catch: an online A/B on a shared absolute clock ---------
    // Calibration: alternate lure-on/lure-off windows. Verdict: commit to
    // the mode with the better per-tick net damage. Identical arithmetic in
    // every brain — the crew agrees without a channel.
    const windowIdx = Math.floor(clock / cfg.AUDIT_WINDOW);
    if (windowIdx < cfg.AB_WINDOWS) {
      this.lureLive = windowIdx % 2 === 0;
    } else {
      const [lureNet, huntNet] = this.netByMode;
      const [lureT, huntT] = this.ticksByMode;
      this.lureLive =
        lureT > 0 && huntT > 0 ? lureNet / lureT >= huntNet / huntT : true;
    }
    // Score the running mode by health flow: enemy drops are earnings,
    // crew drops are costs. Health INCREASES (respawn, pickups) are not
    // damage and only resync the baseline.
    const mode = this.lureLive ? 0 : 1;
    let net = 0;
    for (let i = 1; i < world.sprites.length; i++) {
      const o = world.sprites[i];
      if (o === undefined || !o.active) {
        this.prevHealth.delete(i);
        continue;
      }
      const prev = this.prevHealth.get(i);
      this.prevHealth.set(i, o.health);
      if (prev === undefined || o.health >= prev) continue;
      const drop = prev - o.health;
      const isCrew = s.team > 0 ? o.team === s.team : i === botIndex;
      net += isCrew ? -drop : drop;
    }
    if (windowIdx < cfg.AB_WINDOWS) {
      this.netByMode[mode] += net;
      this.ticksByMode[mode] += 1;
    }

    // Shared-clock role re-evaluation, immediate when the lure is gone.
    const curLure = world.sprites[this.lure];
    const lureAlive =
      this.lure > 0 &&
      curLure !== undefined &&
      curLure.active &&
      !curLure.deadMeat &&
      crew.includes(this.lure);
    if (!lureAlive || clock % cfg.LURE_RETARGET === 0) {
      this.lure = this.pickLure(crew, ctx);
    }

    // Shared-clock target re-evaluation, immediate when the target is gone.
    const curT = world.sprites[this.target];
    const targetAlive =
      this.target > 0 &&
      curT !== undefined &&
      curT.active &&
      !curT.deadMeat &&
      !(s.team > 0 && curT.team === s.team);
    if (!targetAlive || clock % cfg.HUNT_RETARGET === 0) {
      this.target = this.pickTarget(botIndex, crew, this.lure, ctx);
    }

    if (this.lure === botIndex) {
      this.lureTick(botIndex, ctx);
    } else if (this.target > 0) {
      this.engage(botIndex, this.target, crew.filter((i) => i !== this.lure), ctx);
    } else {
      const seen = findTarget(world, botIndex);
      if (seen > 0) {
        this.engage(botIndex, seen, crew.filter((i) => i !== this.lure), ctx);
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

  /** Pillar 1: the lure. Burn to the hold, then dangle at the edge of the
   *  enemy's reach, kite the committed, bob the lead, and never reload. */
  private lureTick(botIndex: number, ctx: BotEngineContext): void {
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
    const dCen = Math.hypot(px - ecen.x, py - ecen.y);

    // Nearest enemy drives the kite; the centroid drives the band.
    let nearest = 0;
    let nearestD = Infinity;
    for (const e of this.enemiesOf(botIndex, ctx)) {
      const d = Math.hypot((parts.posX[e] ?? 0) - px, (parts.posY[e] ?? 0) - py);
      if (d < nearestD) {
        nearestD = d;
        nearest = e;
      }
    }

    const ammo = ctx.ammoOf(botIndex);
    const reloading = ctx.reloadingOf(botIndex);
    const wounded = s.health < cfg.LURE_BAIL;
    const near = wounded ? cfg.LURE_NEAR + 120 : cfg.LURE_NEAR;
    const far = wounded ? cfg.LURE_FAR + 120 : cfg.LURE_FAR;

    // The one reload exception: bone dry AND out of everyone's reach. A dry
    // lure still reads open but can't even bite back at knife range.
    if (!reloading && ammo === 0 && nearestD > cfg.LURE_RELOAD_SAFE) {
      c.reload = true;
    }

    // --- Movement: hold the dangle band, kite the committed -----------------
    if (nearest > 0 && nearestD < cfg.LURE_KITE) {
      // They bit. With breathing room, run TOWARD the planted guns — the
      // chase must cross the crossfire to keep the bait in reach. Only when
      // the biter is on top of us does survival pick the direction.
      const nx = parts.posX[nearest] ?? 0;
      let dir = px >= nx ? 1 : -1;
      if (nearestD >= cfg.KITE_DRAG_MIN) {
        let hx = 0;
        let n = 0;
        for (const w of this.crewOf(botIndex, ctx)) {
          if (w === botIndex) continue;
          hx += parts.posX[w] ?? 0;
          n += 1;
        }
        if (n > 0) dir = hx / n >= px ? 1 : -1;
      }
      if (dir > 0) c.right = true;
      else c.left = true;
      const vx = parts.velocityX[botIndex] ?? 0;
      if (Math.abs(vx) < 0.3) this.fleeStuck += 1;
      else this.fleeStuck = 0;
      if (
        this.fleeStuck > 30 &&
        s.jetsCount > cfg.FUEL_PUNISH_MIN &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
    } else if (dCen < near) {
      if (px >= ecen.x) c.right = true;
      else c.left = true;
    } else if (dCen > far) {
      if (px < ecen.x - 40) c.right = true;
      else if (px > ecen.x + 40) c.left = true;
    }

    // --- Vertical: constant acceleration is the unleadable motion ----------
    // Short jet pulses on an rng clock — the lure barely fires, so the
    // movement-spread tax that killed the juke doesn't apply to it.
    const aboveCap = py < ecen.y - cfg.HEIGHT_CAP;
    if (aboveCap) {
      c.down = true;
    } else if (s.jetsCount > cfg.FUEL_PUNISH_MIN && clock >= this.noClimbUntil) {
      if (clock >= this.bobFallUntil) {
        this.bobJetUntil = clock + cfg.LURE_BOB_UP;
        this.bobFallUntil =
          this.bobJetUntil + cfg.LURE_BOB_DOWN_MIN + world.rng.nextInt(cfg.LURE_BOB_DOWN_VAR);
      }
      c.jetpack = clock < this.bobJetUntil;
    }

    // --- Gun: burn freely above the hold, then knife-range only ------------
    const gun =
      this.target > 0 &&
      hasLineOfSight(
        world,
        { x: px, y: py },
        { x: parts.posX[this.target] ?? 0, y: parts.posY[this.target] ?? 0 },
      )
        ? this.target
        : findTarget(world, botIndex);
    if (gun > 0) {
      if (ammo > cfg.LURE_HOLD_AT) {
        this.aimAndFire(botIndex, gun, ctx, cfg.FIRE_MAX_DIST, false);
      } else {
        // Held rounds: aim stays live, the trigger only at knife range.
        this.aimAndFire(botIndex, gun, ctx, cfg.KNIFE_DIST, true);
      }
    }
  }

  /** Closest-approach scan over live enemy bullets (kestrel pillar, vertical-
   *  first response — band bullets fly flat, the perpendicular is the untaxed
   *  axis; drop under-compensators shoot LOW, so rising widens their miss). */
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

  /** EMA lead + two-pass time-of-flight + TRUE drop, then the trigger.
   *  `auto` fires every tick; otherwise taps locked to the fire cooldown,
   *  staggered per bot so the crew keeps rolling pressure. */
  private aimAndFire(
    botIndex: number,
    targetIdx: number,
    ctx: BotEngineContext,
    fireMax: number,
    auto: boolean,
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
    const speed = this.speedOf(botIndex, ctx);

    if (this.emaTarget !== targetIdx) {
      this.emaTarget = targetIdx;
      this.emaVX = tvx;
      this.emaVY = tvy;
    } else {
      this.emaVX += cfg.EMA_ALPHA * (tvx - this.emaVX);
      this.emaVY += cfg.EMA_ALPHA * (tvy - this.emaVY);
    }

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
    if (auto || dist <= cfg.KNIFE_DIST) c.fire = true;
    else c.fire = (world.mainTickCounter + botIndex * 3) % cfg.TAP_PERIOD < cfg.TAP_OPEN;
  }

  /** The hunters: hold a crossfire bearing on the shared target, pass as a
   *  crew when its window opens, reload rarely and in place. */
  private engage(
    botIndex: number,
    targetIdx: number,
    hunters: readonly number[],
    ctx: BotEngineContext,
  ): void {
    const { world } = ctx;
    const cfg = this.cfg;
    const s = world.sprites[botIndex]!;
    const c = s.control;
    const parts = world.spriteParts!;
    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const tx = parts.posX[targetIdx] ?? 0;
    const ty = parts.posY[targetIdx] ?? 0;
    const clock = world.mainTickCounter;
    const dx = tx - px;
    const dist = Math.hypot(dx, ty - py);
    const heightEdge = ty - py; // + = I'm above the target

    if (hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty })) {
      this.lastSeenX = tx;
      this.lastSeenY = ty;
      this.lastSeenAt = clock;
    }

    // The target's mag clock phases the hunters together. A SPAS target is
    // only "open" while ACTUALLY reloading — a fan is a kill envelope.
    const targetSpas = ctx.weaponOf?.(targetIdx) === 'SPAS12';
    const windowOpen =
      ctx.reloadingOf(targetIdx) ||
      (!targetSpas && ctx.ammoOf(targetIdx) <= cfg.LOW_MAG_OPEN);
    const stalking =
      !windowOpen && !targetSpas && ctx.ammoOf(targetIdx) <= cfg.STALK_MAG;

    // Pass gate: a window beyond PASS_REACH of the hunters' centroid does
    // not move the crew — the angler of all brains respects forged bait.
    let fcx = px;
    let fcy = py;
    if (hunters.length > 0) {
      fcx = 0;
      fcy = 0;
      for (const w of hunters) {
        fcx += parts.posX[w] ?? 0;
        fcy += parts.posY[w] ?? 0;
      }
      fcx /= hunters.length;
      fcy /= hunters.length;
    }
    const passOpen = windowOpen && Math.hypot(tx - fcx, ty - fcy) <= cfg.PASS_REACH;

    // Reload RARELY (5 rounds) and IMMEDIATELY in place — the enemy's eyes
    // are on the lure; a fleeing reloader donates the approach (v2 lesson).
    const ammo = ctx.ammoOf(botIndex);
    const reloading = ctx.reloadingOf(botIndex);
    if (!reloading && (ammo === 0 || (ammo <= cfg.SELF_RELOAD_AT && !passOpen))) {
      c.reload = true;
    }

    // --- Movement -------------------------------------------------------------
    if (passOpen) {
      // THE PASS: every tick inside the window is free damage.
      if (dist > cfg.PUNISH_RANGE) {
        if (dx > 0) c.right = true;
        else c.left = true;
      }
      if (heightEdge < -30 && s.jetsCount > cfg.FUEL_PUNISH_MIN && clock >= this.noClimbUntil) {
        c.jetpack = true;
      }
    } else {
      // Bearing slot: sides split by current position (nobody crosses
      // through the target); stalk tightens the offset.
      const off = stalking ? cfg.STALK_DIST : cfg.BEARING_OFF;
      const sorted = [...hunters].sort((a, b) => {
        const ax = parts.posX[a] ?? 0;
        const bx = parts.posX[b] ?? 0;
        return ax === bx ? a - b : ax - bx;
      });
      const k = Math.max(0, sorted.indexOf(botIndex));
      const leftCount = Math.ceil(sorted.length / 2);
      const dir = k < leftCount ? -1 : 1;
      let slotX = tx + dir * off;

      // Cohesion (hot mag only): an isolated hunter regroups before glory.
      if (!stalking && hunters.length >= 2) {
        let nearest = Infinity;
        let ox = 0;
        let oy = 0;
        let n = 0;
        for (const w of hunters) {
          if (w === botIndex) continue;
          const wx = parts.posX[w] ?? 0;
          const wy = parts.posY[w] ?? 0;
          nearest = Math.min(nearest, Math.hypot(wx - px, wy - py));
          ox += wx;
          oy += wy;
          n += 1;
        }
        if (n > 0 && nearest > cfg.COHESION_DIST) {
          slotX = ox / n;
        }
      }

      // An armed SPAS target gets more ground — the fan's kill envelope is
      // wider than any brawl band; its reload is the window.
      const ground =
        targetSpas && !windowOpen ? Math.max(cfg.GIVE_GROUND, cfg.FAN_GIVE) : cfg.GIVE_GROUND;
      let inSlot = false;
      if (dist < ground) {
        // The target walked onto us with a hot mag: back out, keep shooting.
        if (dx > 0) c.left = true;
        else c.right = true;
      } else if (px < slotX - cfg.X_SLACK) {
        c.right = true;
      } else if (px > slotX + cfg.X_SLACK) {
        c.left = true;
      } else {
        inSlot = true; // PLANT — zero movement spread (the v2 title lesson)
      }

      // Height parity, not height greed — and when planted at parity, bob:
      // jet pulses in the untaxed vertical axis.
      if (
        heightEdge < -cfg.LEVEL_BAND &&
        s.jetsCount > cfg.FUEL_RESERVE &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true; // erase the deficit — never duel from the pit
      } else if (heightEdge > cfg.HEIGHT_CAP) {
        c.down = true; // overextended above: let gravity spend instead of fuel
      } else if (
        inSlot &&
        s.jetsCount > cfg.FUEL_RESERVE &&
        clock >= this.noClimbUntil
      ) {
        if (clock >= this.bobFallUntil) {
          this.bobJetUntil = clock + cfg.BOB_UP_TICKS;
          this.bobFallUntil =
            this.bobJetUntil + cfg.BOB_DOWN_MIN + world.rng.nextInt(cfg.BOB_DOWN_VAR);
        }
        c.jetpack = clock < this.bobJetUntil;
      }
    }

    // --- Gun: the target when shootable, else whatever is biting us ----------
    const auto = windowOpen ? dist <= cfg.WINDOW_AUTO : dist <= cfg.AUTO_RANGE;
    const shootable =
      dist <= cfg.FIRE_MAX_DIST &&
      hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty });
    if (shootable) {
      this.aimAndFire(botIndex, targetIdx, ctx, cfg.FIRE_MAX_DIST, auto);
    } else {
      const seen = findTarget(world, botIndex);
      if (seen > 0) this.aimAndFire(botIndex, seen, ctx, cfg.FIRE_MAX_DIST, false);
    }
  }
}

export function createAnglerEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('angler', ANGLER_DEFAULTS, tweaks);
  return {
    id: 'angler',
    strategy:
      'THE ANGLER — one crew member holds a deliberately low mag and reads "open" forever to every mag-keyed selector; the bait kites the pass across two planted EMA-1 guns, and a cut-bait audit converts the lure to a third hunter when nobody bites',
    tweaks: cfg,
    createBrain: (): BotBrain => new AnglerBrain(cfg),
  };
}
