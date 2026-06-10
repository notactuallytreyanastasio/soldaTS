// SoundManager — a high-level, event-driven wrapper over AudioEngine.
//
// Where AudioEngine speaks in low-level SoundName samples and raw positional
// math (PORT: client/Sound.pas FPlaySound), SoundManager exposes the handful of
// *gameplay events* the renderer/sim actually fire (a weapon shot, a bullet
// hit, a jump, reload begin/end, a death, an explosion) and maps each onto the
// closest real OpenSoldat sample.
//
// ASSET NOTE: the real .wav assets are user-supplied (see sounds.ts licensing
// note). At time of writing only `/sfx/jump.wav` is present under public/sfx;
// every other mapped sample fails to load and its event becomes a silent no-op
// (AudioEngine.load/play both tolerate missing buffers). The orchestrator
// should confirm the referenced filenames once the full SFX set is extracted.

import type { AudioEngine, PlayOptions } from './audio';
import type { SoundName } from './sounds';

/**
 * The high-level gameplay sound events the game emits. These are deliberately
 * coarse — one event per observable game moment, not per weapon — so callers in
 * the sim/render layer need not know about the 163-entry SoundName set.
 */
export type GameSoundEvent =
  | 'fire'
  | 'hit'
  | 'jump'
  | 'reloadStart'
  | 'reloadDone'
  | 'death'
  | 'explosion';

/**
 * Maps each GameSoundEvent to the underlying OpenSoldat sample (SoundName) the
 * AudioEngine will play. Choices mirror client/Sound.pas usage:
 *
 *   fire        -> 'ak74-fire'      generic weapon report (Sound.pas SFX_AK74_1)
 *   hit         -> 'dead-hit'       bullet-into-flesh thud (SFX_DEAD_HIT:46)
 *   jump        -> 'jump'           confirmed present at /sfx/jump.wav (SFX_JUMP:105)
 *   reloadStart -> 'ak74-reload'    reload begin (uses the AK reload sample)
 *   reloadDone  -> 'changeweapon'   reload/weapon-ready click
 *   death       -> 'death'          player death cry (SFX_DEATH:85)
 *   explosion   -> 'grenade-explosion'  generic blast (SFX_GRENADE_EXPLOSION:20)
 *
 * Every target is a key of SOUND_MANIFEST, so each resolves to a `/sfx/*.wav`
 * URL. The orchestrator may retune any value to a different existing SoundName.
 */
export const EVENT_SOUNDS: Readonly<Record<GameSoundEvent, SoundName>> = {
  fire: 'ak74-fire',
  hit: 'dead-hit',
  jump: 'jump',
  reloadStart: 'ak74-reload',
  reloadDone: 'changeweapon',
  death: 'death',
  explosion: 'grenade-explosion',
};

/** All gameplay events, in declaration order. */
export const ALL_GAME_SOUND_EVENTS: readonly GameSoundEvent[] = Object.keys(
  EVENT_SOUNDS,
) as GameSoundEvent[];

/** Per-event playback tuning (gain). The orchestrator may adjust these. */
export const EVENT_GAIN: Readonly<Record<GameSoundEvent, number>> = {
  fire: 1,
  hit: 1,
  jump: 0.8,
  reloadStart: 0.9,
  reloadDone: 0.9,
  death: 1,
  explosion: 1,
};

export interface SoundManagerOptions {
  /**
   * Override which SoundName each event resolves to. Merged over EVENT_SOUNDS,
   * so a partial override only replaces the named events.
   */
  events?: Partial<Record<GameSoundEvent, SoundName>>;
}

/**
 * Event-level facade over AudioEngine. Construct with a shared AudioEngine,
 * `await load()` once (during asset preload), then call `play(event, ...)` from
 * sim/render code. Positional playback kicks in automatically when emitter and
 * listener coordinates are supplied.
 */
export class SoundManager {
  private readonly engine: AudioEngine;
  private readonly events: Readonly<Record<GameSoundEvent, SoundName>>;

  constructor(engine: AudioEngine, opts: SoundManagerOptions = {}) {
    this.engine = engine;
    this.events = { ...EVENT_SOUNDS, ...opts.events };
  }

  /** The SoundName an event currently resolves to. */
  sampleFor(event: GameSoundEvent): SoundName {
    return this.events[event];
  }

  /**
   * Load the core gameplay sample set (one sample per GameSoundEvent) into the
   * AudioEngine. Tolerates missing assets — an unavailable file just leaves its
   * event silent. Resolves once all load attempts settle, so it is safe to
   * await before the first draw. Returns the events whose sample loaded.
   */
  async load(): Promise<GameSoundEvent[]> {
    const events = ALL_GAME_SOUND_EVENTS;
    const samples = new Set<SoundName>(events.map((e) => this.events[e]));
    const loaded = new Set<SoundName>(await this.engine.loadMany(samples));
    return events.filter((e) => loaded.has(this.events[e]));
  }

  /**
   * Play a gameplay event. When `x`/`y` are given the sound is positional
   * (attenuated + panned relative to the listener; defaults listener to origin
   * if only emitter coords are supplied). Without coordinates it plays centred
   * at full distance gain. No-op when headless or the sample is unloaded.
   */
  play(
    event: GameSoundEvent,
    x?: number,
    y?: number,
    listenerX?: number,
    listenerY?: number,
  ): void {
    const name = this.events[event];
    const opts: PlayOptions = { gain: EVENT_GAIN[event] };

    if (x === undefined || y === undefined) {
      this.engine.play(name, opts);
      return;
    }

    this.engine.playAt(name, x, y, listenerX ?? 0, listenerY ?? 0, opts);
  }
}
