// Bot-engine adapter tests (decision node 136): registry resolution and a
// full Game integration pass proving each engine sustains a bot-vs-bot
// match through the same adapter seam.

import { describe, it, expect } from 'vitest';
import { createEngine, engineIds } from './index';
import { Game } from '../app/game';
import { ARENA_SPAWNS } from '../app/arena';
import { resolveVariant } from '../app/tournament';

describe('engine registry', () => {
  it('registers classic, pilot, reaper, matador, kestrel, wolf, plover, hydra, shrike, cuadrilla, orca, and neural', () => {
    expect(engineIds()).toContain('classic');
    expect(engineIds()).toContain('pilot');
    expect(engineIds()).toContain('reaper');
    expect(engineIds()).toContain('matador');
    expect(engineIds()).toContain('kestrel');
    expect(engineIds()).toContain('wolf');
    expect(engineIds()).toContain('plover');
    expect(engineIds()).toContain('hydra');
    expect(engineIds()).toContain('shrike');
    expect(engineIds()).toContain('cuadrilla');
    expect(engineIds()).toContain('orca');
    expect(engineIds()).toContain('neural');
    expect(engineIds()).toContain('angler');
    expect(engineIds()).toContain('disciple');
    expect(engineIds()).toContain('prodigy');
    expect(engineIds()).toContain('buttstein');
    expect(engineIds()).toContain('mojojojo');
  });

  it('resolves engines by id and falls back to classic on unknown ids', () => {
    expect(createEngine('pilot').id).toBe('pilot');
    expect(createEngine('classic').id).toBe('classic');
    expect(createEngine('definitely-not-real').id).toBe('classic');
    expect(createEngine(undefined).id).toBe('classic');
  });
});

describe.each([
  'classic',
  'pilot',
  'reaper',
  'matador',
  'kestrel',
  'wolf',
  'plover',
  'hydra',
  'shrike',
  'cuadrilla',
  'orca',
  'neural',
  'angler',
  'disciple',
  'prodigy',
  'buttstein',
  'mojojojo',
] as const)(
  'spectate match under the %s engine',
  (engine) => {
    it('sustains kills and respawns over 6000 ticks', () => {
      const game = new Game({
        seed: 7,
        spawns: ARENA_SPAWNS,
        botCount: 4,
        spectate: true,
        aiEngine: engine,
      });
      expect(game.aiEngineId).toBe(engine);

      const kills: { killer: number; victim: number }[] = [];
      game.onKill = (killer, victim): void => {
        kills.push({ killer, victim });
      };

      for (let t = 0; t < 6000; t++) game.tick(1 / 60);

      // The match produced kills, and dead bots came back (someone has > 0
      // active sprites at the end — all four, since respawn is 3 s).
      expect(kills.length).toBeGreaterThan(0);
      const alive = game
        .botIndices()
        .filter((i) => game.world.sprites[i]?.active).length;
      expect(alive).toBe(4);
      // Player slot stays out of spectate matches regardless of engine.
      expect(game.world.sprites[game.playerIndex]?.active).toBe(false);
    });
  },
);

describe('mixed-engine matches (one arena, several brains)', () => {
  it('splits bots round-robin across a comma list and reports groups', () => {
    const game = new Game({
      seed: 3,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      aiEngine: 'classic,pilot',
    });
    expect(game.aiEngineId).toBe('classic+pilot');
    expect(game.engineGroups()).toEqual(['classic', 'pilot']);
    const assigned = game.botIndices().map((i) => game.engineOf(i));
    expect(assigned).toEqual(['classic', 'pilot', 'classic', 'pilot']);
  });

  it('hot-swap homogenizes or re-mixes the roster', () => {
    const game = new Game({
      seed: 3,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      aiEngine: 'classic,pilot',
    });
    game.setEngine('pilot');
    expect(game.engineGroups()).toEqual(['pilot']);
    game.setEngine('pilot,classic');
    expect(game.botIndices().map((i) => game.engineOf(i))).toEqual([
      'pilot',
      'classic',
      'pilot',
      'classic',
    ]);
  });

  it('a mixed match sustains itself (both brains fight in one world)', () => {
    const game = new Game({
      seed: 11,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      aiEngine: 'classic,pilot',
    });
    const kills: { killer: number; victim: number }[] = [];
    game.onKill = (killer, victim): void => {
      kills.push({ killer, victim });
    };
    for (let t = 0; t < 6000; t++) game.tick(1 / 60);
    expect(kills.length).toBeGreaterThan(0);
  });
});

