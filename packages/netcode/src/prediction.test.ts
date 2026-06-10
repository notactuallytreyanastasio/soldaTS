/**
 * Client prediction + server reconciliation tests (PORT-PLAN.md §6).
 *
 * Plain f64 (STRICT_F32 off): the clean-break netcode runs the SAME @soldat/sim
 * TS on client and server, so internal determinism is free — with no packet
 * loss the predicted client trajectory must match the authoritative server
 * trajectory tick-for-tick. We also force a divergence and prove reconcile()
 * snaps the client back onto the server state on the next snapshot.
 *
 * Setup mirrors @soldat/sim's own step.test.ts: one active sprite whose COM
 * particle (index == sprite.num == 1) starts above a flat floor, driven by a
 * stream of InputFrames (hold "right" so movement forces actually fire).
 */
import { describe, it, expect } from 'vitest';
import { createWorld, initSimWorld, stepWorld, vec2, POS_STAND } from '@soldat/sim';
import type { World, StepOptions } from '@soldat/sim';
import type { InputFrame, Buttons } from '@soldat/protocol';
import { Posture } from '@soldat/protocol';
import { PredictionBuffer, applyInputToSprite } from './prediction';

const SEED = 0x1234abcd;
const LOCAL = 1; // local sprite + COM particle index
const STEP: StepOptions = { floorY: 200 };

function noButtons(): Buttons {
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
  };
}

/** An input frame for `tick` holding the given buttons (default: right). */
function frame(tick: number, buttons?: Partial<Buttons>): InputFrame {
  return {
    clientTick: tick,
    buttons: { ...noButtons(), right: true, ...buttons },
    aim: { x: 0, y: 0 },
    posture: Posture.Standing,
  };
}

/** Build a seeded world with one active sprite above a flat floor. */
function makeWorld(startY: number): World {
  const world = createWorld();
  initSimWorld(world, { seed: SEED });
  world.spriteParts!.createPart(vec2(0, startY), vec2(0, 0), 1, LOCAL);

  const sprite = world.sprites[LOCAL]!;
  sprite.active = true;
  sprite.num = LOCAL;
  sprite.style = 1;
  sprite.position = POS_STAND;
  sprite.direction = 1;
  return world;
}

/** Snapshot the authoritative COM particle + key sprite movement state. */
function captureState(world: World) {
  const p = world.spriteParts!;
  const s = world.sprites[LOCAL]!;
  return {
    posX: p.posX[LOCAL]!,
    posY: p.posY[LOCAL]!,
    velX: p.velocityX[LOCAL]!,
    velY: p.velocityY[LOCAL]!,
    oldX: p.oldX[LOCAL]!,
    oldY: p.oldY[LOCAL]!,
    forceX: p.forceX[LOCAL]!,
    forceY: p.forceY[LOCAL]!,
    onGround: s.onGround,
    onGroundLastFrame: s.onGroundLastFrame,
    onGroundPermanent: s.onGroundPermanent,
  };
}

/**
 * Build an ApplySnapshot that copies the server world's authoritative sprite
 * COM particle + movement state into the client world. This is the generic
 * callback reconcile() takes (Track B owns the real wire shape); here it's a
 * direct sim-to-sim state copy from a recorded server snapshot.
 */
function makeServerSnapshot(server: World) {
  const snap = captureState(server);
  return (client: World): void => {
    const p = client.spriteParts!;
    const s = client.sprites[LOCAL]!;
    p.posX[LOCAL] = snap.posX;
    p.posY[LOCAL] = snap.posY;
    p.velocityX[LOCAL] = snap.velX;
    p.velocityY[LOCAL] = snap.velY;
    p.oldX[LOCAL] = snap.oldX;
    p.oldY[LOCAL] = snap.oldY;
    p.forceX[LOCAL] = snap.forceX;
    p.forceY[LOCAL] = snap.forceY;
    s.onGround = snap.onGround;
    s.onGroundLastFrame = snap.onGroundLastFrame;
    s.onGroundPermanent = snap.onGroundPermanent;
  };
}

describe('PredictionBuffer — lossless prediction matches server tick-for-tick', () => {
  it('predicts the same trajectory the authoritative server produces', () => {
    const server = makeWorld(0);
    const client = makeWorld(0);
    const buffer = new PredictionBuffer(client, LOCAL, { step: STEP });

    // Same seeded input stream drives both. The server applies each input then
    // steps; the client records each input (which applies + steps internally).
    for (let tick = 0; tick < 60; tick++) {
      const input = frame(tick);

      // Authoritative server: apply input, advance one tick.
      applyInputToSprite(server, LOCAL, input);
      stepWorld(server, STEP);

      // Client prediction: record (applies + steps once immediately).
      buffer.recordInput(tick, input);

      // With no loss and identical code, the predicted state is bit-identical.
      expect(captureState(buffer.predictedWorld)).toEqual(captureState(server));
    }

    // The local sprite actually moved (the test isn't trivially passing on a
    // static body): running right advanced it in +X.
    expect(client.spriteParts!.posX[LOCAL]!).toBeGreaterThan(0);
  });
});

