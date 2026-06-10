import type { World } from '@soldat/sim';
import type { Vec2Like } from './events';
/**
 * Per-player metadata mirroring the Pascal `Sprite.Player.*` fields the sim
 * record omits. Keyed by 1-based sprite id (1..MAX_PLAYERS).
 *
 * PORT: ScriptPlayer.pas:397 (Team), :402 (Name), :654 (Kills) read
 * `Sprite.Player.Team/.Name/.Kills`.
 */
export interface PlayerState {
    name: string;
    team: number;
    kills: number;
    deaths: number;
}
/**
 * Optional game/server state the mod API reads. All fields optional; wrappers
 * fall back to neutral defaults (mirrors a freshly-zeroed Pascal record) so the
 * API is usable in tests with only a World.
 */
export interface ModGameState {
    /** 1-based per-sprite metadata; index 0 unused (sentinel), like the sim arrays. */
    players?: (PlayerState | undefined)[];
    /** PORT: ScriptGame.GetCurrentMap -> Map.Name (ScriptGame.pas:229-232). */
    currentMap?: string;
    /** PORT: ScriptGame.GetNextMap (ScriptGame.pas:219-227). */
    nextMap?: string;
    /** PORT: ScriptGame.GetScoreLimit -> sv_killlimit (ScriptGame.pas:249-252). */
    scoreLimit?: number;
    /** PORT: ScriptGame.GetGameStyle -> sv_gamemode (ScriptGame.pas:195-198). */
    gameStyle?: number;
    /** PORT: ScriptGame.TickThreshold (ScriptGame.pas:162); 0 disables Game.OnClockTick. */
    tickThreshold?: number;
    /** Per-team score (PORT: TScriptTeam.Score, ScriptTeam.pas). Index by team id 0..5. */
    teamScores?: (number | undefined)[];
}
/**
 * PORT: server/scriptcore/ScriptPlayer.pas — TScriptActivePlayer (+ base
 * TScriptPlayer). Property names mirror the Pascal published properties.
 * Reads/writes go straight to the live World sprite and GameState.
 */
export interface ScriptPlayer {
    /** PORT: TScriptActivePlayer.FID — 1-based sprite id (ScriptPlayer.pas:649). */
    readonly id: number;
    /** PORT: TScriptActivePlayer.Active -> Sprite.Active (ScriptPlayer.pas:679-682). */
    readonly active: boolean;
    /** PORT: TScriptPlayer.Name -> Sprite.Player.Name (ScriptPlayer.pas:400-403). */
    readonly name: string;
    /** PORT: TScriptPlayer.Team -> Sprite.Player.Team (ScriptPlayer.pas:395-398). */
    team: number;
    /** PORT: TScriptPlayer.Alive -> not Sprite.DeadMeat (Sprites.pas DeadMeat). */
    readonly alive: boolean;
    /** PORT: TScriptPlayer.Health -> Sprite.Health (ScriptPlayer.pas:410-418). Read/write. */
    health: number;
    /** PORT: TScriptPlayer.Vest -> Sprite.Vest (Sprites.pas:131). Read/write. */
    vest: number;
    /** PORT: TScriptActivePlayer.Kills -> Sprite.Player.Kills (ScriptPlayer.pas:652-661). Read/write. */
    kills: number;
    /** PORT: TScriptActivePlayer.Deaths -> Sprite.Player.Deaths (ScriptPlayer.pas:663-672). Read/write. */
    deaths: number;
    /** PORT: TScriptActivePlayer.X -> SpriteParts.Pos[Id].X (ScriptPlayer.pas:704-707). */
    readonly x: number;
    /** PORT: TScriptActivePlayer.Y -> SpriteParts.Pos[Id].Y (ScriptPlayer.pas:709-712). */
    readonly y: number;
}
/**
 * PORT: server/scriptcore/ScriptPlayers.pas — TScriptPlayers. 1-based
 * `Player[Id]` accessor + the dynamically-maintained `Active` list, plus
 * GetByName. Iteration helpers added for ergonomic TS use.
 */
export interface ScriptPlayers {
    /**
     * PORT: TScriptPlayers.GetPlayer (ScriptPlayers.pas:93-98) — raises for ids
     * outside 1..MAX_PLAYERS. Returns the wrapper for sprite `id` (1-based).
     */
    getById(id: number): ScriptPlayer;
    /**
     * PORT: TScriptPlayers.Active (ScriptPlayers.pas:48) — the list of joined
     * (active) players. Skips inactive sprites.
     */
    readonly active: readonly ScriptPlayer[];
    /** PORT: TScriptPlayers.GetByName (ScriptPlayers.pas:179-194). */
    getByName(name: string): ScriptPlayer | undefined;
    /** Iterate active players (TS convenience over the `Active` list). */
    [Symbol.iterator](): Iterator<ScriptPlayer>;
}
/**
 * PORT: server/scriptcore/ScriptGame.pas — TScriptGame. Subset relevant to the
 * mod-host contract: tick threshold/count, score limit, game style, map names.
 */
export interface ScriptGame {
    /** PORT: TScriptGame.TickThreshold (ScriptGame.pas:162); 0 disables OnClockTick. Read/write. */
    tickThreshold: number;
    /** PORT: TScriptGame.TickCount -> MainTickCounter (ScriptGame.pas:163, world.mainTickCounter). */
    readonly tickCount: number;
    /** PORT: TScriptGame.CurrentMap -> Map.Name (ScriptGame.pas:133, :229-232). */
    readonly currentMap: string;
    /** PORT: TScriptGame.NextMap (ScriptGame.pas:219-227). */
    readonly nextMap: string;
    /** PORT: TScriptGame.ScoreLimit -> sv_killlimit (ScriptGame.pas:137, :249-257). Read/write. */
    scoreLimit: number;
    /** PORT: TScriptGame.GameStyle -> sv_gamemode (ScriptGame.pas:195-203). Read/write. */
    gameStyle: number;
    /** PORT: TScriptGame.Teams[].Score (ScriptTeam.pas) — read team score by team id. */
    getTeamScore(team: number): number;
}
/** Axis-aligned world bounds derived from the PolyMap sector grid. */
export interface MapBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}
/**
 * PORT: server/scriptcore/ScriptMap.pas — TScriptMap. Name + (TS extension)
 * world bounds computed from the loaded PolyMap sector grid.
 */
export interface ScriptMap {
    /** PORT: TScriptMap.Name -> Map.Name (ScriptMap.pas:68, :137). */
    readonly name: string;
    /**
     * World bounds. Pascal exposes geometry via RayCast/Objects, not a `Bounds`
     * property; here we derive an AABB from PolyMap.sectorsNum * sectorsDivision
     * (the sector grid half-extent), which is the playable area RayCast scans.
     */
    readonly bounds: MapBounds;
}
/** PORT: the globals a ScriptCore3 mod sees: Game, Players, Map. */
export interface ScriptApi {
    readonly Game: ScriptGame;
    readonly Players: ScriptPlayers;
    readonly Map: ScriptMap;
}
/**
 * Build the frozen mod API over a live World (+ optional GameState).
 *
 * PORT: the Game/Players/Map globals a ScriptCore3 mod imports. The returned
 * objects are frozen but read the live World on every access, so a mod observes
 * sim mutations and its writes (health, kills, ...) flow back into the World.
 */
export declare function createScriptApi(world: World, gameState?: ModGameState): ScriptApi;
export type { Vec2Like };
//# sourceMappingURL=api.d.ts.map