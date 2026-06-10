// Spectator "broadcast director" — picks which bot the action camera follows
// and keeps the spectate scoreboard / kill feed bookkeeping.
//
// DESIGN: this is new (no Pascal counterpart — OpenSoldat's spectator is a
// free camera). The pure core (scoreSubject / pickSubject / applyKill /
// ffaScores) carries all the rules so they are unit-testable; the `Director`
// class is a thin stateful shell main.ts drives once per frame.
//
// All time units are sim TICKS (60/s, world.mainTickCounter clock) so the
// director is deterministic and frame-rate independent.

import type { HudScores, KillFeedEntry } from '../ui/hud';

// --- Tuning (exported so a watch-and-tweak pass can pin them in tests) ------

/** Min ticks the camera dwells on a subject before auto-switching (~3.5 s). */
export const DWELL_TICKS = 210;
/** A kill makes its scorer "hot" for this long, decaying linearly (~5 s). */
export const KILL_HEAT_TICKS = 300;
/** Flat score bonus while a subject is holding fire. */
export const FIRING_BONUS = 150;
/** Proximity scoring range: closer than this to an enemy earns points. */
export const PROX_RANGE = 600;
/** Max proximity score (at zero distance). */
export const PROX_MAX = 150;
/** Score margin a challenger must clear to steal the camera after dwell. */
export const HYSTERESIS = 100;
/** Camera cut threshold: switches farther than this snap instead of panning. */
export const SNAP_DIST = 1500;

// --- Pure core ---------------------------------------------------------------

/** Per-frame snapshot of one candidate camera subject. */
export interface SubjectInfo {
  readonly index: number;
  /** active && !deadMeat. */
  readonly alive: boolean;
  readonly x: number;
  readonly y: number;
  /** sprite.control.fire this frame. */
  readonly firing: boolean;
  /** Tick of this subject's most recent kill; -Infinity if never. */
  readonly lastKillTick: number;
  /** Distance to the nearest live enemy; Infinity when alone. */
  readonly nearestEnemyDist: number;
}

/**
 * Interest score for one subject: a recent kill dominates (max 600, decaying
 * over KILL_HEAT_TICKS), then active firing, then proximity to a fight.
 * Dead subjects are never watchable (-Infinity).
 */
export function scoreSubject(s: SubjectInfo, nowTick: number): number {
  if (!s.alive) return -Infinity;
  const killHeat = Math.max(0, KILL_HEAT_TICKS - (nowTick - s.lastKillTick)) * 2;
  const firing = s.firing ? FIRING_BONUS : 0;
  const prox = Math.max(0, PROX_MAX * (1 - s.nearestEnemyDist / PROX_RANGE));
  return killHeat + firing + prox;
}

/** Argmax of scoreSubject over live subjects; ties break to the lowest index. */
function bestSubject(
  subjects: readonly SubjectInfo[],
  nowTick: number,
): { index: number; score: number } {
  let best = -Infinity;
  let bestIdx = -1;
  for (const s of subjects) {
    const sc = scoreSubject(s, nowTick);
    if (sc > best || (sc === best && bestIdx >= 0 && s.index < bestIdx)) {
      best = sc;
      bestIdx = s.index;
    }
  }
  return { index: bestIdx, score: best };
}

/**
 * Choose the subject to follow this frame.
 *
 * 1. Current subject dead/missing → switch IMMEDIATELY; prefer its killer
 *    (hold on the money shot) when the killer is a live subject, else the
 *    highest-scoring live subject. All dead → keep current (don't crash).
 * 2. Inside the dwell window → keep current (no whiplash).
 * 3. After dwell → switch only when the challenger clears HYSTERESIS, so the
 *    camera doesn't ping-pong between two equal firefights.
 */
export function pickSubject(
  subjects: readonly SubjectInfo[],
  current: number,
  currentKiller: number,
  nowTick: number,
  lastSwitchTick: number,
): number {
  const cur = subjects.find((s) => s.index === current);

  // Rule 1: nothing to watch where the camera points.
  if (cur === undefined || !cur.alive) {
    const killer = subjects.find((s) => s.index === currentKiller);
    if (killer !== undefined && killer.alive) return killer.index;
    const best = bestSubject(subjects, nowTick);
    return best.index >= 0 && Number.isFinite(best.score) ? best.index : current;
  }

  // Rule 2: minimum dwell.
  if (nowTick - lastSwitchTick < DWELL_TICKS) return current;

  // Rule 3: hysteresis.
  const best = bestSubject(subjects, nowTick);
  if (best.index >= 0 && best.index !== current) {
    const curScore = scoreSubject(cur, nowTick);
    if (best.score > curScore + HYSTERESIS) return best.index;
  }
  return current;
}

// --- Names -------------------------------------------------------------------
// The codebase has no player/bot names; synthesize stable ones from sprite
// indices (bots occupy slots playerIndex+1 ..) for the kill feed / HUD.

export const BOT_NAMES = [
  // NATO core...
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot',
  'Golf', 'Hotel', 'India', 'Juliett', 'Kilo', 'Lima',
  // ...plus callsigns so simultaneous matches read as different squads
  // (user: "we need more names for the players to differentiate").
  'Maverick', 'Viper', 'Goose', 'Iceman', 'Jester', 'Slider',
  'Raven', 'Hawk', 'Falcon', 'Osprey', 'Condor', 'Kestrel',
  'Bullet', 'Tracer', 'Ricochet', 'Magnum', 'Trigger', 'Scope',
  'Dynamo', 'Turbine', 'Piston', 'Throttle', 'Afterburn', 'Nitro',
  'Specter', 'Wraith', 'Phantom', 'Banshee', 'Reaver', 'Ghost',
  'Comet', 'Meteor', 'Nova', 'Quasar', 'Pulsar', 'Zenith',
] as const;

