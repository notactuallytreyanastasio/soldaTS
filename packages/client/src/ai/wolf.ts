// "wolf" bot engine — the pack hunter, the sixth doctrine.
//
// Every doctrine before this one — classic's bands, pilot's height, reaper's
// dive, matador's tempo, kestrel's marksmanship — optimizes the DUELIST.
// Three of them on a team play three independent 1v1s. The wolf's bet is
// that the team is the unit of selection: a pack that concentrates three
// guns on one body turns every fight into a 3v1, and wins the match on
// arithmetic before anyone out-aims anybody.
//
//   1. ONE PREY — all wolves compute the same focus target from the same
//      world state: the enemy with the LOWEST HEALTH among those visible to
//      ANY packmate (shared eyes), ties broken by distance to the pack
//      centroid. No communication channel exists or is needed — agreement
//      by convention is coordination. Re-evaluated on a shared clock
//      (tick % PREY_RETARGET) so the whole pack switches together instead
//      of thrashing.
//   2. CROSSFIRE BEARINGS — three guns from one direction is one gun with
//      extra ammo: dodging is angular. The highest-indexed living wolf
//      takes TOP (HIGH_OFF above the prey); the side wolves split by their
//      current position — leftmost takes left, the other right — so escape
//      from one bearing walks into another and nobody crosses through the
//      prey to reach a slot.
//   3. REGROUP BEFORE GLORY — focus fire dies to isolation. A wolf whose
//      nearest living packmate is beyond COHESION_DIST abandons the
//      approach and moves to the pack centroid first; it still shoots what
//      it can see on the way. The pack fights together or not at all.
//   4. PROVEN FUNDAMENTALS, STOLEN SHAMELESSLY — true 0.135 bullet drop
//      (BulletParts gravity), taps locked to the 6-tick fire cooldown at
//      range with full-auto inside AUTO_RANGE, time-of-flight lead, reload
//      on the disengage, and the ceiling-stall give-up every brain before
//      it paid to learn.
//
// Same contract as every engine: output is the bot's control only, all
// randomness through world.rng.

import { hasLineOfSight } from '@soldat/sim';
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
// Physics facts of the gun (guns.ts AK74 / sim setup.ts), NOT strategy knobs.
const AK_BULLET_SPEED = 24.6; // px/tick — lead math
const BULLET_GRAV = 0.06 * 2.25; // px/tick² — BulletParts gravity (Cvar.pas:228-231)

