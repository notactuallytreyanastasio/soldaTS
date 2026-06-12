// Authoritative-match tests: welcome/teams/engines, input→step→snapshot round
// trip (the netcode ack contract), 3v3 replication, kills, engine fallback,
// spectator observers, and dispose — all over fake sockets, no timers (the test
// drives match.tick directly). The Arena owns socket lifecycle and voice/chat
// relay (see arena.test.ts); Match is fed inputs via feedInput.
import { describe, it, expect, vi } from 'vitest';
import {
  HandshakeResult,
  Posture,
  type Buttons,
  type InputFrame,
  type SpriteSnapshotFull,
} from '@soldat/protocol';
import { Match, MATCH_SPRITES, sanitizeEngineChoice, type MatchPlayer } from './match';
import { FakeSocket } from './lobby.test';

const OPTS = { seed: 7, arenaSeed: 5, engines: ['wolf', 'hydra'] as [string, string] };
const DT = 1 / 60;

const mp = (sock: FakeSocket, id: number): MatchPlayer => ({ sock, id });

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

function feed(
  match: Match,
  num: number,
  tick: number,
  over: Partial<Buttons> = {},
  aim = { x: 100, y: 0 },
): void {
  const frame: InputFrame = { clientTick: tick, buttons: buttons(over), aim, posture: Posture.Standing };
  match.feedInput(num, frame);
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
  it('welcomes both players with opposite slots/teams, the recipe, and their ids', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const match = new Match(mp(a, 11), mp(b, 22), OPTS);

    const welcomes = [a, b].map((s) => {
      const w = s.sent.find((m) => m.kind === 'handshake');
      if (w?.kind !== 'handshake' || w.handshake.kind !== 'welcome') {
        throw new Error('expected a welcome');
      }
      return w.handshake;
    });
    expect(welcomes[0]!.result).toBe(HandshakeResult.Ok);
    expect(welcomes[0]!.yourNum).toBe(1);
    expect(welcomes[1]!.yourNum).toBe(2);
    expect(welcomes[0]!.yourId).toBe(11);
    expect(welcomes[1]!.yourId).toBe(22);
    // Match-start carries BOTH engine choices in the recipe.
    expect(welcomes[0]!.mapName).toBe('arena=5&seed=7&e1=wolf&e2=hydra');
    expect(welcomes[1]!.mapName).toBe(welcomes[0]!.mapName);
    expect(match.recipe).toBe('arena=5&seed=7&e1=wolf&e2=hydra');

    expect(match.game.teamOf(1)).toBe(1);
    expect(match.game.teamOf(2)).toBe(2);
    expect(match.slotOfId(11)).toBe(1);
    expect(match.slotOfId(22)).toBe(2);
    match.dispose();
  });
});

describe('Match — team engines (3v3)', () => {
  it("arms player A's engine on team 1's bots and player B's on team 2's", () => {
    const match = new Match(mp(new FakeSocket(), 1), mp(new FakeSocket(), 2), OPTS);
    expect(match.game.engineOf(3)).toBe('wolf');
    expect(match.game.engineOf(4)).toBe('hydra');
    expect(match.game.engineOf(5)).toBe('wolf');
    expect(match.game.engineOf(6)).toBe('hydra');
    expect(match.game.teamOf(3)).toBe(1);
    expect(match.game.teamOf(4)).toBe(2);
    match.dispose();
  });

  it('rolls the chance wildcard per match — bot carriers only, humans keep their slots', () => {
    // Seed 7 rolls ARMED ('ricochet' under the spectacle weighting); one carrier per team.
    const armed = new Match(mp(new FakeSocket(), 1), mp(new FakeSocket(), 2), OPTS);
    const carriers = armed.game.wildcardCarriers();
    expect(armed.game.wildcard).toBe('ricochet');
    expect(carriers).toHaveLength(2);
    for (const c of carriers) {
      expect(c).toBeGreaterThanOrEqual(3); // never a human slot
      expect(c).toBeLessThanOrEqual(6);
    }
    expect(new Set(carriers.map((c) => armed.game.teamOf(c))).size).toBe(2); // one per team
    armed.dispose();

    const stock = new Match(mp(new FakeSocket(), 1), mp(new FakeSocket(), 2), { ...OPTS, seed: 3 });
    expect(stock.game.wildcard).toBeUndefined();
    expect(stock.game.wildcardCarriers()).toHaveLength(0);
    stock.dispose();
  });

  it("falls back to 'classic' (with a warn) on an unknown or empty choice", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(sanitizeEngineChoice('not-a-brain')).toBe('classic');
    expect(warn).toHaveBeenCalledOnce();
    expect(sanitizeEngineChoice('')).toBe('classic');
    expect(warn).toHaveBeenCalledOnce();
    expect(sanitizeEngineChoice('hydra')).toBe('hydra');
    warn.mockRestore();

    const warn2 = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const match = new Match(mp(new FakeSocket(), 1), mp(new FakeSocket(), 2), {
      ...OPTS,
      engines: ['garbage', ''],
    });
    expect(match.teamEngines).toEqual(['classic', 'classic']);
    warn2.mockRestore();
    match.dispose();
  });
});

