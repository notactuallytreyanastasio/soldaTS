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
import { GameStyle } from '../constants';
export declare const TOUCHDOWN_RADIUS: 28;
/**
 * Per-match game state. Mirrors the cluster of Pascal globals that drive
 * scoring and round flow:
 *   - TeamScore[0..5]                         (Game.pas:88)
 *   - Sprite[i].Player.Kills/Deaths/Flags     (Sprites.pas / Game.pas:23)
 *   - TimeLimitCounter / sv_timelimit         (Game.pas:83, ServerLoop.pas:499)
 *   - sv_killlimit                            (Game.pas:796, :876)
 */
export interface GameState {
    mode: GameStyle;
    teamScores: number[];
    playerScores: number[];
    playerDeaths: number[];
    playerFlags: number[];
    playerTeams: number[];
    multiKills: number[];
    multiKillTime: number[];
    scoreLimit: number;
    timeLimit: number;
    mapTimeLeft: number;
    roundEnded: boolean;
}
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
export declare function createGameState(mode: GameStyle, opts?: GameStateOpts): GameState;
export declare function isTeamGame(mode: GameStyle): boolean;
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
export declare function onKill(state: GameState, killer: number, victim: number, holdingPointmatchFlag?: boolean): void;
/**
 * Award a flag capture (touchdown) to `team`.
 *
 * PORT: shared/mechanics/Things.pas:822-885 — on touchdown the capturing
 * player's Flags increments and TeamScore[team] += 1. (The INF redaward bonus
 * and player-imbalance penalty at Things.pas:837-843 are caller-supplied via
 * `award`; default 1 reproduces the plain CTF/HTF case.)
 */
export declare function onFlagCapture(state: GameState, team: number, capturer?: number, award?: number): void;
/**
 * Per-tick game-mode update. Faithful to the server-loop scoring/flow:
 *   - time-limit countdown + round-end             (ServerLoop.pas:495-501)
 *   - CTF/INF flag touchdown scoring                (Things.pas:811-885)
 *   - kill/time limit win detection                 (Game.pas:794-810, :872-880)
 *
 * Kill scoring is event-driven through {@link onKill}; this loop handles the
 * tick-based pieces (timers, flag captures) and limit detection.
 */
export declare function updateGameMode(world: World, state: GameState): void;
//# sourceMappingURL=gamemode.d.ts.map