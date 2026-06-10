// "matador" bot engine — the tempo counter-puncher, the fourth doctrine.
//
// Pilot proved POSITIONING beats aim; reaper proved COMMITMENT loses to
// accuracy. The matador's bet is that both ignore the one clock that
// actually rations damage in this game: the MAGAZINE. Thirty rounds, then
// 95 ticks of helplessness. Whoever owns those 95 ticks owns the duel.
//
//   1. FIGHT THE MAG, NOT THE MAN — the enemy's ammo state is readable
//      world state, same as position. While the enemy's mag is hot the
//      matador refuses the duel: it holds a poke band outside brawl range
//      and taps. As the mag runs LOW it stalks — creeps to striking
//      distance so the dash starts from close, not from the band (a punish
//      launched at 450px arrives as the window shuts). The moment the
//      target reloads (or runs the mag to the felt), the cape drops:
//      full-tilt dash to point-blank, full-auto into a target that cannot
//      answer for ~1.6 s.
//   2. HUNT THE DISARMED — every other brain fights the NEAREST visible
//      enemy (the Pascal findTarget). The matador picks its bull by mag
//      state: among visible enemies, a reloading or near-dry one within
//      reach is preferred over a closer one with thirty rounds. In a team
//      fight someone is almost always reloading — the matador is always
//      looking at them.
//   3. CALIBRATED BALLISTICS — bullets fall at GRAV×2.25 = 0.135 px/tick²
//      (sim setup.ts, Cvar.pas:228-231), not the 0.06 sprite gravity the
//      older brains compensate with. Aiming with the true drop is a free
//      hit-rate edge at poke range. Lead smoothing stays a knob (VEL_EMA);
//      sparring data against the champion favored instantaneous lead.
//   4. NEVER FIGHT FROM BELOW, NEVER RACE TO THE CEILING — height parity is
//      enough. Climb only to erase a deficit; the tank is war chest for
//      punish dashes, not altitude vanity. (Ceiling-stall give-up kept —
//      that failure mode is proven.)
//   5. OWN MAG ON THE OFF-BEAT — reload proactively while safe and the
//      enemy's mag is hot, so the matador's window opens with thirty
//      rounds and the enemy's opens with none.
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

