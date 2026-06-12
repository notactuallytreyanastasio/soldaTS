import { describe, it, expect } from 'vitest';
import { createWorld } from '@soldat/sim';
import type { World } from '@soldat/sim';

import { ScriptHost } from './host.js';
import { createScriptApi } from './api.js';
import type { ScriptApi, ScriptPlayer } from './api.js';
import {
  createDoubleDamageMod,
  sampleMod,
  sampleModLog,
  type SampleModLog,
} from './sample-mod.js';

// --- Test helpers ------------------------------------------------------------

function makePlayer(id: number, name = `p${id}`): ScriptPlayer {
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

function makeApi(world: World): ScriptApi {
  return createScriptApi(world);
}

describe('createDoubleDamageMod — multiplier parameter', () => {
  it('multiplier=3 triples damage between distinct players', () => {
    const host = new ScriptHost();
    host.loadMod(createDoubleDamageMod({ welcomed: [] }, 3), makeApi(createWorld()));

    expect(host.dispatchPlayerDamage(makePlayer(1), makePlayer(2), 10)).toBe(30);
  });

  it('multiplier=1 leaves damage unchanged', () => {
    const host = new ScriptHost();
    host.loadMod(createDoubleDamageMod({ welcomed: [] }, 1), makeApi(createWorld()));

    expect(host.dispatchPlayerDamage(makePlayer(1), makePlayer(2), 37)).toBe(37);
  });

  it('defaults to double damage when no multiplier is given', () => {
    const host = new ScriptHost();
    host.loadMod(createDoubleDamageMod({ welcomed: [] }), makeApi(createWorld()));

    expect(host.dispatchPlayerDamage(makePlayer(1), makePlayer(2), 21)).toBe(42);
  });

  it('multiplier=0 zeroes out damage (degenerate but allowed)', () => {
    const host = new ScriptHost();
    host.loadMod(createDoubleDamageMod({ welcomed: [] }, 0), makeApi(createWorld()));

    expect(host.dispatchPlayerDamage(makePlayer(1), makePlayer(2), 99)).toBe(0);
  });
});

describe('createDoubleDamageMod — self-damage immunity', () => {
  it('victim.id === shooter.id bypasses the multiplier regardless of its value', () => {
    const host = new ScriptHost();
    host.loadMod(createDoubleDamageMod({ welcomed: [] }, 10), makeApi(createWorld()));

    const self = makePlayer(7);
    expect(host.dispatchPlayerDamage(self, self, 13)).toBe(13);
  });

  it('keys off id, not object identity — two distinct objects with the same id count as self', () => {
    const host = new ScriptHost();
    host.loadMod(createDoubleDamageMod({ welcomed: [] }, 5), makeApi(createWorld()));

    // Same id, different ScriptPlayer instances (the api hands out fresh wrappers).
    expect(host.dispatchPlayerDamage(makePlayer(3, 'a'), makePlayer(3, 'b'), 8)).toBe(8);
  });
});

describe('createDoubleDamageMod — OnJoin log behavior', () => {
  it('appends to the log each time the handler fires on the same mod instance', () => {
    const host = new ScriptHost();
    const log: SampleModLog = { welcomed: [] };
    host.loadMod(createDoubleDamageMod(log), makeApi(createWorld()));

    host.dispatch('OnJoin', makePlayer(1, 'Alice'), 1);
    host.dispatch('OnJoin', makePlayer(2, 'Bob'), 2);
    host.dispatch('OnJoin', makePlayer(1, 'Alice'), 1); // re-join: appended again, no dedupe

    expect(log.welcomed).toEqual(['Alice', 'Bob', 'Alice']);
  });

  it('a no-arg factory gets a fresh default log, independent of the exported singleton log', () => {
    // The default parameter `log = { welcomed: [] }` evaluates per CALL: a
    // factory created without arguments must NOT write into sampleModLog
    // (the module-level singleton) or into any other call's default log.
    const host = new ScriptHost();
    host.loadMod(createDoubleDamageMod(), makeApi(createWorld()));

    const singletonBefore = sampleModLog.welcomed.length;
    host.dispatch('OnJoin', makePlayer(1, 'DefaultLogJoiner'), 1);

    // The join was swallowed by the factory's own private default log —
    // the exported singleton log is untouched.
    expect(sampleModLog.welcomed.length).toBe(singletonBefore);
    expect(sampleModLog.welcomed).not.toContain('DefaultLogJoiner');
  });

  it('two explicit empty-log objects passed separately never alias each other', () => {
    // Guard against a refactor moving the default to a shared module constant:
    // callers handing in their own `{ welcomed: [] }` must keep distinct sinks.
    const logA: SampleModLog = { welcomed: [] };
    const logB: SampleModLog = { welcomed: [] };
    const host = new ScriptHost();
    const api = makeApi(createWorld());
    host.loadMod(createDoubleDamageMod(logA), api, 'a');
    host.loadMod(createDoubleDamageMod(logB), api, 'b');

    logA.welcomed.push('preexisting');
    host.dispatch('OnJoin', makePlayer(1, 'Dana'), 1);

    expect(logA.welcomed).toEqual(['preexisting', 'Dana']);
    expect(logB.welcomed).toEqual(['Dana']);
  });

  it('multiple mod instances with separate explicit logs do not interfere', () => {
    const host = new ScriptHost();
    const api = makeApi(createWorld());
    const logA: SampleModLog = { welcomed: [] };
    const logB: SampleModLog = { welcomed: [] };

    host.loadMod(createDoubleDamageMod(logA), api, 'modA');
    host.loadMod(createDoubleDamageMod(logB), api, 'modB');

    host.dispatch('OnJoin', makePlayer(1, 'Carol'), 1);

    // Both mods see the broadcast, but each writes only to its OWN log.
    expect(logA.welcomed).toEqual(['Carol']);
    expect(logB.welcomed).toEqual(['Carol']);
    expect(logA.welcomed).not.toBe(logB.welcomed);

    // Mutating one log never reaches the other.
    logA.welcomed.length = 0;
    expect(logB.welcomed).toEqual(['Carol']);
  });

  it('reusing one factory across hosts shares its captured log (closure semantics)', () => {
    const log: SampleModLog = { welcomed: [] };
    const factory = createDoubleDamageMod(log);
    const api = makeApi(createWorld());

    const host1 = new ScriptHost();
    const host2 = new ScriptHost();
    host1.loadMod(factory, api);
    host2.loadMod(factory, api);

    host1.dispatch('OnJoin', makePlayer(1, 'FromHost1'), 1);
    host2.dispatch('OnJoin', makePlayer(2, 'FromHost2'), 1);

    // One closure, one log — both hosts append to the same sink.
    expect(log.welcomed).toEqual(['FromHost1', 'FromHost2']);
  });
});

describe('exported singleton sampleMod / sampleModLog', () => {
  // SUSPECT BEHAVIOR (reviewer finding, confirmed): sampleMod and sampleModLog
  // are pre-initialized module-level singletons. Every host that loads
  // `sampleMod` appends joins into the SAME shared `sampleModLog.welcomed`
  // array, so state leaks across hosts/tests that reuse the export. These
  // tests pin the ACTUAL current behavior; they deliberately measure deltas
  // (not absolute contents) so they stay order-independent.

  it('sampleMod writes into the shared module-level sampleModLog', () => {
    const host = new ScriptHost();
    host.loadMod(sampleMod, makeApi(createWorld()));

    const before = sampleModLog.welcomed.length;
    host.dispatch('OnJoin', makePlayer(9, 'SingletonJoiner'), 1);

    expect(sampleModLog.welcomed.length).toBe(before + 1);
    expect(sampleModLog.welcomed[sampleModLog.welcomed.length - 1]).toBe('SingletonJoiner');
  });

  it('state pollutes ACROSS independent hosts loading the same singleton export', () => {
    const hostA = new ScriptHost();
    const hostB = new ScriptHost();
    const api = makeApi(createWorld());
    hostA.loadMod(sampleMod, api);
    hostB.loadMod(sampleMod, api);

    const before = sampleModLog.welcomed.length;
    hostA.dispatch('OnJoin', makePlayer(1, 'ViaA'), 1);
    hostB.dispatch('OnJoin', makePlayer(2, 'ViaB'), 1);

    // Both hosts wrote into ONE shared log — this is the pollution hazard.
    expect(sampleModLog.welcomed.length).toBe(before + 2);
    expect(sampleModLog.welcomed.slice(before)).toEqual(['ViaA', 'ViaB']);
  });

  it('sampleMod uses the default x2 multiplier', () => {
    const host = new ScriptHost();
    host.loadMod(sampleMod, makeApi(createWorld()));

    expect(host.dispatchPlayerDamage(makePlayer(1), makePlayer(2), 15)).toBe(30);
  });
});
