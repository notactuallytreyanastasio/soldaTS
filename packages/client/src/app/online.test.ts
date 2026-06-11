// Pure-logic tests for the online team-vs-team net client (goal node 450).
import { describe, it, expect } from 'vitest';
import { Posture } from '@soldat/protocol';
import type { Control } from '@soldat/sim';
import {
  controlToInputFrame,
  deriveWsUrl,
  parseMatchRecipe,
  parseServerChat,
  spriteLabel,
  spriteTeam,
} from './online';

describe('deriveWsUrl', () => {
  it('uses the same-origin /arena/ws route on https (production behind Caddy)', () => {
    expect(
      deriveWsUrl({ protocol: 'https:', host: 'bobbby.online', hostname: 'bobbby.online' }),
    ).toBe('wss://bobbby.online/arena/ws');
  });

  it('dials the game server port directly in http dev', () => {
    expect(
      deriveWsUrl({ protocol: 'http:', host: 'localhost:5173', hostname: 'localhost' }),
    ).toBe('ws://localhost:8902');
  });
});

describe('controlToInputFrame', () => {
  it('maps every button + aim + posture onto the wire frame', () => {
    const control: Control = {
      left: true,
      right: false,
      up: true,
      down: false,
      fire: true,
      jetpack: true,
      throwNade: false,
      changeWeapon: true,
      throwWeapon: false,
      reload: true,
      prone: false,
      flagThrow: false,
      mouseAimX: 119.6,
      mouseAimY: -3.4,
      mouseDist: 0,
    };
    const frame = controlToInputFrame(42, control);
    expect(frame.clientTick).toBe(42);
    expect(frame.buttons.left).toBe(true);
    expect(frame.buttons.right).toBe(false);
    expect(frame.buttons.fire).toBe(true);
    expect(frame.buttons.jetpack).toBe(true);
    expect(frame.buttons.changeWeapon).toBe(true);
    expect(frame.buttons.reload).toBe(true);
    // Aim is rounded to ints (the codec's svarint demands integers).
    expect(frame.aim).toEqual({ x: 120, y: -3 });
    expect(frame.posture).toBe(Posture.Standing);
  });
});

describe('parseMatchRecipe', () => {
  it('extracts arena + seed + both team engines from the welcome mapName', () => {
    expect(parseMatchRecipe('arena=512&seed=90210&e1=wolf&e2=hydra')).toEqual({
      arenaSeed: 512,
      seed: 90210,
      e1: 'wolf',
      e2: 'hydra',
    });
  });
  it("falls back to 1/1 + 'classic' engines on garbage", () => {
    expect(parseMatchRecipe('')).toEqual({ arenaSeed: 1, seed: 1, e1: 'classic', e2: 'classic' });
  });
});

describe('spriteTeam / spriteLabel (the server slot contract)', () => {
  it('maps humans 1/2 to red/blue and bots 3..6 alternating', () => {
    expect([1, 2, 3, 4, 5, 6].map(spriteTeam)).toEqual([1, 2, 1, 2, 1, 2]);
  });
  it('labels self, the opposing human, and bots by their team engine', () => {
    expect(spriteLabel(1, 1, 'wolf', 'hydra')).toBe('You');
    expect(spriteLabel(2, 1, 'wolf', 'hydra')).toBe('Stranger');
    expect(spriteLabel(1, 2, 'wolf', 'hydra')).toBe('Stranger');
    expect(spriteLabel(3, 1, 'wolf', 'hydra')).toBe('WOLF');
    expect(spriteLabel(4, 1, 'wolf', 'hydra')).toBe('HYDRA');
    expect(spriteLabel(5, 2, 'wolf', 'hydra')).toBe('WOLF');
    expect(spriteLabel(6, 2, 'wolf', 'hydra')).toBe('HYDRA');
  });
});

describe('parseServerChat', () => {
  it('parses kill lines', () => {
    expect(parseServerChat('kill:1:2:AK74')).toEqual({
      type: 'kill',
      killer: 1,
      victim: 2,
      weapon: 'AK74',
    });
  });
  it('parses end-of-match lines', () => {
    expect(parseServerChat('end:disconnect:2')).toEqual({
      type: 'end',
      reason: 'disconnect',
      winnerNum: 2,
    });
  });
  it('parses the queue notice and passes through unknown chatter', () => {
    expect(parseServerChat('queue:waiting')).toEqual({ type: 'waiting' });
    expect(parseServerChat('gg')).toEqual({ type: 'other', text: 'gg' });
  });
});
