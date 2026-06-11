// One authoritative TEAM-vs-TEAM MATCH (goal node 450, team upgrade).
//
// The server runs the SAME headless Game the browser runs — now 3v3:
// humanCount: 2 (slots 1 red / 2 blue) + botCount: 4 (slots 3..6, alternating
// red/blue), teams on, combat on (bots perceive and fight). Each human's
// CHOSEN ENGINE drives their team's bots via Game's per-team engine rule:
// aiEngine 'e1,e2' assigns group 0 (player A's pick) to team 1 and group 1
// (player B's pick) to team 2. Unknown/empty choices fall back to 'classic'
// (with a warn). The chance wildcard rolls per match exactly like local play —
// bot carriers exist now, so online matches can open with a SPAS/Barrett/M79/
// ricochet/chainsaw carrier per team; humans always keep their own stock slots.
//
// The match steps at the fixed 60 Hz the Game's accumulator enforces. Clients
// stream sequence-numbered InputFrames; the match applies at most a couple per
// sim tick (jitter buffer), and every 3rd tick (20 Hz) captures FULL sprite
// snapshots via @soldat/netcode for ALL SIX sprites and sends them to both
// clients.
//
// ACK CONTRACT (what makes client prediction work): the serverTick stamped on
// YOUR OWN sprite's snapshot is the clientTick of the LAST INPUT OF YOURS the
// server applied — exactly the number @soldat/netcode's PredictionBuffer
// needs to drop acknowledged inputs and replay the rest. Every other sprite
// (the opposing human, all four bots) is dead-reckoned client-side, so its
// snapshot's tick domain never matters; those carry the human owner's ack or
// the sim tick respectively.
//
// MATCH START: the welcome's mapName recipe carries the deterministic arena
// AND both engine choices — `arena=<A>&seed=<S>&e1=<idA>&e2=<idB>` — so each
// client can label teams ('YOU + WOLF vs STRANGER + HYDRA') without a new
// message type.
//
// Scoreboard rides Heartbeat (teamScore [red, blue] summed across each team +
// per-sprite rows, bots included) every 30 ticks and immediately after every
// kill; kills also emit a structured server chat `kill:<killer>:<victim>:
// <weapon>` for the client's feed (bot nums 3..6 — the client attributes them
// to engine names).
//
// V1 GAPS that REMAIN (documented, deliberate): weapon-swap and reload-state
// are server-authoritative but only ammo travels (snapshot ammoCount).

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
import { Game, generateArena, engineIds, resolveWildcard } from '@soldat/client/headless';
import type { GameSocket } from './ws.js';

/** Sim ticks between snapshot batches: 3 -> 20 Hz at the 60 Hz sim rate. */
const SNAPSHOT_EVERY_TICKS = 3;
/** Sim ticks between scoreboard heartbeats (also sent on every kill). */
const HEARTBEAT_EVERY_TICKS = 30;
/** Input backlog above which the match applies 2 inputs/tick to catch up. */
const QUEUE_CATCHUP_DEPTH = 5;
/** Hard cap on a client's queued inputs (a stalled tab can't grow memory). */
const QUEUE_MAX = 240;
/** Bots per match (2 per team): 3v3 = 1 human + 2 bots a side. */
export const MATCH_BOT_COUNT = 4;
/** All sprite slots in a match: humans 1..2, bots 3..6. */
export const MATCH_SPRITES = [1, 2, 3, 4, 5, 6] as const;

export interface MatchOptions {
  /** Deterministic world seed (random per match in production). */
  seed: number;
  /** Generated-arena seed (random per match in production). */
  arenaSeed: number;
  /** Raw engine choices from the hellos: [player A's, player B's]. */
  engines: [string, string];
}

/**
 * Sanitise one hello engine choice: a registered id passes through, anything
 * else ('' included) falls back to 'classic'. Warns on a real unknown so a
 * client bug is visible in the server log without poisoning the match.
 */
