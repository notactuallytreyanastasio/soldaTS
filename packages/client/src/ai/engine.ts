// Bot-AI engine adapter — THE line in the sand (decision node 136).
//
// GLUE module (no Pascal provenance). Every bot is driven by a BotBrain
// behind one narrow interface, and engines are picked by name from a
// registry: `classic` is the faithful Pascal-band port (sim updateBot plus
// the client sustainment layer), `pilot` is the first-principles aerial
// brain. New engines register here and become instantly selectable per
// match (?ai=<id>) and watchable head-to-head (?duel=<a>,<b>).
//
// Contract: a brain's ONLY output is the bot sprite's `control` (and its own
// private state). Brains read the world freely but never mutate it — same
// rule as the telemetry observers, or determinism dies. Randomness must come
// from `world.rng`, never Math.random.

import type { World, WaypointGraph } from '@soldat/sim';

/** What a brain may see beyond the sim world: client-owned weapon state. */
export interface BotEngineContext {
  readonly world: World;
  readonly graph: WaypointGraph;
  readonly spawns: readonly { x: number; y: number }[];
  /** True in spectate matches (classic gates its sustainment on this). */
  readonly spectate: boolean;
  ammoOf(index: number): number;
  reloadingOf(index: number): boolean;
  readonly magSize: number;
  /** Weapon label of any sprite ('AK74' | 'SPAS12' | 'BARRETT' | 'ROCKET' |
   *  'RICOCHET' | 'CHAINSAW'); absent on hosts that predate the shotgun
   *  wildcard — treat missing as everyone-on-AK74. */
  weaponOf?(index: number): string;
  /** Spray bloom of any sprite's current weapon (radians, 0..0.16); absent
   *  on hosts that predate replay schema v2 — treat missing as 0 (cool). */
  sprayHeatOf?(index: number): number;
}

/** Per-bot brain instance. tick() runs once per sim tick while alive. */
export interface BotBrain {
  tick(botIndex: number, ctx: BotEngineContext): void;
}

/** A tweak set: subset of a brain's numeric config, keyed by knob name. */
export type EngineTweaks = Record<string, number>;

/** An engine = a named brain factory that can describe its strategy. */
export interface BotEngine {
  readonly id: string;
  /** One-line strategy description (shown in the per-window engine banner). */
  readonly strategy: string;
  /** The RESOLVED full numeric config this engine's brains run with
   *  (defaults + applied tweaks) — consumers report provenance from this. */
  readonly tweaks: Readonly<Record<string, number>>;
  createBrain(): BotBrain;
}

type EngineFactory = (tweaks?: EngineTweaks) => BotEngine;
const REGISTRY = new Map<string, EngineFactory>();

/** Register an engine factory under its id (last registration wins). */
export function registerEngine(id: string, factory: EngineFactory): void {
  REGISTRY.set(id, factory);
}

/** Registered engine ids (for UI / duel parsing). */
export function engineIds(): readonly string[] {
  return [...REGISTRY.keys()];
}

/**
 * Resolve an engine by id; unknown ids fall back to `classic` so a typo'd
 * ?ai= never bricks a match. `tweaks` (goal node 170) are per-brain config
 * overrides — passed through to the factory, which resolves them against its
 * defaults (unknown keys warn-ignored).
 */
export function createEngine(id: string | undefined, tweaks?: EngineTweaks): BotEngine {
  const factory = REGISTRY.get(id ?? 'classic') ?? REGISTRY.get('classic');
  if (factory === undefined) {
    throw new Error('no bot engines registered (classic missing)');
  }
  return factory(tweaks);
}

/**
 * Resolve defaults + overrides. Unknown keys and non-finite values are
 * IGNORED with a console.warn — a typo'd knob never bricks a match. Pure:
 * the defaults object is never mutated.
 */
export function resolveTweaks<T extends Record<string, number>>(
  engineId: string,
  defaults: Readonly<T>,
  tweaks: EngineTweaks | undefined,
): T {
  const out: Record<string, number> = { ...defaults };
  for (const [k, v] of Object.entries(tweaks ?? {})) {
    if (!(k in defaults)) {
      console.warn(`[ai] ${engineId}: ignoring unknown tweak '${k}'`);
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      console.warn(`[ai] ${engineId}: ignoring non-finite tweak '${k}'`);
      continue;
    }
    out[k] = v;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Shared roam helper — both engines fall back to this when no enemy is
// visible: fly toward a randomly chosen spawn pad (always interior, always
// reachable), re-rolling when stuck so nobody grinds a corner.
// ---------------------------------------------------------------------------

export const ROAM_REACHED = 40; // px — close enough (horizontally) to the goal
export const ROAM_MIN_TICKS = 120; // re-roll the goal every 120–240 ticks
export const ROAM_VAR_TICKS = 120;
export const ROAM_JET_ABOVE = 60; // fly when the goal is this much higher
export const STUCK_SPEED = 0.3; // |vx| below this counts as "not moving"
export const STUCK_TRIGGER = 45; // ticks of not moving before a pulse
export const STUCK_PULSE = 20; // ticks the up/jet pulse is held
export const STUCK_JET_MIN_FUEL = 100; // jet only with a reserve

export interface RoamState {
  roamX: number;
  roamY: number;
  retargetAtTick: number;
  stuckTicks: number;
}

export function createRoamState(): RoamState {
  return { roamX: 0, roamY: 0, retargetAtTick: 0, stuckTicks: 0 };
}

/** Drive `control` toward the roam goal; assumes the AI produced no intent. */
export function roamTick(
  roam: RoamState,
  botIndex: number,
  ctx: BotEngineContext,
): void {
  const { world, spawns } = ctx;
  const parts = world.spriteParts;
  const s = world.sprites[botIndex];
  if (parts === null || s === undefined) return;
  const px = parts.posX[botIndex] ?? 0;
  const py = parts.posY[botIndex] ?? 0;

  const clock = world.mainTickCounter;
  const arrived = Math.abs(px - roam.roamX) <= ROAM_REACHED;
  if (clock >= roam.retargetAtTick || arrived) {
    const goal = spawns[world.rng.nextInt(Math.max(1, spawns.length))];
    roam.roamX = goal?.x ?? 0;
    roam.roamY = goal?.y ?? 0;
    roam.retargetAtTick =
      clock + ROAM_MIN_TICKS + Math.floor(world.rng.next() * ROAM_VAR_TICKS);
  }
  if (px < roam.roamX - ROAM_REACHED) s.control.right = true;
  else if (px > roam.roamX + ROAM_REACHED) s.control.left = true;
  // FLY to elevated goals — wanderers cross the arena through the air.
  if (roam.roamY < py - ROAM_JET_ABOVE && s.jetsCount > STUCK_JET_MIN_FUEL) {
    s.control.jetpack = true;
  }

  // Stuck against geometry → pulse jump+jet AND re-roll the destination.
  const vx = parts.velocityX[botIndex] ?? 0;
  if ((s.control.left || s.control.right) && Math.abs(vx) < STUCK_SPEED) {
    roam.stuckTicks += 1;
  } else {
    roam.stuckTicks = 0;
  }
  if (roam.stuckTicks > STUCK_TRIGGER) {
    s.control.up = true;
    s.control.jetpack = s.jetsCount > STUCK_JET_MIN_FUEL;
    if (roam.stuckTicks > STUCK_TRIGGER + STUCK_PULSE) {
      roam.stuckTicks = 0;
      roam.retargetAtTick = 0; // force a new destination next tick
    }
  }
}
