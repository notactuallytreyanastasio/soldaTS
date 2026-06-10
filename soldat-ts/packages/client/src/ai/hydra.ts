// "hydra" bot engine — cut one head, the others bite. The eighth doctrine.
//
// The wolf proved the team is the unit of selection: three guns on one body
// win on arithmetic (kestrel out-aimed the wolf and still lost 0-3). But the
// champion's arithmetic is PUBLISHED — wolf.ts on main says its pack focuses
// the lowest-health enemy visible to any packmate... and only within
// PREY_RADIUS (550px) of the pack centroid, and it holds fire entirely beyond
// FIRE_MAX_DIST (620px). The hydra's answer is the monster's own anatomy:
// no head stays exposed once it's been cut.
//
//   1. ONE MIND, MANY HEADS — all heads compute the same focus target from
//      shared world state: lowest-health enemy visible to ANY head, ties by
//      distance to the pack centroid, re-evaluated on a shared clock. The
//      champion's arithmetic, mirrored back. Agreement by convention; no
//      communication channel exists or is needed.
//   2. THE CUT HEAD WITHDRAWS — when any head's health drops below
//      ROTATE_BELOW, the lowest-health head becomes the ANCHOR: it retreats
//      to a planted long band measured from the ENEMY centroid — outside the
//      published prey radius AND outside the champion's maximum firing range
//      — and keeps tap-firing drop-compensated rounds from there. A
//      kill-securing focus function that ignores distant wounded enemies is
//      starved: the kill it wants to secure is no longer on the menu, so the
//      enemy's three guns land on a FULL-HEALTH head instead. Damage spreads;
//      nobody dies. Selection is stateless (argmin health, ties by index) so
//      heads that die and miss ticks can never disagree about who withdraws.
//   3. FRESH HEADS BITE — the healthy heads fight with the proven kestrel
//      fire kit: plant to shoot (movement spread is a tax), taps locked to
//      the 6-tick fire cooldown, vertical bob in the untaxed axis, dodge only
//      bullets whose closest approach threatens, EMA lead, TRUE 0.135 drop.
//      One change bought by the tape: taps stay allowed all the way out to
//      FIRE_MAX_DIST while repositioning — holding fire on the approach
//      donates the long exchange to whoever doesn't.
//   4. HEADS GROW BACK — a dead head respawns at full health, stops being the
//      argmin, and automatically rejoins the front; whoever is bleeding most
//      inherits the anchor. The rotation is the doctrine.
//
// Against non-pack doctrines nothing is wasted: the anchor rule degenerates
// to "our most wounded player trades from max range", the focus rule to
// "finish the wounded" — sane defaults in any meta.
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