/** Wolf's strategy knobs — every value is tweakable per match.
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type WolfConfig = {
  PACK_RANGE: number;
  HIGH_OFF: number;
  COHESION_DIST: number;
  PREY_RETARGET: number;
  PREY_RADIUS: number;
  JUKE_MIN_TICKS: number;
  JUKE_VAR_TICKS: number;
  X_SLACK: number;
  LEVEL_BAND: number;
  AUTO_RANGE: number;
  TAP_PERIOD: number;
  TAP_OPEN: number;
  FIRE_MAX_DIST: number;
  SELF_RELOAD_AT: number;
  FUEL_RESERVE: number;
  HUNT_MEMORY_TICKS: number;
  STALL_RISE_VY: number;
  STALL_TRIGGER: number;
  STALL_COOLDOWN: number;
};

export const WOLF_DEFAULTS: Readonly<WolfConfig> = {
  PACK_RANGE: 360, // px — side-bearing standoff radius from the prey
  HIGH_OFF: 200, // px — the top wolf holds this far above the prey
  COHESION_DIST: 380, // px — nearest packmate farther than this: regroup first
  PREY_RETARGET: 45, // ticks — shared re-evaluation clock (whole pack switches together)
  PREY_RADIUS: 550, // px — wounded prey beyond this of the centroid doesn't drag the pack
  JUKE_MIN_TICKS: 14, // in-slot strafe-juke clock (a parked wolf is target practice)
  JUKE_VAR_TICKS: 22,
  X_SLACK: 40, // px — horizontal deadband around the bearing slot
  LEVEL_BAND: 50, // px — side wolves climb when more than this below the slot
  AUTO_RANGE: 240, // px — full-auto inside this; taps beyond (bloom discipline)
  TAP_PERIOD: 6, // ticks — tap clock locked to the fire cooldown
  TAP_OPEN: 1, // one shot per period = max volume at zero bloom
  FIRE_MAX_DIST: 620, // px — beyond this, hold fire entirely
  SELF_RELOAD_AT: 8, // rounds — proactive reload when the prey is out of reach
  FUEL_RESERVE: 100, // ticks — below this, no positional climbing
  HUNT_MEMORY_TICKS: 240, // ~4 s of last-seen pursuit after the pack loses all eyes
  // Ceiling-stall give-up (proven failure mode, see pilot.ts node 150).
  STALL_RISE_VY: -0.1,
  STALL_TRIGGER: 25,
  STALL_COOLDOWN: 180,
};

class WolfBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  private prey = 0;
  private jukeDir: 1 | -1 = 1;
  private jukeFlipAt = 0;
  private lastSeenX = 0;
  private lastSeenY = 0;
  private lastSeenAt = -1;
  private stallTicks = 0;
  private noClimbUntil = 0;

  constructor(private readonly cfg: WolfConfig) {}

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

  /** Living packmates (self included), ascending sprite index. */
  private packOf(botIndex: number, ctx: BotEngineContext): number[] {
    const { world } = ctx;
    const self = world.sprites[botIndex];
    if (self === undefined) return [botIndex];
    if (self.team === 0) return [botIndex]; // FFA: a pack of one
    const pack: number[] = [];
    for (let i = 1; i < world.sprites.length; i++) {
      const s = world.sprites[i];
      if (s === undefined || !s.active || s.deadMeat) continue;
      if (s.team === self.team) pack.push(i);
    }
    return pack.length > 0 ? pack : [botIndex];
  }

  /**
   * Pillar 1: the pack's single prey. Lowest health among enemies visible to
   * ANY living packmate (shared eyes), ties by distance to the pack centroid,
   * then by index (iteration order). Every wolf computes this identically
   * from world state — agreement needs no channel.
   */
  private pickPrey(botIndex: number, ctx: BotEngineContext, pack: readonly number[]): number {
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

    // Two tiers: inside PREY_RADIUS of the centroid, lowest health wins
    // (kill-securing); a wounded enemy beyond it doesn't drag the pack
    // across the map past healthy guns — outside the radius only the
    // nearest-to-centroid counts, as a fallback when nobody is in reach.
    const radiusSq = this.cfg.PREY_RADIUS * this.cfg.PREY_RADIUS;
    let best = 0;
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
      if (d <= radiusSq) {
        if (o.health < bestHealth || (o.health === bestHealth && d < bestD)) {
          best = e;
          bestHealth = o.health;
          bestD = d;
        }
      } else if (d < farBestD) {
        farBest = e;
        farBestD = d;
      }
    }
    return best > 0 ? best : farBest;
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
    const cfg = this.cfg;
    const pack = this.packOf(botIndex, ctx);

    // Shared-clock prey re-evaluation, immediate when the prey is gone.
    const cur = world.sprites[this.prey];
    const preyAlive =
      this.prey > 0 &&
      this.prey !== botIndex &&
      cur !== undefined &&
      cur.active &&
      !cur.deadMeat &&
      !(s.team > 0 && cur.team === s.team);
    if (!preyAlive || clock % cfg.PREY_RETARGET === 0) {
      this.prey = this.pickPrey(botIndex, ctx, pack);
    }

    if (this.prey > 0) {
      const tx = parts.posX[this.prey] ?? 0;
      const ty = parts.posY[this.prey] ?? 0;
      if (hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty })) {
        this.lastSeenX = tx;
        this.lastSeenY = ty;
        this.lastSeenAt = clock;
      }
      this.engage(botIndex, this.prey, pack, ctx);
      return;
    }

    // Pack has no eyes on anyone: hunt the last sighting, then patrol.
    if (this.lastSeenAt >= 0 && clock - this.lastSeenAt < cfg.HUNT_MEMORY_TICKS) {
      if (px < this.lastSeenX - 40) c.right = true;
      else if (px > this.lastSeenX + 40) c.left = true;
      if (
        this.lastSeenY < py - cfg.LEVEL_BAND &&
        s.jetsCount > cfg.FUEL_RESERVE &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
      return;
    }
    roamTick(this.roam, botIndex, ctx);
  }

  private engage(
    botIndex: number,
    preyIdx: number,
    pack: readonly number[],
    ctx: BotEngineContext,
  ): void {
    const { world } = ctx;
    const cfg = this.cfg;
    const s = world.sprites[botIndex]!;
    const c = s.control;
    const parts = world.spriteParts!;
    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const tx = parts.posX[preyIdx] ?? 0;
    const ty = parts.posY[preyIdx] ?? 0;
    const tvx = parts.velocityX[preyIdx] ?? 0;
    const tvy = parts.velocityY[preyIdx] ?? 0;
    const clock = world.mainTickCounter;
    const dist = Math.hypot(tx - px, ty - py);

    // --- Mag discipline -----------------------------------------------------
    const ammo = ctx.ammoOf(botIndex);
    const reloading = ctx.reloadingOf(botIndex);
    if (!reloading && ammo === 0) c.reload = true;
    if (!reloading && ammo > 0 && ammo <= cfg.SELF_RELOAD_AT && dist > cfg.PACK_RANGE + 120) {
      c.reload = true;
    }
    if (reloading) {
      // Disengage: open range from the prey, take what height is cheap.
      if (tx > px) c.left = true;
      else c.right = true;
      if (s.jetsCount > cfg.FUEL_RESERVE && clock >= this.noClimbUntil) {
        c.jetpack = true;
      }
      return;
    }

    // --- Pillar 2/3: bearing slot, cohesion override ------------------------
    let slotX: number;
    let slotY: number;
    const top = pack[pack.length - 1]; // highest living index takes TOP
    if (pack.length >= 2 && botIndex === top) {
      slotX = tx;
      slotY = ty - cfg.HIGH_OFF;
    } else {
      // Side wolves split by current position: leftmost-of-prey takes left.
      const sides = pack.filter((w) => w !== top || pack.length < 2);
      const sorted = [...sides].sort((a, b) => {
        const ax = parts.posX[a] ?? 0;
        const bx = parts.posX[b] ?? 0;
        return ax === bx ? a - b : ax - bx;
      });
      const k = sorted.indexOf(botIndex);
      const leftCount = Math.ceil(sorted.length / 2);
      const dir = k >= 0 && k < leftCount ? -1 : 1;
      slotX = tx + dir * cfg.PACK_RANGE;
      slotY = ty;
    }

    // Regroup before glory: isolated wolves go to the pack, not the prey.
    if (pack.length >= 2) {
      let nearest = Infinity;
      let ox = 0;
      let oy = 0;
      let n = 0;
      for (const w of pack) {
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
        slotY = oy / n;
      }
    }

    if (px < slotX - cfg.X_SLACK) c.right = true;
    else if (px > slotX + cfg.X_SLACK) c.left = true;
    else {
      // IN the slot: strafe-juke on an rng clock. A wolf that parks on its
      // bearing is target practice for every lead-aim in the arena — the
      // first sparring series was lost to exactly this.
      if (clock >= this.jukeFlipAt) {
        this.jukeDir = world.rng.nextInt(2) === 0 ? 1 : -1;
        this.jukeFlipAt =
          clock + cfg.JUKE_MIN_TICKS + world.rng.nextInt(cfg.JUKE_VAR_TICKS);
      }
      if (this.jukeDir > 0) c.right = true;
      else c.left = true;
    }
    if (
      slotY < py - cfg.LEVEL_BAND &&
      s.jetsCount > cfg.FUEL_RESERVE &&
      clock >= this.noClimbUntil
    ) {
      c.jetpack = true;
    }

    // --- Gun: the prey when reachable, whatever is biting us otherwise ------
    // Movement is pack doctrine; the trigger is opportunistic. A wolf that
    // walks its bearing while an un-targeted enemy shoots it for free is how
    // the second sparring series was lost — fire at the prey when own eyes
    // and range allow, else at the nearest visible threat.
    let gx = tx;
    let gy = ty;
    let gvx = tvx;
    let gvy = tvy;
    let gdist = dist;
    const preyShootable =
      dist <= cfg.FIRE_MAX_DIST && hasLineOfSight(world, { x: px, y: py }, { x: tx, y: ty });
    if (!preyShootable) {
      let alt = 0;
      let altD = Infinity;
      for (let e = 1; e < world.sprites.length; e++) {
        if (e === botIndex || e === preyIdx) continue;
        const o = world.sprites[e];
        if (o === undefined || !o.active || o.deadMeat) continue;
        if (s.team > 0 && o.team === s.team) continue;
        if (o.alpha !== 255 && o.holdedThing === 0) continue;
        const ex = parts.posX[e] ?? 0;
        const ey = parts.posY[e] ?? 0;
        const d = Math.hypot(ex - px, ey - py);
        if (d > cfg.FIRE_MAX_DIST || d >= altD) continue;
        if (!hasLineOfSight(world, { x: px, y: py }, { x: ex, y: ey })) continue;
        alt = e;
        altD = d;
      }
      if (alt === 0) return;
      gx = parts.posX[alt] ?? 0;
      gy = parts.posY[alt] ?? 0;
      gvx = parts.velocityX[alt] ?? 0;
      gvy = parts.velocityY[alt] ?? 0;
      gdist = altD;
    }

    const tof = gdist / AK_BULLET_SPEED;
    const drop = 0.5 * BULLET_GRAV * tof * tof;
    c.mouseAimX = Math.round(gx + gvx * tof - px);
    c.mouseAimY = Math.round(gy + gvy * tof - py - drop);

    if (gdist <= cfg.AUTO_RANGE) c.fire = true;
    else c.fire = clock % cfg.TAP_PERIOD < cfg.TAP_OPEN;
  }
}

export function createWolfEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('wolf', WOLF_DEFAULTS, tweaks);
  return {
    id: 'wolf',
    strategy:
      'PACK HUNTER — one prey (lowest health, shared eyes), three crossfire bearings, regroup before glory',
    tweaks: cfg,
    createBrain: (): BotBrain => new WolfBrain(cfg),
  };
}
