/**
 * Game-mode logic and scoring — faithful TS port of the OpenSoldat gameplay
 * mode handling (Deathmatch, Pointmatch, TeamMatch, CTF, Infiltration,
 * HoldTheFlag, Rambo).
 *
 * Sim-side gameplay state. The simulation `Sprite` record (entities/types.ts)
 * intentionally OMITS the embedded `TPlayer` object, so the per-player team and
 * score data that Pascal stores on `Sprite[i].Player.{Team,Kills,Deaths,Flags}`
 * lives here in {@link GameState} instead (`playerTeams` / `playerScores` /
 * `playerDeaths` / `playerFlags`). Team totals mirror the Pascal global
 * `TeamScore: array[0..5] of Integer` (Game.pas:88).
 *
 * Provenance is given per-block as `// PORT: file:line`. All physics-flavoured
 * distance arithmetic flows through the shared `f()` Single wrapper; there is no
 * randomness in mode scoring (so no `world.rng` use is needed here).
 */

import type { World } from '../world';
import { GameStyle, Team } from '../constants';
import { MAX_SPRITES, MAX_THINGS } from '../constants';
import { ObjectStyle } from '../constants';
// SECOND/MINUTE are owned by constants.ts (single source of truth).
import { SECOND, MINUTE } from '../constants';
import { distance } from '../math/calc';
import { f } from '../scalar';

// PORT: shared/mechanics/Sprites.pas:41 — TOUCHDOWN_RADIUS = 28.
export const TOUCHDOWN_RADIUS = 28 as const;

// Skeleton layout inside world.thingParts (mirrors entities/thing.ts):
//   basePart(thingIndex) = (thingIndex - 1) * THING_SKELETON_PARTS
//   Skeleton.Pos[k]      = thingParts particle (basePart + k), k in 1..4
// PORT: shared/mechanics/Things.pas:13 — TThing.Skeleton uses Pos[1..4].
const THING_SKELETON_PARTS = 4 as const;

function thingPartId(thingIndex: number, k: number): number {
  return (thingIndex - 1) * THING_SKELETON_PARTS + k;
}

/**
 * Per-match game state. Mirrors the cluster of Pascal globals that drive
 * scoring and round flow:
 *   - TeamScore[0..5]                         (Game.pas:88)
 *   - Sprite[i].Player.Kills/Deaths/Flags     (Sprites.pas / Game.pas:23)
 *   - TimeLimitCounter / sv_timelimit         (Game.pas:83, ServerLoop.pas:499)
 *   - sv_killlimit                            (Game.pas:796, :876)
 */
export interface GameState {
  // PORT: shared/Constants.pas:347-353 — sv_gamemode (GAMESTYLE_*).
  mode: GameStyle;

  // PORT: shared/Game.pas:88 — TeamScore: array[0..5] of Integer.
  // Index by Team.* (0 unused for play, 1=ALPHA..4=DELTA, 5=SPECTATOR unused).
  teamScores: number[];

  // PORT: shared/Game.pas:23 — Player.Kills. Index by sprite num 1..MAX_SPRITES;
  // [0] is the unused sentinel matching the 1-based Sprite array.
  playerScores: number[];
  // PORT: shared/Game.pas:23 — Player.Deaths.
  playerDeaths: number[];
  // PORT: shared/mechanics/Things.pas:832 — Player.Flags (CTF/INF caps).
  playerFlags: number[];

  // PORT: shared/mechanics/Sprites.pas — Player.Team for each sprite.
  // The sim Sprite omits Player; we keep the team mapping here. 0 = none.
  playerTeams: number[];

  // PORT: shared/mechanics/Sprites.pas:130 — MultiKills / MultiKillTime.
  // Pointmatch multiplies kill points by multikill streak; tracked per sprite.
  multiKills: number[];
  multiKillTime: number[];

  // PORT: server config — sv_killlimit (Game.pas:796, :876). 0 = no limit.
  scoreLimit: number;
  // PORT: server config — sv_timelimit (Game.pas:733). In ticks. 0 = no limit.
  timeLimit: number;
  // PORT: shared/Game.pas:83 — TimeLimitCounter. Remaining ticks this map.
  mapTimeLeft: number;

  // PORT: server-side round-end signal (ServerLoop.pas NextMap call sites).
  // Set true once a kill/time limit triggers the round/map to end.
  roundEnded: boolean;
}

