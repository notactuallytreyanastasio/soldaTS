/**
 * Bot waypoint navigation graph — faithful port of shared/Waypoints.pas.
 *
 * The Pascal unit defines a fixed array `Waypoint[1..MAX_WAYPOINTS]` of
 * {@link Waypoint} records plus a single navigation helper, `FindClosest`
 * (Waypoints.pas:42-60), which scans for the nearest *active* waypoint within a
 * radius. The connection lists (TWaypoint.Connections[1..ConnectionsNum]) form
 * an undirected-by-construction graph the bot AI walks to chase a target.
 *
 * This module exposes:
 *   - the {@link Waypoint} interface (faithful to TWaypoint, with the action
 *     flags Soldat stores: left/right/up/down/jetpack/pathNum/action),
 *   - {@link WaypointGraph} with `nearestTo` (FindClosest-style nearest active
 *     waypoint) and `stepToward` (a breadth-first single hop toward a target,
 *     walking the connection graph), and
 *   - {@link buildWaypoints}, which constructs the graph from the parsed `.PMS`
 *     waypoint records.
 *
 * Indexing: `waypoints` is 1-indexed (slot 0 is an inert sentinel) to mirror
 * `Waypoint[1..MAX_WAYPOINTS]`. The navigation API speaks in waypoint *ids*
 * (returning 0 for "none"), matching how `FindClosest` returns an array index
 * and how Connections reference waypoints. We keep an id->index map so the
 * graph is correct whether or not a record's `id` equals its array slot.
 *
 * PORT: shared/Waypoints.pas (TWaypoint, TWaypoints.FindClosest)
 */
import { f } from '../scalar';
import { distance } from '../math/calc';
/** PORT: shared/Waypoints.pas:14 — maximum bot waypoints. */
export const MAX_WAYPOINTS = 5000;
/** PORT: shared/Waypoints.pas:15 — maximum connections per waypoint. */
export const MAX_CONNECTIONS = 20;
/**
 * Camp/idle behaviour stored on a waypoint.
 *
 * PORT: shared/Waypoints.pas:18-19 (TWaypointAction, scopedenums on)
 */
export var WaypointAction;
(function (WaypointAction) {
    WaypointAction[WaypointAction["None"] = 0] = "None";
    WaypointAction[WaypointAction["StopAndCamp"] = 1] = "StopAndCamp";
    WaypointAction[WaypointAction["Wait1Second"] = 2] = "Wait1Second";
    WaypointAction[WaypointAction["Wait5Seconds"] = 3] = "Wait5Seconds";
    WaypointAction[WaypointAction["Wait10Seconds"] = 4] = "Wait10Seconds";
    WaypointAction[WaypointAction["Wait15Seconds"] = 5] = "Wait15Seconds";
    WaypointAction[WaypointAction["Wait20Seconds"] = 6] = "Wait20Seconds";
})(WaypointAction || (WaypointAction = {}));
/**
 * In-memory waypoint navigation graph.
 *
 * The waypoint store is 1-indexed (`waypoints[0]` is an inert sentinel) to
 * mirror `Waypoint[1..MAX_WAYPOINTS]`. Navigation methods speak in waypoint
 * ids and use `0` to mean "none", matching the Pascal convention where index 0
 * is the empty result.
 */