/** Hydra's strategy knobs — every value is tweakable per match.
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type HydraConfig = {
  ROTATE_BELOW: number;
  ANCHOR_MIN: number;
  ANCHOR_MAX: number;
  ANCHOR_FIRE_MAX: number;
  ANCHOR_STUCK_TICKS: number;
  BEARING_OFF: number;
  X_SLACK: number;
  GIVE_GROUND: number;
  KNIFE_DIST: number;
  FIRE_MAX_DIST: number;
  APPROACH_FIRE_DIST: number;
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

export const HYDRA_DEFAULTS: Readonly<HydraConfig> = {
  ROTATE_BELOW: 100, // health (of 150) — lowest head withdraws once under this
  ANCHOR_MIN: 600, // px from ENEMY centroid — outside published prey radius/fire max
  ANCHOR_MAX: 760, // px — farther: drift back toward the fight
  ANCHOR_FIRE_MAX: 700, // px — the anchor's planted taps reach this far
  ANCHOR_STUCK_TICKS: 30, // ticks of no horizontal progress while fleeing = climb out
  BEARING_OFF: 340, // px — front slots sit this far left/right of the focus
  X_SLACK: 40, // px — horizontal deadband around the slot (plant inside it)
  GIVE_GROUND: 240, // px — prey closer than this: back out (their bloom stops mattering)
  KNIFE_DIST: 170, // px — inside: fire every open tick while backing out
  FIRE_MAX_DIST: 620, // px — fronts tap to here while PLANTED (volume wins long trades)
  APPROACH_FIRE_DIST: 620, // px — moving taps stay on all the way out (volume > the move tax)
  FOCUS_RETARGET: 30, // ticks — shared focus re-evaluation clock
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
  HEIGHT_SLACK: 110, // px — fight level happily; fix only deep height deficits
  FUEL_FLOOR: 80, // ticks — below this: no bob/climb, let regen pay
  RELOAD_LOW: 6, // rounds — reload early once safely out of the band
  HUNT_MEMORY_TICKS: 240, // ~4 s of last-seen pursuit after losing all eyes
  // Ceiling-stall give-up (proven failure mode, see pilot.ts node 150).
  STALL_RISE_VY: -0.1,
  STALL_TRIGGER: 25,
  STALL_COOLDOWN: 180,
};

class HydraBrain implements BotBrain {
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
  /** Anchor corner handling: climb out when fleeing into geometry. */
  private fleeStuck = 0;
  private stallTicks = 0;
  private noClimbUntil = 0;

  constructor(private readonly cfg: HydraConfig) {}

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

  /** Living heads (self included), ascending sprite index. */
  private packOf(botIndex: number, ctx: BotEngineContext): number[] {
    const { world } = ctx;
    const self = world.sprites[botIndex];
    if (self === undefined || self.team === 0) return [botIndex]; // FFA: one head
    const pack: number[] = [];
    for (let i = 1; i < world.sprites.length; i++) {
      const s = world.sprites[i];
      if (s === undefined || !s.active || s.deadMeat) continue;
      if (s.team === self.team) pack.push(i);
    }
    return pack.length > 0 ? pack : [botIndex];
  }

  /** Pillar 2: who withdraws — STATELESS argmin health (ties by index), only
   *  when wounded below ROTATE_BELOW. Stateless so heads that died and missed
   *  ticks can never disagree with the living about the rotation. */
  private anchorOf(pack: readonly number[], ctx: BotEngineContext): number {
    if (pack.length < 2) return 0; // a lone head has nowhere to rotate to
    const { world } = ctx;
    let anchor = 0;
    let low = Infinity;
    for (const i of pack) {
      const h = world.sprites[i]?.health ?? Infinity;
      if (h < low) {
        low = h;
        anchor = i;
      }
    }
    return low < this.cfg.ROTATE_BELOW ? anchor : 0;
  }

  /** Pillar 1: the shared focus — lowest-health enemy visible to ANY head,
   *  ties by distance to the pack centroid, then by index. */
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

    const anchorIdx = this.anchorOf(pack, ctx);
    const fronts = pack.filter((i) => i !== anchorIdx);
    if (anchorIdx === botIndex) {
      this.anchorTick(botIndex, ctx);
    } else if (this.focus > 0) {
      this.engage(botIndex, this.focus, fronts, ctx);
    } else {
      const seen = findTarget(world, botIndex);
      if (seen > 0) {
        this.engage(botIndex, seen, fronts, ctx);
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

  /** Pillar 2: the cut head. Hold a planted long band off the ENEMY centroid
   *  and keep trading drop-compensated taps from outside their reach. */
  private anchorTick(botIndex: number, ctx: BotEngineContext): void {
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
    if (!ctx.reloadingOf(botIndex) && (ammo === 0 || ammo <= cfg.RELOAD_LOW)) {
      c.reload = true;
    }

    if (d < cfg.ANCHOR_MIN) {
      // Open range away from the enemy centroid; climb out when geometry
      // blocks the run (vertical distance counts too, and height is escape
      // the chasers must pay fuel for).
      if (px >= ecen.x) c.right = true;
      else c.left = true;
      const vx = parts.velocityX[botIndex] ?? 0;
      if (Math.abs(vx) < 0.3) this.fleeStuck += 1;
      else this.fleeStuck = 0;
      if (
        (this.fleeStuck > cfg.ANCHOR_STUCK_TICKS || d < cfg.ANCHOR_MIN - 150) &&
        s.jetsCount > cfg.FUEL_FLOOR &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
    } else if (d > cfg.ANCHOR_MAX) {
      // Too far to contribute: drift back toward the fight.
      if (px < ecen.x - 40) c.right = true;
      else if (px > ecen.x + 40) c.left = true;
    } else if (s.jetsCount > cfg.FUEL_FLOOR && clock >= this.noClimbUntil) {
      // In the band: planted bob, exactly like a front gunner.
      if (clock >= this.bobFallUntil) {
        this.bobJetUntil = clock + cfg.BOB_UP_TICKS;
        this.bobFallUntil =
          this.bobJetUntil + cfg.BOB_DOWN_MIN + world.rng.nextInt(cfg.BOB_DOWN_VAR);
      }
      c.jetpack = clock < this.bobJetUntil;
    }

    // The anchor's gun: the shared focus when it can see it, else whatever
    // findTarget offers — long planted taps are free damage.
    const gun =
      this.focus > 0 &&
      hasLineOfSight(
        world,
        { x: px, y: py },
        { x: parts.posX[this.focus] ?? 0, y: parts.posY[this.focus] ?? 0 },
      )
        ? this.focus
        : findTarget(world, botIndex);
    if (gun > 0) this.aimAndTap(botIndex, gun, ctx, cfg.ANCHOR_FIRE_MAX);
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
    fireMax: number,
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
    if (dist > fireMax) return;
    if (!hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty })) return;
    if (dist <= cfg.KNIFE_DIST) c.fire = true;
    else c.fire = this.tapOpen(world.mainTickCounter, botIndex);
  }

  /** Pillar 3: a fresh head — kestrel gunnery from a bearing slot. Fronts
   *  split left/right of the focus BY CURRENT POSITION (leftmost takes left,
   *  no head crosses through the prey to reach a slot — the champion's
   *  published geometry, adopted), so escape from one fire line walks into
   *  the other. */
  private engage(
    botIndex: number,
    targetIdx: number,
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
      ((ammo <= cfg.RELOAD_LOW && dist > cfg.BEARING_OFF + 120) ||
        (ammo <= 2 && dist > cfg.KNIFE_DIST))
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

    // Bearing slot: position-based left/right split among the fronts.
    const sorted = [...fronts].sort((a, b) => {
      const ax = parts.posX[a] ?? 0;
      const bx = parts.posX[b] ?? 0;
      return ax === bx ? a - b : ax - bx;
    });
    const k = Math.max(0, sorted.indexOf(botIndex));
    const leftCount = Math.ceil(sorted.length / 2);
    const dir = k < leftCount ? -1 : 1;
    const slotX = tx + dir * cfg.BEARING_OFF;
    const inSlot = Math.abs(px - slotX) <= cfg.X_SLACK;

    // Movement: take the slot, give ground when crowded, bob when planted.
    if (dist < cfg.GIVE_GROUND) {
      if (tx > px) c.left = true;
      else c.right = true;
    } else if (!inSlot) {
      if (px < slotX - cfg.X_SLACK) c.right = true;
      else c.left = true;
      if (
        heightEdge < -cfg.HEIGHT_SLACK &&
        s.jetsCount > cfg.FUEL_FLOOR &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
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

    // Gun: the focus when shootable, else the nearest visible threat — a head
    // that walks its slot while an un-focused enemy shoots it for free is the
    // lesson every pack brain before this one paid for. Moving shots pay the
    // movement-spread tax; APPROACH_FIRE_DIST decides how far they still go.
    const planted = inSlot && dist >= cfg.GIVE_GROUND;
    const fireMax = planted ? cfg.FIRE_MAX_DIST : cfg.APPROACH_FIRE_DIST;
    const focusShootable =
      dist <= fireMax && hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty });
    if (focusShootable) {
      this.aimAndTap(botIndex, targetIdx, ctx, fireMax);
    } else {
      const seen = findTarget(world, botIndex);
      if (seen > 0) this.aimAndTap(botIndex, seen, ctx, fireMax);
    }
  }
}

export function createHydraEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('hydra', HYDRA_DEFAULTS, tweaks);
  return {
    id: 'hydra',
    strategy:
      'CUT ONE HEAD, THE OTHERS BITE — the wounded head withdraws beyond the prey radius and snipes; fresh heads plant and focus-fire the weakest enemy',
    tweaks: cfg,
    createBrain: (): BotBrain => new HydraBrain(cfg),
  };
}
