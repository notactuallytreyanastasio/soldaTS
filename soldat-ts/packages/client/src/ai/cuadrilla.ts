// "cuadrilla" bot engine — the bullfighter's crew, the ninth doctrine.
//
// The ladder taught three separate lessons that no brain has combined:
// the wolf proved the TEAM is the unit of selection (three guns, one body);
// the matador proved the MAGAZINE is the clock that rations damage (the
// league tape shows it as the only engine with a winning record against the
// hydra); the hydra proved a published focus function can be STARVED by
// withdrawing its prey. The cuadrilla is all three at once — a matador
// never works alone, he brings his crew.
//
//   1. ONE BULL, PICKED BY MAG — all crew members compute the same target
//      from shared world state (agreement by convention, no channel):
//      among enemies visible to ANY member and within BULL_RADIUS of the
//      crew centroid, a DISARMED one (reloading or near-dry mag) beats a
//      merely wounded one; among the disarmed, lowest health; among the
//      armed, lowest health (the wolf's kill-secure). In a team fight
//      someone is almost always reloading — the whole crew is always
//      looking at them.
//   2. THE CREW-WIDE PASS — matador's punish, times three. The bull's mag
//      state phases the whole crew together: hot mag → hold bearing slots
//      and tap (refuse the duel); mag running low → the slots tighten to
//      stalk range; mag dead → ALL THREE dash to point-blank and go
//      full-auto. 150 health inside a 95-tick reload window dies faster
//      than any health-threshold rotation can rescue it.
//   3. CROSSFIRE BEARINGS, NO TOP SLOT — wolf geometry with hydra's
//      correction: side slots split by current position (nobody crosses
//      through the bull), no altitude slot (the tape shows the top gun
//      burns its fuel hovering and dies first). Cohesion regroup applies
//      only while the bull's mag is hot — abandoning an open window to
//      regroup donates the window.
//   4. THE RESERVE — the hydra's own defense, mirrored back: when a crew
//      member drops below ROTATE_BELOW, the lowest-health member withdraws
//      to a planted long band off the enemy centroid — outside every
//      published prey radius and fire max — and keeps tap-sniping. Any
//      kill-securing focus function is starved; spread damage kills nobody.
//      Selection is stateless (argmin health, ties by index) so respawned
//      members can never disagree about who holds the reserve.
//   5. NEVER CHASE THE ANCHOR — BULL_RADIUS means a wounded enemy parked
//      beyond the fight (the hydra's anchor, the plover's broken wing)
//      cannot drag the crew past healthy guns. Fight the fronts 3v2.
//
// Gunnery is the proven kestrel kit: taps locked to the 6-tick cooldown,
// EMA lead, two-pass time of flight, TRUE 0.135 drop, closest-approach
// bullet dodge. Ballistics read the carried weapon (shotgun wildcard aware):
// SPAS shells fly at 14 px/tick, AK rounds at 24.6 — same gravity.
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

