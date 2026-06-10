// Tweakable brain configs (goal node 170): resolveTweaks semantics, the
// pinned default configs (the no-tweak game must equal today's constants
// EXACTLY), and createEngine's tweak threading + classic fallback.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEngine, resolveTweaks } from './index';
import { CLASSIC_DEFAULTS } from './classic';
import { PILOT_DEFAULTS } from './pilot';
import { REAPER_DEFAULTS } from './reaper';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveTweaks', () => {
  it('returns an exact, independent copy of the defaults when tweaks are absent', () => {
    const defaults = { A: 1, B: -0.5 };
    for (const tweaks of [undefined, {}]) {
      const out = resolveTweaks('x', defaults, tweaks);
      expect(out).toEqual(defaults);
      expect(out).not.toBe(defaults);
    }
  });

  it('applies overrides without mutating the defaults', () => {
    const defaults = { A: 1, B: 2, C: 3 };
    const out = resolveTweaks('x', defaults, { A: 10, C: 30 });
    expect(out).toEqual({ A: 10, B: 2, C: 30 });
    expect(defaults).toEqual({ A: 1, B: 2, C: 3 });
  });

  it('ignores unknown keys with a single warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = resolveTweaks('pilot', { A: 1 }, { NOPE: 5 });
    expect(out).toEqual({ A: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("unknown tweak 'NOPE'");
  });

  it('ignores non-finite values with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = resolveTweaks('pilot', { A: 1, B: 2 }, { A: NaN, B: Infinity });
    expect(out).toEqual({ A: 1, B: 2 });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('default configs (pinned — defaults ARE the pre-tweak constants)', () => {
  it('PILOT_DEFAULTS', () => {
    expect(PILOT_DEFAULTS).toEqual({
      RANGE_MIN: 200,
      RANGE_MAX: 420,
      FIRE_MAX_DIST: 600,
      HEIGHT_EDGE_MIN: 50,
      HEIGHT_EDGE_MAX: 220,
      FUEL_RESERVE: 130,
      FUEL_COMMIT: 260,
      JUKE_MIN_TICKS: 18,
      JUKE_VAR_TICKS: 26,
      HUNT_MEMORY_TICKS: 240,
      BURST_PERIOD: 14,
      BURST_OPEN: 5,
      STALL_RISE_VY: -0.1,
      STALL_TRIGGER: 25,
      STALL_COOLDOWN: 180,
    });
  });

  it('REAPER_DEFAULTS', () => {
    expect(REAPER_DEFAULTS).toEqual({
      KILL_RANGE: 180,
      FIRE_RANGE: 460,
      DIVE_HEIGHT: 200,
      DIVE_ENTRY_DIST: 260,
      JITTER_MIN_TICKS: 12,
      JITTER_VAR_TICKS: 18,
      JITTER_ODDS: 3,
      FUEL_FLOOR: 60,
      HUNT_MEMORY_TICKS: 300,
      STALL_RISE_VY: -0.1,
      STALL_TRIGGER: 25,
      STALL_COOLDOWN: 150,
    });
  });

  it('CLASSIC_DEFAULTS', () => {
    expect(CLASSIC_DEFAULTS).toEqual({ ACCURACY: 9 });
  });
});

describe('createEngine tweak threading', () => {
  it('exposes the resolved full config as engine.tweaks (defaults when untweaked)', () => {
    expect(createEngine('pilot').tweaks).toEqual(PILOT_DEFAULTS);
  });

  it('applies overrides and keeps the rest at defaults', () => {
    const engine = createEngine('reaper', { KILL_RANGE: 220 });
    expect(engine.tweaks.KILL_RANGE).toBe(220);
    expect({ ...engine.tweaks, KILL_RANGE: 180 }).toEqual(REAPER_DEFAULTS);
  });

  it('unknown engine id falls back to classic (and warns on the unknown key)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = createEngine('definitely-not-real', { RANGE_MAX: 500 });
    expect(engine.id).toBe('classic');
    expect(engine.tweaks).toEqual(CLASSIC_DEFAULTS);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
