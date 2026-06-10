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
import type { InputFrame } from '@soldat/protocol';
/**
 * Map a protocol {@link InputFrame} onto a sim sprite's `control` record. The
 * wire carries logical buttons + aim + posture; the sim consumes a `Control`.
 * This is the one bridge point between @soldat/protocol and @soldat/sim for the
 * prediction path, kept here so the buffer stays transport-agnostic.
 */
export declare function applyInputToSprite(world: World, spriteIndex: number, input: InputFrame): void;
/**
 * Snap the predicted world to an authoritative server state. Track B owns the
 * concrete snapshot wire format and its application, so reconcile() takes this
 * callback rather than depending on Track B's exact signature. It receives the
 * predicted `World` to mutate in place to match the server's authoritative
 * state for `serverTick`.
 */
export type ApplySnapshot = (world: World, serverTick: number) => void;
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
export declare class PredictionBuffer {
    private readonly world;
    private readonly localSpriteIndex;
    private readonly stepOpts;
    /**
     * Unacknowledged inputs in ascending tick order. An input stays here until a
     * snapshot whose serverTick >= the input's tick acknowledges it.
     */
    private readonly pending;
    /** The highest client tick recorded so far (for monotonicity/debugging). */
    private lastRecordedTick;
    /** The most recent server tick reconciled against (−1 = none yet). */
    private lastServerTick;
    /**
     * @param world            the predicted client `World` (already createWorld'd
     *                         + initSimWorld'd by the caller, with the local sprite
     *                         spawned at `localSpriteIndex`).
     * @param localSpriteIndex 1-based index of the local player's sprite.
     * @param opts             step options to forward to every stepWorld.
     */
    constructor(world: World, localSpriteIndex: number, opts?: PredictionBufferOptions);
    /** The current predicted world (read-only access for rendering/inspection). */
    get predictedWorld(): World;
    /** How many inputs are still unacknowledged. */
    get pendingCount(): number;
    /** The last server tick this buffer reconciled against (−1 if never). */
    get acknowledgedServerTick(): number;
    /**
     * Record a local input for `tick`, apply it to the local sprite's control, and
     * step the predicted world once for immediate response. The input is retained
     * as unacknowledged until a snapshot accounts for it.
     *
     * @param tick  the client tick this input was issued on. Must be strictly
     *              greater than the previous recorded tick (inputs are ordered).
     * @param input the logical input frame.
     */
    recordInput(tick: number, input: InputFrame): void;
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
    onSnapshot(serverTick: number, applySnapshot: ApplySnapshot): void;
    /**
     * Core reconciliation. Exposed under the friendlier {@link onSnapshot} name;
     * named reconcile() per PORT-PLAN.md §6 terminology.
     */
    reconcile(serverTick: number, applySnapshot: ApplySnapshot): void;
    /** Advance the predicted world by one sim tick with the configured options. */
    private step;
}
//# sourceMappingURL=prediction.d.ts.map