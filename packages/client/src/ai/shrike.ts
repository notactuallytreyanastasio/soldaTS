// "shrike" bot engine — the butcherbird, the ninth doctrine: the first
// WEAPON-AWARE brain.
//
// The shotgun wildcard changed the hardware but no doctrine noticed: every
// incumbent plays its AK game with whatever it happens to hold, so a SPAS
// carrier holds a 400px band and throws confetti. The shrike reads its own
// hardware (BotEngineContext.weaponOf) and fields two coordinated roles:
//
//   1. ROLE BY HARDWARE — the SPAS-12 carrier is the BREACHER; everyone on
//      an AK-74 is OVERWATCH. No assignment protocol: the weapon IS the
//      role, and the wildcard hands it out deterministically.
//   2. THE BREACHER fights the SPAS's actual math: 6-pellet fan (±0.057
//      rad), pellets at 14 px/tick that rainbow past 300px, damage halved
//      beyond 500px. So: HOLD FIRE on the way in (a silent approach gives
//      the lead-aimers nothing to dodge-read), come in HIGH and drop with
//      jets cut (gravity is the unleadable juke — reaper's one good idea),
//      open up only inside EFFECT_MAX, full pulls inside BLAST_RANGE, push
//      THROUGH below PUSH_DIST. The dash commits hardest into a reload
//      window (matador's clock: the target's mag is readable state). Six
//      shells, then climb out and pump them back in from height.
//   3. OVERWATCH escorts the breach with kestrel gunnery — planted
//      cooldown-locked taps, vertical bob, closest-approach bullet dodge,
//      EMA lead, true 0.135 drop — and focuses the enemy NEAREST THE
//      BREACHER: every head that turns to meet the breach eats overwatch
//      fire; every head that ignores overwatch eats the fan.
//   4. Without a wildcard (or before a host exposes weaponOf) every shrike
//      holds an AK and the doctrine degenerates to focus-fire marksmen —
//      a sane stock-rules fighter, not a wasted card.
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
const AK_BULLET_SPEED = 24.6; // px/tick — overwatch lead/drop math
const SPAS_BULLET_SPEED = 14; // px/tick — breacher lead/drop math