/** Matador's strategy knobs — every value is tweakable per match.
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type MatadorConfig = {
  POKE_MIN: number;
  POKE_MAX: number;
  FIRE_MAX_DIST: number;
  AUTO_RANGE: number;
  WINDOW_AUTO: number;
  PUNISH_RANGE: number;
  LOW_MAG_OPEN: number;
  WINDOW_HUNT: number;
  STALK_MAG: number;
  STALK_DIST: number;
  SELF_RELOAD_AT: number;
  VEL_EMA: number;
  LEVEL_BAND: number;
  HEIGHT_CAP: number;
  FUEL_RESERVE: number;
  FUEL_PUNISH_MIN: number;
  JUKE_MIN_TICKS: number;
  JUKE_VAR_TICKS: number;
  BURST_PERIOD: number;
  BURST_OPEN: number;
  HUNT_MEMORY_TICKS: number;
  STALL_RISE_VY: number;
  STALL_TRIGGER: number;
  STALL_COOLDOWN: number;
};

export const MATADOR_DEFAULTS: Readonly<MatadorConfig> = {
  POKE_MIN: 380, // px — hot-mag floor: sit OUTSIDE typical full-auto bands, give ground inside it
  POKE_MAX: 520, // px — farther: drift in (stay a live threat, keep the window reachable)
  FIRE_MAX_DIST: 620, // px — beyond this, hold fire entirely
  AUTO_RANGE: 230, // px — full-auto only inside this (bloom is fatal at the stalk standoff)
  WINDOW_AUTO: 620, // px — during an open window, full-auto from here in (they can't answer)
  PUNISH_RANGE: 120, // px — dash to this distance during an open window
  LOW_MAG_OPEN: 4, // rounds — enemy mag at/below this opens the window early
  WINDOW_HUNT: 760, // px — prefer a disarmed enemy over a nearer armed one within this reach
  STALK_MAG: 11, // rounds — enemy mag at/below this starts the stalk (creep in pre-window)
  STALK_DIST: 250, // px — stalk standoff: close enough that the dash lands inside the window
  SELF_RELOAD_AT: 9, // rounds — proactive reload threshold (only while safe + their mag hot)
  VEL_EMA: 1, // per-tick EMA factor for target velocity (1 = instantaneous lead; spar data vs VEGA favored it)
  LEVEL_BAND: 50, // px — climb only when more than this below the target
  HEIGHT_CAP: 200, // px — never chase height past this edge (no ceiling races)
  FUEL_RESERVE: 110, // ticks — below this, no positional climbing; let regen pay
  FUEL_PUNISH_MIN: 40, // ticks — punish dashes still fly on fumes (mostly horizontal anyway)
  JUKE_MIN_TICKS: 14, // poke-band strafe-juke clock (rng-rolled per leg)
  JUKE_VAR_TICKS: 22,
  BURST_PERIOD: 6, // ticks — poke tap clock, locked to the fire cooldown:
  BURST_OPEN: 1, // one shot per period = max volume at zero bloom (the 4/12 burst halved poke volume)
  HUNT_MEMORY_TICKS: 240, // ~4 s of last-seen pursuit after losing LOS
  // Ceiling-stall give-up (proven failure mode, see pilot.ts node 150).
  STALL_RISE_VY: -0.1,
  STALL_TRIGGER: 25,
  STALL_COOLDOWN: 180,
};

class MatadorBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  private jukeDir: 1 | -1 = 1;
  private jukeFlipAt = 0;
  private lastSeenX = 0;
  private lastSeenY = 0;
  private lastSeenAt = -1;
  /** EMA of the current target's velocity (the smoothed lead, pillar 2). */
  private emaVX = 0;
  private emaVY = 0;
  private emaTarget = 0; // sprite index the EMA belongs to; reset on switch
  private stallTicks = 0;
  private noClimbUntil = 0;

  constructor(private readonly cfg: MatadorConfig) {}

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

    const targetIdx = this.pickTarget(botIndex, ctx);
    if (targetIdx > 0) {
      this.lastSeenX = parts.posX[targetIdx] ?? 0;
      this.lastSeenY = parts.posY[targetIdx] ?? 0;
      this.lastSeenAt = clock;
      this.engage(botIndex, targetIdx, ctx);
      return;
    }

    // MEMORY: lost LOS recently → hunt the last seen position.
    const cfg = this.cfg;
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

  /**
   * Pillar 2: pick the bull by mag state. Same visibility rules as the sim's
   * findTarget (skip self/inactive/dead/teammates/invisible, line-of-sight),
   * but a reloading or near-dry enemy inside WINDOW_HUNT beats a nearer
   * armed one. Falls back to nearest-visible when every mag is hot.
   */
  private pickTarget(botIndex: number, ctx: BotEngineContext): number {
    const { world } = ctx;
    const cfg = this.cfg;
    const self = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (self === undefined || parts === null) return 0;
    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const huntSq = cfg.WINDOW_HUNT * cfg.WINDOW_HUNT;

    let nearest = 0;
    let nearestD = Infinity;
    let disarmed = 0;
    let disarmedD = Infinity;
    for (let i = 1; i < world.sprites.length; i++) {
      if (i === botIndex) continue;
      const other = world.sprites[i];
      if (other === undefined || !other.active || other.deadMeat) continue;
      if (self.team > 0 && other.team === self.team) continue;
      if (other.alpha !== 255 && other.holdedThing === 0) continue;
      const ox = parts.posX[i] ?? 0;
      const oy = parts.posY[i] ?? 0;
      if (!hasLineOfSight(world, { x: px, y: py }, { x: ox, y: oy })) continue;
      const dx = ox - px;
      const dy = oy - py;
      const d = dx * dx + dy * dy;
      if (d < nearestD) {
        nearestD = d;
        nearest = i;
      }
      const open = ctx.reloadingOf(i) || ctx.ammoOf(i) <= cfg.LOW_MAG_OPEN;
      if (open && d <= huntSq && d < disarmedD) {
        disarmedD = d;
        disarmed = i;
      }
    }
    return disarmed > 0 ? disarmed : nearest;
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

    // --- Pillar 2: smoothed lead — EMA the target's velocity ---------------
    if (this.emaTarget !== targetIdx) {
      this.emaTarget = targetIdx;
      this.emaVX = tvx;
      this.emaVY = tvy;
    } else {
      this.emaVX += cfg.VEL_EMA * (tvx - this.emaVX);
      this.emaVY += cfg.VEL_EMA * (tvy - this.emaVY);
    }

    // --- Pillar 1: the window — read the enemy's mag clock -----------------
    const tReloading = ctx.reloadingOf(targetIdx);
    const tAmmo = ctx.ammoOf(targetIdx);
    const windowOpen = tReloading || tAmmo <= cfg.LOW_MAG_OPEN;
    const stalking = !windowOpen && tAmmo <= cfg.STALK_MAG;

    // --- Pillar 4: own mag on the off-beat ----------------------------------
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
      dist > cfg.POKE_MIN
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

    // --- Movement -----------------------------------------------------------
    if (windowOpen) {
      // THE PASS: their head is down. Dash to point-blank and stay there
      // until the window shuts — every tick inside it is free damage.
      if (dist > cfg.PUNISH_RANGE) {
        if (dx > 0) c.right = true;
        else c.left = true;
      }
      // Close vertical gaps aggressively; punish flight runs on fumes.
      if (heightEdge < -30 && s.jetsCount > cfg.FUEL_PUNISH_MIN && clock >= this.noClimbUntil) {
        c.jetpack = true;
      }
    } else if (stalking) {
      // THE STALK: their mag is running out. Creep to striking distance NOW
      // so the pass launches from close range — and never back off: their
      // remaining rounds trade against our full mag, and going dry next to
      // a matador is how the window opens.
      if (dist > cfg.STALK_DIST) {
        if (dx > 0) c.right = true;
        else c.left = true;
      } else {
        if (clock >= this.jukeFlipAt) {
          this.jukeDir = world.rng.nextInt(2) === 0 ? 1 : -1;
          this.jukeFlipAt =
            clock + cfg.JUKE_MIN_TICKS + world.rng.nextInt(cfg.JUKE_VAR_TICKS);
        }
        if (this.jukeDir > 0) c.right = true;
        else c.left = true;
      }
      if (
        heightEdge < -cfg.LEVEL_BAND &&
        s.jetsCount > cfg.FUEL_PUNISH_MIN &&
        clock >= this.noClimbUntil
      ) {
        c.jetpack = true;
      }
    } else {
      // HOT MAG: refuse the duel. Hold the poke band, juke, tap.
      if (dist < cfg.POKE_MIN) {
        if (dx > 0) c.left = true;
        else c.right = true;
      } else if (dist > cfg.POKE_MAX) {
        if (dx > 0) c.right = true;
        else c.left = true;
      } else {
        // In the band: strafe-juke on an rng clock (their lead aim is
        // instantaneous-velocity; oscillation poisons it).
        if (clock >= this.jukeFlipAt) {
          this.jukeDir = world.rng.nextInt(2) === 0 ? 1 : -1;
          this.jukeFlipAt =
            clock + cfg.JUKE_MIN_TICKS + world.rng.nextInt(cfg.JUKE_VAR_TICKS);
        }
        if (this.jukeDir > 0) c.right = true;
        else c.left = true;
      }

      // Pillar 3: height parity, not height greed.
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

    // --- Aim: smoothed lead + ballistic drop --------------------------------
    const tof = dist / AK_BULLET_SPEED;
    const drop = 0.5 * BULLET_GRAV * tof * tof;
    c.mouseAimX = Math.round(tx + this.emaVX * tof - px);
    c.mouseAimY = Math.round(ty + this.emaVY * tof - py - drop);

    // --- Fire discipline -----------------------------------------------------
    if (dist > cfg.FIRE_MAX_DIST) return; // out of effective range: hold
    if (dist <= (windowOpen ? cfg.WINDOW_AUTO : cfg.AUTO_RANGE)) {
      // Full-auto at true knife range — and from further in during a window,
      // BUT never spray the whole dash: the window's value is arriving at
      // point-blank with a full mag, not feeding it to bloom at 500px.
      c.fire = true;
    } else {
      // Everywhere else — poke band AND stalk standoff — tap-burst so spray
      // bloom recovers between bursts. Sustained spray at 250-500px is how
      // round 2 of the spar bled 4 hit-rate points.
      c.fire = clock % cfg.BURST_PERIOD < cfg.BURST_OPEN;
    }
  }
}

export function createMatadorEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('matador', MATADOR_DEFAULTS, tweaks);
  return {
    id: 'matador',
    strategy:
      'TEMPO COUNTER-PUNCHER — refuse the duel while their mag is hot, dash to point-blank the moment they reload, lead with smoothed velocity',
    tweaks: cfg,
    createBrain: (): BotBrain => new MatadorBrain(cfg),
  };
}