describe('Match — 3v3 snapshot replication', () => {
  it('streams full snapshots of all six sprites to both clients', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const match = new Match(mp(a, 1), mp(b, 2), OPTS);
    for (let t = 0; t < 30; t++) match.tick(DT);
    for (const sock of [a, b]) {
      for (const num of MATCH_SPRITES) {
        expect(snapshotsOf(sock, num).length, `sprite ${num}`).toBeGreaterThan(0);
      }
    }
    const hb = [...a.sent].reverse().find((m) => m.kind === 'heartbeat');
    if (hb?.kind !== 'heartbeat') throw new Error('expected a heartbeat');
    expect(hb.players.map((p) => p.num)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(hb.players.map((p) => p.team)).toEqual([1, 2, 1, 2, 1, 2]);
    match.dispose();
  });

  it('streams full snapshots of all six sprites to a spectator observer too', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const spec = new FakeSocket();
    const match = new Match(mp(a, 1), mp(b, 2), OPTS);
    match.addObserver(spec);
    for (let t = 0; t < 30; t++) match.tick(DT);
    for (const num of MATCH_SPRITES) {
      expect(snapshotsOf(spec, num).length, `sprite ${num}`).toBeGreaterThan(0);
    }
    // A spectator's snapshots are sim-tick stamped (they dead-reckon all six).
    const own = [...spec.sent].reverse().find((m) => m.kind === 'heartbeat');
    expect(own?.kind).toBe('heartbeat');
    // Removing the observer stops the stream.
    match.removeObserver(spec);
    const before = snapshotsOf(spec, 1).length;
    for (let t = 0; t < 6; t++) match.tick(DT);
    expect(snapshotsOf(spec, 1).length).toBe(before);
    match.dispose();
  });
});

describe('Match — input → step → snapshot round trip', () => {
  it("moves A's sprite in the snapshots B receives, with A's inputs acked", () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const match = new Match(mp(a, 1), mp(b, 2), OPTS);

    for (let t = 0; t < 30; t++) match.tick(DT);
    const before = snapshotsOf(b, 1).at(-1)!;

    for (let t = 1; t <= 60; t++) {
      feed(match, 1, t, { right: true });
      match.tick(DT);
    }

    const after = snapshotsOf(b, 1).at(-1)!;
    expect(after.pos.x).toBeGreaterThan(before.pos.x + 10);

    const ownSnaps = snapshotsOf(a, 1);
    expect(ownSnaps.at(-1)!.serverTick).toBe(60);
    expect(snapshotsOf(b, 2).at(-1)!.serverTick).toBe(-1);
    match.dispose();
  });

  it('registers a kill (chat + heartbeat) when A shoots B point-blank', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const match = new Match(mp(a, 1), mp(b, 2), OPTS);
    const world = match.game.world;
    const parts = world.spriteParts!;

    for (let t = 1; t <= 400; t++) {
      parts.posX[2] = parts.posX[1]! + 60;
      parts.posY[2] = parts.posY[1]!;
      parts.oldX[2] = parts.posX[2]!;
      parts.oldY[2] = parts.posY[2]!;
      parts.velocityX[2] = 0;
      parts.velocityY[2] = 0;
      feed(match, 1, t, { fire: true });
      match.tick(DT);
      if (match.game.killsOf(1) > 0) break;
    }

    expect(match.game.killsOf(1)).toBeGreaterThan(0);
    const kill = b.sent.find((m) => m.kind === 'chat' && m.text.startsWith('kill:1:2:'));
    expect(kill).toBeDefined();
    const lastHb = [...b.sent].reverse().find((m) => m.kind === 'heartbeat');
    if (lastHb?.kind !== 'heartbeat') throw new Error('expected a heartbeat');
    expect(lastHb.teamScore[0]).toBeGreaterThan(0);
    expect(lastHb.players.find((p) => p.num === 2)?.deaths).toBeGreaterThan(0);
    match.dispose();
  });
});

describe('Match — dispose contract', () => {
  it('stops the round on dispose, never closes sockets, ignores a gone player', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const match = new Match(mp(a, 1), mp(b, 2), OPTS);
    for (let t = 0; t < 10; t++) match.tick(DT);

    let ended = false;
    match.onEnd = (): void => {
      ended = true;
    };
    match.markGone(1); // Arena saw player A's socket close
    feed(match, 1, 999, { right: true }); // gone player's input is dropped (no throw)
    match.dispose();

    expect(ended).toBe(true);
    expect(a.closed).toBe(false); // Match NEVER closes sockets — the Arena owns them
    expect(b.closed).toBe(false);

    const sentBefore = b.sent.length;
    match.tick(DT);
    expect(b.sent.length).toBe(sentBefore); // a disposed match never ticks again
  });
});
