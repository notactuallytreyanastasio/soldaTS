import { describe, it, expect } from 'vitest';

import { f } from './scalar';

import {
  MAX_PLAYERS,
  MAX_SPRITES,
  MAX_BULLETS,
  MAX_SPARKS,
  MAX_THINGS,
  NUM_PARTICLES,
  DEFAULT_GOALTICKS,
  SECOND,
  RKV,
  DEFAULT_GRAVITY,
  SURFACECOEFX,
  SURFACECOEFY,
  CROUCHMOVESURFACECOEFX,
  CROUCHMOVESURFACECOEFY,
  STANDSURFACECOEFX,
  STANDSURFACECOEFY,
  GRENADE_SURFACECOEF,
  SPARK_SURFACECOEF,
  RUNSPEED,
  JUMPSPEED,
  GameStyle,
  Team,
  ObjectStyle,
  Bonus,
} from './constants';

// Regression guard: every value below is quoted directly from the FreePascal
// source. Tests run with plain f64 (STRICT_F32 not required).

describe('hard caps', () => {
  it('matches the Pascal world-state array sizes', () => {
    expect(MAX_PLAYERS).toBe(32); // shared/network/Net.pas:104
    expect(MAX_SPRITES).toBe(32); // shared/mechanics/Sprites.pas:19 (= MAX_PLAYERS)
    expect(MAX_SPRITES).toBe(MAX_PLAYERS);
    expect(MAX_BULLETS).toBe(254); // shared/mechanics/Sprites.pas:20
    expect(MAX_SPARKS).toBe(558); //  shared/mechanics/Sprites.pas:21
    expect(MAX_THINGS).toBe(90); //   shared/mechanics/Sprites.pas:22
    expect(NUM_PARTICLES).toBe(560); // shared/Parts.pas:31
  });

  it('keeps the NUM_PARTICLES > MAX_SPARKS buffer invariant', () => {
    expect(NUM_PARTICLES - MAX_SPARKS).toBe(2);
  });
});

describe('timing', () => {
  it('matches the 60 Hz tick constants', () => {
    expect(DEFAULT_GOALTICKS).toBe(60); // shared/Constants.pas:27
    expect(SECOND).toBe(60); //           shared/Constants.pas:84
  });
});

describe('core physics constants', () => {
  // Float-physics constants are stored as Pascal `Single`, so the module wraps
  // them in f(). Assert against f(literal) so the guard holds in both f64 mode
  // (f = identity) and STRICT_F32 mode (f = Math.fround).
  it('matches the Verlet damping and gravity', () => {
    expect(RKV).toBe(f(0.98)); //           shared/Parts.pas:32
    expect(DEFAULT_GRAVITY).toBe(f(0.06)); // shared/Cvar.pas:985
  });

  it('matches the surface friction coefficients', () => {
    expect(SURFACECOEFX).toBe(f(0.97)); //           shared/mechanics/Sprites.pas:24
    expect(SURFACECOEFY).toBe(f(0.97)); //           shared/mechanics/Sprites.pas:25
    expect(CROUCHMOVESURFACECOEFX).toBe(f(0.85)); // shared/mechanics/Sprites.pas:26
    expect(CROUCHMOVESURFACECOEFY).toBe(f(0.97)); // shared/mechanics/Sprites.pas:27
    expect(STANDSURFACECOEFX).toBe(f(0.0)); //       shared/mechanics/Sprites.pas:28
    expect(STANDSURFACECOEFY).toBe(f(0.0)); //       shared/mechanics/Sprites.pas:29
    expect(GRENADE_SURFACECOEF).toBe(f(0.88)); //    shared/mechanics/Sprites.pas:30
    expect(SPARK_SURFACECOEF).toBe(f(0.7)); //       shared/mechanics/Sprites.pas:31
  });

  it('matches representative movement speeds', () => {
    expect(RUNSPEED).toBe(f(0.118)); //  shared/Constants.pas:40
    expect(JUMPSPEED).toBe(f(0.66)); //  shared/Constants.pas:43
  });
});

describe('game styles', () => {
  it('matches GAMESTYLE_* (shared/Constants.pas:347-353)', () => {
    expect(GameStyle.DEATHMATCH).toBe(0);
    expect(GameStyle.POINTMATCH).toBe(1);
    expect(GameStyle.TEAMMATCH).toBe(2);
    expect(GameStyle.CTF).toBe(3);
    expect(GameStyle.RAMBO).toBe(4);
    expect(GameStyle.INF).toBe(5);
    expect(GameStyle.HTF).toBe(6);
  });
});

describe('teams', () => {
  it('matches TEAM_* (shared/Constants.pas:339-344)', () => {
    expect(Team.NONE).toBe(0);
    expect(Team.ALPHA).toBe(1);
    expect(Team.BRAVO).toBe(2);
    expect(Team.CHARLIE).toBe(3);
    expect(Team.DELTA).toBe(4);
    expect(Team.SPECTATOR).toBe(5);
  });
});

describe('object styles', () => {
  it('matches representative OBJECT_* (shared/Constants.pas:393-419)', () => {
    expect(ObjectStyle.ALPHA_FLAG).toBe(1);
    expect(ObjectStyle.BRAVO_FLAG).toBe(2);
    expect(ObjectStyle.POINTMATCH_FLAG).toBe(3);
    expect(ObjectStyle.M79).toBe(11);
    expect(ObjectStyle.STATIONARY_GUN).toBe(27);
  });
});

describe('bonus styles', () => {
  it('matches BONUS_* (shared/Constants.pas:194-200)', () => {
    expect(Bonus.NONE).toBe(0);
    expect(Bonus.GRENADES).toBe(17);
    expect(Bonus.FLAMEGOD).toBe(18);
    expect(Bonus.PREDATOR).toBe(19);
    expect(Bonus.VEST).toBe(20);
    expect(Bonus.BERSERKER).toBe(21);
    expect(Bonus.CLUSTERS).toBe(22);
  });
});