describe('PredictionBuffer — reconciliation after forced divergence', () => {
  it('snaps the client back onto the server state on the next snapshot', () => {
    const server = makeWorld(0);
    const client = makeWorld(0);
    const buffer = new PredictionBuffer(client, LOCAL, { step: STEP });

    // Advance both with matching inputs for a while, recording server snapshots
    // so a "delayed" snapshot can be delivered later.
    const inputs: InputFrame[] = [];
    let serverSnapAtTick10: ReturnType<typeof makeServerSnapshot> | null = null;

    for (let tick = 0; tick < 20; tick++) {
      const input = frame(tick);
      inputs.push(input);

      applyInputToSprite(server, LOCAL, input);
      stepWorld(server, STEP);
      buffer.recordInput(tick, input);

      // Capture the authoritative snapshot AT tick 10 to deliver later.
      if (tick === 10) {
        serverSnapAtTick10 = makeServerSnapshot(server);
      }
    }

    // FORCE A DIVERGENCE: corrupt the client's predicted position directly, as
    // if a mispredicted/dropped input had pushed it off the true trajectory.
    const cp = client.spriteParts!;
    cp.posX[LOCAL] = cp.posX[LOCAL]! + 500;
    cp.posY[LOCAL] = cp.posY[LOCAL]! - 250;
    cp.velocityX[LOCAL] = cp.velocityX[LOCAL]! + 50;

    // Sanity: the client is now badly diverged from the server.
    expect(client.spriteParts!.posX[LOCAL]!).not.toBeCloseTo(
      server.spriteParts!.posX[LOCAL]!,
      3,
    );

    // Deliver the authoritative snapshot for serverTick=10. reconcile() snaps to
    // the tick-10 server state, drops inputs 0..10, and re-applies inputs 11..19.
    expect(serverSnapAtTick10).not.toBeNull();
    buffer.onSnapshot(10, serverSnapAtTick10!);

    // After reconciliation the predicted state must equal the server state: the
    // server (which has also seen inputs 0..19) and the reconciled client (snap
    // to tick 10 + re-applied 11..19) converge to the same place.
    expect(captureState(buffer.predictedWorld)).toEqual(captureState(server));

    // The 11 acknowledged inputs (ticks 0..10) were dropped; 9 remain pending.
    expect(buffer.pendingCount).toBe(9);
    expect(buffer.acknowledgedServerTick).toBe(10);
  });

  it('continues to predict correctly after a reconcile', () => {
    const server = makeWorld(0);
    const client = makeWorld(0);
    const buffer = new PredictionBuffer(client, LOCAL, { step: STEP });

    for (let tick = 0; tick < 15; tick++) {
      const input = frame(tick);
      applyInputToSprite(server, LOCAL, input);
      stepWorld(server, STEP);
      buffer.recordInput(tick, input);
    }

    // Corrupt + reconcile against the latest authoritative server state (tick 14
    // is fully acknowledged, so the buffer empties).
    client.spriteParts!.posX[LOCAL] = client.spriteParts!.posX[LOCAL]! + 999;
    buffer.onSnapshot(14, makeServerSnapshot(server));
    expect(buffer.pendingCount).toBe(0);
    expect(captureState(buffer.predictedWorld)).toEqual(captureState(server));

    // Keep driving both with fresh inputs: prediction stays locked to server.
    for (let tick = 15; tick < 30; tick++) {
      const input = frame(tick);
      applyInputToSprite(server, LOCAL, input);
      stepWorld(server, STEP);
      buffer.recordInput(tick, input);
      expect(captureState(buffer.predictedWorld)).toEqual(captureState(server));
    }
  });
});

describe('PredictionBuffer — input bookkeeping', () => {
  it('ignores non-increasing ticks and tracks pending count', () => {
    const client = makeWorld(0);
    const buffer = new PredictionBuffer(client, LOCAL, { step: STEP });

    buffer.recordInput(0, frame(0));
    buffer.recordInput(1, frame(1));
    expect(buffer.pendingCount).toBe(2);

    // A stale/duplicate tick is ignored (does not advance the world twice).
    const before = captureState(buffer.predictedWorld);
    buffer.recordInput(1, frame(1));
    expect(buffer.pendingCount).toBe(2);
    expect(captureState(buffer.predictedWorld)).toEqual(before);
  });
});