describe('play mode under the adapter (regression)', () => {
  it('default Game still spawns the player with classic bots', () => {
    const game = new Game({});
    expect(game.aiEngineId).toBe('classic');
    expect(game.world.sprites[game.playerIndex]?.active).toBe(true);
    expect(game.playerAmmo()).toBeGreaterThan(0);
  });
});

describe('team dynamics (red vs blue, goal node 154)', () => {
  it('mixed matches put each engine on its own team', () => {
    const game = new Game({
      seed: 5,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      aiEngine: 'classic,pilot',
    });
    expect(game.teamsEnabled).toBe(true);
    const teams = game.botIndices().map((i) => game.teamOf(i));
    expect(teams).toEqual([1, 2, 1, 2]); // classic=red, pilot=blue
    // The sim sprites carry the team (renderer + targeting read it).
    for (const i of game.botIndices()) {
      expect(game.world.sprites[i]?.team).toBe(game.teamOf(i));
    }
  });

  it('uniform matches stay FFA unless ?teams forces them', () => {
    const ffa = new Game({ seed: 5, spawns: ARENA_SPAWNS, botCount: 4, spectate: true });
    expect(ffa.teamsEnabled).toBe(false);
    expect(ffa.botIndices().every((i) => ffa.teamOf(i) === 0)).toBe(true);

    const teamed = new Game({
      seed: 5,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      teams: true,
    });
    expect(teamed.botIndices().map((i) => teamed.teamOf(i))).toEqual([1, 2, 1, 2]);
  });

  it('a team match sustains cross-team kills only', () => {
    const game = new Game({
      seed: 13,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      aiEngine: 'classic,pilot',
    });
    const kills: { killer: number; victim: number }[] = [];
    game.onKill = (killer, victim): void => {
      kills.push({ killer, victim });
    };
    for (let t = 0; t < 6000; t++) game.tick(1 / 60);
    expect(kills.length).toBeGreaterThan(0);
    // Friendly fire is off and teammates are never targeted: every
    // attributed kill crosses teams.
    for (const k of kills) {
      if (k.killer > 0 && k.killer !== k.victim) {
        expect(game.teamOf(k.killer)).not.toBe(game.teamOf(k.victim));
      }
    }
  });
});


describe('whole teams (user correction on node 157)', () => {
  it('a lopsided roster still yields even, single-engine teams', () => {
    // Evolved-style 5:1 roster: red must still be ALL classic, blue ALL
    // pilot, split 3v3 — never 1v5 "everyone is on pilot".
    const game = new Game({
      seed: 9,
      spawns: ARENA_SPAWNS,
      botCount: 6,
      spectate: true,
      aiEngine: 'classic,pilot,pilot,pilot,pilot,pilot',
    });
    const byTeam = new Map<number, string[]>();
    for (const i of game.botIndices()) {
      const t = game.teamOf(i);
      byTeam.set(t, [...(byTeam.get(t) ?? []), game.engineOf(i)]);
    }
    expect(byTeam.get(1)).toEqual(['classic', 'classic', 'classic']);
    expect(byTeam.get(2)).toEqual(['pilot', 'pilot', 'pilot']);
  });

  it('FFA (no teams) keeps the roster proportions', () => {
    const game = new Game({
      seed: 9,
      spawns: ARENA_SPAWNS,
      botCount: 6,
      spectate: true,
      aiEngine: 'classic,pilot,pilot,pilot,pilot,pilot',
      teams: false,
    });
    const pilots = game.botIndices().filter((i) => game.engineOf(i) === 'pilot');
    expect(pilots).toHaveLength(5);
  });
});

