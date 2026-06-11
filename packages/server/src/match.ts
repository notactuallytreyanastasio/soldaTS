// One authoritative 1v1 MATCH (goal node 450).
//
// The server runs the SAME headless Game the browser runs (humanCount: 2,
// botCount: 0, red vs blue) on a generated arena, stepping at the fixed 60 Hz
// the Game's own accumulator enforces. Clients stream sequence-numbered
// InputFrames; the match applies at most a couple per sim tick (jitter
// buffer), and every 3rd tick (20 Hz) captures FULL sprite snapshots via
// @soldat/netcode and sends both sprites to both clients.
//
// ACK CONTRACT (what makes client prediction work): the serverTick stamped on
// YOUR OWN sprite's snapshot is the clientTick of the LAST INPUT OF YOURS the
// server applied — exactly the number @soldat/netcode's PredictionBuffer
// needs to drop acknowledged inputs and replay the rest. The opponent
// sprite's snapshot carries the opponent's ack (the client only dead-reckons
// from it, so its tick domain never matters there).
//
// Scoreboard rides Heartbeat (teamScore [red, blue] + per-player rows) every
// 30 ticks and immediately after every kill; kills also emit a structured
// server chat `kill:<killer>:<victim>:<weapon>` for the client's feed.
// Disconnect = the opponent wins: `end:disconnect:<winnerNum>` then close.
//
// V1 GAPS (documented, deliberate — see the goal node): weapon-swap and
// reload-state are server-authoritative but only ammo travels (snapshot
// ammoCount); the chance wildcard arms BOT carriers only, so with zero bots
// every 1v1 starts stock AK74 (players can still cycle weapons — the
// changeWeapon button rides the wire and the server swaps authoritatively).

import {
  ChatChannel,
  decodeMessage,
  encodeMessage,
  HandshakeResult,
  PROTOCOL_VERSION,
  type InputFrame,
  type Message,
  type ScoreboardEntry,
} from '@soldat/protocol';
import { applyInputToSprite, captureSpriteSnapshotOne } from '@soldat/netcode';
import { Game, generateArena } from '@soldat/client/headless';
import type { GameSocket } from './ws.js';

/** Sim ticks between snapshot batches: 3 -> 20 Hz at the 60 Hz sim rate. */
const SNAPSHOT_EVERY_TICKS = 3;
/** Sim ticks between scoreboard heartbeats (also sent on every kill). */
const HEARTBEAT_EVERY_TICKS = 30;
/** Input backlog above which the match applies 2 inputs/tick to catch up. */
const QUEUE_CATCHUP_DEPTH = 5;
/** Hard cap on a client's queued inputs (a stalled tab can't grow memory). */
const QUEUE_MAX = 240;

export interface MatchOptions {
  /** Deterministic world seed (random per match in production). */
  seed: number;
  /** Generated-arena seed (random per match in production). */
  arenaSeed: number;
}

interface PlayerSlot {
  readonly sock: GameSocket;
  /** Sprite index: 1 (red) or 2 (blue). */
  readonly num: number;
  readonly queue: InputFrame[];
  /** clientTick of the last input applied (-1 = none yet). */
  acked: number;
  connected: boolean;
}

export class Match {
  readonly game: Game;
  readonly options: MatchOptions;
  /** Fires once when the match ends (disconnect); production clears timers. */
  onEnd: (() => void) | null = null;

  private readonly players: [PlayerSlot, PlayerSlot];
  private lastSnapshotTick = 0;
  private lastHeartbeatTick = 0;
  private ended = false;

  constructor(a: GameSocket, b: GameSocket, opts: MatchOptions) {
    this.options = opts;
    const arena = generateArena(opts.arenaSeed);
    this.game = new Game({
      seed: opts.seed,
      spawns: arena.spawns,
      botCount: 0,
      humanCount: 2,
      teams: true,
    });
    this.game.loadMap(arena.map);

    this.players = [
      { sock: a, num: 1, queue: [], acked: -1, connected: true },
      { sock: b, num: 2, queue: [], acked: -1, connected: true },
    ];

    // Input application seam: onBrainsTicked fires once per SIM tick, after
    // (zero) brains and before firing/physics — the exact point the netcode
    // prediction tests apply inputs at, so server and client trajectories
    // match tick-for-tick.
    this.game.onBrainsTicked = (): void => this.applyQueuedInputs();

    this.game.onKill = (killer, victim): void => {
      const weapon = this.game.weaponNameOf(killer > 0 && killer !== victim ? killer : victim);
      this.broadcast(this.chat(`kill:${killer}:${victim}:${weapon}`));
      this.sendHeartbeat();
    };

    for (const p of this.players) {
      p.sock.onMessage((data) => this.onClientMessage(p, data));
      p.sock.onClose(() => this.onDisconnect(p));
    }

    // MATCH START: each player learns its slot (1 = red, 2 = blue) and the
    // deterministic map recipe via the welcome's mapName.
    const mapName = `arena=${opts.arenaSeed}&seed=${opts.seed}`;
    for (const p of this.players) {
      p.sock.send(
        encodeMessage({
          kind: 'handshake',
          handshake: {
            kind: 'welcome',
            result: HandshakeResult.Ok,
            protocolVersion: PROTOCOL_VERSION,
            yourNum: p.num,
            mapName,
            serverTick: 0,
          },
        }),
      );
    }
    this.sendHeartbeat();
  }

