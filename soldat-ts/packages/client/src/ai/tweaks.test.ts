// Tweakable brain configs (goal node 170): resolveTweaks semantics, the
// pinned default configs (the no-tweak game must equal today's constants
// EXACTLY), and createEngine's tweak threading + classic fallback.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEngine, resolveTweaks } from './index';
import { CLASSIC_DEFAULTS } from './classic';
import { PILOT_DEFAULTS } from './pilot';
import { REAPER_DEFAULTS } from './reaper';
import { MATADOR_DEFAULTS } from './matador';
import { KESTREL_DEFAULTS } from './kestrel';
import { WOLF_DEFAULTS } from './wolf';
import { PLOVER_DEFAULTS } from './plover';
import { HYDRA_DEFAULTS } from './hydra';
import { SHRIKE_DEFAULTS } from './shrike';
import { NEURAL_DEFAULTS } from './neural';

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

  it('MATADOR_DEFAULTS', () => {
    expect(MATADOR_DEFAULTS).toEqual({
      POKE_MIN: 380,
      POKE_MAX: 520,
      FIRE_MAX_DIST: 620,
      AUTO_RANGE: 230,
      WINDOW_AUTO: 620,
      PUNISH_RANGE: 120,
      LOW_MAG_OPEN: 4,
      WINDOW_HUNT: 760,
      STALK_MAG: 11,
      STALK_DIST: 250,
      SELF_RELOAD_AT: 9,
      VEL_EMA: 1,
      LEVEL_BAND: 50,
      HEIGHT_CAP: 200,
      FUEL_RESERVE: 110,
      FUEL_PUNISH_MIN: 40,
      JUKE_MIN_TICKS: 14,
      JUKE_VAR_TICKS: 22,
      BURST_PERIOD: 6,
      BURST_OPEN: 1,
      HUNT_MEMORY_TICKS: 240,
      STALL_RISE_VY: -0.1,
      STALL_TRIGGER: 25,
      STALL_COOLDOWN: 180,
    });
  });

  it('KESTREL_DEFAULTS', () => {
    expect(KESTREL_DEFAULTS).toEqual({
      BAND_MIN: 240,
      BAND_MAX: 430,
      FIRE_MAX_DIST: 600,
      APPROACH_FIRE_DIST: 460,
      KNIFE_DIST: 170,
      TAP_PERIOD: 7,
      TAP_OPEN: 2,
      EMA_ALPHA: 0.15,
      DROP_G: 0.135,
      BOB_UP_TICKS: 12,
      BOB_DOWN_MIN: 18,
      BOB_DOWN_VAR: 14,
      DODGE_HORIZON: 26,
      DANGER_RADIUS: 56,
      DODGE_COMMIT: 6,
      HEIGHT_SLACK: 110,
      FUEL_FLOOR: 80,
      RELOAD_LOW: 6,
      HUNT_MEMORY_TICKS: 240,
      STALL_RISE_VY: -0.1,
      STALL_TRIGGER: 25,
      STALL_COOLDOWN: 180,
    });
  });

  it('WOLF_DEFAULTS', () => {
    expect(WOLF_DEFAULTS).toEqual({
      PACK_RANGE: 360,
      HIGH_OFF: 200,
      COHESION_DIST: 380,
      PREY_RETARGET: 45,
      PREY_RADIUS: 550,
      JUKE_MIN_TICKS: 14,
      JUKE_VAR_TICKS: 22,
      X_SLACK: 40,
      LEVEL_BAND: 50,
      AUTO_RANGE: 240,
      TAP_PERIOD: 6,
      TAP_OPEN: 1,
      FIRE_MAX_DIST: 620,
      SELF_RELOAD_AT: 8,
      FUEL_RESERVE: 100,
      HUNT_MEMORY_TICKS: 240,
      STALL_RISE_VY: -0.1,
      STALL_TRIGGER: 25,
      STALL_COOLDOWN: 180,
    });
  });

  it('PLOVER_DEFAULTS', () => {
    expect(PLOVER_DEFAULTS).toEqual({
      BAIT_HP_ON: 95,
      BAIT_NEAR: 420,
      BAIT_FAR: 560,
      ORBIT_MIN: 220,
      ORBIT_MAX: 420,
      BAIT_STUCK_TICKS: 30,
      BAIT_FLIP_TICKS: 70,
      HUNT_BAND_MIN: 340,
      HUNT_BAND_MAX: 480,
      APPROACH_FIRE_DIST: 500,
      FIRE_MAX_DIST: 620,
      FOCUS_RETARGET: 30,
      TAP_PERIOD: 6,
      TAP_OPEN: 1,
      EMA_ALPHA: 0.15,
      DROP_G: 0.135,
      BOB_UP_TICKS: 12,
      BOB_DOWN_MIN: 18,
      BOB_DOWN_VAR: 14,
      DODGE_HORIZON: 26,
      DANGER_RADIUS: 56,
      DODGE_COMMIT: 6,
      HEIGHT_SLACK: 110,
      FUEL_FLOOR: 80,
      RELOAD_LOW: 6,
      HUNT_MEMORY_TICKS: 240,
      STALL_RISE_VY: -0.1,
      STALL_TRIGGER: 25,
      STALL_COOLDOWN: 180,
    });
  });

  it('HYDRA_DEFAULTS', () => {
    expect(HYDRA_DEFAULTS).toEqual({
      ROTATE_BELOW: 55,
      ANCHOR_MIN: 600,
      ANCHOR_MAX: 760,
      ANCHOR_FIRE_MAX: 700,
      ANCHOR_STUCK_TICKS: 30,
      BEARING_OFF: 340,
      HIGH_OFF: 0,
      X_SLACK: 40,
      GIVE_GROUND: 240,
      KNIFE_DIST: 170,
      FIRE_MAX_DIST: 620,
      APPROACH_FIRE_DIST: 620,
      FOCUS_RETARGET: 30,
      TAP_PERIOD: 6,
      TAP_OPEN: 1,
      EMA_ALPHA: 0.15,
      DROP_G: 0.135,
      JUKE_MIN_TICKS: 0,
      JUKE_VAR_TICKS: 22,
      BOB_UP_TICKS: 12,
      BOB_DOWN_MIN: 18,
      BOB_DOWN_VAR: 14,
      DODGE_HORIZON: 26,
      DANGER_RADIUS: 56,
      DODGE_COMMIT: 6,
      HEIGHT_SLACK: 110,
      FUEL_FLOOR: 80,
      RELOAD_LOW: 6,
      HUNT_MEMORY_TICKS: 240,
      STALL_RISE_VY: -0.1,
      STALL_TRIGGER: 25,
      STALL_COOLDOWN: 180,
    });
  });

  it('SHRIKE_DEFAULTS', () => {
    expect(SHRIKE_DEFAULTS).toEqual({
      ESCORT_FOCUS: 0,
      BLAST_RANGE: 200,
      EFFECT_MAX: 280,
      PUSH_DIST: 90,
      DIVE_HEIGHT: 180,
      DIVE_ENTRY: 250,
      WINDOW_MAG: 6,
      SHELLS_LEAVE: 1,
      BAND_MIN: 320,
      BAND_MAX: 460,
      APPROACH_FIRE_DIST: 620,
      FIRE_MAX_DIST: 620,
      FOCUS_RETARGET: 30,
      TAP_PERIOD: 6,
      TAP_OPEN: 1,
      EMA_ALPHA: 0.15,
      DROP_G: 0.135,
      BOB_UP_TICKS: 12,
      BOB_DOWN_MIN: 18,
      BOB_DOWN_VAR: 14,
      DODGE_HORIZON: 26,
      DANGER_RADIUS: 56,
      DODGE_COMMIT: 6,
      HEIGHT_SLACK: 110,
      FUEL_FLOOR: 80,
      RELOAD_LOW: 6,
      HUNT_MEMORY_TICKS: 240,
      STALL_RISE_VY: -0.1,
      STALL_TRIGGER: 25,
      STALL_COOLDOWN: 180,
    });
  });

  it('NEURAL_DEFAULTS', () => {
    expect(NEURAL_DEFAULTS).toEqual({
      FIRE_THRESH: 0.5,
      MOVE_THRESH: 0.5,
      UPDOWN_THRESH: 0.5,
      JET_THRESH: 0.5,
      RELOAD_THRESH: 0.5,
      AIM_DIST: 300,
    });
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
