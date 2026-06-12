// Replay row builder + JSONL serializer (goal node 170).
import { describe, it, expect } from 'vitest';
import { ARENA_SPAWNS, Game, buildArena, nearestBulletThreat, } from '@soldat/client/headless';
import { buildReplayRow, rowsToJsonl } from './replay';
function tinyGame() {
    const game = new Game({
        seed: 2,
        spawns: ARENA_SPAWNS,
        botCount: 2,
        spectate: true,
        aiEngine: 'pilot,reaper',
        teams: true,
    });
    game.loadMap(buildArena());
    return game;
}
describe('buildReplayRow', () => {
    it('captures every field with correct types and rounding', () => {
        const game = tinyGame();
        for (let t = 0; t < 50; t++)
            game.tick(1 / 60);
        const bot = game.botIndices()[0];
        const row = buildReplayRow(game, bot, game.world.mainTickCounter);
        expect(row).not.toBeNull();
        const r = row;
        expect(r.tick).toBe(game.world.mainTickCounter);
        expect(r.bot).toBe(bot);
        expect([1, 2]).toContain(r.team);
        expect(r.engine).toBe(game.engineOf(bot));
        // 2-decimal kinematics: re-rounding is the identity.
        for (const v of [r.x, r.y, r.vx, r.vy]) {
            expect(v).toBe(Number(v.toFixed(2)));
        }
        expect(r.hp).toBe(Number(r.hp.toFixed(1)));
        expect(Number.isFinite(r.fuel)).toBe(true);
        expect(Number.isInteger(r.ammo)).toBe(true);
        expect(typeof r.reloading).toBe('boolean');
        expect(typeof r.onGround).toBe('boolean');
        // v2 fields: weapon label, spray heat (4 decimals), threat present flag.
        expect(r.weapon).toBe(game.weaponNameOf(bot));
        expect(r.heat).toBe(Number(r.heat.toFixed(4)));
        expect(r.heat).toBeGreaterThanOrEqual(0);
        expect(typeof r.btt).toBe('boolean');
        if (r.btt) {
            for (const v of [r.btx, r.bty, r.btvx, r.btvy]) {
                expect(v).toBe(Number(v.toFixed(2)));
            }
        }
        else {
            expect(r.btx).toBeUndefined();
        }
        expect(Object.keys(r.control)).toEqual([
            'left', 'right', 'up', 'down', 'fire', 'jetpack', 'reload', 'aimX', 'aimY',
        ]);
        expect(Number.isFinite(r.control.aimX)).toBe(true);
    });
    it('logs the nearest bullet threat once bullets fly (and it matches the runtime scan)', () => {
        const game = tinyGame();
        // Run until some row carries a threat — two hostile bots trade fire well
        // within 600 ticks.
        let threatRow = null;
        for (let t = 0; t < 600 && threatRow === null; t++) {
            game.tick(1 / 60);
            for (const i of game.botIndices()) {
                const row = buildReplayRow(game, i, game.world.mainTickCounter);
                if (row !== null && row.btt) {
                    threatRow = row;
                    break;
                }
            }
        }
        expect(threatRow).not.toBeNull();
        const r = threatRow;
        // The logged winner re-derives the exact BulletThreat the runtime scan
        // (nearestBulletThreat over all live bullets) would produce — the
        // single-winner identity that makes schema v2 lossless for training.
        const single = nearestBulletThreat([
            { rx: r.btx, ry: r.bty, vx: r.btvx, vy: r.btvy },
        ]);
        expect(single).not.toBeNull();
        expect(Math.hypot(single.dx - r.btx, single.dy - r.bty)).toBe(0);
    });
    it('returns null for dead or inactive sprites', () => {
        const game = tinyGame();
        const bot = game.botIndices()[0];
        game.world.sprites[bot].deadMeat = true;
        expect(buildReplayRow(game, bot, 0)).toBeNull();
        // Slot 1 (the never-spawned spectate player) is inactive.
        expect(buildReplayRow(game, game.playerIndex, 0)).toBeNull();
    });
});
describe('rowsToJsonl', () => {
    it('one JSON line per row plus a trailing newline; empty → empty string', () => {
        const game = tinyGame();
        const rows = game
            .botIndices()
            .map((i) => buildReplayRow(game, i, 0))
            .filter((r) => r !== null);
        expect(rows.length).toBeGreaterThan(0);
        const jsonl = rowsToJsonl(rows);
        expect(jsonl.endsWith('\n')).toBe(true);
        const lines = jsonl.trimEnd().split('\n');
        expect(lines).toHaveLength(rows.length);
        expect(lines.map((l) => JSON.parse(l))).toEqual(rows);
        expect(rowsToJsonl([])).toBe('');
    });
});
//# sourceMappingURL=replay.test.js.map