// PORT: shared/mechanics/Constants.pas:204 — MULTIKILLINTERVAL = 180.
const MULTIKILLINTERVAL = 180 as const;

export interface GameStateOpts {
  scoreLimit?: number;
  timeLimit?: number;
}

/**
 * Build a fresh {@link GameState}. `mode` is one of {@link GameStyle}.
 *
 * PORT: shared/Game.pas:626 (TeamScore reset) + Game.pas:733
 * (TimeLimitCounter := sv_timelimit.Value).
 */
export function createGameState(mode: GameStyle, opts: GameStateOpts = {}): GameState {
  const scoreLimit = opts.scoreLimit ?? 0;
  const timeLimit = opts.timeLimit ?? 0;
  return {
    mode,
    // 0..5 inclusive (Team.SPECTATOR = 5).
    teamScores: new Array<number>(Team.SPECTATOR + 1).fill(0),
    playerScores: new Array<number>(MAX_SPRITES + 1).fill(0),
    playerDeaths: new Array<number>(MAX_SPRITES + 1).fill(0),
    playerFlags: new Array<number>(MAX_SPRITES + 1).fill(0),
    playerTeams: new Array<number>(MAX_SPRITES + 1).fill(Team.NONE),
    multiKills: new Array<number>(MAX_SPRITES + 1).fill(0),
    multiKillTime: new Array<number>(MAX_SPRITES + 1).fill(0),
    scoreLimit,
    timeLimit,
    mapTimeLeft: timeLimit,
    roundEnded: false,
  };
}

// PORT: shared/Game.pas:502-510 — IsTeamGame: TEAMMATCH, CTF, INF, HTF.
export function isTeamGame(mode: GameStyle): boolean {
  switch (mode) {
    case GameStyle.TEAMMATCH:
    case GameStyle.CTF:
    case GameStyle.INF:
    case GameStyle.HTF:
      return true;
    default:
      return false;
  }
}

// PORT: shared/mechanics/Sprites.pas — IsNotInSameTeam(killer, victim).
// In real Soldat this consults Sprite[*].Player.Team; here we read playerTeams.
function isNotInSameTeam(state: GameState, killer: number, victim: number): boolean {
  return state.playerTeams[killer] !== state.playerTeams[victim];
}

/**
 * Score a kill. `killer`/`victim` are 1-based sprite nums.
 *
 * Faithful to the per-mode kill scoring block in DoDamageDeit/registerkill.
 * PORT: shared/mechanics/Sprites.pas:1644-1735.
 *
 * `holdingPointmatchFlag` reflects whether the killer is currently carrying the
 * pointmatch flag (Sprites.pas:1662-1665) — passed in because flag-holding is a
 * Thing/Sprite relationship the caller already knows.
 */
