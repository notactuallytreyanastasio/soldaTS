// THE ARENA tests (goal node 551): single stage, spectator queue, chat + voice
// mesh relay, and clean-restart cycling — over fake sockets, deterministic
// seeds, no timers. The Arena builds real Matches; we drive their clock by hand.
import { describe, it, expect } from 'vitest';
import { ChatChannel, PROTOCOL_VERSION, type HandshakeWelcome, type Message } from '@soldat/protocol';
import { Arena } from './arena';
import { Match } from './match';
import { FakeSocket, hello } from './lobby.test';

const SEEDS = { seed: 7, arenaSeed: 5 };
const DT = 1 / 60;

function newArena(): { arena: Arena; starts: Match[]; ends: Match[] } {
  const starts: Match[] = [];
  const ends: Match[] = [];
  const arena = new Arena({
    rollSeeds: () => SEEDS,
    onMatchStart: (m) => starts.push(m),
    onMatchEnd: (m) => ends.push(m),
  });
  return { arena, starts, ends };
}

function lastWelcome(sock: FakeSocket): HandshakeWelcome | null {
  for (const m of [...sock.sent].reverse()) {
    if (m.kind === 'handshake' && m.handshake.kind === 'welcome') return m.handshake;
  }
  return null;
}

function lastRoster(sock: FakeSocket): Record<string, unknown> | null {
  for (const m of [...sock.sent].reverse()) {
    if (m.kind === 'chat' && m.text.startsWith('arena:')) {
      return JSON.parse(m.text.slice('arena:'.length)) as Record<string, unknown>;
    }
  }
  return null;
}

function voice(peer: number, data: string): Message {
  return { kind: 'voice', peer, data };
}
function chat(text: string): Message {
  return { kind: 'chat', senderNum: 0, channel: ChatChannel.Public, text };
}

describe('Arena — seating', () => {
  it('seats the first two hellos as players and starts a match', () => {
    const { arena, starts } = newArena();
    const a = new FakeSocket();
    const b = new FakeSocket();
    arena.add(a);
    arena.add(b);
    a.emit(hello(PROTOCOL_VERSION, 'wolf'));
    expect(arena.liveMatch).toBeNull(); // one player waits
    expect(lastRoster(a)?.['you']).toMatchObject({ role: 'player', waiting: true });

    b.emit(hello(PROTOCOL_VERSION, 'hydra'));
    expect(arena.liveMatch).not.toBeNull();
    expect(starts).toHaveLength(1);
    expect(lastWelcome(a)?.yourNum).toBe(1);
    expect(lastWelcome(b)?.yourNum).toBe(2);
    expect(lastWelcome(a)?.spectator).toBeUndefined();
    expect(lastWelcome(a)?.mapName).toBe('arena=5&seed=7&e1=wolf&e2=hydra&variant=sidearm');
  });

  it('makes the third+ visitor a spectator who gets a spectator welcome and the live feed', () => {
    const { arena } = newArena();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const c = new FakeSocket();
    for (const s of [a, b, c]) arena.add(s);
    a.emit(hello());
    b.emit(hello());
    c.emit(hello());

    const wc = lastWelcome(c);
    expect(wc?.spectator).toBe(true);
    expect(wc?.yourNum).toBeUndefined();
    expect(wc?.mapName).toBe(arena.liveMatch!.recipe);
    expect(arena.playerCount).toBe(2);
    expect(arena.spectatorCount).toBe(1);

    // The spectator receives snapshots as the match ticks.
    const before = c.sent.filter((m) => m.kind === 'spriteSnapshot').length;
    for (let t = 0; t < 30; t++) arena.liveMatch!.tick(DT);
    const after = c.sent.filter((m) => m.kind === 'spriteSnapshot').length;
    expect(after).toBeGreaterThan(before);
    // Roster tells the spectator their place in line.
    expect(lastRoster(c)?.['you']).toMatchObject({ role: 'spectator', queuePos: 1 });
  });
});