/** Shrike's strategy knobs — every value is tweakable per match.
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type ShrikeConfig = {
  ESCORT_FOCUS: number;
  BLAST_RANGE: number;
  EFFECT_MAX: number;
  PUSH_DIST: number;
  DIVE_HEIGHT: number;
  DIVE_ENTRY: number;
  WINDOW_MAG: number;
  SHELLS_LEAVE: number;
  BAND_MIN: number;
  BAND_MAX: number;
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

export const SHRIKE_DEFAULTS: Readonly<ShrikeConfig> = {
  ESCORT_FOCUS: 0, // 1 = overwatch shares the escort focus target; 0 = every
  // non-carrier duels independently (kestrel-style). The A/B vs hydra said
  // shared focus chases the rotation even as an escort — independent dueling
  // with a breacher in the mix is the stronger composition.
  BLAST_RANGE: 200, // px — inside this: every pump, full commitment
  EFFECT_MAX: 280, // px — first shells; beyond this the fan is confetti
  PUSH_DIST: 90, // px — closer: push THROUGH (re-opening range helps them)
  DIVE_HEIGHT: 180, // px — approach altitude above the mark
  DIVE_ENTRY: 250, // px — inside this with height: jets cut, freefall in
  WINDOW_MAG: 6, // rounds — target's mag at/below this opens the dash window
  SHELLS_LEAVE: 1, // shells — at/below this outside blast range: climb out, reload
  BAND_MIN: 320, // px — overwatch band (kestrel-proven)
  BAND_MAX: 460,
  APPROACH_FIRE_DIST: 620, // px — overwatch taps while repositioning inside this
  FIRE_MAX_DIST: 620, // px — beyond this, hold fire entirely
  FOCUS_RETARGET: 30, // ticks — overwatch shared-focus clock
  TAP_PERIOD: 6, // ticks — tap clock locked to the AK fire cooldown
  TAP_OPEN: 1,
  EMA_ALPHA: 0.15, // per-tick velocity smoothing (jukes average to center)
  DROP_G: 0.135, // px/tick² — TRUE bullet gravity (GRAV 0.06 × 2.25)
  BOB_UP_TICKS: 12, // hover-bob jet pulse (overwatch, planted)
  BOB_DOWN_MIN: 18,
  BOB_DOWN_VAR: 14,
  DODGE_HORIZON: 26, // ticks — closest-approach bullet-dodge window
  DANGER_RADIUS: 56,
  DODGE_COMMIT: 6,
  HEIGHT_SLACK: 110, // px — fix only deep height deficits
  FUEL_FLOOR: 80, // ticks — below this: no bob/climb, let regen pay
  RELOAD_LOW: 6, // rounds — overwatch reloads early behind the band
  HUNT_MEMORY_TICKS: 240, // ~4 s of last-seen pursuit
  // Ceiling-stall give-up (proven failure mode, see pilot.ts node 150).
  STALL_RISE_VY: -0.1,
  STALL_TRIGGER: 25,
  STALL_COOLDOWN: 180,
};

class ShrikeBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  private focus = 0;
  private lastSeenX = 0;
  private lastSeenY = 0;
  private lastSeenAt = -1;
  private emaVX = 0;
  private emaVY = 0;
  private emaTarget = 0;
  private bobJetUntil = 0;
  private bobFallUntil = 0;
  private dodgeX: 1 | 0 | -1 = 0;
  private dodgeJet: 1 | 0 | -1 = 0;
  private dodgeUntil = 0;
  private stallTicks = 0;
  private noClimbUntil = 0;

  constructor(private readonly cfg: ShrikeConfig) {}

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

  /** Role by hardware: 'SPAS12' carriers breach, everyone else overwatches. */
  private isBreacher(botIndex: number, ctx: BotEngineContext): boolean {
    return ctx.weaponOf?.(botIndex) === 'SPAS12';
  }

  /** The friendly breacher's sprite index, 0 if none alive. */
  private breacherOf(botIndex: number, ctx: BotEngineContext): number {
    const { world } = ctx;
    const self = world.sprites[botIndex];
    if (self === undefined || ctx.weaponOf === undefined) return 0;
    if (this.isBreacher(botIndex, ctx)) return botIndex;
    if (self.team === 0) return 0;
    for (let i = 1; i < world.sprites.length; i++) {
      const o = world.sprites[i];
      if (o === undefined || !o.active || o.deadMeat) continue;
      if (o.team !== self.team) continue;
      if (ctx.weaponOf(i) === 'SPAS12') return i;
    }
    return 0;
  }

  /** Overwatch focus: the enemy nearest the breach (escort the dive), else
   *  the lowest-health enemy visible to the team (the proven mirror). */
  private pickFocus(botIndex: number, ctx: BotEngineContext): number {
    const { world } = ctx;
    const self = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (self === undefined || parts === null) return 0;

    const breacher = this.breacherOf(botIndex, ctx);
    const ax = parts.posX[breacher > 0 ? breacher : botIndex] ?? 0;
    const ay = parts.posY[breacher > 0 ? breacher : botIndex] ?? 0;

    let best = 0;
    let bestKey = Infinity;
    for (let e = 1; e < world.sprites.length; e++) {
      if (e === botIndex) continue;
      const o = world.sprites[e];
      if (o === undefined || !o.active || o.deadMeat) continue;
      if (self.team > 0 && o.team === self.team) continue;
      if (o.alpha !== 255 && o.holdedThing === 0) continue;
      const ex = parts.posX[e] ?? 0;
      const ey = parts.posY[e] ?? 0;
      if (!hasLineOfSight(world, { x: parts.posX[botIndex] ?? 0, y: parts.posY[botIndex] ?? 0 }, { x: ex, y: ey })) {
        continue;
      }
      // Escort key: distance to the breach anchor; health breaks ties so a
      // wounded head near the breach gets finished first.
      const d = Math.hypot(ex - ax, ey - ay);
      const key = breacher > 0 ? d * 1000 + o.health : o.health * 100000 + d;
      if (key < bestKey) {
        bestKey = key;
        best = e;
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

    this.scanBullets(botIndex, ctx);

    // Role machinery only runs while a breach exists. With no SPAS on the
    // field (stock match, or the carrier is down) the shared-focus targeting
    // is pure downside — hydra's rotation starves exactly that rule, and the
    // controlled A/B (arena 57) showed stock shrike at 0.82 K/D where plain
    // kestrel dueling posts 1.05. No breacher → fight like a kestrel.
    const breacher = this.breacherOf(botIndex, ctx);
    const cur = world.sprites[this.focus];
    const focusAlive =
      this.focus > 0 &&
      cur !== undefined &&
      cur.active &&
      !cur.deadMeat &&
      !(s.team > 0 && cur.team === s.team);
    if (breacher > 0 && (!focusAlive || clock % cfg.FOCUS_RETARGET === 0)) {
      this.focus = this.pickFocus(botIndex, ctx);
    }

    if (breacher === botIndex) {
      this.breach(botIndex, ctx);
    } else if (breacher > 0 && this.focus > 0 && cfg.ESCORT_FOCUS > 0) {
      this.overwatch(botIndex, this.focus, ctx);
    } else {
      const seen = findTarget(world, botIndex);
      if (seen > 0) {
        this.overwatch(botIndex, seen, ctx);
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

    // Committed dodge LAST: survival movement beats positioning. The diving
    // breacher is exempt while falling — the dive IS the dodge.
    if (clock < this.dodgeUntil) {
      if (this.dodgeX !== 0) {
        c.left = this.dodgeX < 0;
        c.right = this.dodgeX > 0;
      }
      if (this.dodgeJet > 0 && s.jetsCount > 0) c.jetpack = true;
      else if (this.dodgeJet < 0) c.jetpack = false;
    }
  }

  /** Pillar 2: the breach. Silent high approach, gravity entry, blast range. */
  private breach(botIndex: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const cfg = this.cfg;
    const s = world.sprites[botIndex]!;
    const c = s.control;
    const parts = world.spriteParts!;
    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const clock = world.mainTickCounter;

    // The mark: nearest visible enemy — travel time dominates a brawler's
    // target value, not health.
    const mark = findTarget(world, botIndex);
    if (mark <= 0) {
      if (this.lastSeenAt >= 0 && clock - this.lastSeenAt < cfg.HUNT_MEMORY_TICKS) {
        if (px < this.lastSeenX - 40) c.right = true;
        else if (px > this.lastSeenX + 40) c.left = true;
        if (
          this.lastSeenY < py - 60 &&
          s.jetsCount > cfg.FUEL_FLOOR &&
          clock >= this.noClimbUntil
        ) {
          c.jetpack = true;
        }
      } else {
        roamTick(this.roam, botIndex, ctx);
      }
      return;
    }

    const tx = parts.posX[mark] ?? 0;
    const ty = parts.posY[mark] ?? 0;
    const tvx = parts.velocityX[mark] ?? 0;
    const tvy = parts.velocityY[mark] ?? 0;
    this.lastSeenX = tx;
    this.lastSeenY = ty;
    this.lastSeenAt = clock;

    const dx = tx - px;
    const dist = Math.hypot(dx, ty - py);
    const above = ty - py; // + = I'm above the mark
    const inbound: 1 | -1 = dx > 0 ? 1 : -1;

    // Shell discipline: six in the tube; leaving the fight dry is how
    // breachers die. Climb out and pump them back in from height.
    const shells = ctx.ammoOf(botIndex);
    const reloading = ctx.reloadingOf(botIndex);
    if (!reloading && shells === 0) c.reload = true;
    if (
      !reloading &&
      shells > 0 &&
      shells <= cfg.SHELLS_LEAVE &&
      dist > cfg.BLAST_RANGE
    ) {
      c.reload = true;
    }
    if (reloading) {
      if (dx > 0) c.left = true;
      else c.right = true;
      if (s.jetsCount > cfg.FUEL_FLOOR && clock >= this.noClimbUntil) {
        c.jetpack = true; // disengage UP: height is the next dive's fuel
      }
      return;
    }

    // The window: a reloading or near-dry mark cannot answer the dash.
    const windowOpen =
      ctx.reloadingOf(mark) || ctx.ammoOf(mark) <= cfg.WINDOW_MAG;

    // --- Movement: high silent approach, gravity entry, push through -------
    if (dist <= cfg.PUSH_DIST) {
      // THROUGH the mark — re-opening the range is a gift to a rifle.
      if (inbound > 0) c.right = true;
      else c.left = true;
      if (above < -30 && s.jetsCount > 0 && clock >= this.noClimbUntil) {
        c.jetpack = true; // under them: jet up into their feet
      }
    } else {
      // Net motion inbound, always; the window doubles as full commitment.
      if (inbound > 0) c.right = true;
      else c.left = true;

      const diving = dist <= cfg.DIVE_ENTRY && above >= 40;
      const wantHeight = above < cfg.DIVE_HEIGHT - 40 && !windowOpen;
      if (
        !diving &&
        wantHeight &&
        s.jetsCount > cfg.FUEL_FLOOR &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true; // climb to dive altitude on the way in
      }
      // (diving or window-dashing: jets stay cut — fall or sprint.)
    }

    // --- Gun: the SPAS's math, not the AK's ---------------------------------
    const tof = dist / SPAS_BULLET_SPEED;
    const drop = 0.5 * cfg.DROP_G * tof * tof;
    if (this.emaTarget !== mark) {
      this.emaTarget = mark;
      this.emaVX = tvx;
      this.emaVY = tvy;
    } else {
      this.emaVX += cfg.EMA_ALPHA * (tvx - this.emaVX);
      this.emaVY += cfg.EMA_ALPHA * (tvy - this.emaVY);
    }
    c.mouseAimX = Math.round(tx + this.emaVX * tof - px);
    c.mouseAimY = Math.round(ty + this.emaVY * tof - py - drop);

    // Silent approach: shells only where the fan kills. The pump cadence is
    // the cooldown's problem — inside the envelope the trigger stays down.
    c.fire = dist <= cfg.EFFECT_MAX;
  }

  /** Closest-approach scan over live enemy bullets (kestrel pillar). */
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

  private tapOpen(clock: number, botIndex: number): boolean {
    const cfg = this.cfg;
    return (clock + botIndex * 3) % cfg.TAP_PERIOD < cfg.TAP_OPEN;
  }

  /** Pillar 3: overwatch — kestrel band gunnery escorting the breach. */
  private overwatch(botIndex: number, targetIdx: number, ctx: BotEngineContext): void {
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
    const dist = Math.hypot(tx - px, ty - py);
    const heightEdge = ty - py;

    if (hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty })) {
      this.lastSeenX = tx;
      this.lastSeenY = ty;
      this.lastSeenAt = clock;
    }

    const ammo = ctx.ammoOf(botIndex);
    const reloading = ctx.reloadingOf(botIndex);
    if (!reloading && ammo === 0) c.reload = true;
    if (!reloading && ammo > 0 && ammo <= cfg.RELOAD_LOW && dist > cfg.BAND_MAX) {
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

    const planted = dist >= cfg.BAND_MIN && dist <= cfg.BAND_MAX;
    if (dist > cfg.BAND_MAX) {
      if (tx > px) c.right = true;
      else c.left = true;
      if (
        heightEdge < -cfg.HEIGHT_SLACK &&
        s.jetsCount > cfg.FUEL_FLOOR &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
    } else if (dist < cfg.BAND_MIN) {
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

    if (dist > cfg.FIRE_MAX_DIST) return;
    if (!planted && dist > cfg.APPROACH_FIRE_DIST) return;
    if (!hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty })) return;
    c.fire = this.tapOpen(clock, botIndex);
  }
}

export function createShrikeEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('shrike', SHRIKE_DEFAULTS, tweaks);
  return {
    id: 'shrike',
    strategy:
      'BUTCHERBIRD — weapon-aware: the SPAS carrier breaches (silent high approach, gravity dive, blast range), AK overwatch escorts with planted taps',
    tweaks: cfg,
    createBrain: (): BotBrain => new ShrikeBrain(cfg),
  };
}
