/** PORT: shared/Waypoints.pas:14 — maximum bot waypoints. */
export declare const MAX_WAYPOINTS = 5000;
/** PORT: shared/Waypoints.pas:15 — maximum connections per waypoint. */
export declare const MAX_CONNECTIONS = 20;
/**
 * Camp/idle behaviour stored on a waypoint.
 *
 * PORT: shared/Waypoints.pas:18-19 (TWaypointAction, scopedenums on)
 */
export declare enum WaypointAction {
    None = 0,
    StopAndCamp = 1,
    Wait1Second = 2,
    Wait5Seconds = 3,
    Wait10Seconds = 4,
    Wait15Seconds = 5,
    Wait20Seconds = 6
}
/**
 * A single bot path node.
 *
 * Faithful to the Pascal `TWaypoint` record: the boolean direction flags
 * (left/right/up/down/jetpack), the path grouping byte, the camp action, and
 * the connection list. `connections` holds the live connection ids
 * (`Connections[1..ConnectionsNum]`); we drop the trailing unused slots of the
 * fixed `array[1..MAX_CONNECTIONS]` so the list length is meaningful.
 *
 * PORT: shared/Waypoints.pas:20-29 (TWaypoint)
 */
export interface Waypoint {
    /** TWaypoint.Active — inactive waypoints are skipped by navigation. */
    active: boolean;
    /** TWaypoint.Id — user-defined identifier; distinct from array slot. */
    id: number;
    /** TWaypoint.X — integer world units. */
    x: number;
    /** TWaypoint.Y — integer world units. */
    y: number;
    /** TWaypoint.Left — bot may move left from here. */
    left: boolean;
    /** TWaypoint.Right — bot may move right from here. */
    right: boolean;
    /** TWaypoint.Up — bot may move up from here. */
    up: boolean;
    /** TWaypoint.Down — bot may move down from here. */
    down: boolean;
    /** TWaypoint.Jetpack — bot should use the jetpack to traverse. */
    jetpack: boolean;
    /** TWaypoint.PathNum (Byte) — path/group identifier. */
    pathNum: number;
    /** TWaypoint.Action — camp/wait behaviour. */
    action: WaypointAction;
    /** Live connection ids (Connections[1..ConnectionsNum]). */
    connections: number[];
}
/** Mirror of the assets `Waypoint` shape (pms-types.ts:221-235). */
export interface PmsWaypoint {
    active: boolean;
    id: number;
    x: number;
    y: number;
    left: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
    jetpack: boolean;
    pathNum: number;
    action: number;
    connectionsNum: number;
    /** Fixed-length array of MAX_CONNECTIONS ids; only [0..connectionsNum) live. */
    connections: number[];
}
/** Structural mirror of the assets `PmsMap` waypoint section. */
export interface WaypointSource {
    waypoints: PmsWaypoint[];
}
/**
 * In-memory waypoint navigation graph.
 *
 * The waypoint store is 1-indexed (`waypoints[0]` is an inert sentinel) to
 * mirror `Waypoint[1..MAX_WAYPOINTS]`. Navigation methods speak in waypoint
 * ids and use `0` to mean "none", matching the Pascal convention where index 0
 * is the empty result.
 */
export declare class WaypointGraph {
    /** 1-indexed waypoint store; slot 0 is an inert sentinel. */
    readonly waypoints: Waypoint[];
    /** Map from waypoint id -> array slot in {@link waypoints}. */
    private readonly idToIndex;
    constructor(waypoints: Waypoint[]);
    /** Resolve a waypoint id to its (active) array slot, or 0 if unknown. */
    private indexOfId;
    /**
     * Id of the nearest *active* waypoint to (x, y), or 0 if none.
     *
     * Faithful in spirit to `TWaypoints.FindClosest` (Waypoints.pas:42-60): a
     * linear scan over the waypoint array computing `Distance`. FindClosest
     * short-circuits on the first waypoint inside a radius; the M5 contract asks
     * for the *closest*, so we keep scanning and track the minimum. Distance
     * arithmetic flows through `Distance` (calc.ts) which already wraps each step
     * in `f()`; the running minimum compare is wrapped in `f()` too.
     */
    nearestTo(x: number, y: number): number;
    /**
     * Next waypoint id on a shortest connection path from `fromId` toward
     * `targetId`. Returns `targetId` when it is directly reachable in one hop,
     * the first hop of a shortest path otherwise, and `0` when the target is
     * unreachable (or either endpoint is unknown/inactive).
     *
     * This is the connection-graph navigation step the bot AI performs when
     * chasing a goal waypoint. We run a breadth-first search from `fromId` and,
     * for the discovered target, backtrack to the neighbour of `fromId` that
     * begins the path — that neighbour id is the single hop to take this tick.
     */
    stepToward(fromId: number, targetId: number): number;
    /**
     * Walk the BFS predecessor chain back from `targetId` to the neighbour of
     * `fromId`, returning that neighbour id (the first hop to take). Returns 0 if
     * the chain is malformed (should not happen for a discovered target).
     */
    private firstHop;
}
/**
 * Construct a {@link WaypointGraph} from the parsed `.PMS` waypoint records.
 *
 * The store is built 1-indexed to mirror `Waypoint[1..MAX_WAYPOINTS]`: slot 0
 * is an inert sentinel and the i-th source record (0-indexed in the file) lands
 * at slot `i + 1`. We copy the action flags verbatim and trim each connection
 * list to its live length (`Connections[1..ConnectionsNum]`), dropping the
 * unused tail of the fixed 20-slot array.
 *
 * PORT: shared/Waypoints.pas (TWaypoint array population)
 */
export declare function buildWaypoints(source: WaypointSource): WaypointGraph;
//# sourceMappingURL=waypoints.d.ts.map