import { describe, it, expect } from 'vitest';
import type { AudioEngine, PlayOptions } from './audio';
import type { SoundName } from './sounds';
import { SOUND_MANIFEST } from './sounds';
import {
  SoundManager,
  EVENT_SOUNDS,
  EVENT_GAIN,
  ALL_GAME_SOUND_EVENTS,
  type GameSoundEvent,
} from './soundManager';

type PlayCall = { name: SoundName; opts: PlayOptions };
type PlayAtCall = {
  name: SoundName;
  x: number;
  y: number;
  lx: number;
  ly: number;
  opts: PlayOptions;
};

/** Minimal AudioEngine fake recording the calls SoundManager makes. */
function fakeEngine(loadable: Set<SoundName> = new Set()): {
  engine: AudioEngine;
  plays: PlayCall[];
  playAts: PlayAtCall[];
} {
  const plays: PlayCall[] = [];
  const playAts: PlayAtCall[] = [];
  const engine = {
    async loadMany(names: Iterable<SoundName>): Promise<SoundName[]> {
      return [...names].filter((n) => loadable.has(n));
    },
    play(name: SoundName, opts: PlayOptions = {}): void {
      plays.push({ name, opts });
    },
    playAt(
      name: SoundName,
      x: number,
      y: number,
      lx: number,
      ly: number,
      opts: PlayOptions = {},
    ): void {
      playAts.push({ name, x, y, lx, ly, opts });
    },
  } as unknown as AudioEngine;
  return { engine, plays, playAts };
}

describe('EVENT_SOUNDS map', () => {
  it('has an entry for every GameSoundEvent', () => {
    for (const event of ALL_GAME_SOUND_EVENTS) {
      expect(EVENT_SOUNDS[event]).toBeDefined();
    }
  });

  it('lists exactly the seven documented events', () => {
    const expected: GameSoundEvent[] = [
      'fire',
      'hit',
      'jump',
      'reloadStart',
      'reloadDone',
      'death',
      'explosion',
    ];
    expect([...ALL_GAME_SOUND_EVENTS].sort()).toEqual([...expected].sort());
  });

  it('maps every event to a real SOUND_MANIFEST sample', () => {
    for (const event of ALL_GAME_SOUND_EVENTS) {
      expect(SOUND_MANIFEST[EVENT_SOUNDS[event]]).toMatch(/^\/sfx\/.+\.wav$/);
    }
  });

  it('has a gain entry for every event', () => {
    for (const event of ALL_GAME_SOUND_EVENTS) {
      expect(typeof EVENT_GAIN[event]).toBe('number');
    }
  });
});

describe('SoundManager.load', () => {
  it('returns only events whose sample loaded', async () => {
    const { engine } = fakeEngine(new Set<SoundName>(['jump']));
    const sm = new SoundManager(engine);
    const loaded = await sm.load();
    expect(loaded).toEqual(['jump']);
  });

  it('returns all events when every sample loads', async () => {
    const all = new Set<SoundName>(
      ALL_GAME_SOUND_EVENTS.map((e) => EVENT_SOUNDS[e]),
    );
    const { engine } = fakeEngine(all);
    const sm = new SoundManager(engine);
    const loaded = await sm.load();
    expect([...loaded].sort()).toEqual([...ALL_GAME_SOUND_EVENTS].sort());
  });
});

describe('SoundManager.play', () => {
  it('plays non-positionally when no coords are given', () => {
    const { engine, plays, playAts } = fakeEngine();
    new SoundManager(engine).play('fire');
    expect(playAts).toHaveLength(0);
    expect(plays).toHaveLength(1);
    expect(plays[0]?.name).toBe(EVENT_SOUNDS.fire);
    expect(plays[0]?.opts.gain).toBe(EVENT_GAIN.fire);
  });

  it('plays positionally when emitter+listener coords are given', () => {
    const { engine, plays, playAts } = fakeEngine();
    new SoundManager(engine).play('explosion', 100, 200, 10, 20);
    expect(plays).toHaveLength(0);
    expect(playAts).toHaveLength(1);
    const c = playAts[0];
    expect(c?.name).toBe(EVENT_SOUNDS.explosion);
    expect(c?.x).toBe(100);
    expect(c?.y).toBe(200);
    expect(c?.lx).toBe(10);
    expect(c?.ly).toBe(20);
  });

  it('defaults the listener to the origin when only emitter coords given', () => {
    const { engine, playAts } = fakeEngine();
    new SoundManager(engine).play('hit', 50, 60);
    expect(playAts[0]?.lx).toBe(0);
    expect(playAts[0]?.ly).toBe(0);
  });
});

describe('SoundManager event overrides', () => {
  it('honours a partial event override', () => {
    const { engine, plays } = fakeEngine();
    const sm = new SoundManager(engine, { events: { fire: 'm249-fire' } });
    expect(sm.sampleFor('fire')).toBe('m249-fire');
    expect(sm.sampleFor('jump')).toBe(EVENT_SOUNDS.jump);
    sm.play('fire');
    expect(plays[0]?.name).toBe('m249-fire');
  });
});