export function sanitizeEngineChoice(raw: string): string {
  const id = raw.trim();
  if ((engineIds() as readonly string[]).includes(id)) return id;
  if (id !== '') {
    console.warn(`[match] unknown engine choice '${id}' — falling back to 'classic'`);
  }
  return 'classic';
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
  /** Sanitised per-team engine ids: [team 1 (red), team 2 (blue)]. */
  readonly teamEngines: [string, string];
  /** Fires once when the match ends (disconnect); production clears timers. */
  onEnd: (() => void) | null = null;

  private readonly players: [PlayerSlot, PlayerSlot];
  private lastSnapshotTick = 0;
  private lastHeartbeatTick = 0;
  private ended = false;

  constructor(a: GameSocket, b: GameSocket, opts: MatchOptions) {
    this.options = opts;
    this.teamEngines = [
      sanitizeEngineChoice(opts.engines[0]),
      sanitizeEngineChoice(opts.engines[1]),
    ];
    const arena = generateArena(opts.arenaSeed);
    this.game = new Game({
      seed: opts.seed,
      spawns: arena.spawns,
      botCount: MATCH_BOT_COUNT,
      humanCount: 2,
      teams: true,
      combat: true,
      // Per-team engine rule: group 0 → team 1 (player A), group 1 → team 2
      // (player B). Identical picks collapse to one group; teams alternate.
      aiEngine: `${this.teamEngines[0]},${this.teamEngines[1]}`,
      // Same seeded chance roll local play uses — bot carriers exist online
      // now, so a lucky seed arms one wildcard carrier per team.
      wildcard: resolveWildcard('chance', opts.seed),
    });
    this.game.loadMap(arena.map);

    this.players = [
      { sock: a, num: 1, queue: [], acked: -1, connected: true },
      { sock: b, num: 2, queue: [], acked: -1, connected: true },
    ];

    // Input application seam: onBrainsTicked fires once per SIM tick, after
    // the four bot brains and before firing/physics — the exact point the
    // netcode prediction tests apply inputs at, so server and client
    // trajectories match tick-for-tick.
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

    // MATCH START: each player learns its slot (1 = red, 2 = blue), the
    // deterministic map recipe, and BOTH teams' engines via the welcome's
    // mapName.
    const mapName =
      `arena=${opts.arenaSeed}&seed=${opts.seed}` +
      `&e1=${encodeURIComponent(this.teamEngines[0])}&e2=${encodeURIComponent(this.teamEngines[1])}`;
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
    for (const num of MATCH_SPRITES) {
      const s = world.sprites[num];
      if (s !== undefined) s.bulletCount = this.game.ammoOf(num);
    }
    const simTick = world.mainTickCounter;
    for (const recipient of this.players) {
      if (!recipient.connected) continue;
      for (const num of MATCH_SPRITES) {
        const sprite = world.sprites[num];
        if (sprite === undefined || !sprite.active) continue;
        // Humans carry THEIR ack (the recipient's own one is the prediction
        // contract; the opponent's is dead-reckoned, domain irrelevant).
        // Bots carry the sim tick — also dead-reckoned, also irrelevant.
        const human = this.players.find((p) => p.num === num);
        const tickStamp = human !== undefined ? human.acked : simTick;
        const snap = captureSpriteSnapshotOne(sprite, parts, tickStamp);
        recipient.sock.send(encodeMessage({ kind: 'spriteSnapshot', snapshot: snap }));
      }
    }
  }

  private sendHeartbeat(): void {
    const rows: ScoreboardEntry[] = MATCH_SPRITES.map((num) => {
      const human = this.players.find((p) => p.num === num);
      return {
        num,
        active: human !== undefined ? human.connected : true,
        team: this.game.teamOf(num),
        kills: this.game.killsOf(num),
        deaths: this.game.deathsOf(num),
        caps: 0,
        ping: 0,
        realPing: 0,
        connectionQuality: 0,
        flags: 0,
      };
    });
    // TEAM score = the SUM of each side's kills (humans + their bots).
    let red = 0;
    let blue = 0;
    for (const r of rows) {
      if (r.team === 1) red += r.kills;
      else if (r.team === 2) blue += r.kills;
    }
    this.broadcast({
      kind: 'heartbeat',
      mapId: this.options.arenaSeed,
      teamScore: [red, blue],
      players: rows,
    });
  }
}
