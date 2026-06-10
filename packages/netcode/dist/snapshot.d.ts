/**
 * World <-> snapshot replication — the bridge between @soldat/sim authoritative
 * state and @soldat/protocol wire messages.
 *
 * This is the netcode "capture / apply" seam. The server captures a World into
 * sprite-snapshot {@link Message}s; the client applies those messages back onto
 * its own World. We mirror the snapshot / major / delta model from
 * docs/rewrite-reference/wire-protocol.md ("Snapshot / Delta Model"), but over
 * the clean discriminated-union message types in @soldat/protocol rather than
 * the legacy `packed record` layout:
 *
 *   - captureSpriteSnapshot(world) -> a `full` {@link SpriteSnapshotFull} per
 *     active sprite (PORT: ID=3 TMsg_ServerSpriteSnapshot). The complete
 *     authoritative state: position, velocity, aim, posture, buttons, health,
 *     vest, weapons, cosmetics.
 *   - applySpriteSnapshot(world, msg) -> write a captured `full` snapshot back
 *     into a World (server -> client reconstruction).
 *   - diffSpriteSnapshot(prev, curr) -> a `delta` {@link SpriteSnapshotDelta}
 *     carrying only the fields that changed (PORT: ID=41 "Major" + the per-field
 *     deltas ID=21/25/26/29). `num`/`serverTick` are always present.
 *   - applySpriteDelta(base, delta) -> fold a delta onto a prior full snapshot to
 *     reproduce the later full state without resending unchanged fields.
 *
 * IMPORTANT: the authoritative sprite COM lives in world.spriteParts at particle
 * index == sprite.num (see @soldat/sim step.ts / sprite.ts: "SpriteParts[Num]").
 * Position and velocity are read from / written to that particle, NOT a field on
 * the Sprite record. Health/direction/aim/posture/buttons live on the Sprite.
 *
 * Platform-pure: no DOM, no Node, no transport. No randomness. The arithmetic
 * here is plain assignment/equality, so there is no f() scalar wrapping to do —
 * f32 fidelity is the sim's responsibility when it consumes these values.
 */
import type { World, Sprite, ParticleSystem } from "@soldat/sim";
import { type SpriteSnapshotFull, type SpriteSnapshotDelta, type Message } from "@soldat/protocol";
/**
 * Capture a single active sprite into a `full` snapshot. The COM position and
 * velocity are read from `parts` (the world's spriteParts) at index sprite.num.
 *
 * PORT: TMsg_ServerSpriteSnapshot (wire-protocol.md ID=3, "Full").
 */
export declare function captureSpriteSnapshotOne(sprite: Sprite, parts: ParticleSystem, serverTick: number): SpriteSnapshotFull;
/**
 * Capture the whole World into a batch of `spriteSnapshot` messages — one `full`
 * snapshot per active, non-sentinel sprite (slot 0 is the dead sentinel; see
 * @soldat/sim world.ts INDEXING CONTRACT).
 *
 * Returns a flat list of {@link Message}s ready to frame + send. `serverTick`
 * defaults to the world's authoritative serverTickCounter.
 */
export declare function captureSpriteSnapshot(world: World, serverTick?: number): Message[];
/**
 * Apply a `full` snapshot onto a World, reconstructing the authoritative sprite
 * state. Marks the target sprite active and seeds its COM particle position /
 * velocity so the next integrate continues smoothly.
 *
 * Accepts either a bare {@link SpriteSnapshotFull} or a `spriteSnapshot`
 * {@link Message} wrapping one (the form `captureSpriteSnapshot` emits).
 */
export declare function applySpriteSnapshot(world: World, msg: SpriteSnapshotFull | Extract<Message, {
    kind: "spriteSnapshot";
}>): void;
/**
 * Diff two `full` snapshots of the SAME sprite, producing a `delta` that carries
 * only the fields that changed between `prev` and `curr`. `num` and `serverTick`
 * are always present (serverTick is taken from `curr`).
 *
 * PORT: TMsg_ServerSpriteSnapshot_Major (ID=41) fused with the per-field deltas
 * ID=21 (movement) / ID=25 (weapons) / ID=26 (helmet) / ID=29 (mouse aim) — see
 * wire-protocol.md "Snapshot / Delta Model". Equipment that the Major variant
 * omits (vest, ammo, cosmetics beyond helmet) is intentionally not carried by
 * the delta; those ride full snapshots.
 */
export declare function diffSpriteSnapshot(prev: SpriteSnapshotFull, curr: SpriteSnapshotFull): SpriteSnapshotDelta;
/**
 * Fold a `delta` onto a prior `full` snapshot (`base`), returning a NEW full
 * snapshot equal to the state the delta was diffed against. `base` is not
 * mutated. Fields absent from the delta are inherited unchanged from `base`;
 * present fields overwrite. The `serverTick` advances to the delta's tick.
 *
 * This reproduces the later snapshot from (earlier full + delta) — the receive
 * side of the delta path. The result can then be fed to applySpriteSnapshot.
 */
export declare function applySpriteDelta(base: SpriteSnapshotFull, delta: SpriteSnapshotDelta): SpriteSnapshotFull;
//# sourceMappingURL=snapshot.d.ts.map