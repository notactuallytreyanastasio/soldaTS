/**
 * Client-side prediction + server reconciliation for the LOCAL sprite.
 *
 * PORT-PLAN.md §6 ("Reconciliation"): "ring buffer of unacknowledged inputs;
 * on snapshot, rewind local sprite to server state and re-simulate buffered
 * inputs." This is the modernization the clean break buys us over the original
 * engine's looser correction — and because @soldat/sim is identical TS on both
 * the client and the authoritative server, predicted local movement is the SAME
 * code path the server runs, so with no packet loss the prediction is exact.
 *
 * THE MODEL
 * ---------
 * The client owns a predicted `World` (its own @soldat/sim instance). Each local
 * input frame is:
 *   1. recorded in an unacknowledged-input buffer keyed by its client tick,
 *   2. written onto the local sprite's `control`,
 *   3. immediately applied by stepping the predicted world ONE tick — so the
 *      player sees instant response without waiting for the server round trip.
 *
 * When an authoritative snapshot arrives (server tick + state), `onSnapshot`:
 *   1. snaps the predicted world to the server's authoritative state (via a
 *      caller-supplied `applySnapshot` callback — Track B owns the exact wire
 *      shape, so we stay generic and never hard-depend on its signature),
 *   2. drops every buffered input the server has already accounted for
 *      (clientTick <= serverTick),
 *   3. re-applies the still-unacknowledged inputs by re-stepping the world once
 *      per buffered input, so the prediction converges back onto the server's
 *      trajectory plus the inputs the server hasn't seen yet.
 *
 * This module is PURE LOGIC over @soldat/sim's stepWorld. No DOM, no transport,
 * no Node. Randomness (if any sub-step needs it) flows through world.rng inside
 * the sim — never the global JS RNG.
 */
import type { World, StepOptions } from '@soldat/sim';
import { stepWorld } from '@soldat/sim';
import type { InputFrame } from '@soldat/protocol';
import { Posture } from '@soldat/protocol';

/**
 * Map a protocol {@link InputFrame} onto a sim sprite's `control` record. The
 * wire carries logical buttons + aim + posture; the sim consumes a `Control`.
 * This is the one bridge point between @soldat/protocol and @soldat/sim for the
 * prediction path, kept here so the buffer stays transport-agnostic.
 */
export function applyInputToSprite(world: World, spriteIndex: number, input: InputFrame): void {
  const sprite = world.sprites[spriteIndex];
  if (sprite === undefined) {
    return;
  }
  const c = sprite.control;
  const b = input.buttons;
  c.left = b.left;
  c.right = b.right;
  c.up = b.up;
  c.down = b.down;
  c.fire = b.fire;
  c.jetpack = b.jetpack;
  c.throwNade = b.throwNade;
  c.changeWeapon = b.changeWeapon;
  c.throwWeapon = b.throwWeapon;
  c.reload = b.reload;
  c.flagThrow = b.flagThrow;
  // Posture drives prone; the down button already covers crouch intent for the
  // movement spine. prone is a discrete posture flag the sim reads separately.
  c.prone = input.posture === Posture.Prone;
  c.mouseAimX = input.aim.x;
  c.mouseAimY = input.aim.y;
}

/**
 * Snap the predicted world to an authoritative server state. Track B owns the
 * concrete snapshot wire format and its application, so reconcile() takes this
 * callback rather than depending on Track B's exact signature. It receives the
 * predicted `World` to mutate in place to match the server's authoritative
 * state for `serverTick`.
 */
export type ApplySnapshot = (world: World, serverTick: number) => void;

/** A local input frame paired with the client tick it was issued on. */
interface BufferedInput {
  tick: number;
  input: InputFrame;
}

export interface PredictionBufferOptions {
  /**
   * Step options forwarded to every stepWorld call (floor, map radius, realistic
   * weapon table). The SAME options the authoritative server steps with, so the
   * predicted trajectory matches tick-for-tick.
   */
  step?: StepOptions;
}

/**
 * Records local inputs, predicts forward, and reconciles against authoritative
 * snapshots for a single local sprite.
 */
export class PredictionBuffer {
  private readonly world: World;
  private readonly localSpriteIndex: number;
  private readonly stepOpts: StepOptions | undefined;