/**
 * Display name for a sprite index ('You' for the local player slot).
 * `nameOffset` (pass the match seed) rotates the pool so simultaneous
 * matches field differently-named squads instead of six identical Alphas.
 */
export function subjectName(index: number, playerIndex = 1, nameOffset = 0): string {
  if (index === playerIndex) return 'You';
  const at =
    (((index - playerIndex - 1 + nameOffset) % BOT_NAMES.length) + BOT_NAMES.length) %
    BOT_NAMES.length;
  return BOT_NAMES[at] ?? `Bot ${index}`;
}

// --- Kill tally / feed (pure helpers for the spectate HUD) -------------------

/** Mutable scoreboard state main.ts owns; mutated only via applyKill. */
export interface KillBoard {
  /** Sprite index → kill count. */
  readonly kills: Map<number, number>;
  /** Newest-first kill feed (kept slightly deeper than the HUD displays). */
  readonly feed: KillFeedEntry[];
}

/** Feed entries retained (the HUD renders its own KILL_FEED_MAX = 5). */
export const FEED_KEEP = 8;

/**
 * Record one death on the board. Suicides and unattributed deaths
 * (killer 0 / killer === victim) add no tally and render with an empty
 * killer name (the HUD shows `cause Victim`). `cause` is the weapon label
 * shown between the names (wildcard SPAS-12 kills read `[SPAS12]`).
 */
export function applyKill(
  board: KillBoard,
  killer: number,
  victim: number,
  nameOf: (index: number) => string,
  localIndex: number,
  cause = 'AK74',
): void {
  const valid = killer > 0 && killer !== victim;
  if (valid) {
    board.kills.set(killer, (board.kills.get(killer) ?? 0) + 1);
  }
  board.feed.unshift({
    killer: valid ? nameOf(killer) : '',
    victim: nameOf(victim),
    cause,
    byLocalPlayer: valid && killer === localIndex,
  });
  if (board.feed.length > FEED_KEEP) board.feed.pop();
}

/**
 * Project the free-for-all tally onto the team-shaped HudScores the HUD
 * already renders: alpha = leader's kills, bravo = runner-up's kills,
 * player* fields describe the currently-followed subject.
 */
export function ffaScores(
  kills: ReadonlyMap<number, number>,
  followed: number,
): HudScores {
  let leader = 0;
  let runnerUp = 0;
  for (const k of kills.values()) {
    if (k >= leader) {
      runnerUp = leader;
      leader = k;
    } else if (k > runnerUp) {
      runnerUp = k;
    }
  }
  const own = kills.get(followed) ?? 0;
  return {
    alpha: leader,
    bravo: runnerUp,
    playerKills: own,
    leading: own >= leader && leader > 0,
    gap: leader - own,
  };
}

// --- Stateful shell ----------------------------------------------------------

/**
 * Frame-to-frame director state: current subject, auto/manual mode, and the
 * per-sprite kill recency that feeds scoreSubject.
 */
export class Director {
  /** 'auto' = interest-driven switching; 'manual' = user-pinned subject. */
  mode: 'auto' | 'manual' = 'auto';
  /** Sprite index the camera follows. */
  followed: number;
  /** True for exactly one update() after the subject changed (camera may snap). */
  switched = false;

  private lastSwitchTick = 0;
  /** Sprite index → tick of its most recent kill. */
  private readonly lastKillTick = new Map<number, number>();
  /** Victim sprite index → its most recent killer (for the rule-1 cut). */
  private readonly lastKillerOf = new Map<number, number>();

  constructor(initialFollowed: number) {
    this.followed = initialFollowed;
  }

  /** Feed kill events in (from Game.onKill) to drive heat + killer cuts. */
  notifyKill(killer: number, victim: number, tick: number): void {
    if (killer > 0 && killer !== victim) {
      this.lastKillTick.set(killer, tick);
    }
    this.lastKillerOf.set(victim, killer);
  }

  /** Tick of `index`'s most recent kill (-Infinity if never). */
  lastKillTickOf(index: number): number {
    return this.lastKillTick.get(index) ?? -Infinity;
  }

  /** Pin the camera on a specific subject (manual mode). */
  setManual(index: number, nowTick: number): void {
    this.mode = 'manual';
    if (index !== this.followed) {
      this.followed = index;
      this.switched = true;
    }
    this.lastSwitchTick = nowTick;
  }

  /** Resume interest-driven auto switching. */
  setAuto(): void {
    this.mode = 'auto';
  }

  /**
   * Advance one frame; returns the subject to follow. Manual mode holds the
   * pinned subject until it dies, then cuts once (killer preferred) and STAYS
   * manual on the new subject.
   */
  update(subjects: readonly SubjectInfo[], nowTick: number): number {
    this.switched = false;
    const cur = subjects.find((s) => s.index === this.followed);
    const curAlive = cur !== undefined && cur.alive;
    if (this.mode === 'manual' && curAlive) {
      return this.followed;
    }
    const next = pickSubject(
      subjects,
      this.followed,
      this.lastKillerOf.get(this.followed) ?? 0,
      nowTick,
      this.lastSwitchTick,
    );
    if (next !== this.followed) {
      this.followed = next;
      this.lastSwitchTick = nowTick;
      this.switched = true;
    }
    return this.followed;
  }
}
