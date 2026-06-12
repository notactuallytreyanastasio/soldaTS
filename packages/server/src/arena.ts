// THE ARENA — one global stage (goal node 551).
//
// Supersedes the two-by-two Lobby: instead of spawning independent concurrent
// 1v1s, every visitor joins ONE shared stage. The first two hello'd visitors
// are the PLAYERS; everyone after them is a SPECTATOR who watches the live
// match, can text-chat, and joins the voice mesh. When a player's socket drops,
// the match ends and a fresh one starts immediately, pairing the survivor with
// the head of the spectator queue (clean-restart cycling — no reload, no
// mid-match hot-swap of the deterministic sim).
//
// The Arena owns EVERY participant socket's message/close wiring and routes:
//   - inputFrame from a player        -> match.feedInput(slot, frame)
//   - voice from anyone               -> mesh relay to the addressed peer
//   - chat from anyone                -> `say:<id>:<text>` to everyone
// Match (match.ts) is a pure per-round game that never touches socket lifecycle.
//
// Each participant is told the roster over a structured server chat
// (`arena:<json>`) carrying the player ids, the spectator count, this client's
// role + queue position, and the full participant id list (the voice-mesh peer
// set). Clients reconcile their mesh and UI from it.

import {
  ChatChannel,
  decodeMessage,
  DecodeError,
  encodeMessage,
  HandshakeResult,
  PROTOCOL_VERSION,
  type Message,
} from '@soldat/protocol';
import { Match, type MatchOptions } from './match.js';
import type { GameSocket } from './ws.js';

interface Participant {
  readonly id: number;
  readonly sock: GameSocket;
  /** Chosen bot engine from the hello ('' = none); Match sanitises. */
  engine: string;
  helloed: boolean;
  /** 'player' once seated, 'spectator' while queued, null before hello. */
  role: 'player' | 'spectator' | null;
  /** Sprite slot 1/2 once a match seats this player. */
  num: number | null;
}

/** A reject welcome (stale/incompatible client). */
function rejectMessage(result: HandshakeResult, reason: string): Message {
  return {
    kind: 'handshake',
    handshake: { kind: 'welcome', result, protocolVersion: PROTOCOL_VERSION, reason },
  };
}

function serverChat(text: string): Message {
  return { kind: 'chat', senderNum: 255, channel: ChatChannel.Public, text };
}

export interface ArenaCallbacks {
  /** Start driving this match's clock (production: a ~16 ms interval). */
  onMatchStart?: (match: Match) => void;
  /** Stop driving the match that just ended. */
  onMatchEnd?: (match: Match) => void;
  /** Per-match seeds; injectable so tests are deterministic. */
  rollSeeds?: () => { seed: number; arenaSeed: number };
}

export class Arena {
  private readonly participants = new Map<number, Participant>();
  /** The (≤2) participants designated as players, in seat order. */
  private seated: Participant[] = [];
  /** Spectators waiting for a seat, head = next up. */
  private queue: Participant[] = [];
  private match: Match | null = null;
  private nextId = 1;

  private readonly cb: ArenaCallbacks;

  constructor(cb: ArenaCallbacks = {}) {
    this.cb = cb;
  }

  // --- introspection (tests) -------------------------------------------------

  get liveMatch(): Match | null {
    return this.match;
  }
  get playerCount(): number {
    return this.seated.length;
  }
  get spectatorCount(): number {
    return this.queue.length;
  }

  // --- connection lifecycle --------------------------------------------------

  /** Register a fresh socket; role is decided once its hello arrives. */
  add(sock: GameSocket): void {
    const p: Participant = {
      id: this.nextId++,
      sock,
      engine: '',
      helloed: false,
      role: null,
      num: null,
    };
    this.participants.set(p.id, p);
    sock.onMessage((data) => this.onMessage(p, data));
    sock.onClose(() => this.onClose(p));
  }

  private onMessage(p: Participant, data: ArrayBuffer): void {
    let msg: Message;
    try {
      msg = decodeMessage(data);
    } catch (err) {
      if (!p.helloed && err instanceof DecodeError && err.kind === 'version-mismatch') {
        p.sock.send(
          encodeMessage(
            rejectMessage(HandshakeResult.WrongVersion, `server speaks protocol v${PROTOCOL_VERSION}`),
          ),
        );
        p.sock.close();
      }
      return;
    }

    if (!p.helloed) {
      // Pre-hello: only a valid handshake hello advances; anything else waits.
      if (msg.kind !== 'handshake' || msg.handshake.kind !== 'hello') return;
      if (msg.handshake.protocolVersion !== PROTOCOL_VERSION) {
        p.sock.send(
          encodeMessage(
            rejectMessage(HandshakeResult.WrongVersion, `server speaks protocol v${PROTOCOL_VERSION}`),
          ),
        );
        p.sock.close();
        return;
      }
      p.helloed = true;
      p.engine = msg.handshake.engine;
      this.admit(p);
      return;
    }

    // Post-hello routing.
    if (msg.kind === 'inputFrame') {
      if (p.role === 'player' && p.num !== null && this.match !== null) {
        this.match.feedInput(p.num, msg);
      }
      return;
    }
    if (msg.kind === 'voice') {
      // Mesh relay: deliver to the addressed peer, rewriting `peer` to the
      // SENDER so the receiver learns the source. Never echoed back.
      const target = this.participants.get(msg.peer);
      if (target !== undefined && target.id !== p.id) {
        target.sock.send(encodeMessage({ kind: 'voice', peer: p.id, data: msg.data }));
      }
      return;
    }
    if (msg.kind === 'chat') {
      // Relay text to everyone as `say:<id>:<text>`; clients label by roster.
      this.broadcastAll(serverChat(`say:${p.id}:${msg.text}`));
      return;
    }
  }

