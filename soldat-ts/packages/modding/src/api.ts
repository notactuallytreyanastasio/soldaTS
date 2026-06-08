// @soldat/modding — the frozen object model handed to a mod.
//
// Faithful TS mirror of the published PascalScript Script* classes, implemented
// as thin live views over an `@soldat/sim` World (+ optional GameState carrying
// the player/server metadata the sim's bare Sprite record omits).
//
// Authoritative Pascal sources:
//   - server/scriptcore/ScriptGame.pas    (TScriptGame)
//   - server/scriptcore/ScriptPlayer.pas  (TScriptPlayer / TScriptActivePlayer)
//   - server/scriptcore/ScriptPlayers.pas (TScriptPlayers)
//   - server/scriptcore/ScriptMap.pas     (TScriptMap)
// See docs/rewrite-reference/pascalscript-api.md §"Exposed Object Model".
//
// DESIGN NOTE — why a GameState:
// The sim's TS `Sprite` record (packages/sim entities/types.ts) intentionally
// OMITS the embedded Pascal `TPlayer` sub-object (Name/Team/Kills/IP) and stores
// no position (position lives in `world.spriteParts`, the COM particle system).
// In Pascal those reads go through `Sprite.Player.*` and `SpriteParts.Pos[Id]`
// (ScriptPlayer.pas:397/402/654/706). We surface the same values via an optional
// `ModGameState` so the wrappers stay faithful without bloating the sim record.

import { MAX_PLAYERS } from '@soldat/sim';
import type { World, Sprite } from '@soldat/sim';

import type { Vec2Like } from './events';

// ---------------------------------------------------------------------------
// GameState — the metadata the bare Sprite record doesn't carry.
// ---------------------------------------------------------------------------

/**
 * Per-player metadata mirroring the Pascal `Sprite.Player.*` fields the sim
 * record omits. Keyed by 1-based sprite id (1..MAX_PLAYERS).
 *
 * PORT: ScriptPlayer.pas:397 (Team), :402 (Name), :654 (Kills) read
 * `Sprite.Player.Team/.Name/.Kills`.
 */
