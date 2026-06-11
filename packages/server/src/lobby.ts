// The LOBBY (goal node 450): pairs visitors into 1v1 matches.
//
// Protocol-level contract: a fresh connection says nothing until the client
// sends a handshake HELLO. The first hello'd connection waits; the second one
// completes the pair and the lobby hands both sockets to `onPair` (production
// wraps them in a Match; tests assert the pairing itself). Visitors keep
// pairing two-by-two — a third visitor waits for a fourth, and so on. Matches
// run concurrently and independently; the lobby never tracks them.
//
// Hellos with a mismatched PROTOCOL_VERSION are rejected with a welcome
// (WrongVersion) and closed — a stale cached client can't poison a match.

import {
  ChatChannel,
  decodeMessage,
  encodeMessage,
  HandshakeResult,
  PROTOCOL_VERSION,
  type Message,
} from '@soldat/protocol';
import type { GameSocket } from './ws.js';

export type PairHandler = (a: GameSocket, b: GameSocket) => void;

/** Welcome-shaped reject helper (also used by tests). */
export function rejectMessage(result: HandshakeResult, reason: string): Message {
  return {
    kind: 'handshake',
    handshake: { kind: 'welcome', result, protocolVersion: PROTOCOL_VERSION, reason },
  };
}

/** Chat from "the server" (senderNum 255) — the lobby's waiting notice. */
export function serverChat(text: string): Message {
  return { kind: 'chat', senderNum: 255, channel: ChatChannel.Public, text };
}

export class Lobby {
  private waiting: GameSocket | null = null;
  private readonly onPair: PairHandler;

  constructor(onPair: PairHandler) {
    this.onPair = onPair;
  }

  /** Whether a hello'd visitor is currently waiting for an opponent. */
  get hasWaiting(): boolean {
    return this.waiting !== null;
  }

  /** Register a fresh connection; pairing happens once its hello arrives. */
  add(sock: GameSocket): void {
    let helloed = false;
    sock.onClose(() => {
      // A waiting visitor who leaves frees the slot for the next pair.
      if (this.waiting === sock) this.waiting = null;
    });
    sock.onMessage((data) => {
      if (helloed) return; // post-hello traffic belongs to the match
      let msg: Message;
      try {
        msg = decodeMessage(data);
      } catch {
        sock.close(1002);
        return;
      }
      if (msg.kind !== 'handshake' || msg.handshake.kind !== 'hello') return;
      if (msg.handshake.protocolVersion !== PROTOCOL_VERSION) {
        sock.send(
          encodeMessage(
            rejectMessage(
              HandshakeResult.WrongVersion,
              `server speaks protocol v${PROTOCOL_VERSION}`,
            ),
          ),
        );
        sock.close();
        return;
      }
      helloed = true;
      if (this.waiting === null) {
        this.waiting = sock;
        sock.send(encodeMessage(serverChat('queue:waiting')));
        return;
      }
      const a = this.waiting;
      this.waiting = null;
      this.onPair(a, sock);
    });
  }
}
