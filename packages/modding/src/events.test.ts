import { describe, it, expect } from 'vitest';

import {
  MOD_EVENT_CASCADE,
  MOD_EVENT_NAMES,
  type ModEventCascade,
  type ModEventName,
} from './events.js';

// The authoritative classification per ScriptDispatcher.pas (see events.ts
// header comments). These lists are spelled out here independently so a
// future edit to MOD_EVENT_CASCADE that misclassifies an event fails loudly.
const CHAIN_EVENTS: readonly ModEventName[] = [
  'OnPlayerDamage',
  'OnBeforeJoinTeam',
  'OnBeforePlayerRespawn',
  'OnRequestGame',
];

const OR_EVENTS: readonly ModEventName[] = [
  'OnVoteMapStart',
  'OnVoteKickStart',
  'OnPlayerCommand',
  'OnConsoleCommand',
];

const BROADCAST_EVENTS: readonly ModEventName[] = [
  'OnClockTick',
  'OnJoin',
  'OnLeave',
  'OnJoinTeam',
  'OnPlayerKill',
  'OnFlagGrab',
  'OnFlagScore',
  'OnFlagReturn',
  'OnFlagDrop',
  'OnKitPickup',
  'OnWeaponChange',
  'OnAfterPlayerRespawn',
  'OnBeforeMapChange',
  'OnAfterMapChange',
  'OnPlayerSpeak',
  'OnVoteMap',
  'OnVoteKick',
  'OnAdminConnect',
  'OnAdminDisconnect',
  'OnAdminMessage',
];

describe('MOD_EVENT_CASCADE', () => {
  it('covers exactly the 28 ported dispatcher events', () => {
    expect(Object.keys(MOD_EVENT_CASCADE)).toHaveLength(28);
    expect(new Set(Object.keys(MOD_EVENT_CASCADE))).toEqual(
      new Set([...BROADCAST_EVENTS, ...CHAIN_EVENTS, ...OR_EVENTS]),
    );
  });

  it('classifies the four value-threading events as "chain"', () => {
    for (const event of CHAIN_EVENTS) {
      expect(MOD_EVENT_CASCADE[event], event).toBe('chain');
    }
  });

  it('classifies the four boolean veto/handled events as "or"', () => {
    for (const event of OR_EVENTS) {
      expect(MOD_EVENT_CASCADE[event], event).toBe('or');
    }
  });

  it('classifies every remaining (procedure) event as "broadcast"', () => {
    for (const event of BROADCAST_EVENTS) {
      expect(MOD_EVENT_CASCADE[event], event).toBe('broadcast');
    }
  });

  it('only ever uses the three known cascade strategies', () => {
    const valid: ReadonlySet<ModEventCascade> = new Set(['broadcast', 'chain', 'or']);
    for (const [event, cascade] of Object.entries(MOD_EVENT_CASCADE)) {
      expect(valid.has(cascade), `${event} -> ${String(cascade)}`).toBe(true);
    }
  });

  it('is frozen — a mod cannot reclassify an event at runtime', () => {
    expect(Object.isFrozen(MOD_EVENT_CASCADE)).toBe(true);
    expect(() => {
      // Strict-mode assignment to a frozen object throws.
      (MOD_EVENT_CASCADE as Record<string, ModEventCascade>).OnPlayerDamage = 'broadcast';
    }).toThrow(TypeError);
    expect(MOD_EVENT_CASCADE.OnPlayerDamage).toBe('chain');
  });
});

describe('MOD_EVENT_NAMES', () => {
  it('lists every key of MOD_EVENT_CASCADE exactly once, in the same order', () => {
    expect(MOD_EVENT_NAMES).toEqual(Object.keys(MOD_EVENT_CASCADE));
    expect(new Set(MOD_EVENT_NAMES).size).toBe(MOD_EVENT_NAMES.length);
  });

  it('is frozen — registration loops cannot mutate the catalogue', () => {
    expect(Object.isFrozen(MOD_EVENT_NAMES)).toBe(true);
    expect(() => {
      (MOD_EVENT_NAMES as ModEventName[]).push('OnClockTick');
    }).toThrow(TypeError);
  });
});