export function onKill(
  state: GameState,
  killer: number,
  victim: number,
  holdingPointmatchFlag = false,
): void {
  // PORT: Sprites.pas:1644 — if Who <> Num then (no self-kill scoring).
  if (killer === victim) {
    return;
  }
  if (killer < 1 || killer > MAX_SPRITES) {
    return;
  }

  switch (state.mode) {
    case GameStyle.DEATHMATCH: {
      // PORT: Sprites.pas:1646-1655.
      state.playerScores[killer] = (state.playerScores[killer] ?? 0) + 1;
      bumpMultiKill(state, killer);
      break;
    }
    case GameStyle.POINTMATCH: {
      // PORT: Sprites.pas:1656-1686.
      let i = 1;
      // add another point for holding the flag (Sprites.pas:1662-1665).
      if (holdingPointmatchFlag) {
        i *= 2;
      }
      // multikill point multiplier (Sprites.pas:1668-1677).
      if ((state.multiKillTime[killer] ?? 0) > 0) {
        const mk = state.multiKills[killer] ?? 0;
        if (mk === 2) i *= 2;
        else if (mk === 3) i *= 4;
        else if (mk === 4) i *= 8;
        else if (mk === 5) i *= 16;
        else if (mk > 5) i *= 32;
      }
      state.playerScores[killer] = (state.playerScores[killer] ?? 0) + i;
      bumpMultiKill(state, killer);
      break;
    }
    case GameStyle.TEAMMATCH: {
      // PORT: Sprites.pas:1687-1698.
      if (isNotInSameTeam(state, killer, victim)) {
        state.playerScores[killer] = (state.playerScores[killer] ?? 0) + 1;
        const t = state.playerTeams[killer] ?? Team.NONE;
        state.teamScores[t] = (state.teamScores[t] ?? 0) + 1;
        bumpMultiKill(state, killer);
      }
      break;
    }
    case GameStyle.CTF:
    case GameStyle.INF:
    case GameStyle.HTF: {
      // PORT: Sprites.pas:1700-1735 — kill counts only for cross-team kills;
      // team score in these modes comes from flag/objective events, not kills.
      if (isNotInSameTeam(state, killer, victim)) {
        state.playerScores[killer] = (state.playerScores[killer] ?? 0) + 1;
        bumpMultiKill(state, killer);
      }
      break;
    }
    case GameStyle.RAMBO: {
      // PORT: Sprites.pas:1736-1752 — only Rambo-involved kills score. The
      // bow-involvement test needs weapon data the caller resolves; we score
      // the kill here and leave the bow gating to the caller (it should only
      // invoke onKill for qualifying Rambo kills). Faithful to the scored path.
      state.playerScores[killer] = (state.playerScores[killer] ?? 0) + 1;
      bumpMultiKill(state, killer);
      break;
    }
    default:
      break;
  }

  // PORT: Sprites.pas — victim Deaths increment (Player.Deaths).
  if (victim >= 1 && victim <= MAX_SPRITES) {
    state.playerDeaths[victim] = (state.playerDeaths[victim] ?? 0) + 1;
  }
}

// PORT: shared/mechanics/Sprites.pas:1652-1653 — MultiKillTime/MultiKills.
function bumpMultiKill(state: GameState, who: number): void {
  state.multiKillTime[who] = MULTIKILLINTERVAL;
  state.multiKills[who] = (state.multiKills[who] ?? 0) + 1;
}

/**
 * Award a flag capture (touchdown) to `team`.
 *
 * PORT: shared/mechanics/Things.pas:822-885 — on touchdown the capturing
 * player's Flags increments and TeamScore[team] += 1. (The INF redaward bonus
 * and player-imbalance penalty at Things.pas:837-843 are caller-supplied via
 * `award`; default 1 reproduces the plain CTF/HTF case.)
 */
export function onFlagCapture(
  state: GameState,
  team: number,
  capturer = 0,
  award = 1,
): void {
  if (team < 0 || team >= state.teamScores.length) {
    return;
  }
  // PORT: Things.pas:832/884 — Player.Flags := Player.Flags + 1.
  if (capturer >= 1 && capturer <= MAX_SPRITES) {
    state.playerFlags[capturer] = (state.playerFlags[capturer] ?? 0) + 1;
  }
  // PORT: Things.pas:833/885 — Inc(TeamScore[team], award).
  state.teamScores[team] = (state.teamScores[team] ?? 0) + award;
  // PORT: Things.pas:843 — clamp (INF penalty can drive negative).
  if ((state.teamScores[team] ?? 0) < 0) {
    state.teamScores[team] = 0;
  }
}

/**
 * Read a thing's skeleton Pos[k] (default Pos[1]) out of world.thingParts.
 * Returns null when there is no thingParts system.
 */
function thingPos(world: World, thingIndex: number, k = 1): { x: number; y: number } | null {
  const parts = world.thingParts;
  if (parts === null) {
    return null;
  }
  const id = thingPartId(thingIndex, k);
  return { x: parts.posX[id] ?? 0, y: parts.posY[id] ?? 0 };
}

/**
 * CTF/INF touchdown detection — a held team flag carried into the opposing
 * base (its home flag in-base and within TOUCHDOWN_RADIUS) scores for the
 * carrier's team.
 *
 * PORT: shared/mechanics/Things.pas:811-885 (TThing.Update touchdown block).
 * Returns the scoring team (Team.ALPHA / Team.BRAVO) or null if no touchdown.
 */