/** Cuadrilla's strategy knobs — every value is tweakable per match.
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type CuadrillaConfig = {
  BULL_RETARGET: number;
  BULL_RADIUS: number;
  LOW_MAG_OPEN: number;
  STALK_MAG: number;
  BEARING_OFF: number;
  STALK_DIST: number;
  PUNISH_RANGE: number;
  WINDOW_AUTO: number;
  AUTO_RANGE: number;
  KNIFE_DIST: number;
  GIVE_GROUND: number;
  FIRE_MAX_DIST: number;
  X_SLACK: number;
  COHESION_DIST: number;
  ROTATE_BELOW: number;
  ANCHOR_MIN: number;
  ANCHOR_MAX: number;
  ANCHOR_FIRE_MAX: number;
  ANCHOR_STUCK_TICKS: number;
  SELF_RELOAD_AT: number;
  TAP_PERIOD: number;
  TAP_OPEN: number;
  EMA_ALPHA: number;
  DROP_G: number;
  JUKE_MIN_TICKS: number;
  JUKE_VAR_TICKS: number;
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

export const CUADRILLA_DEFAULTS: Readonly<CuadrillaConfig> = {
  BULL_RETARGET: 30, // ticks — shared re-evaluation clock (crew switches together)
  BULL_RADIUS: 550, // px — wounded/disarmed enemies beyond this of the crew
  // centroid don't drag the crew (anti-anchor, anti-broken-wing)
  LOW_MAG_OPEN: 4, // rounds — bull's mag at/below this opens the window early
  STALK_MAG: 11, // rounds — bull's mag at/below this tightens slots to stalk range
  BEARING_OFF: 380, // px — hot-mag bearing slot offset (outside full-auto bands)
  STALK_DIST: 250, // px — stalk slot offset: the pass launches from close, not the band
  PUNISH_RANGE: 120, // px — dash to this distance during an open window
  WINDOW_AUTO: 620, // px — during a window, full-auto from here in (they can't answer)
  AUTO_RANGE: 230, // px — full-auto only inside this otherwise (bloom discipline)
  KNIFE_DIST: 170, // px — inside: fire every open tick regardless of phase
  GIVE_GROUND: 240, // px — hot-mag bull closer than this: back out
  FIRE_MAX_DIST: 620, // px — beyond this, hold fire entirely
  X_SLACK: 40, // px — horizontal deadband around the slot
  COHESION_DIST: 380, // px — nearest crewmate farther: regroup first (hot mag only)
  ROTATE_BELOW: 55, // health (of 150) — lowest member withdraws once under this
  ANCHOR_MIN: 600, // px from ENEMY centroid — outside published prey radii/fire maxes
  ANCHOR_MAX: 760, // px — farther: drift back toward the fight
  ANCHOR_FIRE_MAX: 700, // px — the reserve's planted taps reach this far
  ANCHOR_STUCK_TICKS: 30, // ticks of no horizontal progress while fleeing = climb out
  SELF_RELOAD_AT: 9, // rounds — proactive reload (only while safe + their mag hot)
  TAP_PERIOD: 6, // ticks — tap clock locked to the fire cooldown
  TAP_OPEN: 1, // one shot per period = full volume at zero bloom
  EMA_ALPHA: 0.4, // per-tick velocity smoothing (1 = instantaneous lead)
  DROP_G: 0.135, // px/tick² — TRUE bullet gravity (GRAV 0.06 × 2.25)
  JUKE_MIN_TICKS: 14, // in-slot strafe-juke clock (a parked gun is target practice)
  JUKE_VAR_TICKS: 22,
  DODGE_HORIZON: 26, // ticks — only bullets arriving within this are threats
  DANGER_RADIUS: 56, // px — closest-approach distance that triggers a dodge
  DODGE_COMMIT: 6, // ticks — hold a dodge so it doesn't dither
  LEVEL_BAND: 50, // px — climb only when more than this below the slot/bull
  HEIGHT_CAP: 200, // px — never chase height past this edge (no ceiling races)
  FUEL_RESERVE: 110, // ticks — below this, no positional climbing; let regen pay
  FUEL_PUNISH_MIN: 40, // ticks — punish dashes still fly on fumes
  HUNT_MEMORY_TICKS: 240, // ~4 s of last-seen pursuit after the crew loses all eyes
  // Ceiling-stall give-up (proven failure mode, see pilot.ts node 150).
  STALL_RISE_VY: -0.1,
  STALL_TRIGGER: 25,
  STALL_COOLDOWN: 180,
};

class CuadrillaBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  private bull = 0;
  private lastSeenX = 0;
  private lastSeenY = 0;
  private lastSeenAt = -1;
  /** EMA of the current gun target's velocity; reset on target switch. */
  private emaVX = 0;
  private emaVY = 0;
  private emaTarget = 0;
  /** In-slot strafe-juke clock. */
  private jukeDir: 1 | -1 = 1;
  private jukeFlipAt = 0;
  /** Committed bullet dodge. */
  private dodgeX: 1 | 0 | -1 = 0;
  private dodgeJet: 1 | 0 | -1 = 0;
  private dodgeUntil = 0;
  /** Reserve corner handling: climb out when fleeing into geometry. */
  private fleeStuck = 0;
  private stallTicks = 0;
  private noClimbUntil = 0;

  constructor(private readonly cfg: CuadrillaConfig) {}

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

  /** Pillar 4: who holds the reserve — STATELESS argmin health (ties by
   *  index), only when wounded below ROTATE_BELOW and the crew has spares. */
  private reserveOf(crew: readonly number[], ctx: BotEngineContext): number {
    if (crew.length < 2) return 0; // a lone torero has no crew to rotate into
    const { world } = ctx;
    let reserve = 0;
    let low = Infinity;
    for (const i of crew) {
      const h = world.sprites[i]?.health ?? Infinity;
      if (h < low) {
        low = h;
        reserve = i;
      }
    }
    return low < this.cfg.ROTATE_BELOW ? reserve : 0;
  }

  /** Pillar 1: the crew's single bull. Among enemies visible to ANY member
   *  and within BULL_RADIUS of the crew centroid: disarmed (reloading or
   *  near-dry) beats armed, then lowest health, ties by distance to the
   *  centroid. Beyond the radius only nearest-to-centroid counts, as a
   *  fallback when nobody is in reach. Deterministic from world state —
   *  every member computes the same answer without a channel. */
  private pickBull(botIndex: number, crew: readonly number[], ctx: BotEngineContext): number {
    const { world } = ctx;
    const cfg = this.cfg;
    const self = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (self === undefined || parts === null) return 0;
    let cx = 0;
    let cy = 0;
    for (const w of crew) {
      cx += parts.posX[w] ?? 0;
      cy += parts.posY[w] ?? 0;
    }
    cx /= crew.length;
    cy /= crew.length;

    const radiusSq = cfg.BULL_RADIUS * cfg.BULL_RADIUS;
    let best = 0;
    let bestOpen = false;
    let bestHealth = Infinity;
    let bestD = Infinity;
    let farBest = 0;
    let farBestD = Infinity;
    for (let e = 1; e < world.sprites.length; e++) {
      if (e === botIndex) continue;
      const o = world.sprites[e];
      if (o === undefined || !o.active || o.deadMeat) continue;
      if (self.team > 0 && o.team === self.team) continue;
      if (o.alpha !== 255 && o.holdedThing === 0) continue;
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
      const open = ctx.reloadingOf(e) || ctx.ammoOf(e) <= cfg.LOW_MAG_OPEN;
      const better =
        (open && !bestOpen) ||
        (open === bestOpen &&
          (o.health < bestHealth || (o.health === bestHealth && d < bestD)));
      if (better) {
        best = e;
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
    const crew = this.crewOf(botIndex, ctx);

    // Bullet threats override everything else's movement (kestrel pillar).
    this.scanBullets(botIndex, ctx);

    // Shared-clock bull re-evaluation, immediate when the bull is gone.
    const cur = world.sprites[this.bull];
    const bullAlive =
      this.bull > 0 &&
      cur !== undefined &&
      cur.active &&
      !cur.deadMeat &&
      !(s.team > 0 && cur.team === s.team);
    if (!bullAlive || clock % cfg.BULL_RETARGET === 0) {
      this.bull = this.pickBull(botIndex, crew, ctx);
    }

    const reserveIdx = this.reserveOf(crew, ctx);
    if (reserveIdx === botIndex) {
      this.reserveTick(botIndex, ctx);
    } else if (this.bull > 0) {
      this.engage(botIndex, this.bull, crew.filter((i) => i !== reserveIdx), ctx);
    } else {
      const seen = findTarget(world, botIndex);
      if (seen > 0) {
        this.engage(botIndex, seen, crew.filter((i) => i !== reserveIdx), ctx);
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

  /** Pillar 4: the reserve. Hold a planted long band off the ENEMY centroid
   *  and keep trading drop-compensated taps from outside their reach. */
  private reserveTick(botIndex: number, ctx: BotEngineContext): void {
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
    if (!ctx.reloadingOf(botIndex) && ammo <= cfg.SELF_RELOAD_AT) {
      c.reload = true;
    }

    if (d < cfg.ANCHOR_MIN) {
      // Open range away from the enemy centroid; climb out when geometry
      // blocks the run (height is escape the chasers must pay fuel for).
      if (px >= ecen.x) c.right = true;
      else c.left = true;
      const vx = parts.velocityX[botIndex] ?? 0;
      if (Math.abs(vx) < 0.3) this.fleeStuck += 1;
      else this.fleeStuck = 0;
      if (
        (this.fleeStuck > cfg.ANCHOR_STUCK_TICKS || d < cfg.ANCHOR_MIN - 150) &&
        s.jetsCount > cfg.FUEL_PUNISH_MIN &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
    } else if (d > cfg.ANCHOR_MAX) {
      // Too far to contribute: drift back toward the fight.
      if (px < ecen.x - 40) c.right = true;
      else if (px > ecen.x + 40) c.left = true;
    }

    // The reserve's gun: the bull when it can see it, else whatever
    // findTarget offers — long planted taps are free damage.
    const gun =
      this.bull > 0 &&
      hasLineOfSight(
        world,
        { x: px, y: py },
        { x: parts.posX[this.bull] ?? 0, y: parts.posY[this.bull] ?? 0 },
      )
        ? this.bull
        : findTarget(world, botIndex);
    if (gun > 0) this.aimAndFire(botIndex, gun, ctx, cfg.ANCHOR_FIRE_MAX, false);
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

  /** Pillars 1-3: a front torero. Phase off the BULL's mag, hold a crossfire
   *  bearing, and pass as a crew the moment the window opens. */
  private engage(
    botIndex: number,
    bullIdx: number,
    fronts: readonly number[],
    ctx: BotEngineContext,
  ): void {
    const { world } = ctx;
    const cfg = this.cfg;
    const s = world.sprites[botIndex]!;
    const c = s.control;
    const parts = world.spriteParts!;
    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const tx = parts.posX[bullIdx] ?? 0;
    const ty = parts.posY[bullIdx] ?? 0;
    const clock = world.mainTickCounter;
    const dx = tx - px;
    const dist = Math.hypot(dx, ty - py);
    const heightEdge = ty - py; // + = I'm above the bull

    if (hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty })) {
      this.lastSeenX = tx;
      this.lastSeenY = ty;
      this.lastSeenAt = clock;
    }

    // --- Pillar 2: the bull's mag clock phases the whole crew ---------------
    const windowOpen = ctx.reloadingOf(bullIdx) || ctx.ammoOf(bullIdx) <= cfg.LOW_MAG_OPEN;
    const stalking = !windowOpen && ctx.ammoOf(bullIdx) <= cfg.STALK_MAG;

    // --- Own mag on the off-beat ---------------------------------------------
    const ammo = ctx.ammoOf(botIndex);
    const reloading = ctx.reloadingOf(botIndex);
    if (!reloading && ammo === 0) c.reload = true;
    // Proactive reload only in the calm — their mag hot, no stalk underway,
    // and us out of reach: never volunteer a dry mag into an opening window.
    if (
      !reloading &&
      ammo > 0 &&
      ammo <= cfg.SELF_RELOAD_AT &&
      !windowOpen &&
      !stalking &&
      dist > cfg.BEARING_OFF - cfg.X_SLACK
    ) {
      c.reload = true;
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

    // --- Movement -------------------------------------------------------------
    if (windowOpen) {
      // THE PASS: the bull's head is down. The WHOLE CREW dashes to
      // point-blank — every tick inside the window is free damage, and three
      // mags at knife range outrun any rotation threshold.
      if (dist > cfg.PUNISH_RANGE) {
        if (dx > 0) c.right = true;
        else c.left = true;
      }
      if (heightEdge < -30 && s.jetsCount > cfg.FUEL_PUNISH_MIN && clock >= this.noClimbUntil) {
        c.jetpack = true;
      }
    } else {
      // Bearing slot: sides split by current position (nobody crosses
      // through the bull); stalk tightens the offset so the pass launches
      // from striking distance. No top slot — the tape says the high gun
      // burns its fuel hovering and dies first.
      const off = stalking ? cfg.STALK_DIST : cfg.BEARING_OFF;
      const sorted = [...fronts].sort((a, b) => {
        const ax = parts.posX[a] ?? 0;
        const bx = parts.posX[b] ?? 0;
        return ax === bx ? a - b : ax - bx;
      });
      const k = Math.max(0, sorted.indexOf(botIndex));
      const leftCount = Math.ceil(sorted.length / 2);
      const dir = k < leftCount ? -1 : 1;
      let slotX = tx + dir * off;

      // Cohesion (hot mag only): an isolated torero regroups before glory —
      // but never abandons an open window or a committed stalk.
      if (!stalking && fronts.length >= 2) {
        let nearest = Infinity;
        let ox = 0;
        let oy = 0;
        let n = 0;
        for (const w of fronts) {
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

      if (dist < cfg.GIVE_GROUND) {
        // The bull walked onto us with a hot mag: back out, keep shooting.
        if (dx > 0) c.left = true;
        else c.right = true;
      } else if (px < slotX - cfg.X_SLACK) {
        c.right = true;
      } else if (px > slotX + cfg.X_SLACK) {
        c.left = true;
      } else {
        // IN the slot: strafe-juke on an rng clock — a parked gun is target
        // practice for every lead-aim in the arena.
        if (clock >= this.jukeFlipAt) {
          this.jukeDir = world.rng.nextInt(2) === 0 ? 1 : -1;
          this.jukeFlipAt =
            clock + cfg.JUKE_MIN_TICKS + world.rng.nextInt(cfg.JUKE_VAR_TICKS);
        }
        if (this.jukeDir > 0) c.right = true;
        else c.left = true;
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

    // --- Gun: the bull when shootable, else whatever is biting us ------------
    // A torero that walks its bearing while an un-targeted enemy shoots it
    // for free is the lesson every pack brain paid for.
    const auto = windowOpen ? dist <= cfg.WINDOW_AUTO : dist <= cfg.AUTO_RANGE;
    const bullShootable =
      dist <= cfg.FIRE_MAX_DIST &&
      hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty });
    if (bullShootable) {
      this.aimAndFire(botIndex, bullIdx, ctx, cfg.FIRE_MAX_DIST, auto);
    } else {
      const seen = findTarget(world, botIndex);
      if (seen > 0) this.aimAndFire(botIndex, seen, ctx, cfg.FIRE_MAX_DIST, false);
    }
  }
}

export function createCuadrillaEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('cuadrilla', CUADRILLA_DEFAULTS, tweaks);
  return {
    id: 'cuadrilla',
    strategy:
      "THE BULLFIGHTER'S CREW — one bull picked by mag state, crossfire bearings while its mag is hot, the whole crew passes to point-blank when it reloads; the wounded torero holds the long reserve",
    tweaks: cfg,
    createBrain: (): BotBrain => new CuadrillaBrain(cfg),
  };
}
