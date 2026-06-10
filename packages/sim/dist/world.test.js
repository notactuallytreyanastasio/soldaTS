/**
 * World invariants — array sizing, 1-based indexing, and sentinel-0.
 *
 * Caps are the OpenSoldat hard caps (Sprites.pas:19-22):
 *   MAX_SPRITES = MAX_PLAYERS = 32, MAX_BULLETS = 254, MAX_SPARKS = 558, MAX_THINGS = 90.
 * See docs/rewrite-reference/global-state-and-caps.md §2-3.
 */
import { describe, it, expect } from 'vitest';
import { MAX_SPRITES, MAX_BULLETS, MAX_SPARKS, MAX_THINGS } from './constants';
import { createWorld } from './world';
describe('createWorld array sizing (length = CAP + 1 for sentinel-0)', () => {
    const w = createWorld();
    it('matches the OpenSoldat hard caps', () => {
        expect(MAX_SPRITES).toBe(32); // PORT: Sprites.pas:19 (= MAX_PLAYERS)
        expect(MAX_BULLETS).toBe(254); // PORT: Sprites.pas:20
        expect(MAX_SPARKS).toBe(558); // PORT: Sprites.pas:21
        expect(MAX_THINGS).toBe(90); // PORT: Sprites.pas:22
    });
    it('allocates each array with length CAP + 1', () => {
        expect(w.sprites).toHaveLength(MAX_SPRITES + 1);
        expect(w.bullets).toHaveLength(MAX_BULLETS + 1);
        expect(w.sparks).toHaveLength(MAX_SPARKS + 1);
        expect(w.things).toHaveLength(MAX_THINGS + 1);
    });
    it('exposes the highest valid 1-based index and no index beyond it', () => {
        // Last valid slot exists...
        expect(w.sprites[MAX_SPRITES]).toBeDefined();
        expect(w.bullets[MAX_BULLETS]).toBeDefined();
        expect(w.sparks[MAX_SPARKS]).toBeDefined();
        expect(w.things[MAX_THINGS]).toBeDefined();
        // ...and one past the cap does not.
        expect(w.sprites[MAX_SPRITES + 1]).toBeUndefined();
        expect(w.bullets[MAX_BULLETS + 1]).toBeUndefined();
        expect(w.sparks[MAX_SPARKS + 1]).toBeUndefined();
        expect(w.things[MAX_THINGS + 1]).toBeUndefined();
    });
});
describe('sentinel-0 and slot initialization', () => {
    const w = createWorld();
    it('keeps index 0 present but inactive (the reserved sentinel)', () => {
        expect(w.sprites[0]?.active).toBe(false);
        expect(w.bullets[0]?.active).toBe(false);
        expect(w.sparks[0]?.active).toBe(false);
        expect(w.things[0]?.active).toBe(false);
    });
    it('initializes every slot (0..CAP) inactive', () => {
        expect(w.sprites.every((s) => s.active === false)).toBe(true);
        expect(w.bullets.every((b) => b.active === false)).toBe(true);
        expect(w.sparks.every((s) => s.active === false)).toBe(true);
        expect(w.things.every((t) => t.active === false)).toBe(true);
    });
    it('gives each slot an independent record (no aliasing)', () => {
        const s1 = w.sprites[1];
        const s2 = w.sprites[2];
        expect(s1).toBeDefined();
        expect(s2).toBeDefined();
        if (s1 && s2) {
            s1.active = true;
            expect(s2.active).toBe(false);
            expect(w.sprites[0]?.active).toBe(false);
        }
    });
});
describe('tick counters', () => {
    it('initializes all tick counters to zero', () => {
        const w = createWorld();
        expect(w.mainTickCounter).toBe(0); // PORT: Net.pas:817
        expect(w.serverTickCounter).toBe(0); // PORT: Net.pas:840
        expect(w.clientTickCount).toBe(0); // PORT: Net.pas:822
        expect(w.ticks).toBe(0); // PORT: Game.pas:31
    });
});
describe('embedded sub-arrays preserve 1-based indexing', () => {
    const w = createWorld();
    it('bullet.spriteCollisions covers sprites 1..32 with [0] unused', () => {
        // PORT: Bullets.pas:32 — Set of 1..32.
        expect(w.bullets[1]?.spriteCollisions).toHaveLength(MAX_SPRITES + 1);
    });
    it('thing.collideCount covers 1..4 with [0] unused', () => {
        // PORT: Things.pas:26 — array[1..4] of Byte.
        expect(w.things[1]?.collideCount).toHaveLength(5);
    });
});
//# sourceMappingURL=world.test.js.map