describe('Arena — chat + voice relay', () => {
  it('relays chat from anyone to everyone as say:<id>:<text>', () => {
    const { arena } = newArena();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const c = new FakeSocket();
    for (const s of [a, b, c]) arena.add(s);
    a.emit(hello());
    b.emit(hello());
    c.emit(hello()); // spectator, id 3

    c.emit(chat('hello from the cheap seats'));
    for (const s of [a, b, c]) {
      const said = [...s.sent].reverse().find((m) => m.kind === 'chat' && m.text.startsWith('say:'));
      expect(said?.kind === 'chat' && said.text).toBe('say:3:hello from the cheap seats');
    }
  });

  it('routes a voice frame to the addressed peer, rewriting peer to the sender', () => {
    const { arena } = newArena();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const c = new FakeSocket();
    for (const s of [a, b, c]) arena.add(s);
    a.emit(hello()); // id 1 (player)
    b.emit(hello()); // id 2 (player)
    c.emit(hello()); // id 3 (spectator)

    // Spectator c offers voice to player a.
    c.emit(voice(1, '{"sdp":"offer"}'));
    const got = [...a.sent].reverse().find((m) => m.kind === 'voice');
    expect(got).toEqual({ kind: 'voice', peer: 3, data: '{"sdp":"offer"}' });
    // b (not addressed) got nothing.
    expect(b.sent.some((m) => m.kind === 'voice')).toBe(false);
    // A voice frame to a non-existent peer is dropped silently.
    expect(() => c.emit(voice(999, 'x'))).not.toThrow();
  });

  it('lists every participant id as a voice-mesh peer in the roster', () => {
    const { arena } = newArena();
    const a = new FakeSocket();
    const b = new FakeSocket();
    for (const s of [a, b]) arena.add(s);
    a.emit(hello());
    b.emit(hello());
    expect(lastRoster(a)?.['peers']).toEqual([1, 2]);
    expect(lastRoster(a)?.['players']).toEqual([1, 2]);
  });
});

describe('Arena — clean-restart cycling', () => {
  it('promotes the queued spectator when a player leaves and starts a fresh match', () => {
    const { arena, starts, ends } = newArena();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const c = new FakeSocket();
    for (const s of [a, b, c]) arena.add(s);
    a.emit(hello()); // player, id 1
    b.emit(hello()); // player, id 2
    c.emit(hello()); // spectator, id 3
    expect(starts).toHaveLength(1);

    a.close(); // player A walks away

    expect(ends).toHaveLength(1); // the first match ended
    expect(starts).toHaveLength(2); // a fresh one began
    expect(arena.playerCount).toBe(2);
    expect(arena.spectatorCount).toBe(0);
    // C was promoted spectator -> player and got a PLAYER welcome.
    const wc = lastWelcome(c);
    expect(wc?.spectator).toBeUndefined();
    expect(wc?.yourNum).toBe(2); // seated after the survivor B
    expect(wc?.yourId).toBe(3);
    // B (survivor) rolled straight into the new match without reconnecting.
    expect(b.closed).toBe(false);
    expect(lastWelcome(b)?.yourNum).toBe(1);
  });

  it('a lone survivor waits when the queue is empty', () => {
    const { arena, starts, ends } = newArena();
    const a = new FakeSocket();
    const b = new FakeSocket();
    arena.add(a);
    arena.add(b);
    a.emit(hello());
    b.emit(hello());
    expect(starts).toHaveLength(1);

    a.close();
    expect(ends).toHaveLength(1);
    expect(arena.liveMatch).toBeNull();
    expect(arena.playerCount).toBe(1);
    expect(lastRoster(b)?.['you']).toMatchObject({ role: 'player', waiting: true });
  });

  it('drops a leaving spectator from the queue without touching the match', () => {
    const { arena, ends } = newArena();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const c = new FakeSocket();
    for (const s of [a, b, c]) arena.add(s);
    a.emit(hello());
    b.emit(hello());
    c.emit(hello());
    expect(arena.spectatorCount).toBe(1);

    c.close();
    expect(arena.spectatorCount).toBe(0);
    expect(ends).toHaveLength(0); // match untouched
    expect(arena.liveMatch).not.toBeNull();
  });
});

describe('Arena — rejects', () => {
  it('rejects a wrong-version hello and never seats it', () => {
    const { arena, starts } = newArena();
    const a = new FakeSocket();
    arena.add(a);
    a.emit(hello(PROTOCOL_VERSION + 1));
    const w = lastWelcome(a);
    expect(w?.result).not.toBe(undefined);
    expect(a.closed).toBe(true);
    expect(arena.playerCount).toBe(0);
    expect(starts).toHaveLength(0);
  });
});
