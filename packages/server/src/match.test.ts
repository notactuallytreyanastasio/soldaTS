// Authoritative-match tests: welcome/teams/engines, input→step→snapshot round
// trip (the netcode ack contract), 3v3 replication, kills, engine fallback,
// and disconnect handling — all over fake sockets, no timers (the test drives
// match.tick directly).
import { describe, it, expect, vi } from 'vitest';
import {
  HandshakeResult,
  Posture,
  type Buttons,
  type InputFrame,
  type Message,
  type SpriteSnapshotFull,
} from '@soldat/protocol';
import { Match, MATCH_SPRITES, sanitizeEngineChoice } from './match';
import { FakeSocket } from './lobby.test';

const OPTS = { seed: 7, arenaSeed: 5, engines: ['wolf', 'hydra'] as [string, string] };
const DT = 1 / 60;

function buttons(over: Partial<Buttons> = {}): Buttons {
  return {
    left: false,
    right: false,
    up: false,
    down: false,
    fire: false,
    jetpack: false,
    throwNade: false,
    changeWeapon: false,
    throwWeapon: false,
    reload: false,
    flagThrow: false,
    ...over,
  };
}

function input(tick: number, over: Partial<Buttons> = {}, aim = { x: 100, y: 0 }): Message {
  const frame: InputFrame = {
    clientTick: tick,
    buttons: buttons(over),
    aim,
    posture: Posture.Standing,
  };
  return { kind: 'inputFrame', ...frame };
}

function snapshotsOf(sock: FakeSocket, num: number): SpriteSnapshotFull[] {
  const out: SpriteSnapshotFull[] = [];
  for (const m of sock.sent) {
    if (m.kind === 'spriteSnapshot' && m.snapshot.kind === 'full' && m.snapshot.num === num) {
      out.push(m.snapshot);
    }
  }
  return out;
}

describe('Match — pairing handshake', () => {
  it('welcomes both players with opposite slots/teams and the same recipe', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const match = new Match(a, b, OPTS);

    const welcomes = [a, b].map((s) => {
      const w = s.sent.find((m) => m.kind === 'handshake');
      if (w?.kind !== 'handshake' || w.handshake.kind !== 'welcome') {
        throw new Error('expected a welcome');
      }
      return w.handshake;
    });
    expect(welcomes[0]!.result).toBe(HandshakeResult.Ok);
    expect(welcomes[1]!.result).toBe(HandshakeResult.Ok);
    expect(welcomes[0]!.yourNum).toBe(1);
    expect(welcomes[1]!.yourNum).toBe(2);
    // Match-start carries BOTH engine choices in the recipe.
    expect(welcomes[0]!.mapName).toBe('arena=5&seed=7&e1=wolf&e2=hydra');
    expect(welcomes[1]!.mapName).toBe(welcomes[0]!.mapName);

    // Red vs blue, by slot.
    expect(match.game.teamOf(1)).toBe(1);
    expect(match.game.teamOf(2)).toBe(2);
    match.dispose();
  });
});

describe('Match — team engines (3v3)', () => {
  it("arms player A's engine on team 1's bots and player B's on team 2's", () => {
    const match = new Match(new FakeSocket(), new FakeSocket(), OPTS);
    // Bots are slots 3..6, alternating red/blue; whole team = one engine.
    expect(match.game.engineOf(3)).toBe('wolf');
    expect(match.game.engineOf(4)).toBe('hydra');
    expect(match.game.engineOf(5)).toBe('wolf');
    expect(match.game.engineOf(6)).toBe('hydra');
    expect(match.game.teamOf(3)).toBe(1);
    expect(match.game.teamOf(4)).toBe(2);
    expect(match.game.teamOf(5)).toBe(1);
    expect(match.game.teamOf(6)).toBe(2);
    match.dispose();
  });

  it('rolls the chance wildcard per match — bot carriers only, humans keep their slots', () => {
    // Seed 7 rolls ARMED ('ricochet' under the spectacle weighting); one carrier per team.
    const armed = new Match(new FakeSocket(), new FakeSocket(), OPTS);
    const carriers = armed.game.wildcardCarriers();
    expect(armed.game.wildcard).toBe('ricochet');
    expect(carriers).toHaveLength(2);
    for (const c of carriers) {
      expect(c).toBeGreaterThanOrEqual(3); // never a human slot
      expect(c).toBeLessThanOrEqual(6);
    }
    expect(new Set(carriers.map((c) => armed.game.teamOf(c))).size).toBe(2); // one per team
    armed.dispose();

    // Seed 3 rolls STOCK: nobody carries.
    const stock = new Match(new FakeSocket(), new FakeSocket(), { ...OPTS, seed: 3 });
    expect(stock.game.wildcard).toBeUndefined();
    expect(stock.game.wildcardCarriers()).toHaveLength(0);
    stock.dispose();
  });

  it('runs the same engine on both teams when both players pick it', () => {
    const match = new Match(new FakeSocket(), new FakeSocket(), {
      ...OPTS,
      engines: ['wolf', 'wolf'],
    });
    for (const num of [3, 4, 5, 6]) expect(match.game.engineOf(num)).toBe('wolf');
    expect(match.game.teamOf(3)).toBe(1);
    expect(match.game.teamOf(4)).toBe(2);
    match.dispose();
  });

  it("falls back to 'classic' (with a warn) on an unknown or empty choice", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(sanitizeEngineChoice('not-a-brain')).toBe('classic');
    expect(warn).toHaveBeenCalledOnce();
    expect(sanitizeEngineChoice('')).toBe('classic'); // empty = quiet default
    expect(warn).toHaveBeenCalledOnce();
    expect(sanitizeEngineChoice('hydra')).toBe('hydra');
    warn.mockRestore();

    const warn2 = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const match = new Match(new FakeSocket(), new FakeSocket(), {
      ...OPTS,
      engines: ['garbage', ''],
    });
    expect(match.teamEngines).toEqual(['classic', 'classic']);
    expect(match.game.engineOf(3)).toBe('classic');
    expect(match.game.engineOf(4)).toBe('classic');
    warn2.mockRestore();
    match.dispose();
  });
});

