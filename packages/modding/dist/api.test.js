import { describe, it, expect } from 'vitest';
import { createWorld, ParticleSystem, MAX_PLAYERS } from '@soldat/sim';
import { createScriptApi } from './api';
/**
 * Build a World with two active sprites (ids 1 and 2) plus the matching
 * GameState metadata. Sprite 1 = alpha, sprite 2 = bravo; sprite 3 left inactive.
 */
function makeWorld() {
    const world = createWorld();
    const parts = new ParticleSystem();
    world.spriteParts = parts;
    const s1 = world.sprites[1];
    const s2 = world.sprites[2];
    if (s1 === undefined || s2 === undefined)
        throw new Error('sprite slots missing');
    s1.active = true;
    s1.deadMeat = false;
    s1.health = 150;
    s1.vest = 50;
    parts.posX[1] = 100;
    parts.posY[1] = 200;
    s2.active = true;
    s2.deadMeat = true;
    s2.health = 0;
    parts.posX[2] = 300;
    parts.posY[2] = 400;
    // sprite 3 stays inactive (default)
    const players = new Array(MAX_PLAYERS + 1).fill(undefined);
    players[1] = { name: 'Alice', team: 1, kills: 5, deaths: 1 };
    players[2] = { name: 'Bob', team: 2, kills: 2, deaths: 3 };
    const gameState = {
        players,
        currentMap: 'ctf_Ash',
        nextMap: 'ctf_Run',
        scoreLimit: 10,
        gameStyle: 2,
        tickThreshold: 60,
        teamScores: [0, 3, 4],
    };
    return { world, gameState };
}
describe('createScriptApi — ScriptPlayer reflects the live World', () => {
    it('reads sprite health/team/position through the wrapper', () => {
        const { world, gameState } = makeWorld();
        const api = createScriptApi(world, gameState);
        const p1 = api.Players.getById(1);
        expect(p1.id).toBe(1);
        expect(p1.active).toBe(true);
        expect(p1.name).toBe('Alice');
        expect(p1.team).toBe(1);
        expect(p1.alive).toBe(true);
        expect(p1.health).toBe(150);
        expect(p1.vest).toBe(50);
        expect(p1.kills).toBe(5);
        expect(p1.deaths).toBe(1);
        expect(p1.x).toBe(100);
        expect(p1.y).toBe(200);
        const p2 = api.Players.getById(2);
        expect(p2.alive).toBe(false); // deadMeat = true
        expect(p2.team).toBe(2);
    });
    it('reflects sim mutations live (no caching)', () => {
        const { world, gameState } = makeWorld();
        const api = createScriptApi(world, gameState);
        const p1 = api.Players.getById(1);
        const s1 = world.sprites[1];
        if (s1 === undefined)
            throw new Error('missing');
        s1.health = 42;
        expect(p1.health).toBe(42);
        if (world.spriteParts === null)
            throw new Error('missing parts');
        world.spriteParts.posX[1] = 999;
        expect(p1.x).toBe(999);
    });
    it('writes back to the World when set through the API', () => {
        const { world, gameState } = makeWorld();
        const api = createScriptApi(world, gameState);
        const p1 = api.Players.getById(1);
        p1.health = 75;
        expect(world.sprites[1]?.health).toBe(75);
        p1.vest = 10;
        expect(world.sprites[1]?.vest).toBe(10);
        // kills/team write back into GameState
        p1.kills = 99;
        expect(gameState.players?.[1]?.kills).toBe(99);
        p1.team = 3;
        expect(gameState.players?.[1]?.team).toBe(3);
    });
    it('returns a stable wrapper identity per id', () => {
        const { world, gameState } = makeWorld();
        const api = createScriptApi(world, gameState);
        expect(api.Players.getById(1)).toBe(api.Players.getById(1));
    });
    it('throws for out-of-range player ids', () => {
        const { world, gameState } = makeWorld();
        const api = createScriptApi(world, gameState);
        expect(() => api.Players.getById(0)).toThrow();
        expect(() => api.Players.getById(MAX_PLAYERS + 1)).toThrow();
    });
});
describe('createScriptApi — Players iteration skips inactive', () => {
    it('Active list contains only active sprites', () => {
        const { world, gameState } = makeWorld();
        const api = createScriptApi(world, gameState);
        const ids = api.Players.active.map((p) => p.id);
        expect(ids).toEqual([1, 2]); // sprite 3 inactive
    });
    it('is iterable over active players', () => {
        const { world, gameState } = makeWorld();
        const api = createScriptApi(world, gameState);
        const names = [...api.Players].map((p) => p.name);
        expect(names).toEqual(['Alice', 'Bob']);
    });
    it('Active list updates when a sprite deactivates', () => {
        const { world, gameState } = makeWorld();
        const api = createScriptApi(world, gameState);
        const s2 = world.sprites[2];
        if (s2 === undefined)
            throw new Error('missing');
        s2.active = false;
        expect(api.Players.active.map((p) => p.id)).toEqual([1]);
    });
    it('getByName finds active players only', () => {
        const { world, gameState } = makeWorld();
        const api = createScriptApi(world, gameState);
        expect(api.Players.getByName('Bob')?.id).toBe(2);
        expect(api.Players.getByName('Nobody')).toBeUndefined();
    });
});
describe('createScriptApi — Game / Map', () => {
    it('Game reads tick count, score limit, style, maps; tickThreshold writes back', () => {
        const { world, gameState } = makeWorld();
        world.mainTickCounter = 1234;
        const api = createScriptApi(world, gameState);
        expect(api.Game.tickCount).toBe(1234);
        expect(api.Game.scoreLimit).toBe(10);
        expect(api.Game.gameStyle).toBe(2);
        expect(api.Game.currentMap).toBe('ctf_Ash');
        expect(api.Game.nextMap).toBe('ctf_Run');
        expect(api.Game.tickThreshold).toBe(60);
        expect(api.Game.getTeamScore(1)).toBe(3);
        expect(api.Game.getTeamScore(2)).toBe(4);
        api.Game.tickThreshold = 30;
        expect(gameState.tickThreshold).toBe(30);
        api.Game.scoreLimit = 20;
        expect(gameState.scoreLimit).toBe(20);
    });
    it('Map exposes name; bounds default to zero with no PolyMap', () => {
        const { world, gameState } = makeWorld();
        const api = createScriptApi(world, gameState);
        expect(api.Map.name).toBe('ctf_Ash');
        expect(api.Map.bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
    });
    it('works with no GameState (neutral defaults)', () => {
        const world = createWorld();
        const s1 = world.sprites[1];
        if (s1 === undefined)
            throw new Error('missing');
        s1.active = true;
        s1.health = 100;
        const api = createScriptApi(world);
        const p1 = api.Players.getById(1);
        expect(p1.name).toBe('');
        expect(p1.team).toBe(0);
        expect(p1.health).toBe(100);
        expect(api.Game.currentMap).toBe('');
        expect(api.Game.tickThreshold).toBe(0);
    });
    it('returns frozen API objects', () => {
        const { world, gameState } = makeWorld();
        const api = createScriptApi(world, gameState);
        expect(Object.isFrozen(api)).toBe(true);
        expect(Object.isFrozen(api.Game)).toBe(true);
        expect(Object.isFrozen(api.Players)).toBe(true);
        expect(Object.isFrozen(api.Map)).toBe(true);
    });
});
//# sourceMappingURL=api.test.js.map