export class WaypointGraph {
    /** 1-indexed waypoint store; slot 0 is an inert sentinel. */
    waypoints;
    /** Map from waypoint id -> array slot in {@link waypoints}. */
    idToIndex;
    constructor(waypoints) {
        this.waypoints = waypoints;
        this.idToIndex = new Map();
        for (let i = 1; i < waypoints.length; i++) {
            const wp = waypoints[i];
            if (wp !== undefined && wp.active) {
                // Last writer wins on duplicate ids, mirroring a linear scan.
                this.idToIndex.set(wp.id, i);
            }
        }
    }
    /** Resolve a waypoint id to its (active) array slot, or 0 if unknown. */
    indexOfId(id) {
        const idx = this.idToIndex.get(id);
        return idx === undefined ? 0 : idx;
    }
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
    nearestTo(x, y) {
        let best = 0;
        let bestDist = f(Number.POSITIVE_INFINITY);
        for (let i = 1; i < this.waypoints.length; i++) {
            const wp = this.waypoints[i];
            if (wp === undefined || !wp.active) {
                continue;
            }
            const d = distance(x, y, wp.x, wp.y);
            if (f(d) < bestDist) {
                bestDist = f(d);
                best = wp.id;
            }
        }
        return best;
    }
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
    stepToward(fromId, targetId) {
        const fromIdx = this.indexOfId(fromId);
        const targetIdx = this.indexOfId(targetId);
        if (fromIdx === 0 || targetIdx === 0) {
            return 0;
        }
        if (fromId === targetId) {
            return fromId;
        }
        // BFS over ids, recording each node's predecessor id so we can reconstruct
        // the first hop. `parent` doubles as the visited set.
        const parent = new Map();
        parent.set(fromId, fromId);
        const queue = [fromId];
        let head = 0;
        while (head < queue.length) {
            const curId = queue[head];
            head += 1;
            if (curId === undefined) {
                continue;
            }
            const curIdx = this.indexOfId(curId);
            if (curIdx === 0) {
                continue;
            }
            const cur = this.waypoints[curIdx];
            if (cur === undefined) {
                continue;
            }
            for (const nextId of cur.connections) {
                // Skip dangling connections (id not present / inactive) and visited.
                if (this.indexOfId(nextId) === 0 || parent.has(nextId)) {
                    continue;
                }
                parent.set(nextId, curId);
                if (nextId === targetId) {
                    return this.firstHop(parent, fromId, targetId);
                }
                queue.push(nextId);
            }
        }
        return 0;
    }
    /**
     * Walk the BFS predecessor chain back from `targetId` to the neighbour of
     * `fromId`, returning that neighbour id (the first hop to take). Returns 0 if
     * the chain is malformed (should not happen for a discovered target).
     */
    firstHop(parent, fromId, targetId) {
        let cur = targetId;
        let guard = 0;
        while (guard <= MAX_WAYPOINTS) {
            const prev = parent.get(cur);
            if (prev === undefined) {
                return 0;
            }
            if (prev === fromId) {
                return cur;
            }
            cur = prev;
            guard += 1;
        }
        return 0;
    }
}
/**
 * Coerce a numeric `.PMS` action value into the {@link WaypointAction} enum,
 * clamping unknown values to `None` (defensive: the file is untrusted input).
 */
function toAction(value) {
    switch (value) {
        case WaypointAction.StopAndCamp:
        case WaypointAction.Wait1Second:
        case WaypointAction.Wait5Seconds:
        case WaypointAction.Wait10Seconds:
        case WaypointAction.Wait15Seconds:
        case WaypointAction.Wait20Seconds:
            return value;
        default:
            return WaypointAction.None;
    }
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
export function buildWaypoints(source) {
    const sentinel = {
        active: false,
        id: 0,
        x: 0,
        y: 0,
        left: false,
        right: false,
        up: false,
        down: false,
        jetpack: false,
        pathNum: 0,
        action: WaypointAction.None,
        connections: [],
    };
    const waypoints = [sentinel];
    for (const src of source.waypoints) {
        const liveCount = Math.max(0, Math.min(src.connectionsNum, MAX_CONNECTIONS));
        const connections = [];
        for (let c = 0; c < liveCount; c++) {
            const id = src.connections[c];
            if (id !== undefined) {
                connections.push(id);
            }
        }
        waypoints.push({
            active: src.active,
            id: src.id,
            x: src.x,
            y: src.y,
            left: src.left,
            right: src.right,
            up: src.up,
            down: src.down,
            jetpack: src.jetpack,
            pathNum: src.pathNum,
            action: toAction(src.action),
            connections,
        });
    }
    return new WaypointGraph(waypoints);
}
//# sourceMappingURL=waypoints.js.map