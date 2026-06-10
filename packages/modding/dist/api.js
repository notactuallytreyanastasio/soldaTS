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
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
function spriteAt(world, id) {
    const sprite = world.sprites[id];
    if (sprite === undefined) {
        // PORT: ScriptPlayers.GetPlayer raises for out-of-range ids (ScriptPlayers.pas:95-96).
        throw new RangeError(`player id must be 1..${String(MAX_PLAYERS)} (got ${String(id)})`);
    }
    return sprite;
}
function playerStateAt(gameState, id) {
    return gameState?.players?.[id];
}
function makePlayer(world, gameState, id) {
    // The wrapper holds no cached state: every getter reads the live World/GameState
    // so the view reflects mutations from the sim (mirrors the Pascal pointer view,
    // ScriptPlayer.pas FSpritePtr).
    const player = {
        get id() {
            return id;
        },
        get active() {
            // PORT: ScriptPlayer.pas:679-682.
            return spriteAt(world, id).active;
        },
        get name() {
            // PORT: ScriptPlayer.pas:400-403 (Sprite.Player.Name).
            return playerStateAt(gameState, id)?.name ?? '';
        },
        get team() {
            // PORT: ScriptPlayer.pas:395-398 (Sprite.Player.Team).
            return playerStateAt(gameState, id)?.team ?? 0;
        },
        set team(value) {
            const st = playerStateAt(gameState, id);
            if (st !== undefined)
                st.team = value;
        },
        get alive() {
            // PORT: TScriptPlayer.Alive -> not Sprite.DeadMeat.
            return !spriteAt(world, id).deadMeat;
        },
        get health() {
            // PORT: ScriptPlayer.pas:410-413 (Sprite.Health).
            return spriteAt(world, id).health;
        },
        set health(value) {
            // PORT: ScriptPlayer.pas:415-418 — writes straight back to Sprite.Health.
            spriteAt(world, id).health = value;
        },
        get vest() {
            // PORT: Sprite.Vest (Sprites.pas:131).
            return spriteAt(world, id).vest;
        },
        set vest(value) {
            spriteAt(world, id).vest = value;
        },
        get kills() {
            // PORT: ScriptPlayer.pas:652-655 (Sprite.Player.Kills).
            return playerStateAt(gameState, id)?.kills ?? 0;
        },
        set kills(value) {
            const st = playerStateAt(gameState, id);
            if (st !== undefined)
                st.kills = value;
        },
        get deaths() {
            // PORT: ScriptPlayer.pas:663-666 (Sprite.Player.Deaths).
            return playerStateAt(gameState, id)?.deaths ?? 0;
        },
        set deaths(value) {
            const st = playerStateAt(gameState, id);
            if (st !== undefined)
                st.deaths = value;
        },
        get x() {
            // PORT: ScriptPlayer.pas:704-706 — SpriteParts.Pos[Id].X.
            return world.spriteParts?.posX[id] ?? 0;
        },
        get y() {
            // PORT: ScriptPlayer.pas:709-711 — SpriteParts.Pos[Id].Y.
            return world.spriteParts?.posY[id] ?? 0;
        },
    };
    return Object.freeze(player);
}
function makePlayers(world, gameState) {
    // One wrapper per slot, created lazily and memoized so identity is stable
    // across calls (mirrors TScriptPlayers' fixed FPlayers array, ScriptPlayers.pas:31).
    const cache = new Array(MAX_PLAYERS + 1).fill(undefined);
    const getById = (id) => {
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
    const players = {
        getById,
        get active() {
            // PORT: TScriptPlayers.Active — only joined (active) sprites; skips inactive.
            const list = [];
            for (let id = 1; id <= MAX_PLAYERS; id++) {
                if (spriteAt(world, id).active)
                    list.push(getById(id));
            }
            return list;
        },
        getByName(name) {
            // PORT: ScriptPlayers.pas:179-194 — scans active players for a name match.
            for (let id = 1; id <= MAX_PLAYERS; id++) {
                if (!spriteAt(world, id).active)
                    continue;
                if ((playerStateAt(gameState, id)?.name ?? '') === name)
                    return getById(id);
            }
            return undefined;
        },
        [Symbol.iterator]() {
            return this.active[Symbol.iterator]();
        },
    };
    return Object.freeze(players);
}
function makeGame(world, gameState) {
    const game = {
        get tickThreshold() {
            return gameState?.tickThreshold ?? 0;
        },
        set tickThreshold(value) {
            if (gameState !== undefined)
                gameState.tickThreshold = value;
        },
        get tickCount() {
            // PORT: ScriptGame.pas:163 — TickCount = MainTickCounter.
            return world.mainTickCounter;
        },
        get currentMap() {
            return gameState?.currentMap ?? '';
        },
        get nextMap() {
            return gameState?.nextMap ?? '';
        },
        get scoreLimit() {
            return gameState?.scoreLimit ?? 0;
        },
        set scoreLimit(value) {
            if (gameState !== undefined)
                gameState.scoreLimit = value;
        },
        get gameStyle() {
            return gameState?.gameStyle ?? 0;
        },
        set gameStyle(value) {
            if (gameState !== undefined)
                gameState.gameStyle = value;
        },
        getTeamScore(team) {
            // PORT: TScriptTeam.Score -> TeamScore[ID] (ScriptTeam.pas).
            return gameState?.teamScores?.[team] ?? 0;
        },
    };
    return Object.freeze(game);
}
function makeMap(world, gameState) {
    const map = {
        get name() {
            // PORT: ScriptMap.pas:137 — Map.Name.
            return gameState?.currentMap ?? '';
        },
        get bounds() {
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
export function createScriptApi(world, gameState) {
    return Object.freeze({
        Game: makeGame(world, gameState),
        Players: makePlayers(world, gameState),
        Map: makeMap(world, gameState),
    });
}
//# sourceMappingURL=api.js.map