// THE SIDEARM ERA (goal node 573): the default era for NEW fights runs the
// 'sidearm' variant — AK demoted to a pistol (fireInterval 20, mag 12,
// reload 70, spread 0.012). Every brain above was tuned/probed under the
// 10/s baseline AK, so this is the sustainment reality check: representative
// engines (3 hand-written + the learned MOJOJOJO) must still produce kills
// over 6000 ticks at 3/s.
// The per-engine suite above stays on default tuning (= baseline) on purpose.
//
describe.each(['classic', 'cuadrilla', 'orca'] as const)(
  'sidearm-era sustainment under the %s engine',
  (engine) => {
    it('still produces kills over 6000 ticks with the pistol AK', () => {
      const game = new Game({
        seed: 7,
        spawns: ARENA_SPAWNS,
        botCount: 4,
        spectate: true,
        aiEngine: engine,
        tuning: resolveVariant('sidearm').tuning,
      });
      expect(game.magSize()).toBe(12); // the variant actually applied
      const kills: { killer: number; victim: number }[] = [];
      game.onKill = (killer, victim): void => {
        kills.push({ killer, victim });
      };
      for (let t = 0; t < 6000; t++) game.tick(1 / 60);
      expect(kills.length).toBeGreaterThan(0);
    });
  },
);

// KNOWN CASUALTIES of the era, noted loudly (probed, 6000-tick matches):
//  * MOJOJOJO's FACTORY FIRE_THRESH (0.3) was probed under the baseline AK
//    and effectively dies under sidearm tuning — 0 kills across most probe
//    seeds (the trained trigger rarely crosses 0.3 at a 20-tick cadence,
//    and each miss now costs 1/12th of the mag). Its CARD
//    (fights/mojojojo.json) pins FIRE_THRESH 0.01, which sustains in mixed
//    company; the test below applies the CARD tweak. The pinned engine
//    DEFAULTS are deliberately untouched — they are the trained artifact's
//    provenance.
//  * A learned-vs-learned MIRROR (mojojojo-only world) zeroes under sidearm
//    even at FIRE_THRESH 0 — aim precision is the learned bots' known
//    bottleneck, and the pistol's 3/s DPS is below their hit rate's kill
//    threshold. Sidearm-era sustainment for learned bots therefore means
//    "lands kills in mixed company", which is what the league plays.
//  * The other learned bots (neural/disciple/prodigy/buttstein) sustain at
//    factory defaults under sidearm vs hand-written opponents — weakly, but
//    alive (1-3 kills per 100 s 3v3).
describe('sidearm-era sustainment under the learned mojojojo engine (card tweak)', () => {
  it('lands a kill over 6000 ticks (3v3 vs classic) with FIRE_THRESH 0.01 from its card', () => {
    const game = new Game({
      seed: 7,
      spawns: ARENA_SPAWNS,
      botCount: 6,
      spectate: true,
      aiEngine: 'mojojojo,classic',
      engineTweaks: { mojojojo: { FIRE_THRESH: 0.01 } },
      tuning: resolveVariant('sidearm').tuning,
    });
    expect(game.magSize()).toBe(12);
    let total = 0;
    let byMojo = 0;
    game.onKill = (killer): void => {
      total += 1;
      if (killer > 0 && game.engineOf(killer) === 'mojojojo') byMojo += 1;
    };
    for (let t = 0; t < 6000; t++) game.tick(1 / 60);
    expect(total).toBeGreaterThan(0);
    expect(byMojo).toBeGreaterThan(0); // factory 0.3 lands ZERO here
  });
});