export interface PlayerState {
  name: string; // PORT: Sprite.Player.Name  (ScriptPlayer.pas:402)
  team: number; // PORT: Sprite.Player.Team  (ScriptPlayer.pas:397)
  kills: number; // PORT: Sprite.Player.Kills (ScriptPlayer.pas:654)
  deaths: number; // PORT: Sprite.Player.Deaths (ScriptPlayer.pas:665)
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

// ---------------------------------------------------------------------------
// ScriptPlayer — live view over one sprite (PORT: TScriptActivePlayer).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ScriptPlayers — the player collection (PORT: TScriptPlayers).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ScriptGame — server/game state (PORT: TScriptGame).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ScriptMap — current map (PORT: TScriptMap).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ScriptApi — the frozen object model handed to a mod.
// ---------------------------------------------------------------------------

/** PORT: the globals a ScriptCore3 mod sees: Game, Players, Map. */
export interface ScriptApi {
  readonly Game: ScriptGame;
  readonly Players: ScriptPlayers;
  readonly Map: ScriptMap;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function spriteAt(world: World, id: number): Sprite {
  const sprite = world.sprites[id];
  if (sprite === undefined) {
    // PORT: ScriptPlayers.GetPlayer raises for out-of-range ids (ScriptPlayers.pas:95-96).
    throw new RangeError(`player id must be 1..${String(MAX_PLAYERS)} (got ${String(id)})`);
  }
  return sprite;
}

function playerStateAt(gameState: ModGameState | undefined, id: number): PlayerState | undefined {
  return gameState?.players?.[id];
}

function makePlayer(world: World, gameState: ModGameState | undefined, id: number): ScriptPlayer {
  // The wrapper holds no cached state: every getter reads the live World/GameState
  // so the view reflects mutations from the sim (mirrors the Pascal pointer view,
  // ScriptPlayer.pas FSpritePtr).
  const player: ScriptPlayer = {
    get id(): number {
      return id;
    },
    get active(): boolean {
      // PORT: ScriptPlayer.pas:679-682.
      return spriteAt(world, id).active;
    },
    get name(): string {
      // PORT: ScriptPlayer.pas:400-403 (Sprite.Player.Name).
      return playerStateAt(gameState, id)?.name ?? '';
    },
    get team(): number {
      // PORT: ScriptPlayer.pas:395-398 (Sprite.Player.Team).
      return playerStateAt(gameState, id)?.team ?? 0;
    },
    set team(value: number) {
      const st = playerStateAt(gameState, id);
      if (st !== undefined) st.team = value;
    },
    get alive(): boolean {
      // PORT: TScriptPlayer.Alive -> not Sprite.DeadMeat.
      return !spriteAt(world, id).deadMeat;
    },
    get health(): number {
      // PORT: ScriptPlayer.pas:410-413 (Sprite.Health).
      return spriteAt(world, id).health;
    },
    set health(value: number) {
      // PORT: ScriptPlayer.pas:415-418 — writes straight back to Sprite.Health.
      spriteAt(world, id).health = value;
    },
    get vest(): number {
      // PORT: Sprite.Vest (Sprites.pas:131).
      return spriteAt(world, id).vest;
    },
    set vest(value: number) {
      spriteAt(world, id).vest = value;
    },
    get kills(): number {
      // PORT: ScriptPlayer.pas:652-655 (Sprite.Player.Kills).
      return playerStateAt(gameState, id)?.kills ?? 0;
    },
    set kills(value: number) {
      const st = playerStateAt(gameState, id);
      if (st !== undefined) st.kills = value;
    },
    get deaths(): number {
      // PORT: ScriptPlayer.pas:663-666 (Sprite.Player.Deaths).
      return playerStateAt(gameState, id)?.deaths ?? 0;
    },
    set deaths(value: number) {
      const st = playerStateAt(gameState, id);
      if (st !== undefined) st.deaths = value;
    },
    get x(): number {
      // PORT: ScriptPlayer.pas:704-706 — SpriteParts.Pos[Id].X.
      return world.spriteParts?.posX[id] ?? 0;
    },
    get y(): number {
      // PORT: ScriptPlayer.pas:709-711 — SpriteParts.Pos[Id].Y.
      return world.spriteParts?.posY[id] ?? 0;
    },
  };
  return Object.freeze(player);
}

function makePlayers(world: World, gameState: ModGameState | undefined): ScriptPlayers {
  // One wrapper per slot, created lazily and memoized so identity is stable
  // across calls (mirrors TScriptPlayers' fixed FPlayers array, ScriptPlayers.pas:31).
  const cache = new Array<ScriptPlayer | undefined>(MAX_PLAYERS + 1).fill(undefined);

  const getById = (id: number): ScriptPlayer => {
    if (!Number.isInteger(id) || id < 1 || id > MAX_PLAYERS) {
      // PORT: ScriptPlayers.pas:95-96.
      throw new RangeError(`ID must be from 1 to ${String(MAX_PLAYERS)} (got ${String(id)})`);
    }
    let wrapper = cache[id];
    if (wrapper === undefined) {
      wrapper = makePlayer(world, gameState, id);
      cache[id] = wrapper;
    }
    return wrapper;
  };

  const players: ScriptPlayers = {
    getById,
    get active(): readonly ScriptPlayer[] {
      // PORT: TScriptPlayers.Active — only joined (active) sprites; skips inactive.
      const list: ScriptPlayer[] = [];
      for (let id = 1; id <= MAX_PLAYERS; id++) {
        if (spriteAt(world, id).active) list.push(getById(id));
      }
      return list;
    },
    getByName(name: string): ScriptPlayer | undefined {
      // PORT: ScriptPlayers.pas:179-194 — scans active players for a name match.
      for (let id = 1; id <= MAX_PLAYERS; id++) {
        if (!spriteAt(world, id).active) continue;
        if ((playerStateAt(gameState, id)?.name ?? '') === name) return getById(id);
      }
      return undefined;
    },
    [Symbol.iterator](): Iterator<ScriptPlayer> {
      return this.active[Symbol.iterator]();
    },
  };
  return Object.freeze(players);
}

function makeGame(world: World, gameState: ModGameState | undefined): ScriptGame {
  const game: ScriptGame = {
    get tickThreshold(): number {
      return gameState?.tickThreshold ?? 0;
    },
    set tickThreshold(value: number) {
      if (gameState !== undefined) gameState.tickThreshold = value;
    },
    get tickCount(): number {
      // PORT: ScriptGame.pas:163 — TickCount = MainTickCounter.
      return world.mainTickCounter;
    },
    get currentMap(): string {
      return gameState?.currentMap ?? '';
    },
    get nextMap(): string {
      return gameState?.nextMap ?? '';
    },
    get scoreLimit(): number {
      return gameState?.scoreLimit ?? 0;
    },
    set scoreLimit(value: number) {
      if (gameState !== undefined) gameState.scoreLimit = value;
    },
    get gameStyle(): number {
      return gameState?.gameStyle ?? 0;
    },
    set gameStyle(value: number) {
      if (gameState !== undefined) gameState.gameStyle = value;
    },
    getTeamScore(team: number): number {
      // PORT: TScriptTeam.Score -> TeamScore[ID] (ScriptTeam.pas).
      return gameState?.teamScores?.[team] ?? 0;
    },
  };
  return Object.freeze(game);
}

function makeMap(world: World, gameState: ModGameState | undefined): ScriptMap {
  const map: ScriptMap = {
    get name(): string {
      // PORT: ScriptMap.pas:137 — Map.Name.
      return gameState?.currentMap ?? '';
    },
    get bounds(): MapBounds {
      // Derive an AABB from the PolyMap sector grid half-extent. The grid spans
      // cells -sectorsNum..+sectorsNum at sectorsDivision world units per cell;
      // that is exactly the area RayCast scans (PolyMap.pas sector bounds).
      const pm = world.map;
      if (pm === null) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      }
      const extent = pm.sectorsNum * pm.sectorsDivision;
      return { minX: -extent, minY: -extent, maxX: extent, maxY: extent };
    },
  };
  return Object.freeze(map);
}

/**
 * Build the frozen mod API over a live World (+ optional GameState).
 *
 * PORT: the Game/Players/Map globals a ScriptCore3 mod imports. The returned
 * objects are frozen but read the live World on every access, so a mod observes
 * sim mutations and its writes (health, kills, ...) flow back into the World.
 */
export function createScriptApi(world: World, gameState?: ModGameState): ScriptApi {
  return Object.freeze({
    Game: makeGame(world, gameState),
    Players: makePlayers(world, gameState),
    Map: makeMap(world, gameState),
  });
}

// Re-export the position shape used by spawn-related events for host convenience.
export type { Vec2Like };
