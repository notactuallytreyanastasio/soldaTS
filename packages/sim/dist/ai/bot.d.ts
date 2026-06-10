import type { World } from '../world';
import type { Control } from '../entities/types';
import type { WaypointGraph } from './waypoints';
export declare const DIST_AWAY = 731;
export declare const DIST_TOO_FAR = 730;
export declare const DIST_VERY_FAR = 500;
export declare const DIST_FAR = 350;
export declare const DIST_ROCK_THROW = 180;
export declare const DIST_CLOSE = 95;
export declare const DIST_VERY_CLOSE = 55;
export declare const DIST_TOO_CLOSE = 35;
export declare const DIST_COLLIDE = 20;
export declare const DIST_STOP_PRONE = 25;
/**
 * Quantizes the absolute one-axis distance into a band.
 * PORT: shared/AI.pas:41-69 — CheckDistance(PosA, PosB).
 */
export declare function checkDistance(posA: number, posB: number): number;
export interface BotState {
    /** Sprite index of the current target enemy (0 = none). PORT: Brain.TargetNum. */
    targetNum: number;
    /** Currently occupied waypoint id (0 = none). PORT: Brain.CurrentWaypoint. */
    currentWaypoint: number;
    /** Next waypoint along the chosen path (0 = none). PORT: Brain.NextWaypoint. */
    nextWaypoint: number;
    /** Previous CurrentWaypoint for change detection. PORT: Brain.OldWaypoint. */
    oldWaypoint: number;
    /** Last waypoint, for the "stuck" timer. PORT: Brain.LastWaypoint. */
    lastWaypoint: number;
    /** Ticks parked at LastWaypoint (timeout -> drop path). PORT: Brain.WaypointTime. */
    waypointTime: number;
    /**
     * Aim error magnitude in world units. AI.pas:406-409 adds
     * `-Accuracy + Random(Accuracy)` to MouseAimY, i.e. a symmetric-ish jitter
     * scaled by difficulty. Higher accuracy value => sloppier bot (more spread).
     * PORT: Brain.Accuracy.
     */
    accuracy: number;
    /**
     * Stand-in for `Weapon.Speed` in the aim-lead term (AI.pas:405-409). The real
     * weapon model is DEFERRED; this is a positive nominal projectile speed so the
     * lead/drop computation stays finite. TODO: fold into the ported TGun.
     */
    weaponSpeed: number;
    /**
     * Camper temperament 0..255 (AI.pas:187-237 gates crouch/hold). Kept for
     * fidelity; only the >0 / >127 thresholds are consulted. PORT: Brain.Camper.
     */
    camper: number;
    /**
     * DESIGN OVERRIDE (node 124, no Pascal provenance): remaining ticks of the
     * current jet burst. The aerial-combat layer rolls multi-tick jet holds so
     * bots dogfight in the air instead of trading from the floor; a 1-tick
     * rng tap would barely lift them.
     */
    jetBurstTicks: number;
}
/** Allocate a fresh brain. `accuracy`/`weaponSpeed` default to a mid bot. */
export declare function createBotState(overrides?: Partial<BotState>): BotState;
/**
 * Approximate line-of-sight between two world points.
 *
 * PORT (approximation): shared/AI.pas:562 `Map.RayCast(LookPoint, StartPoint,
 * D2, 651)`. PolyMap exposes no RayCast yet, so we sample the segment at a few
 * points and report blocked if any sample lands inside a *solid* polygon
 * (non-background, not bullets-only). This is a coarse stand-in; the faithful
 * ray-cast (which also returns the hit distance D2) is DEFERRED to the PolyMap
 * track. With no map (world.map === null) sight is always clear.
 */
export declare function hasLineOfSight(world: World, from: {
    x: number;
    y: number;
}, to: {
    x: number;
    y: number;
}): boolean;
/**
 * Pick the nearest *visible* active enemy.
 *
 * PORT: shared/AI.pas:544-604 — the "see?" loop. We keep the core structure
 * (iterate all sprites, skip self/inactive/dead/spectators, line-of-sight test,
 * keep the closest) and DEFER the team/friend/rambo-bow/dead-kill refinements
 * (AI.pas:549-601). Returns the chosen target sprite index, or 0 if none seen.
 */
export declare function findTarget(world: World, selfNum: number): number;
/**
 * Sets movement + fire + aim for an in-sight target. Faithful port of the
 * movement-critical core of SimpleDecision (AI.pas:71-456): horizontal approach,
 * the X-distance band ladder (fire / crouch / advance / retreat), the Y-distance
 * jetpack rise, and the lead/drop aim. Reload, camper-prone, minigun/realistic
 * burst, grenade/knife, and the BARRETT/RUGER "impossible" branch are DEFERRED
 * (commented at their sites) since they need the weapon model.
 *
 * Assumes `brain.targetNum` is a valid, in-sight enemy.
 */
export declare function simpleDecision(world: World, selfNum: number, brain: BotState): void;
/**
 * Walk the waypoint graph toward the bot's goal when no enemy is in sight.
 *
 * PORT (scoped): shared/AI.pas:651-863. We keep the essential behaviour — find
 * the closest waypoint, pick a next waypoint along its connections, face it, and
 * apply movement toward it — using the SHARED WAYPOINT CONTRACT
 * (`graph.nearestTo` / `graph.stepToward`). The per-gamemode PathNum selection
 * (CTF/INF/HTF, AI.pas:676-730), the per-waypoint Left/Right/Up/Down/Jetpack
 * action bytes, StopAndCamp / WaitNSeconds actions, the stuck-detection and
 * weapon-management tails (AI.pas:817-861) are DEFERRED.
 *
 * Movement is derived from the geometric direction to the next waypoint so a bot
 * with a navigation target sets left/right (and up if the target is above),
 * exactly as a human walking that way would.
 */
export declare function navigateWaypoints(world: World, selfNum: number, brain: BotState, graph: WaypointGraph): void;
/**
 * One AI tick for a single bot. Reads the world, updates the brain, and writes
 * the sprite's Control — the same Control a human would produce, so the shared
 * sprite movement path (applyControl) drives the bot identically.
 *
 * PORT: shared/AI.pas:518-1097 (ControlBot). The high-level flow is preserved:
 *   1. clear controls (FreeControls), AI.pas:532
 *   2. perception: pick the nearest visible enemy, AI.pas:544-604
 *   3. if an enemy is seen -> SimpleDecision (combat), AI.pas:865-901
 *      else -> navigate waypoints, AI.pas:651-863
 *
 * DEFERRED (commented in the helpers above): flag/thing seeking, grenade dodge,
 * camp/pissedoff/team logic, chat, fall-save, weapon management, full RayCast LOS.
 */
export declare function updateBot(world: World, selfNum: number, brain: BotState, graph: WaypointGraph): void;
/**
 * Reset every control field to its neutral value.
 * PORT: shared/mechanics/Sprites.pas — TSprite.FreeControls (AI.pas:532 calls it).
 */
export declare function freeControls(control: Control): void;
//# sourceMappingURL=bot.d.ts.map