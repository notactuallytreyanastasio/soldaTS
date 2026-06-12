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
// clients AND to any spectators watching the stage (goal node 551).
//
// ACK CONTRACT (what makes client prediction work): the serverTick stamped on
// YOUR OWN sprite's snapshot is the clientTick of the LAST INPUT OF YOURS the
// server applied — exactly the number @soldat/netcode's PredictionBuffer
// needs to drop acknowledged inputs and replay the rest. Every other sprite
// (the opposing human, all four bots) is dead-reckoned client-side, so its
// snapshot's tick domain never matters; those carry the human owner's ack or
// the sim tick respectively. Spectators dead-reckon ALL six, so every sprite
// they receive carries the sim tick.
//
// MATCH START: the welcome's mapName recipe carries the deterministic arena,
// both engine choices, AND the gameplay variant —
// `arena=<A>&seed=<S>&e1=<idA>&e2=<idB>&variant=sidearm` — so each client can
// label teams ('YOU + WOLF vs STRANGER + HYDRA') and knows the era's rules
// without a new message type. The Arena reuses the same recipe to boot
// spectators.
//
// LIFECYCLE: the Match never owns socket message/close wiring and never closes
// a socket. The Arena (arena.ts) owns every participant socket, routes player
// inputs in via feedInput(), and disposes the match when a seat opens so the
// survivor's socket can roll straight into the next round.

import {
  ChatChannel,
  encodeMessage,
  HandshakeResult,
  PROTOCOL_VERSION,
  type InputFrame,
  type Message,
  type ScoreboardEntry,
} from '@soldat/protocol';
import { applyInputToSprite, captureSpriteSnapshotOne } from '@soldat/netcode';
import { Game, generateArena, engineIds, resolveWildcard, resolveVariant } from '@soldat/client/headless';
import type { GameSocket } from './ws.js';

/** THE SIDEARM ERA: online matches run the sidearm variant (AK demoted to a
 *  pistol; the wildcards are the stars). The welcome recipe carries it so
 *  clients can label/replay the exact rules. Sidearm touches only weapon
 *  knobs (fire/mag/reload/spread) — jet + respawn prediction client-side is
 *  untouched, ammo/reload already ride server snapshots. */
export const ONLINE_VARIANT = 'sidearm';

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

/** A player handed to the match: their socket plus their arena participant id. */
export interface MatchPlayer {
  readonly sock: GameSocket;
  /** Stable arena participant id (for the welcome's yourId / voice mesh). */
  readonly id: number;
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
  readonly id: number;
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
  /** The deterministic map recipe; the Arena boots spectators with it. */
  readonly recipe: string;
  /** Fires once when the match ends; production clears timers, Arena cycles. */
  onEnd: (() => void) | null = null;

  private readonly players: [PlayerSlot, PlayerSlot];
  /** Read-only spectator sockets that also receive snapshots/heartbeat/kills. */
  private readonly observers = new Set<GameSocket>();
  private lastSnapshotTick = 0;
  private lastHeartbeatTick = 0;
  private ended = false;

  constructor(a: MatchPlayer, b: MatchPlayer, opts: MatchOptions) {
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
      // Sidearm-era rules (see ONLINE_VARIANT).
      tuning: resolveVariant(ONLINE_VARIANT).tuning,
    });
    this.game.loadMap(arena.map);

    this.players = [
      { sock: a.sock, id: a.id, num: 1, queue: [], acked: -1, connected: true },
      { sock: b.sock, id: b.id, num: 2, queue: [], acked: -1, connected: true },
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

    // MATCH START: each player learns its slot (1 = red, 2 = blue), the
    // deterministic map recipe, both teams' engines, and its own participant id.
    this.recipe =
      `arena=${opts.arenaSeed}&seed=${opts.seed}` +
      `&e1=${encodeURIComponent(this.teamEngines[0])}&e2=${encodeURIComponent(this.teamEngines[1])}` +
      `&variant=${ONLINE_VARIANT}`;
    for (const p of this.players) {
      p.sock.send(
        encodeMessage({
          kind: 'handshake',
          handshake: {
            kind: 'welcome',
            result: HandshakeResult.Ok,
            protocolVersion: PROTOCOL_VERSION,
            yourNum: p.num,
            yourId: p.id,
            mapName: this.recipe,
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

  /** Stop the match and fire onEnd. Does NOT close sockets (the Arena owns them). */
  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd?.();
  }

  get isOver(): boolean {
    return this.ended;
  }

  // --- player wiring (driven by the Arena) -----------------------------------

  /** The sprite slot (1 or 2) of the player with this participant id, or null. */
  slotOfId(id: number): number | null {
    const p = this.players.find((p) => p.id === id);
    return p ? p.num : null;
  }

  /** Feed one validated input frame from the player in `num`. */
  feedInput(num: number, frame: InputFrame): void {
    if (this.ended) return;
    const p = this.players.find((p) => p.num === num);
    if (p === undefined || !p.connected) return;
    const last = p.queue[p.queue.length - 1];
    // Monotonic guard mirrors PredictionBuffer: stale/duplicate ticks drop.
    if (frame.clientTick <= (last?.clientTick ?? p.acked)) return;
    if (p.queue.length >= QUEUE_MAX) p.queue.shift();
    p.queue.push(frame);
  }

  /** Mark a player's socket gone (the Arena cycles a new round after this). */
  markGone(num: number): void {
    const p = this.players.find((p) => p.num === num);
    if (p !== undefined) p.connected = false;
  }

  /** The other player's participant id (for a 1v1 voice fallback), or null. */
  otherPlayerId(num: number): number | null {
    const other = this.players[num === 1 ? 1 : 0];
    return other ? other.id : null;
  }

  // --- spectators ------------------------------------------------------------

  addObserver(sock: GameSocket): void {
    this.observers.add(sock);
  }

  removeObserver(sock: GameSocket): void {
    this.observers.delete(sock);
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

  // --- outbound --------------------------------------------------------------

  private chat(text: string): Message {
    return { kind: 'chat', senderNum: 255, channel: ChatChannel.Public, text };
  }

  /** Send to both connected players and every spectator. */
  private broadcast(msg: Message): void {
    const buf = encodeMessage(msg);
    for (const p of this.players) {
      if (p.connected) p.sock.send(buf);
    }
    for (const sock of this.observers) sock.send(buf);
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
    // Players: their OWN sprite carries their ack (the prediction contract);
    // everything else carries the sim tick (dead-reckoned).
    for (const recipient of this.players) {
      if (!recipient.connected) continue;
      for (const num of MATCH_SPRITES) {
        const sprite = world.sprites[num];
        if (sprite === undefined || !sprite.active) continue;
        const human = this.players.find((p) => p.num === num);
        const tickStamp = human !== undefined ? human.acked : simTick;
        const snap = captureSpriteSnapshotOne(sprite, parts, tickStamp);
        recipient.sock.send(encodeMessage({ kind: 'spriteSnapshot', snapshot: snap }));
      }
    }
    // Spectators dead-reckon every sprite, so all six carry the sim tick. One
    // capture per sprite, shared across all observers.
    if (this.observers.size > 0) {
      for (const num of MATCH_SPRITES) {
        const sprite = world.sprites[num];
        if (sprite === undefined || !sprite.active) continue;
        const buf = encodeMessage({
          kind: 'spriteSnapshot',
          snapshot: captureSpriteSnapshotOne(sprite, parts, simTick),
        });
        for (const sock of this.observers) sock.send(buf);
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
