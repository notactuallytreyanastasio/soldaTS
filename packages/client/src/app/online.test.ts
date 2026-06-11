// Pure-logic tests for the online 1v1 net client (goal node 450).
import { describe, it, expect } from 'vitest';
import { Posture } from '@soldat/protocol';
import type { Control } from '@soldat/sim';
import {
  controlToInputFrame,
  deriveWsUrl,
  parseMatchRecipe,
  parseServerChat,
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
  it('extracts arena + seed from the welcome mapName', () => {
    expect(parseMatchRecipe('arena=512&seed=90210')).toEqual({ arenaSeed: 512, seed: 90210 });
  });
  it('falls back to 1/1 on garbage', () => {
    expect(parseMatchRecipe('')).toEqual({ arenaSeed: 1, seed: 1 });
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