function checkTouchdown(world: World, state: GameState): number | null {
  for (let n = 1; n <= MAX_THINGS; n++) {
    const flag = world.things[n];
    if (flag === undefined || !flag.active) {
      continue;
    }
    // PORT: Things.pas:813 — only Alpha/Bravo flags touchdown.
    if (flag.style !== ObjectStyle.ALPHA_FLAG && flag.style !== ObjectStyle.BRAVO_FLAG) {
      continue;
    }
    const holder = flag.holdingSprite;
    // PORT: Things.pas:814 — HoldingSprite in 1..MAX_SPRITES.
    if (holder < 1 || holder > MAX_SPRITES) {
      continue;
    }
    const holderTeam = state.playerTeams[holder] ?? Team.NONE;
    // PORT: Things.pas:815 — carrier must be the *opposing* team to the flag.
    if (holderTeam === flag.style) {
      continue;
    }
    const flagPos = thingPos(world, n, 1);
    if (flagPos === null) {
      continue;
    }
    // PORT: Things.pas:817-821 — find the carrier-team's own flag, in base,
    // not held, and within TOUCHDOWN_RADIUS.
    for (let i = 1; i <= MAX_THINGS; i++) {
      if (i === n) {
        continue;
      }
      const home = world.things[i];
      if (home === undefined || !home.active || !home.inBase || home.holdingSprite !== 0) {
        continue;
      }
      const homePos = thingPos(world, i, 1);
      if (homePos === null) {
        continue;
      }
      // PORT: Things.pas:820-821 — Distance(Pos[1], Pos[1]) < TOUCHDOWN_RADIUS.
      const d = distance(flagPos.x, flagPos.y, homePos.x, homePos.y);
      if (f(d) < TOUCHDOWN_RADIUS) {
        // PORT: Things.pas:823/878 — score for the carrier's team.
        if (holderTeam === Team.ALPHA) {
          onFlagCapture(state, Team.ALPHA, holder);
          return Team.ALPHA;
        }
        if (holderTeam === Team.BRAVO) {
          onFlagCapture(state, Team.BRAVO, holder);
          return Team.BRAVO;
        }
      }
    }
  }
  return null;
}

/**
 * Per-tick game-mode update. Faithful to the server-loop scoring/flow:
 *   - time-limit countdown + round-end             (ServerLoop.pas:495-501)
 *   - CTF/INF flag touchdown scoring                (Things.pas:811-885)
 *   - kill/time limit win detection                 (Game.pas:794-810, :872-880)
 *
 * Kill scoring is event-driven through {@link onKill}; this loop handles the
 * tick-based pieces (timers, flag captures) and limit detection.
 */
export function updateGameMode(world: World, state: GameState): void {
  // PORT: server/ServerLoop.pas:495-501 — time-limit decrease + NextMap at 1.
  if (state.timeLimit > 0) {
    if (state.mapTimeLeft > 0) {
      state.mapTimeLeft -= 1;
    }
    if (state.mapTimeLeft <= 0) {
      state.roundEnded = true;
    }
  }

  // PORT: shared/mechanics/Sprites.pas:130 — decay multikill timers each tick.
  for (let i = 1; i <= MAX_SPRITES; i++) {
    if ((state.multiKillTime[i] ?? 0) > 0) {
      state.multiKillTime[i] = (state.multiKillTime[i] ?? 0) - 1;
      if ((state.multiKillTime[i] ?? 0) <= 0) {
        state.multiKills[i] = 0;
      }
    }
  }

  // PORT: shared/mechanics/Things.pas:811-885 — flag touchdown scoring.
  if (state.mode === GameStyle.CTF || state.mode === GameStyle.INF) {
    checkTouchdown(world, state);
  }

  // PORT: shared/Game.pas:794-810 / :872-880 — kill-limit / round-end.
  if (state.scoreLimit > 0) {
    if (isTeamGame(state.mode)) {
      // PORT: Game.pas:874-880 — for i := 1 to 4 do if TeamScore[i] >= limit.
      for (let t = Team.ALPHA; t <= Team.DELTA; t++) {
        if ((state.teamScores[t] ?? 0) >= state.scoreLimit) {
          state.roundEnded = true;
          break;
        }
      }
    } else {
      // PORT: Game.pas:794-810 — Sprite[i].Player.Kills >= killlimit.
      for (let i = 1; i <= MAX_SPRITES; i++) {
        if ((state.playerScores[i] ?? 0) >= state.scoreLimit) {
          state.roundEnded = true;
          break;
        }
      }
    }
  }
}
