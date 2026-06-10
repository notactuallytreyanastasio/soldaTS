/**
 * Tests for game-mode logic and scoring (Track A / M7).
 *
 * Builds worlds via createWorld + synthetic sprites/things, exercises the
 * per-mode kill scoring, CTF flag touchdown, team-mode scoring split, and
 * win/round-end detection on score & time limits.
 */
import { describe, it, expect } from 'vitest';
import { createWorld } from '../world';
import { ParticleSystem } from '../physics/particles';
import { GameStyle, Team, ObjectStyle } from '../constants';
import { createGameState, updateGameMode, onKill, onFlagCapture, TOUCHDOWN_RADIUS, } from './gamemode';
// Place a thing's skeleton Pos[1] inside world.thingParts (stride of 4).
function setFlagPos(world, thingIndex, x, y) {
    const parts = world.thingParts;
    const id = (thingIndex - 1) * 4 + 1;
    parts.posX[id] = x;
    parts.posY[id] = y;
}
function makeWorld() {
    const world = createWorld();
    world.thingParts = new ParticleSystem();
    return world;
}
describe('Deathmatch scoring', () => {
    it('a kill increments the killer score, not the victim', () => {
        const state = createGameState(GameStyle.DEATHMATCH, { scoreLimit: 10 });
        onKill(state, 1, 2);
        expect(state.playerScores[1]).toBe(1);
        expect(state.playerScores[2]).toBe(0);
        expect(state.playerDeaths[2]).toBe(1);
    });
    it('self-kill does not score but does count a death', () => {
        const state = createGameState(GameStyle.DEATHMATCH, { scoreLimit: 10 });
        onKill(state, 1, 1);
        expect(state.playerScores[1]).toBe(0);
    });
    it('reaching the score limit ends the round', () => {
        const world = makeWorld();
        const state = createGameState(GameStyle.DEATHMATCH, { scoreLimit: 3 });
        onKill(state, 1, 2);
        onKill(state, 1, 2);
        updateGameMode(world, state);
        expect(state.roundEnded).toBe(false);
        onKill(state, 1, 2);
        updateGameMode(world, state);
        expect(state.playerScores[1]).toBe(3);
        expect(state.roundEnded).toBe(true);
    });
});
describe('Pointmatch scoring', () => {
    it('flag-holding doubles the kill point', () => {
        const state = createGameState(GameStyle.POINTMATCH, { scoreLimit: 50 });
        onKill(state, 1, 2, /* holdingPointmatchFlag */ true);
        expect(state.playerScores[1]).toBe(2);
    });
});
describe('TeamMatch scoring', () => {
    it('splits scoring: cross-team kill awards player and team', () => {
        const state = createGameState(GameStyle.TEAMMATCH, { scoreLimit: 10 });
        state.playerTeams[1] = Team.ALPHA;
        state.playerTeams[2] = Team.BRAVO;
        onKill(state, 1, 2);
        expect(state.playerScores[1]).toBe(1);
        expect(state.teamScores[Team.ALPHA]).toBe(1);
        expect(state.teamScores[Team.BRAVO]).toBe(0);
    });
    it('same-team kill does not award team score', () => {
        const state = createGameState(GameStyle.TEAMMATCH, { scoreLimit: 10 });
        state.playerTeams[1] = Team.ALPHA;
        state.playerTeams[2] = Team.ALPHA;
        onKill(state, 1, 2);
        expect(state.playerScores[1]).toBe(0);
        expect(state.teamScores[Team.ALPHA]).toBe(0);
    });
    it('team score limit ends the round', () => {
        const world = makeWorld();
        const state = createGameState(GameStyle.TEAMMATCH, { scoreLimit: 2 });
        state.playerTeams[1] = Team.ALPHA;
        state.playerTeams[2] = Team.BRAVO;
        onKill(state, 1, 2);
        updateGameMode(world, state);
        expect(state.roundEnded).toBe(false);
        onKill(state, 1, 2);
        updateGameMode(world, state);
        expect(state.teamScores[Team.ALPHA]).toBe(2);
        expect(state.roundEnded).toBe(true);
    });
});
describe('CTF flag capture', () => {
    function setupCtf() {
        const world = makeWorld();
        const state = createGameState(GameStyle.CTF, { scoreLimit: 5 });
        // Alpha home flag (thing 1) at origin, in base, not held.
        const alphaFlag = world.things[1];
        alphaFlag.active = true;
        alphaFlag.style = ObjectStyle.ALPHA_FLAG;
        alphaFlag.inBase = true;
        alphaFlag.holdingSprite = 0;
        setFlagPos(world, 1, 100, 100);
        // Bravo flag (thing 2), carried by an Alpha player (sprite 1).
        const bravoFlag = world.things[2];
        bravoFlag.active = true;
        bravoFlag.style = ObjectStyle.BRAVO_FLAG;
        bravoFlag.inBase = false;
        bravoFlag.holdingSprite = 1;
        state.playerTeams[1] = Team.ALPHA;
        return { world, state };
    }
    it('carrying the enemy flag into your base (near your in-base flag) scores', () => {
        const { world, state } = setupCtf();
        // Bravo flag right on top of the Alpha home flag → within radius.
        setFlagPos(world, 2, 100 + TOUCHDOWN_RADIUS - 1, 100);
        updateGameMode(world, state);
        expect(state.teamScores[Team.ALPHA]).toBe(1);
        expect(state.playerFlags[1]).toBe(1);
    });
    it('no capture when the flags are far apart', () => {
        const { world, state } = setupCtf();
        setFlagPos(world, 2, 100 + TOUCHDOWN_RADIUS + 50, 100);
        updateGameMode(world, state);
        expect(state.teamScores[Team.ALPHA]).toBe(0);
        expect(state.playerFlags[1]).toBe(0);
    });
    it('reaching the team score limit via captures ends the round', () => {
        const world = makeWorld();
        const state = createGameState(GameStyle.CTF, { scoreLimit: 2 });
        onFlagCapture(state, Team.BRAVO, 3);
        updateGameMode(world, state);
        expect(state.roundEnded).toBe(false);
        onFlagCapture(state, Team.BRAVO, 3);
        updateGameMode(world, state);
        expect(state.teamScores[Team.BRAVO]).toBe(2);
        expect(state.roundEnded).toBe(true);
    });
});
describe('onFlagCapture hook', () => {
    it('increments the team score and capturer flag count', () => {
        const state = createGameState(GameStyle.CTF, { scoreLimit: 5 });
        onFlagCapture(state, Team.ALPHA, 4);
        expect(state.teamScores[Team.ALPHA]).toBe(1);
        expect(state.playerFlags[4]).toBe(1);
    });
});
describe('time limit', () => {
    it('counts mapTimeLeft down and ends the round at zero', () => {
        const world = makeWorld();
        const state = createGameState(GameStyle.DEATHMATCH, { timeLimit: 2 });
        expect(state.mapTimeLeft).toBe(2);
        updateGameMode(world, state);
        expect(state.mapTimeLeft).toBe(1);
        expect(state.roundEnded).toBe(false);
        updateGameMode(world, state);
        expect(state.mapTimeLeft).toBe(0);
        expect(state.roundEnded).toBe(true);
    });
});
//# sourceMappingURL=gamemode.test.js.map