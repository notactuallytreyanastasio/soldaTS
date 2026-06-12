import { describe, it, expect } from 'vitest';

// The barrel module is pure re-exports; these tests pin the public surface so
// an accidental removal from index.ts breaks loudly instead of at a consumer.
import * as modding from './index.js';

describe('@soldat/modding barrel exports', () => {
  it('re-exports the event catalogue from ./events', () => {
    expect(modding.MOD_EVENT_CASCADE).toBeTypeOf('object');
    expect(modding.MOD_EVENT_NAMES).toBeInstanceOf(Array);
    expect(modding.MOD_EVENT_NAMES).toEqual(Object.keys(modding.MOD_EVENT_CASCADE));
  });

  it('re-exports the host from ./host', () => {
    expect(modding.ScriptHost).toBeTypeOf('function');
    const host = new modding.ScriptHost();
    expect(host.handlerCount('OnClockTick')).toBe(0);
  });

  it('re-exports the api factory from ./api', () => {
    expect(modding.createScriptApi).toBeTypeOf('function');
  });

  it('re-exports the sample mod from ./sample-mod', () => {
    expect(modding.createDoubleDamageMod).toBeTypeOf('function');
    expect(modding.sampleMod).toBeTypeOf('function');
    expect(modding.sampleModLog).toBeTypeOf('object');
    expect(Array.isArray(modding.sampleModLog.welcomed)).toBe(true);
  });

  it('barrel exports are the SAME bindings as the source modules (no duplication)', async () => {
    const events = await import('./events.js');
    const host = await import('./host.js');
    const api = await import('./api.js');
    const sample = await import('./sample-mod.js');

    expect(modding.MOD_EVENT_CASCADE).toBe(events.MOD_EVENT_CASCADE);
    expect(modding.MOD_EVENT_NAMES).toBe(events.MOD_EVENT_NAMES);
    expect(modding.ScriptHost).toBe(host.ScriptHost);
    expect(modding.createScriptApi).toBe(api.createScriptApi);
    expect(modding.createDoubleDamageMod).toBe(sample.createDoubleDamageMod);
    expect(modding.sampleMod).toBe(sample.sampleMod);
    expect(modding.sampleModLog).toBe(sample.sampleModLog);
  });
});
