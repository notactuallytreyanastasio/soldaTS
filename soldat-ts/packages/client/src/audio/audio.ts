// AudioEngine — a WebAudio port of OpenSoldat's OpenAL sound system.
//
// PORT: client/Sound.pas — the sample registry (Samp[]), positional playback
// (FPlaySound), volume scaling (ScaleVolumeSetting) and master gain (SetVolume).
//
// OpenSoldat uses OpenAL: one source per channel, 3D AL_POSITION + per-source
// AL_GAIN, with AL_NONE distance model (i.e. distance attenuation is computed
// by the game itself, not OpenAL — see FPlaySound's manual `Volume := ... *
// (1 - Dist)`). We reproduce that exactly here: gain/pan are computed in
// `computePan` (pure, tested) and applied via a per-voice GainNode +
// StereoPannerNode rather than letting WebAudio's PannerNode model distance.
//
// Graceful no-op: in SSR / headless environments there is no AudioContext, so
// every method short-circuits and loads/plays nothing. This keeps the engine
// safe to construct and call from sim-driven code without guards everywhere.

import type { SoundName } from './sounds';
import { SOUND_MANIFEST, LOOPING_SOUNDS } from './sounds';

// PORT: shared/Constants.pas:62-64.
export const SOUND_MAXDIST = 750;
export const SOUND_PANWIDTH = 1000;
export const SOUND_METERLENGTH = 2000;

/** Result of the distance/pan model for a single positional voice. */
export interface PanResult {
  /** Stereo pan, -1 (full left) .. +1 (full right). */
  pan: number;
  /** Linear gain multiplier, 0 (silent) .. 1 (full), before master volume. */
  gain: number;
}

/**
 * Pure distance-attenuation + stereo-pan model.
 *
 * PORT: client/Sound.pas:422-478 — FPlaySound's distance/gain/position math.
 *
 *   Dist   := sqrt(dx*dx + dy*dy) / SOUND_MAXDIST   (line 422)
 *   if Dist > 1 then Exit                            (line 448-449) -> gain 0
 *   Volume := VolumeInternal * (1 - Dist)            (line 472)
 *   AL_POSITION.x := dx / SOUND_METERLENGTH          (line 476)
 *
 * Here `gain` is the `(1 - Dist)` factor (master volume applied later by the
 * caller / engine), and `pan` is the OpenAL X position clamped to [-1, 1]
 * (OpenAL pans by source X relative to the listener; with AL_NONE the listener
 * is at origin facing -Z, so a +X emitter is heard on the right).
 *
 * @param dx       emitterX - listenerX (world units)
 * @param dy       emitterY - listenerY (world units)
 * @param maxDist  distance at which the sound becomes inaudible (SOUND_MAXDIST)
 */
export function computePan(
  dx: number,
  dy: number,
  maxDist: number = SOUND_MAXDIST,
): PanResult {
  const dist = Math.sqrt(dx * dx + dy * dy) / maxDist;

  // PORT: Sound.pas:448 — beyond max distance the source is not played at all.
  if (dist > 1) {
    return { pan: 0, gain: 0 };
  }

  // PORT: Sound.pas:472 — linear falloff (1 - normalized distance).
  const gain = 1 - dist;

  // PORT: Sound.pas:476 — OpenAL X position = dx / SOUND_METERLENGTH. Clamp to
  // the StereoPanner range [-1, 1] (OpenAL would attenuate smoothly past the
  // pan width; a hard clamp is the faithful audible approximation).
  let pan = dx / SOUND_METERLENGTH;
  if (pan < -1) pan = -1;
  else if (pan > 1) pan = 1;

  return { pan, gain };
}

/**
 * Takes a volume percentage (0-100) and converts it for internal use (0-1).
 * The result is exponentially scaled to improve volume control intuitiveness
 * and sensitivity at lower decibels.
 *
 * PORT: client/Sound.pas:193-196 (ScaleVolumeSetting).
 */
export function scaleVolumeSetting(volumeSetting: number): number {
  return (Math.pow(1.0404, volumeSetting) - 1) / (1.0404 - 1) / 1275;
}

/** Options for a one-shot or positional playback. */
export interface PlayOptions {
  /** Override loop behaviour (defaults to the manifest's LOOPING_SOUNDS). */
  loop?: boolean;
  /** Per-voice gain multiplier (0..1), applied on top of distance gain. */
  gain?: number;
}

/**
 * Minimal structural view of the WebAudio surface we use, so the engine can be
 * unit-tested against a fake and so the module type-checks without a real
 * audio device. Mirrors the relevant lib.dom AudioContext members.
 */
type AudioContextLike = Pick<
  AudioContext,
  | 'createBufferSource'
  | 'createGain'
  | 'createStereoPanner'
  | 'decodeAudioData'
  | 'destination'
  | 'currentTime'
  | 'state'
  | 'resume'
  | 'close'
>;

/** Factory that yields an AudioContext, or null when unavailable (headless). */
export type AudioContextFactory = () => AudioContextLike | null;