  /** Drive the match clock; production calls this from a ~16 ms interval. */
  tick(dtSeconds: number): void {
    if (this.ended) return;
    this.game.tick(dtSeconds);
    const now = this.game.world.mainTickCounter;
    if (now - this.lastSnapshotTick >= SNAPSHOT_EVERY_TICKS) {
      this.lastSnapshotTick = now;
      this.sendSnapshots();
    }
    if (now - this.lastHeartbeatTick >= HEARTBEAT_EVERY_TICKS) {
      this.lastHeartbeatTick = now;
      this.sendHeartbeat();
    }
  }

  /** Tear the match down (both sockets closed; timers are the caller's). */
  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    for (const p of this.players) p.sock.close();
    this.onEnd?.();
  }

  // --- inbound ---------------------------------------------------------------

  private onClientMessage(p: PlayerSlot, data: ArrayBuffer): void {
    if (this.ended) return;
    let msg: Message;
    try {
      msg = decodeMessage(data);
    } catch {
      return; // a malformed frame is dropped, not fatal
    }
    if (msg.kind === 'inputFrame') {
      const last = p.queue[p.queue.length - 1];
      // Monotonic guard mirrors PredictionBuffer: stale/duplicate ticks drop.
      if (msg.clientTick <= (last?.clientTick ?? p.acked)) return;
      if (p.queue.length >= QUEUE_MAX) p.queue.shift();
      p.queue.push(msg);
    }
    // Anything else (late hello, chat) is ignored in v1.
  }

  /** Per sim tick: apply 1 queued input per player (2 when backlogged). */
  private applyQueuedInputs(): void {
    for (const p of this.players) {
      let apply = p.queue.length > QUEUE_CATCHUP_DEPTH ? 2 : 1;
      while (apply > 0 && p.queue.length > 0) {
        const input = p.queue.shift()!;
        applyInputToSprite(this.game.world, p.num, input);
        p.acked = input.clientTick;
        apply -= 1;
      }
    }
  }

  private onDisconnect(p: PlayerSlot): void {
    if (this.ended || !p.connected) return;
    p.connected = false;
    const other = this.players[p.num === 1 ? 1 : 0]!;
    if (other.connected) {
      other.sock.send(encodeMessage(this.chat(`end:disconnect:${other.num}`)));
    }
    this.dispose();
  }

  // --- outbound ----------------------------------------------------------------

  private chat(text: string): Message {
    return { kind: 'chat', senderNum: 255, channel: ChatChannel.Public, text };
  }

  private broadcast(msg: Message): void {
    const buf = encodeMessage(msg);
    for (const p of this.players) {
      if (p.connected) p.sock.send(buf);
    }
  }

  private sendSnapshots(): void {
    const world = this.game.world;
    const parts = world.spriteParts;
    if (parts === null) return;
    // Wire ammo is the Game's per-slot magazine (sprite.bulletCount is an
    // unused Pascal mirror otherwise) — copy it in so the HUD can show it.
    for (const p of this.players) {
      const s = world.sprites[p.num];
      if (s !== undefined) s.bulletCount = this.game.ammoOf(p.num);
    }
    for (const recipient of this.players) {
      if (!recipient.connected) continue;
      for (const subject of this.players) {
        const sprite = world.sprites[subject.num];
        if (sprite === undefined || !sprite.active) continue;
        const snap = captureSpriteSnapshotOne(sprite, parts, subject.acked);
        recipient.sock.send(encodeMessage({ kind: 'spriteSnapshot', snapshot: snap }));
      }
    }
  }

  private sendHeartbeat(): void {
    const rows: ScoreboardEntry[] = this.players.map((p) => ({
      num: p.num,
      active: p.connected,
      team: this.game.teamOf(p.num),
      kills: this.game.killsOf(p.num),
      deaths: this.game.deathsOf(p.num),
      caps: 0,
      ping: 0,
      realPing: 0,
      connectionQuality: 0,
      flags: 0,
    }));
    const red = rows.find((r) => r.team === 1)?.kills ?? 0;
    const blue = rows.find((r) => r.team === 2)?.kills ?? 0;
    this.broadcast({
      kind: 'heartbeat',
      mapId: this.options.arenaSeed,
      teamScore: [red, blue],
      players: rows,
    });
  }
}
