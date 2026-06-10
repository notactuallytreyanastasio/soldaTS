// "plover" bot engine — the broken-wing gambit, the seventh doctrine.
//
// The wolf proved the team is the unit of selection: three guns on one body
// win on arithmetic before anyone out-aims anybody (kestrel out-hit the wolf
// 47% to 43% and still lost 0-3). But the wolf's coordination has a fatal
// property: its prey function is DETERMINISTIC and computed from PUBLIC world
// state. Anything the pack can agree on without a channel, its prey can
// predict without a channel. The plover is the bird that fakes a broken wing
// to lure the predator away from the nest:
//
//   1. READ THE PACK'S MIND — the enemy focus falls on our lowest-health
//      member (that is what kill-securing focus rules converge on, and it is
//      exactly wolf's pickPrey). Every plover computes the same designation
//      from shared state: lowest health, ties by index. No comms, mirrored
//      convention.
//   2. THE BROKEN WING — the designated BAIT stops dueling and survives ON
//      PURPOSE: it kites the chasers inside a distance window (far enough to
//      live, close enough to stay seen and keep the aggro), drags the pack
//      into permanent transit — straight-line movers paying the movement
//      spread tax — and flips direction when cornered. A pack chasing a
//      ghost is three guns shooting at the hardest target on the field.
//   3. THE EXECUTIONERS — everyone else gets what focus doctrine never
//      grants: time UNTARGETED. They fight with kestrel gunnery (plant to
//      shoot, taps locked to the 6-tick cooldown, vertical bob in the
//      untaxed axis, dodge only bullets whose closest approach threatens,
//      EMA lead, TRUE 0.135 drop) and mirror the wolves' own arithmetic
//      back: all executioner guns on the lowest-health visible enemy,
//      re-evaluated on a shared clock. They chase a ghost; we delete a wolf.
//   4. ROLES FLOW — health changes, deaths and respawns re-run the same
//      designation everywhere at once. The bait that dies respawns whole and
//      picks up a gun; the executioner that bleeds becomes the new wing.
//
// Against non-pack doctrines nothing is wasted: the bait rule degenerates to
// "our weakest player plays safe", the focus rule to "finish the wounded" —
// both sane defaults in any meta.
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
// Physics fact of the gun (guns.ts AK74), NOT a strategy knob — stays a const.
const AK_BULLET_SPEED = 24.6; // px/tick — lead/drop math