function defaultContextFactory(): AudioContextLike | null {
  const g = globalThis as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/** How a sound name is fetched into an ArrayBuffer (overridable for tests). */
export type AudioFetcher = (url: string) => Promise<ArrayBuffer>;

async function defaultFetcher(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch sound '${url}': ${res.status}`);
  }
  return res.arrayBuffer();
}

export interface AudioEngineOptions {
  /** Override the AudioContext factory (e.g. for SSR or testing). */
  contextFactory?: AudioContextFactory;
  /** Override the network fetcher used to load samples. */
  fetcher?: AudioFetcher;
  /** Initial master volume (0..1). Defaults to 1. */
  masterVolume?: number;
}

/**
 * WebAudio implementation of the OpenSoldat sound registry + playback.
 *
 * PORT: client/Sound.pas (whole unit). Channels/sources are not modelled
 * 1:1 — WebAudio spins up a fresh BufferSource per play, which is the idiomatic
 * equivalent of OpenSoldat cycling through its 128 non-reserved sources.
 */
export class AudioEngine {
  private readonly ctx: AudioContextLike | null;
  private readonly fetcher: AudioFetcher;
  /** PORT: Sound.pas:36 — `Samp` array. Keyed by SoundName instead of 1..163. */
  private readonly buffers = new Map<SoundName, AudioBuffer>();
  /** Master gain node — equivalent to VolumeInternal applied to every voice. */
  private readonly masterGain: GainNode | null;
  private masterVolumeValue: number;

  constructor(opts: AudioEngineOptions = {}) {
    const factory = opts.contextFactory ?? defaultContextFactory;
    this.ctx = factory() as AudioContext | null;
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.masterVolumeValue = opts.masterVolume ?? 1;

    if (this.ctx) {
      const ctx = this.ctx as unknown as AudioContext;
      this.masterGain = ctx.createGain();
      this.masterGain.gain.value = this.masterVolumeValue;
      this.masterGain.connect(ctx.destination);
    } else {
      this.masterGain = null;
    }
  }

  /** True when a real audio device is available. */
  get available(): boolean {
    return this.ctx !== null;
  }

  /**
   * Master volume (0..1). PORT: Sound.pas:541-551 (SetVolume with Channel=-1,
   * i.e. all sources). Setting this re-gains every future voice.
   */
  get masterVolume(): number {
    return this.masterVolumeValue;
  }

  setMasterVolume(volume: number): void {
    const v = volume < 0 ? 0 : volume > 1 ? 1 : volume;
    this.masterVolumeValue = v;
    if (this.masterGain) {
      this.masterGain.gain.value = v;
    }
  }

  /**
   * Resume a suspended context. Browsers start the AudioContext suspended until
   * a user gesture; call this from a click/keydown handler. No-op when headless.
   */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  /**
   * Load and decode a single sound into the registry. No-op (resolves) when
   * headless. Silently records nothing on fetch/decode failure — a missing
   * user-supplied asset must not crash the game (see sounds.ts licensing note).
   */
  async load(name: SoundName): Promise<boolean> {
    if (!this.ctx) return false;
    if (this.buffers.has(name)) return true;

    const url = SOUND_MANIFEST[name];
    try {
      const data = await this.fetcher(url);
      const ctx = this.ctx as unknown as AudioContext;
      const buffer = await ctx.decodeAudioData(data);
      this.buffers.set(name, buffer);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load many sounds, tolerating per-file failure. Returns the names that
   * loaded successfully. PORT: Sound.pas:198-384 (LoadSounds loop).
   */
  async loadMany(names: Iterable<SoundName>): Promise<SoundName[]> {
    const list = [...names];
    const results = await Promise.all(
      list.map(async (n) => ((await this.load(n)) ? n : null)),
    );
    return results.filter((n): n is SoundName => n !== null);
  }

  /** Whether a sound's buffer is loaded and ready. */
  isLoaded(name: SoundName): boolean {
    return this.buffers.has(name);
  }

  /**
   * Play a non-positional sound (centred, full distance gain).
   * PORT: Sound.pas:490-496 (PlaySound with listener == emitter -> Dist 0).
   */
  play(name: SoundName, opts: PlayOptions = {}): void {
    this.start(name, 0, 1, opts);
  }

  /**
   * Play a positional sound, attenuated and panned by emitter position relative
   * to the listener. PORT: Sound.pas:402-488 (FPlaySound).
   *
   * @param name      sound to play
   * @param x,y       emitter world position
   * @param listenerX listener (camera/followed-sprite) world X
   * @param listenerY listener world Y
   */
  playAt(
    name: SoundName,
    x: number,
    y: number,
    listenerX: number,
    listenerY: number,
    opts: PlayOptions = {},
  ): void {
    const { pan, gain } = computePan(x - listenerX, y - listenerY);
    // PORT: Sound.pas:448 — gain 0 means the source was beyond max distance and
    // is never started.
    if (gain <= 0) return;
    this.start(name, pan, gain, opts);
  }

  /** Shared voice spin-up. No-op when headless or buffer not loaded. */
  private start(
    name: SoundName,
    pan: number,
    distanceGain: number,
    opts: PlayOptions,
  ): void {
    if (!this.ctx || !this.masterGain) return;
    // PORT: Sound.pas:413-414 — `if not Samp[SampleNum].Loaded then Exit`.
    const buffer = this.buffers.get(name);
    if (!buffer) return;

    const ctx = this.ctx as unknown as AudioContext;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = opts.loop ?? LOOPING_SOUNDS.has(name);

    const voiceGain = ctx.createGain();
    const extra = opts.gain ?? 1;
    voiceGain.gain.value = distanceGain * extra;

    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;

    source.connect(voiceGain);
    voiceGain.connect(panner);
    panner.connect(this.masterGain);

    source.start();
  }

  /** Tear down the AudioContext. No-op when headless. */
  async close(): Promise<void> {
    this.buffers.clear();
    if (this.ctx) {
      await this.ctx.close();
    }
  }
}
