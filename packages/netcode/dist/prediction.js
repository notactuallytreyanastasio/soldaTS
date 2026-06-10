import { stepWorld } from '@soldat/sim';
import { Posture } from '@soldat/protocol';
/**
 * Map a protocol {@link InputFrame} onto a sim sprite's `control` record. The
 * wire carries logical buttons + aim + posture; the sim consumes a `Control`.
 * This is the one bridge point between @soldat/protocol and @soldat/sim for the
 * prediction path, kept here so the buffer stays transport-agnostic.
 */
export function applyInputToSprite(world, spriteIndex, input) {
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
 * Records local inputs, predicts forward, and reconciles against authoritative
 * snapshots for a single local sprite.
 */
export class PredictionBuffer {
    world;
    localSpriteIndex;
    stepOpts;
    /**
     * Unacknowledged inputs in ascending tick order. An input stays here until a
     * snapshot whose serverTick >= the input's tick acknowledges it.
     */
    pending = [];
    /** The highest client tick recorded so far (for monotonicity/debugging). */
    lastRecordedTick = -1;
    /** The most recent server tick reconciled against (−1 = none yet). */
    lastServerTick = -1;
    /**
     * @param world            the predicted client `World` (already createWorld'd
     *                         + initSimWorld'd by the caller, with the local sprite
     *                         spawned at `localSpriteIndex`).
     * @param localSpriteIndex 1-based index of the local player's sprite.
     * @param opts             step options to forward to every stepWorld.
     */
    constructor(world, localSpriteIndex, opts) {
        this.world = world;
        this.localSpriteIndex = localSpriteIndex;
        this.stepOpts = opts?.step;
    }
    /** The current predicted world (read-only access for rendering/inspection). */
    get predictedWorld() {
        return this.world;
    }
    /** How many inputs are still unacknowledged. */
    get pendingCount() {
        return this.pending.length;
    }
    /** The last server tick this buffer reconciled against (−1 if never). */
    get acknowledgedServerTick() {
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
    recordInput(tick, input) {
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
    onSnapshot(serverTick, applySnapshot) {
        this.reconcile(serverTick, applySnapshot);
    }
    /**
     * Core reconciliation. Exposed under the friendlier {@link onSnapshot} name;
     * named reconcile() per PORT-PLAN.md §6 terminology.
     */
    reconcile(serverTick, applySnapshot) {
        this.lastServerTick = serverTick;
        // 1. Snap the predicted world to the authoritative server state.
        applySnapshot(this.world, serverTick);
        // 2. Drop every input the server has already accounted for. The server's
        //    snapshot at serverTick already reflects all inputs with tick <=
        //    serverTick, so those are no longer "unacknowledged".
        let firstUnacked = 0;
        while (firstUnacked < this.pending.length &&
            this.pending[firstUnacked].tick <= serverTick) {
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
    step() {
        stepWorld(this.world, this.stepOpts);
    }
}
//# sourceMappingURL=prediction.js.map