  /**
   * Unacknowledged inputs in ascending tick order. An input stays here until a
   * snapshot whose serverTick >= the input's tick acknowledges it.
   */
  private readonly pending: BufferedInput[] = [];

  /** The highest client tick recorded so far (for monotonicity/debugging). */
  private lastRecordedTick = -1;

  /** The most recent server tick reconciled against (−1 = none yet). */
  private lastServerTick = -1;

  /**
   * @param world            the predicted client `World` (already createWorld'd
   *                         + initSimWorld'd by the caller, with the local sprite
   *                         spawned at `localSpriteIndex`).
   * @param localSpriteIndex 1-based index of the local player's sprite.
   * @param opts             step options to forward to every stepWorld.
   */
  constructor(world: World, localSpriteIndex: number, opts?: PredictionBufferOptions) {
    this.world = world;
    this.localSpriteIndex = localSpriteIndex;
    this.stepOpts = opts?.step;
  }

  /** The current predicted world (read-only access for rendering/inspection). */
  get predictedWorld(): World {
    return this.world;
  }

  /** How many inputs are still unacknowledged. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** The last server tick this buffer reconciled against (−1 if never). */
  get acknowledgedServerTick(): number {
    return this.lastServerTick;
  }

  /**
   * Record a local input for `tick`, apply it to the local sprite's control, and
   * step the predicted world once for immediate response. The input is retained
   * as unacknowledged until a snapshot accounts for it.
   *
   * @param tick  the client tick this input was issued on. Must be strictly
   *              greater than the previous recorded tick (inputs are ordered).
   * @param input the logical input frame.
   */
  recordInput(tick: number, input: InputFrame): void {
    // Keep the buffer monotonic. A non-increasing tick is a caller bug; ignore
    // it rather than corrupt the replay order (which reconcile() relies on).
    if (tick <= this.lastRecordedTick) {
      return;
    }
    this.lastRecordedTick = tick;
    this.pending.push({ tick, input });

    // 1. Write the input onto the local sprite + 2. step once (instant feedback).
    applyInputToSprite(this.world, this.localSpriteIndex, input);
    this.step();
  }

  /**
   * Reconcile against an authoritative snapshot. Snaps the predicted world to the
   * server state via `applySnapshot`, drops inputs the server has already seen,
   * then re-applies the still-unacknowledged inputs by re-stepping — so the
   * prediction converges onto the authoritative trajectory.
   *
   * @param serverTick    the authoritative tick the snapshot represents. Inputs
   *                      with clientTick <= serverTick are considered acknowledged.
   * @param applySnapshot caller-supplied callback that mutates `world` to match
   *                      the server's authoritative state (Track B-owned format).
   */
  onSnapshot(serverTick: number, applySnapshot: ApplySnapshot): void {
    this.reconcile(serverTick, applySnapshot);
  }

  /**
   * Core reconciliation. Exposed under the friendlier {@link onSnapshot} name;
   * named reconcile() per PORT-PLAN.md §6 terminology.
   */
  reconcile(serverTick: number, applySnapshot: ApplySnapshot): void {
    this.lastServerTick = serverTick;

    // 1. Snap the predicted world to the authoritative server state.
    applySnapshot(this.world, serverTick);

    // 2. Drop every input the server has already accounted for. The server's
    //    snapshot at serverTick already reflects all inputs with tick <=
    //    serverTick, so those are no longer "unacknowledged".
    let firstUnacked = 0;
    while (
      firstUnacked < this.pending.length &&
      this.pending[firstUnacked]!.tick <= serverTick
    ) {
      firstUnacked += 1;
    }
    if (firstUnacked > 0) {
      this.pending.splice(0, firstUnacked);
    }

    // 3. Re-apply the still-unacknowledged inputs on top of the authoritative
    //    state, re-stepping once per input. After this the predicted world ==
    //    server state advanced by exactly the inputs the server hasn't seen.
    for (const buffered of this.pending) {
      applyInputToSprite(this.world, this.localSpriteIndex, buffered.input);
      this.step();
    }
  }

  /** Advance the predicted world by one sim tick with the configured options. */
  private step(): void {
    stepWorld(this.world, this.stepOpts);
  }
}