describe('Match — 3v3 snapshot replication', () => {
  it('streams full snapshots of all six sprites to both clients', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const match = new Match(a, b, OPTS);
    for (let t = 0; t < 30; t++) match.tick(DT);
    for (const sock of [a, b]) {
      for (const num of MATCH_SPRITES) {
        expect(snapshotsOf(sock, num).length, `sprite ${num}`).toBeGreaterThan(0);
      }
    }
    // Heartbeat rows cover all six sprites with their teams.
    const hb = [...a.sent].reverse().find((m) => m.kind === 'heartbeat');
    if (hb?.kind !== 'heartbeat') throw new Error('expected a heartbeat');
    expect(hb.players.map((p) => p.num)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(hb.players.map((p) => p.team)).toEqual([1, 2, 1, 2, 1, 2]);
    match.dispose();
  });
});

describe('Match — input → step → snapshot round trip', () => {
  it("moves A's sprite in the snapshots B receives, with A's inputs acked", () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const match = new Match(a, b, OPTS);

    // Let both sprites settle (no inputs), then capture A's resting x.
    for (let t = 0; t < 30; t++) match.tick(DT);
    const before = snapshotsOf(b, 1).at(-1)!;

    // A runs right for a second; B idles.
    for (let t = 1; t <= 60; t++) {
      a.emit(input(t, { right: true }));
      match.tick(DT);
    }

    const after = snapshotsOf(b, 1).at(-1)!;
    expect(after.pos.x).toBeGreaterThan(before.pos.x + 10);

    // ACK CONTRACT: A's own-sprite snapshots carry A's last applied
    // clientTick as serverTick (what PredictionBuffer reconciles against).
    const ownSnaps = snapshotsOf(a, 1);
    expect(ownSnaps.at(-1)!.serverTick).toBe(60);
    // B sent nothing: its ack stays -1 on its own snapshots.
    expect(snapshotsOf(b, 2).at(-1)!.serverTick).toBe(-1);
    match.dispose();
  });

  it('registers a kill (chat + heartbeat) when A shoots B point-blank', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const match = new Match(a, b, OPTS);
    const world = match.game.world;
    const parts = world.spriteParts!;

    // Pin B just right of A every tick (gravity would otherwise drop it) and
    // have A hold fire aiming right.
    for (let t = 1; t <= 400; t++) {
      parts.posX[2] = parts.posX[1]! + 60;
      parts.posY[2] = parts.posY[1]!;
      parts.oldX[2] = parts.posX[2]!;
      parts.oldY[2] = parts.posY[2]!;
      parts.velocityX[2] = 0;
      parts.velocityY[2] = 0;
      a.emit(input(t, { fire: true }));
      match.tick(DT);
      if (match.game.killsOf(1) > 0) break;
    }

    expect(match.game.killsOf(1)).toBeGreaterThan(0);
    const kill = b.sent.find((m) => m.kind === 'chat' && m.text.startsWith('kill:1:2:'));
    expect(kill).toBeDefined();
    const lastHb = [...b.sent].reverse().find((m) => m.kind === 'heartbeat');
    if (lastHb?.kind !== 'heartbeat') throw new Error('expected a heartbeat');
    expect(lastHb.teamScore[0]).toBeGreaterThan(0); // red leads
    expect(lastHb.players.find((p) => p.num === 2)?.deaths).toBeGreaterThan(0);
    match.dispose();
  });
});

describe('Match — disconnect', () => {
  it('tells the survivor it won and closes the match', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const match = new Match(a, b, OPTS);
    for (let t = 0; t < 10; t++) match.tick(DT);

    let ended = false;
    match.onEnd = (): void => {
      ended = true;
    };
    a.close(); // player A walks away

    const endMsg = b.sent.find((m) => m.kind === 'chat' && m.text.startsWith('end:disconnect:'));
    expect(endMsg).toBeDefined();
    if (endMsg?.kind === 'chat') expect(endMsg.text).toBe('end:disconnect:2');
    expect(b.closed).toBe(true);
    expect(ended).toBe(true);

    // A dead match never ticks again (no throw, no new traffic).
    const sentBefore = b.sent.length;
    match.tick(DT);
    expect(b.sent.length).toBe(sentBefore);
  });
});

describe('Match — voice signaling relay', () => {
  it('relays a voice frame to the OTHER player only, verbatim', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    new Match(a, b, OPTS);
    const sentBeforeA = a.sent.length;
    const sentBeforeB = b.sent.length;

    a.emit({ kind: 'voice', data: '{"sdp":"offer-from-a"}' });
    expect(b.sent[b.sent.length - 1]).toEqual({ kind: 'voice', data: '{"sdp":"offer-from-a"}' });
    expect(a.sent.length).toBe(sentBeforeA); // never echoed to the sender

    b.emit({ kind: 'voice', data: '{"candidate":"from-b"}' });
    expect(a.sent[a.sent.length - 1]).toEqual({ kind: 'voice', data: '{"candidate":"from-b"}' });
    expect(b.sent.length).toBe(sentBeforeB + 1); // only the relayed offer above
  });

  it('drops voice frames after the peer disconnects', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    new Match(a, b, OPTS);
    b.close();
    const sentBeforeB = b.sent.length;
    a.emit({ kind: 'voice', data: '{"sdp":"too-late"}' });
    expect(b.sent.length).toBe(sentBeforeB);
  });
});
