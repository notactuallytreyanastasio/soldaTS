// Parsed .PMS binary map structures.
//
// Faithful port of the on-disk record layout from shared/MapFile.pas. Field
// order, sizes and 1-indexing semantics mirror the Pascal records exactly.
// See docs/rewrite-reference/pms-map-format.md for the byte-level spec.
//
// PORT: shared/MapFile.pas:8-89 (type declarations)
// ---------------------------------------------------------------------------
// Capacity constants — PolyMap.pas / Waypoints.pas (quoted in pms-map-format.md)
// ---------------------------------------------------------------------------
/** PORT: PolyMap.pas — maximum collision polygons. */
export const MAX_POLYS = 5000;
/** PORT: PolyMap.pas — maximum half-dimension of the sector grid. */
export const MAX_SECTOR = 25;
/** PORT: PolyMap.pas — maximum props and scenery. */
export const MAX_PROPS = 500;
/** PORT: PolyMap.pas — maximum circular colliders. */
export const MAX_COLLIDERS = 128;
/** PORT: PolyMap.pas — maximum spawnpoints. */
export const MAX_SPAWNPOINTS = 255;
/** PORT: shared/Waypoints.pas:14 — maximum bot waypoints. */
export const MAX_WAYPOINTS = 5000;
/** PORT: shared/Waypoints.pas:15 — maximum connections per waypoint. */
export const MAX_CONNECTIONS = 20;
/**
 * Polygon collision type. PORT: PolyMap.pas:22-47 (POLY_TYPE_*).
 * Stored in the file as a single Uint8.
 */
export var PolyType;
(function (PolyType) {
    PolyType[PolyType["Normal"] = 0] = "Normal";
    PolyType[PolyType["OnlyBullets"] = 1] = "OnlyBullets";
    PolyType[PolyType["OnlyPlayer"] = 2] = "OnlyPlayer";
    PolyType[PolyType["Doesnt"] = 3] = "Doesnt";
    PolyType[PolyType["Ice"] = 4] = "Ice";
    PolyType[PolyType["Deadly"] = 5] = "Deadly";
    PolyType[PolyType["BloodyDeadly"] = 6] = "BloodyDeadly";
    PolyType[PolyType["Hurts"] = 7] = "Hurts";
    PolyType[PolyType["Regenerates"] = 8] = "Regenerates";
    PolyType[PolyType["Lava"] = 9] = "Lava";
    PolyType[PolyType["RedBullets"] = 10] = "RedBullets";
    PolyType[PolyType["RedPlayer"] = 11] = "RedPlayer";
    PolyType[PolyType["BlueBullets"] = 12] = "BlueBullets";
    PolyType[PolyType["BluePlayer"] = 13] = "BluePlayer";
    PolyType[PolyType["YellowBullets"] = 14] = "YellowBullets";
    PolyType[PolyType["YellowPlayer"] = 15] = "YellowPlayer";
    PolyType[PolyType["GreenBullets"] = 16] = "GreenBullets";
    PolyType[PolyType["GreenPlayer"] = 17] = "GreenPlayer";
    PolyType[PolyType["Bouncy"] = 18] = "Bouncy";
    PolyType[PolyType["Explodes"] = 19] = "Explodes";
    PolyType[PolyType["HurtsFlaggers"] = 20] = "HurtsFlaggers";
    PolyType[PolyType["OnlyFlaggers"] = 21] = "OnlyFlaggers";
    PolyType[PolyType["NotFlaggers"] = 22] = "NotFlaggers";
    PolyType[PolyType["NonFlaggerCollides"] = 23] = "NonFlaggerCollides";
    PolyType[PolyType["Background"] = 24] = "Background";
    PolyType[PolyType["BackgroundTransition"] = 25] = "BackgroundTransition";
})(PolyType || (PolyType = {}));
// ---------------------------------------------------------------------------
// Spawnpoints
// ---------------------------------------------------------------------------
/**
 * Spawn / object team type. PORT: spawnpoint Team field
 * (MapFile.pas:61, semantics from pms-map-format.md:186).
 */
export var SpawnTeam;
(function (SpawnTeam) {
    SpawnTeam[SpawnTeam["Any"] = 0] = "Any";
    SpawnTeam[SpawnTeam["Alpha"] = 1] = "Alpha";
    SpawnTeam[SpawnTeam["Bravo"] = 2] = "Bravo";
    SpawnTeam[SpawnTeam["Charlie"] = 3] = "Charlie";
    SpawnTeam[SpawnTeam["Delta"] = 4] = "Delta";
    SpawnTeam[SpawnTeam["Flag1"] = 5] = "Flag1";
    SpawnTeam[SpawnTeam["Flag2"] = 6] = "Flag2";
})(SpawnTeam || (SpawnTeam = {}));
// ---------------------------------------------------------------------------
// Waypoints
// ---------------------------------------------------------------------------
/** PORT: shared/Waypoints.pas:18-19 (TWaypointAction, scopedenums on) */
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
//# sourceMappingURL=pms-types.js.map