  private onClose(p: Participant): void {
    if (!this.participants.has(p.id)) return;
    this.participants.delete(p.id);

    const wasSeated = this.seated.includes(p);
    this.seated = this.seated.filter((x) => x !== p);
    this.queue = this.queue.filter((x) => x !== p);
    if (this.match !== null) this.match.removeObserver(p.sock);

    if (wasSeated && this.match !== null) {
      // A player dropped: end the round and cycle a fresh one.
      if (p.num !== null) this.match.markGone(p.num);
      this.endMatch();
      this.fillAndStart();
    } else {
      // A spectator left (or a seated player with no live match yet).
      this.fillAndStart();
      this.broadcastRoster();
    }
  }

  // --- seating + matchmaking -------------------------------------------------

  /** Place a freshly hello'd participant as a player or a spectator. */
  private admit(p: Participant): void {
    if (this.seated.length < 2 && this.match === null) {
      p.role = 'player';
      this.seated.push(p);
      this.fillAndStart(); // starts at two, else broadcasts the "waiting" roster
    } else {
      p.role = 'spectator';
      this.queue.push(p);
      if (this.match !== null) {
        this.match.addObserver(p.sock);
        this.sendSpectatorWelcome(p, this.match);
      }
      this.broadcastRoster();
    }
  }

  /** Promote queued spectators into empty seats; start a match at two. */
  private fillAndStart(): void {
    if (this.match !== null) return;
    while (this.seated.length < 2 && this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.role = 'player';
      this.seated.push(next);
    }
    if (this.seated.length === 2) {
      this.startMatch();
    } else {
      this.broadcastRoster(); // lone player waits for an opponent
    }
  }

  private startMatch(): void {
    const [a, b] = this.seated as [Participant, Participant];
    const seeds = this.cb.rollSeeds?.() ?? { seed: roll(99999), arenaSeed: roll(999) };
    const opts: MatchOptions = {
      seed: seeds.seed,
      arenaSeed: seeds.arenaSeed,
      engines: [a.engine, b.engine],
    };
    const match = new Match({ sock: a.sock, id: a.id }, { sock: b.sock, id: b.id }, opts);
    a.num = match.slotOfId(a.id);
    b.num = match.slotOfId(b.id);
    this.match = match;
    match.onEnd = (): void => {
      this.cb.onMatchEnd?.(match);
      if (this.match === match) this.match = null;
    };
    // Every queued spectator watches this match.
    for (const s of this.queue) {
      match.addObserver(s.sock);
      this.sendSpectatorWelcome(s, match);
    }
    this.cb.onMatchStart?.(match);
    this.broadcastRoster();
  }

  /** Dispose the live match (fires onEnd, which clears this.match). */
  private endMatch(): void {
    const m = this.match;
    if (m === null) return;
    m.dispose();
  }

  // --- messaging -------------------------------------------------------------

  private sendSpectatorWelcome(p: Participant, match: Match): void {
    p.sock.send(
      encodeMessage({
        kind: 'handshake',
        handshake: {
          kind: 'welcome',
          result: HandshakeResult.Ok,
          protocolVersion: PROTOCOL_VERSION,
          spectator: true,
          yourId: p.id,
          mapName: match.recipe,
          serverTick: 0,
        },
      }),
    );
  }

  private broadcastAll(msg: Message): void {
    const buf = encodeMessage(msg);
    for (const part of this.participants.values()) {
      if (part.helloed) part.sock.send(buf);
    }
  }

  /** Tell every participant the roster + their place + the voice peer set. */
  private broadcastRoster(): void {
    const players = this.seated.filter((p) => p.helloed).map((p) => p.id);
    const peerIds = [...this.participants.values()].filter((p) => p.helloed).map((p) => p.id);
    const spectators = this.queue.length;
    for (const part of this.participants.values()) {
      if (!part.helloed) continue;
      const queuePos = part.role === 'spectator' ? this.queue.indexOf(part) + 1 : 0;
      const roster = {
        players,
        spectators,
        peers: peerIds,
        you: { id: part.id, role: part.role, queuePos, waiting: this.match === null && part.role === 'player' },
      };
      part.sock.send(encodeMessage(serverChat(`arena:${JSON.stringify(roster)}`)));
    }
  }
}

/** Random int in [1, max] — seeds only (the sim itself uses world.rng). */
function roll(max: number): number {
  return 1 + Math.floor(Math.random() * max);
}
