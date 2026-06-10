import { describe, it, expect, vi } from 'vitest';
import { createWorld } from '@soldat/sim';
import { ScriptHost } from './host.js';
import { createScriptApi } from './api.js';
import { createDoubleDamageMod } from './sample-mod.js';
// --- Test helpers ------------------------------------------------------------
function makePlayer(id, name = `p${id}`) {
    return {
        id,
        name,
        health: 150,
        team: 1,
        active: true,
        alive: true,
        vest: 0,
        kills: 0,
        deaths: 0,
        x: 0,
        y: 0,
    };
}
/** Build a real ScriptApi over a World (the host treats it as opaque). */
function makeApi(world) {
    return createScriptApi(world);
}
describe('ScriptHost dispatch', () => {
    it('fires void handlers in registration order across mods', () => {
        const host = new ScriptHost();
        const order = [];
        const api = makeApi(createWorld());
        host.loadMod((ctx) => {
            ctx.on('OnClockTick', () => order.push('A'));
        }, api, 'modA');
        host.loadMod((ctx) => {
            ctx.on('OnClockTick', () => order.push('B'));
        }, api, 'modB');
        host.loadMod((ctx) => {
            ctx.on('OnClockTick', () => order.push('C'));
        }, api, 'modC');
        host.dispatch('OnClockTick', 42);
        expect(order).toEqual(['A', 'B', 'C']);
    });
    it('a throwing handler is logged + skipped; later handlers still run; host survives', () => {
        const errors = [];
        const host = new ScriptHost((info) => errors.push(info));
        const api = makeApi(createWorld());
        const order = [];
        host.loadMod((ctx) => {
            ctx.on('OnClockTick', () => order.push('before'));
        }, api, 'good1');
        host.loadMod((ctx) => {
            ctx.on('OnClockTick', () => {
                throw new Error('boom');
            });
        }, api, 'bad');
        host.loadMod((ctx) => {
            ctx.on('OnClockTick', () => order.push('after'));
        }, api, 'good2');
        // Dispatch must NOT throw even though a handler does.
        expect(() => host.dispatch('OnClockTick', 1)).not.toThrow();
        // Both surviving handlers ran, in order, around the failure.
        expect(order).toEqual(['before', 'after']);
        // The failure was reported via the onError hook exactly once.
        expect(errors).toHaveLength(1);
        expect(errors[0]?.event).toBe('OnClockTick');
        expect(errors[0]?.modName).toBe('bad');
        expect(errors[0]?.error).toBeInstanceOf(Error);
        // Host is still usable for subsequent dispatches.
        order.length = 0;
        host.dispatch('OnClockTick', 2);
        expect(order).toEqual(['before', 'after']);
    });
    it('default onError logs to console.error and does not rethrow', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
        const host = new ScriptHost();
        const api = makeApi(createWorld());
        host.loadMod((ctx) => {
            ctx.on('OnClockTick', () => {
                throw new Error('nope');
            });
        }, api, 'crasher');
        expect(() => host.dispatch('OnClockTick', 0)).not.toThrow();
        expect(spy).toHaveBeenCalledOnce();
        spy.mockRestore();
    });
    it('a mod that throws during registration does not abort other mods', () => {
        const errors = [];
        const host = new ScriptHost((info) => errors.push(info));
        const api = makeApi(createWorld());
        const order = [];
        host.loadMod(() => {
            throw new Error('registration failed');
        }, api, 'brokenLoader');
        host.loadMod((ctx) => {
            ctx.on('OnClockTick', () => order.push('survivor'));
        }, api, 'healthy');
        host.dispatch('OnClockTick', 0);
        expect(order).toEqual(['survivor']);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.modName).toBe('brokenLoader');
    });
});
describe('ScriptHost OnPlayerDamage cascade', () => {
    it('threads the modified damage through multiple handlers in order', () => {
        const host = new ScriptHost();
        const api = makeApi(createWorld());
        host.loadMod((ctx) => {
            // +10 flat
            ctx.on('OnPlayerDamage', (_v, _s, dmg) => dmg + 10);
        }, api, 'flat');
        host.loadMod((ctx) => {
            // x3
            ctx.on('OnPlayerDamage', (_v, _s, dmg) => dmg * 3);
        }, api, 'triple');
        // (5 + 10) * 3 = 45
        const result = host.dispatchPlayerDamage(makePlayer(1), makePlayer(2), 5);
        expect(result).toBe(45);
    });
    it('a throwing cascade handler keeps the last good damage and continues', () => {
        const errors = [];
        const host = new ScriptHost((info) => errors.push(info));
        const api = makeApi(createWorld());
        host.loadMod((ctx) => {
            ctx.on('OnPlayerDamage', (_v, _s, dmg) => dmg + 100); // -> 110
        }, api, 'add');
        host.loadMod((ctx) => {
            ctx.on('OnPlayerDamage', () => {
                throw new Error('cascade boom');
            });
        }, api, 'bad');
        host.loadMod((ctx) => {
            ctx.on('OnPlayerDamage', (_v, _s, dmg) => dmg * 2); // -> 220
        }, api, 'double');
        const result = host.dispatchPlayerDamage(makePlayer(1), makePlayer(2), 10);
        expect(result).toBe(220);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.event).toBe('OnPlayerDamage');
        expect(errors[0]?.modName).toBe('bad');
    });
    it('a non-number cascade return is ignored (damage carries forward)', () => {
        const host = new ScriptHost();
        const api = makeApi(createWorld());
        host.loadMod((ctx) => {
            // Misbehaving handler returns a non-number; host must ignore it.
            ctx.on('OnPlayerDamage', (() => 'oops'));
        }, api, 'bogus');
        host.loadMod((ctx) => {
            ctx.on('OnPlayerDamage', (_v, _s, dmg) => dmg + 1);
        }, api, 'inc');
        const result = host.dispatchPlayerDamage(makePlayer(1), makePlayer(2), 7);
        expect(result).toBe(8); // 7 (bogus ignored) -> 8
    });
    it('returns the input damage unchanged when no handlers are registered', () => {
        const host = new ScriptHost();
        expect(host.dispatchPlayerDamage(makePlayer(1), makePlayer(2), 99)).toBe(99);
    });
});
describe('sample mod', () => {
    it('runs against a createScriptApi-shaped world: doubles damage and welcomes joiners', () => {
        const host = new ScriptHost();
        const world = createWorld();
        const api = makeApi(world);
        const log = { welcomed: [] };
        host.loadMod(createDoubleDamageMod(log), api);
        // OnJoin side-effect.
        host.dispatch('OnJoin', makePlayer(3, 'Alice'), 1);
        host.dispatch('OnJoin', makePlayer(4, 'Bob'), 2);
        expect(log.welcomed).toEqual(['Alice', 'Bob']);
        // OnPlayerDamage cascade: damage doubled between distinct players...
        expect(host.dispatchPlayerDamage(makePlayer(1), makePlayer(2), 25)).toBe(50);
        // ...but self-damage is left untouched.
        const p = makePlayer(1);
        expect(host.dispatchPlayerDamage(p, p, 25)).toBe(25);
    });
    it('composes with another mod in the cascade (registration order matters)', () => {
        const host = new ScriptHost();
        const api = makeApi(createWorld());
        // double-damage first, then a +5 mod.
        host.loadMod(createDoubleDamageMod({ welcomed: [] }), api);
        host.loadMod((ctx) => {
            ctx.on('OnPlayerDamage', (_v, _s, dmg) => dmg + 5);
        }, api, 'plusFive');
        // (10 * 2) + 5 = 25
        expect(host.dispatchPlayerDamage(makePlayer(1), makePlayer(2), 10)).toBe(25);
    });
});
//# sourceMappingURL=host.test.js.map