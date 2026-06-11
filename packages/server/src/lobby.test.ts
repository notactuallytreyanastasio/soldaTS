// Lobby pairing tests — fake sockets, no transport.
import { describe, it, expect } from 'vitest';
import {
  decodeMessage,
  encodeMessage,
  HandshakeResult,
  PROTOCOL_VERSION,
  type Message,
} from '@soldat/protocol';
import { Lobby } from './lobby';
import type { GameSocket } from './ws';

export class FakeSocket implements GameSocket {
  readonly sent: Message[] = [];
  closed = false;
  private msgCb: ((data: ArrayBuffer) => void) | null = null;
  private closeCb: (() => void) | null = null;

  send(data: ArrayBuffer): void {
    this.sent.push(decodeMessage(data));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCb?.();
  }
  onMessage(cb: (data: ArrayBuffer) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  /** Test driver: deliver a message as if the peer sent it. */
  emit(msg: Message): void {
    this.msgCb?.(encodeMessage(msg));
  }
}

export function hello(protocolVersion: number = PROTOCOL_VERSION): Message {
  return {
    kind: 'handshake',
    handshake: {
      kind: 'hello',
      protocolVersion,
      gameVersion: '1',
      haveAntiCheat: false,
      hardwareId: '',
      password: '',
      name: 'stranger',
      team: 0,
      look: 0,
      modChecksum: '',
    },
  };
}

describe('Lobby', () => {
  it('pairs the first two hello’d visitors into one match', () => {
    const pairs: [GameSocket, GameSocket][] = [];
    const lobby = new Lobby((a, b) => pairs.push([a, b]));
    const a = new FakeSocket();
    const b = new FakeSocket();
    lobby.add(a);
    lobby.add(b);
    expect(pairs).toHaveLength(0); // no hellos yet — nothing pairs

    a.emit(hello());
    expect(pairs).toHaveLength(0);
    expect(lobby.hasWaiting).toBe(true);
    // The waiting visitor is told it's queued.
    expect(a.sent.some((m) => m.kind === 'chat' && m.text === 'queue:waiting')).toBe(true);

    b.emit(hello());
    expect(pairs).toHaveLength(1);
    expect(pairs[0]![0]).toBe(a);
    expect(pairs[0]![1]).toBe(b);
    expect(lobby.hasWaiting).toBe(false);
  });

  it('queues the third visitor for the next match', () => {
    const pairs: [GameSocket, GameSocket][] = [];
    const lobby = new Lobby((a, b) => pairs.push([a, b]));
    const socks = [new FakeSocket(), new FakeSocket(), new FakeSocket(), new FakeSocket()];
    for (const s of socks) {
      lobby.add(s);
      s.emit(hello());
    }
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual([socks[0], socks[1]]);
    expect(pairs[1]).toEqual([socks[2], socks[3]]);
  });

  it('frees the waiting slot when the waiting visitor disconnects', () => {
    const pairs: [GameSocket, GameSocket][] = [];
    const lobby = new Lobby((a, b) => pairs.push([a, b]));
    const a = new FakeSocket();
    lobby.add(a);
    a.emit(hello());
    expect(lobby.hasWaiting).toBe(true);
    a.close();
    expect(lobby.hasWaiting).toBe(false);

    const c = new FakeSocket();
    const d = new FakeSocket();
    lobby.add(c);
    lobby.add(d);
    c.emit(hello());
    d.emit(hello());
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual([c, d]);
  });

  it('rejects a protocol-version mismatch with WrongVersion and closes', () => {
    const pairs: [GameSocket, GameSocket][] = [];
    const lobby = new Lobby((a, b) => pairs.push([a, b]));
    const stale = new FakeSocket();
    lobby.add(stale);
    stale.emit(hello(PROTOCOL_VERSION + 1));
    expect(pairs).toHaveLength(0);
    expect(stale.closed).toBe(true);
    const welcome = stale.sent.find((m) => m.kind === 'handshake');
    expect(welcome).toBeDefined();
    if (welcome?.kind === 'handshake' && welcome.handshake.kind === 'welcome') {
      expect(welcome.handshake.result).toBe(HandshakeResult.WrongVersion);
    } else {
      throw new Error('expected a welcome reject');
    }
  });
});