/** Plover's strategy knobs — every value is tweakable per match.
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type PloverConfig = {
  BAIT_HP_ON: number;
  BAIT_NEAR: number;
  BAIT_FAR: number;
  ORBIT_MIN: number;
  ORBIT_MAX: number;
  BAIT_STUCK_TICKS: number;
  BAIT_FLIP_TICKS: number;
  HUNT_BAND_MIN: number;
  HUNT_BAND_MAX: number;
  APPROACH_FIRE_DIST: number;
  FIRE_MAX_DIST: number;
  FOCUS_RETARGET: number;
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

export const PLOVER_DEFAULTS: Readonly<PloverConfig> = {
  BAIT_HP_ON: 95, // hp — the wing breaks only once actually wounded; at full
  // health ties the pack's focus is ambiguous and a runner just burns a gun
  // (spar 1 was lost to a tick-0 bait chasing a prediction nobody made)
  BAIT_NEAR: 420, // px — chaser closer than this: the wing flees
  BAIT_FAR: 560, // px — chaser farther: drift back (stay seen, hold the aggro)
  ORBIT_MIN: 220, // px — fleeing wing keeps at least this from its gunners
  ORBIT_MAX: 420, // px — and at most this: the chase gets dragged THROUGH the
  // executioners' band instead of off the map (spars 1-4: a wing that flees
  // anywhere pulls the pack out of our guns' reach and the fight stays 2v3)
  BAIT_STUCK_TICKS: 30, // ticks of no horizontal progress = cornered
  BAIT_FLIP_TICKS: 70, // ticks the cornered wing commits to the reverse break
  HUNT_BAND_MIN: 340, // px — executioners stay outside wolf full-auto range
  HUNT_BAND_MAX: 480, // px — farther: close in
  APPROACH_FIRE_DIST: 500, // px — taps allowed while repositioning inside this
  FIRE_MAX_DIST: 620, // px — beyond this, hold fire entirely
  FOCUS_RETARGET: 30, // ticks — shared kill-target clock (mirror of the pack's)
  TAP_PERIOD: 6, // ticks — tap clock locked to the fire cooldown
  TAP_OPEN: 1, // one shot per period = full volume at zero bloom
  EMA_ALPHA: 0.15, // per-tick velocity smoothing (jukes average to center)
  DROP_G: 0.135, // px/tick² — TRUE bullet gravity (GRAV 0.06 × 2.25)
  BOB_UP_TICKS: 12, // jet-pulse length of the hover bob
  BOB_DOWN_MIN: 18, // fall phase length (rng-rolled per cycle)
  BOB_DOWN_VAR: 14,
  DODGE_HORIZON: 26, // ticks — only bullets arriving within this are threats
  DANGER_RADIUS: 56, // px — closest-approach distance that triggers a dodge
  DODGE_COMMIT: 6, // ticks — hold a dodge so it doesn't dither
  HEIGHT_SLACK: 110, // px — fix only deep height deficits
  FUEL_FLOOR: 80, // ticks — below this: no bob/climb, let regen pay
  RELOAD_LOW: 6, // rounds — reload early once safely out of the band
  HUNT_MEMORY_TICKS: 240, // ~4 s of last-seen pursuit after losing all eyes
  // Ceiling-stall give-up (proven failure mode, see pilot.ts node 150).
  STALL_RISE_VY: -0.1,
  STALL_TRIGGER: 25,
  STALL_COOLDOWN: 180,
};

class PloverBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  private focus = 0;
  private lastSeenX = 0;
  private lastSeenY = 0;
  private lastSeenAt = -1;
  /** EMA of the current gun target's velocity; reset on target switch. */
  private emaVX = 0;
  private emaVY = 0;
  private emaTarget = 0;
  /** Hover-bob phase clocks. */
  private bobJetUntil = 0;
  private bobFallUntil = 0;
  /** Committed bullet dodge. */
  private dodgeX: 1 | 0 | -1 = 0;
  private dodgeJet: 1 | 0 | -1 = 0;
  private dodgeUntil = 0;
  /** Broken-wing corner handling: flee-direction override while cornered. */
  private fleeStuck = 0;
  private flipDir: 1 | 0 | -1 = 0;
  private flipUntil = 0;
  private stallTicks = 0;
  private noClimbUntil = 0;

  constructor(private readonly cfg: PloverConfig) {}

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

  /** Living teammates (self included), ascending index. */
  private packOf(botIndex: number, ctx: BotEngineContext): number[] {
    const { world } = ctx;
    const self = world.sprites[botIndex];
    if (self === undefined || self.team === 0) return [botIndex];
    const pack: number[] = [];
    for (let i = 1; i < world.sprites.length; i++) {
      const s = world.sprites[i];
      if (s === undefined || !s.active || s.deadMeat) continue;
      if (s.team === self.team) pack.push(i);
    }
    return pack.length > 0 ? pack : [botIndex];
  }

  /** Pillar 1: who the enemy pack converges on = our lowest health; health
   *  ties break by distance to the ENEMY centroid (the same tie-break a
   *  centroid-anchored focus rule uses). Every plover computes this
   *  identically — mirrored convention. Returns 0 when nobody is wounded:
   *  an unprovoked runner is a wasted gun (spar-1 lesson). */
  private baitOf(botIndex: number, pack: readonly number[], ctx: BotEngineContext): number {
    const { world } = ctx;
    const parts = world.spriteParts;
    const self = world.sprites[botIndex];
    if (parts === null || self === undefined) return 0;

    let ecx = 0;
    let ecy = 0;
    let en = 0;
    for (let e = 1; e < world.sprites.length; e++) {
      if (e === botIndex) continue;
      const o = world.sprites[e];
      if (o === undefined || !o.active || o.deadMeat) continue;
      if (self.team > 0 && o.team === self.team) continue;
      ecx += parts.posX[e] ?? 0;
      ecy += parts.posY[e] ?? 0;
      en += 1;
    }
    if (en === 0) return 0;
    ecx /= en;
    ecy /= en;

    let bait = 0;
    let low = Infinity;
    let lowD = Infinity;
    for (const i of pack) {
      const h = world.sprites[i]?.health ?? Infinity;
      if (h >= this.cfg.BAIT_HP_ON) continue; // unwounded birds keep shooting
      const dx = (parts.posX[i] ?? 0) - ecx;
      const dy = (parts.posY[i] ?? 0) - ecy;
      const d = dx * dx + dy * dy;
      if (h < low || (h === low && d < lowD)) {
        low = h;
        lowD = d;
        bait = i;
      }
    }
    return bait;
  }

  /** Pillar 3: the executioners' shared kill target — lowest-health enemy
   *  visible to ANY packmate, ties by distance to the pack centroid. The
   *  wolves' own arithmetic, mirrored back at them. */
  private pickFocus(botIndex: number, pack: readonly number[], ctx: BotEngineContext): number {
    const { world } = ctx;
    const self = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (self === undefined || parts === null) return 0;
    let cx = 0;
    let cy = 0;
    for (const w of pack) {
      cx += parts.posX[w] ?? 0;
      cy += parts.posY[w] ?? 0;
    }
    cx /= pack.length;
    cy /= pack.length;

    let best = 0;
    let bestHealth = Infinity;
    let bestD = Infinity;
    for (let e = 1; e < world.sprites.length; e++) {
      if (e === botIndex) continue;
      const o = world.sprites[e];
      if (o === undefined || !o.active || o.deadMeat) continue;
      if (self.team > 0 && o.team === self.team) continue;
      if (o.alpha !== 255 && o.holdedThing === 0) continue;
      const ex = parts.posX[e] ?? 0;
      const ey = parts.posY[e] ?? 0;
      let seen = false;
      for (const w of pack) {
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
      if (o.health < bestHealth || (o.health === bestHealth && d < bestD)) {
        best = e;
        bestHealth = o.health;
        bestD = d;
      }
    }
    return best;
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
    const pack = this.packOf(botIndex, ctx);

    // Bullet threats override everything else's movement (kestrel pillar).
    this.scanBullets(botIndex, ctx);

    // Shared-clock focus target, immediate re-pick when it dies.
    const cur = world.sprites[this.focus];
    const focusAlive =
      this.focus > 0 &&
      cur !== undefined &&
      cur.active &&
      !cur.deadMeat &&
      !(s.team > 0 && cur.team === s.team);
    if (!focusAlive || clock % cfg.FOCUS_RETARGET === 0) {
      this.focus = this.pickFocus(botIndex, pack, ctx);
    }

    const isBait = pack.length >= 2 && this.baitOf(botIndex, pack, ctx) === botIndex;
    if (isBait) {
      this.baitTick(botIndex, ctx);
    } else if (this.focus > 0) {
      this.engage(botIndex, this.focus, ctx);
    } else {
      const seen = findTarget(world, botIndex);
      if (seen > 0) {
        this.engage(botIndex, seen, ctx);
      } else if (
        this.lastSeenAt >= 0 &&
        clock - this.lastSeenAt < cfg.HUNT_MEMORY_TICKS
      ) {
        const px = parts.posX[botIndex] ?? 0;
        const py = parts.posY[botIndex] ?? 0;
        if (px < this.lastSeenX - 40) c.right = true;
        else if (px > this.lastSeenX + 40) c.left = true;
        if (
          this.lastSeenY < py - cfg.HEIGHT_SLACK &&
          s.jetsCount > cfg.FUEL_FLOOR &&
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

  /** Pillar 2: the broken wing. Survive, stay seen, drag the pack. */
  private baitTick(botIndex: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const cfg = this.cfg;
    const s = world.sprites[botIndex]!;
    const c = s.control;
    const parts = world.spriteParts!;
    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const clock = world.mainTickCounter;

    // Nearest living enemy (the lead chaser) and the chaser centroid.
    let near = 0;
    let nearD = Infinity;
    let ecx = 0;
    let en = 0;
    for (let e = 1; e < world.sprites.length; e++) {
      if (e === botIndex) continue;
      const o = world.sprites[e];
      if (o === undefined || !o.active || o.deadMeat) continue;
      if (s.team > 0 && o.team === s.team) continue;
      const d = Math.hypot((parts.posX[e] ?? 0) - px, (parts.posY[e] ?? 0) - py);
      ecx += parts.posX[e] ?? 0;
      en += 1;
      if (d < nearD) {
        nearD = d;
        near = e;
      }
    }
    if (near === 0) {
      roamTick(this.roam, botIndex, ctx);
      return;
    }
    ecx /= en;

    // Mag hygiene: the wing reloads while it runs — its gun is a bonus.
    const ammo = ctx.ammoOf(botIndex);
    if (!ctx.reloadingOf(botIndex) && (ammo === 0 || ammo <= cfg.RELOAD_LOW)) {
      c.reload = true;
    }

    // Gunner (non-bait packmate) centroid: the wing's orbit anchor.
    const pack = this.packOf(botIndex, ctx);
    let gx0 = 0;
    let gy0 = 0;
    let gn = 0;
    for (const w of pack) {
      if (w === botIndex) continue;
      gx0 += parts.posX[w] ?? 0;
      gy0 += parts.posY[w] ?? 0;
      gn += 1;
    }
    const anchorX = gn > 0 ? gx0 / gn : px;

    if (nearD < cfg.BAIT_NEAR) {
      // FLEE — but never off the map: orbit the gunners so the chase is
      // dragged through their band. Outside ORBIT_MAX → break back toward
      // the anchor; inside ORBIT_MIN → push out; in the ring → keep running
      // away from the chasers. Cornered → committed reverse break (running
      // into a wall while three guns converge is how wings actually get
      // broken).
      let dir: 1 | -1 = px >= ecx ? 1 : -1;
      if (gn > 0) {
        const fromAnchor = px - anchorX;
        if (Math.abs(fromAnchor) > cfg.ORBIT_MAX) {
          dir = fromAnchor > 0 ? -1 : 1; // too far: drag the pack back through
        } else if (Math.abs(fromAnchor) < cfg.ORBIT_MIN) {
          dir = fromAnchor >= 0 ? 1 : -1; // too close: don't park on the guns
        }
      }
      const vx = parts.velocityX[botIndex] ?? 0;
      if (clock < this.flipUntil && this.flipDir !== 0) {
        dir = this.flipDir > 0 ? 1 : -1;
      } else {
        if (Math.abs(vx) < 0.3) this.fleeStuck += 1;
        else this.fleeStuck = 0;
        if (this.fleeStuck > cfg.BAIT_STUCK_TICKS) {
          this.fleeStuck = 0;
          this.flipDir = dir > 0 ? -1 : 1;
          this.flipUntil = clock + cfg.BAIT_FLIP_TICKS;
          dir = this.flipDir;
        }
      }
      if (dir > 0) c.right = true;
      else c.left = true;
      // Altitude is escape distance the chasers must pay fuel for.
      if (s.jetsCount > cfg.FUEL_FLOOR && clock >= this.noClimbUntil) {
        c.jetpack = true;
      }
    } else if (nearD > cfg.BAIT_FAR) {
      // Too safe = invisible = the pack retargets a gunner. Drift back in.
      const tx = parts.posX[near] ?? 0;
      if (px < tx - 40) c.right = true;
      else if (px > tx + 40) c.left = true;
    } else {
      // In the window: plant + bob like a gunner — seen, alive, infuriating.
      if (s.jetsCount > cfg.FUEL_FLOOR && clock >= this.noClimbUntil) {
        if (clock >= this.bobFallUntil) {
          this.bobJetUntil = clock + cfg.BOB_UP_TICKS;
          this.bobFallUntil =
            this.bobJetUntil + cfg.BOB_DOWN_MIN + world.rng.nextInt(cfg.BOB_DOWN_VAR);
        }
        c.jetpack = clock < this.bobJetUntil;
      }
    }

    // The wing still shoots what it can: the shared focus if in reach, else
    // the lead chaser. Taxed while fleeing, free while planted in the window.
    const gun =
      this.focus > 0 &&
      hasLineOfSight(
        world,
        { x: px, y: py },
        { x: parts.posX[this.focus] ?? 0, y: parts.posY[this.focus] ?? 0 },
      )
        ? this.focus
        : near;
    this.aimAndTap(botIndex, gun, ctx, /*allowWhileMoving=*/ true);
  }

  /** Closest-approach scan over live enemy bullets (kestrel pillar, vertical-
   *  first response — band bullets fly flat, the perpendicular is the untaxed
   *  axis; incumbents under-compensate drop so rising widens their miss). */
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

  /** Tap clock staggered per bot so the team keeps rolling pressure. */
  private tapOpen(clock: number, botIndex: number): boolean {
    const cfg = this.cfg;
    return (clock + botIndex * 3) % cfg.TAP_PERIOD < cfg.TAP_OPEN;
  }

  /** EMA lead + two-pass time-of-flight + TRUE drop, then the tap trigger. */
  private aimAndTap(
    botIndex: number,
    targetIdx: number,
    ctx: BotEngineContext,
    allowWhileMoving: boolean,
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

    const tof0 = dist / AK_BULLET_SPEED;
    const px1 = tx + this.emaVX * tof0;
    const py1 = ty + this.emaVY * tof0;
    const tof = Math.hypot(px1 - px, py1 - py) / AK_BULLET_SPEED;
    const drop = 0.5 * cfg.DROP_G * tof * tof;
    c.mouseAimX = Math.round(tx + this.emaVX * tof - px);
    c.mouseAimY = Math.round(ty + this.emaVY * tof - py - drop);

    if (ctx.reloadingOf(botIndex)) return;
    if (dist > cfg.FIRE_MAX_DIST) return;
    if (!allowWhileMoving && dist > cfg.APPROACH_FIRE_DIST) return;
    if (!hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty })) return;
    c.fire = this.tapOpen(world.mainTickCounter, botIndex);
  }

  /** Executioner: kestrel band gunnery against the shared focus target. */
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
    const clock = world.mainTickCounter;
    const dist = Math.hypot(tx - px, ty - py);
    const heightEdge = ty - py; // + = I'm above the target

    if (hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty })) {
      this.lastSeenX = tx;
      this.lastSeenY = ty;
      this.lastSeenAt = clock;
    }

    // Mag hygiene: reload on MY terms, disengage while the mag is out.
    const ammo = ctx.ammoOf(botIndex);
    const reloading = ctx.reloadingOf(botIndex);
    if (!reloading && ammo === 0) c.reload = true;
    if (
      !reloading &&
      ammo > 0 &&
      ammo <= cfg.RELOAD_LOW &&
      dist > cfg.HUNT_BAND_MAX
    ) {
      c.reload = true;
    }
    if (reloading) {
      if (tx > px) c.left = true;
      else c.right = true;
      if (s.jetsCount > cfg.FUEL_FLOOR && clock >= this.noClimbUntil) {
        c.jetpack = true;
      }
      return;
    }

    const planted = dist >= cfg.HUNT_BAND_MIN && dist <= cfg.HUNT_BAND_MAX;
    if (dist > cfg.HUNT_BAND_MAX) {
      if (tx > px) c.right = true;
      else c.left = true;
      if (
        heightEdge < -cfg.HEIGHT_SLACK &&
        s.jetsCount > cfg.FUEL_FLOOR &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
    } else if (dist < cfg.HUNT_BAND_MIN) {
      if (tx > px) c.left = true;
      else c.right = true;
    } else if (s.jetsCount > cfg.FUEL_FLOOR && clock >= this.noClimbUntil) {
      if (heightEdge < -cfg.HEIGHT_SLACK) {
        c.jetpack = true;
      } else {
        if (clock >= this.bobFallUntil) {
          this.bobJetUntil = clock + cfg.BOB_UP_TICKS;
          this.bobFallUntil =
            this.bobJetUntil + cfg.BOB_DOWN_MIN + world.rng.nextInt(cfg.BOB_DOWN_VAR);
        }
        c.jetpack = clock < this.bobJetUntil;
      }
    }

    // Gun: the focus when shootable, else the nearest visible threat (the
    // wolf's own opportunistic-trigger lesson, adopted).
    const focusShootable =
      dist <= cfg.FIRE_MAX_DIST &&
      hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty });
    if (focusShootable) {
      this.aimAndTap(botIndex, targetIdx, ctx, planted);
    } else {
      const seen = findTarget(world, botIndex);
      if (seen > 0) this.aimAndTap(botIndex, seen, ctx, planted);
    }
  }
}

export function createPloverEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('plover', PLOVER_DEFAULTS, tweaks);
  return {
    id: 'plover',
    strategy:
      'BROKEN-WING GAMBIT — predict the pack’s prey, bait it with a kiting decoy, executioners plant and delete the chasers one by one',
    tweaks: cfg,
    createBrain: (): BotBrain => new PloverBrain(cfg),
  };
}
