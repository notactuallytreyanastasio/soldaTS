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
import { POS_STAND, POS_CROUCH, POS_PRONE, } from "@soldat/sim";
import { Posture, } from "@soldat/protocol";
// ---------------------------------------------------------------------------
// Posture <-> sim position byte
// ---------------------------------------------------------------------------
// PORT: @soldat/sim sprite.ts POS_STAND=1 / POS_CROUCH=2 / POS_PRONE=4 vs the
// wire `Posture` enum (Standing=0 / Prone=1 / Crouching=2). The two encodings
// are independent integer sets, so we translate explicitly in both directions.
function postureFromPosition(position) {
    switch (position) {
        case POS_PRONE:
            return Posture.Prone;
        case POS_CROUCH:
            return Posture.Crouching;
        case POS_STAND:
        default:
            return Posture.Standing;
    }
}
function positionFromPosture(posture) {
    switch (posture) {
        case Posture.Prone:
            return POS_PRONE;
        case Posture.Crouching:
            return POS_CROUCH;
        case Posture.Standing:
        default:
            return POS_STAND;
    }
}
// ---------------------------------------------------------------------------
// Buttons <-> sim Control
// ---------------------------------------------------------------------------
// PORT: the wire `Buttons` set (B1..B11) maps 1:1 onto the matching booleans in
// @soldat/sim Control. Control carries extra non-button fields (prone, aim,
// dist) that are conveyed via `posture` / `aim`, not the button set.
function buttonsFromControl(c) {
    return {
        left: c.left,
        right: c.right,
        up: c.up,
        down: c.down,
        fire: c.fire,
        jetpack: c.jetpack,
        throwNade: c.throwNade,
        changeWeapon: c.changeWeapon,
        throwWeapon: c.throwWeapon,
        reload: c.reload,
        flagThrow: c.flagThrow,
    };
}
function writeButtonsToControl(c, b) {
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
}
// ---------------------------------------------------------------------------
// Particle COM accessors (authoritative position / velocity).
// ---------------------------------------------------------------------------
// PORT: SpriteParts[Num] — the COM particle index equals the sprite number.
function readPos(parts, num) {
    return { x: parts.posX[num] ?? 0, y: parts.posY[num] ?? 0 };
}
function readVelocity(parts, num) {
    return { x: parts.velocityX[num] ?? 0, y: parts.velocityY[num] ?? 0 };
}
/**
 * Write a COM position back into the particle system. Mirrors how CreatePart
 * seeds oldPos := pos so a freshly-applied snapshot does not produce a spurious
 * Verlet/Euler velocity on the next integrate (Parts.pas:210).
 */
function writePos(parts, num, pos) {
    parts.posX[num] = pos.x;
    parts.posY[num] = pos.y;
}
function writeVelocity(parts, num, vel) {
    parts.velocityX[num] = vel.x;
    parts.velocityY[num] = vel.y;
}
// ---------------------------------------------------------------------------
// Field extractors used by both the full capture and the delta diff.
// ---------------------------------------------------------------------------
function aimOf(sprite) {
    return { x: sprite.control.mouseAimX, y: sprite.control.mouseAimY };
}
function weaponOf(sprite) {
    return {
        weaponNum: sprite.selWeapon,
        secondaryWeaponNum: sprite.lastWeaponStyle,
        ammoCount: sprite.bulletCount,
        grenadeCount: sprite.grenadeCanThrow ? 1 : 0,
    };
}
function cosmeticsOf(sprite) {
    return {
        wearHelmet: sprite.wearHelmet !== 0,
        cigar: sprite.hasCigar !== 0,
    };
}
// ---------------------------------------------------------------------------
// FULL snapshot: capture one sprite.
// ---------------------------------------------------------------------------
/**
 * Capture a single active sprite into a `full` snapshot. The COM position and
 * velocity are read from `parts` (the world's spriteParts) at index sprite.num.
 *
 * PORT: TMsg_ServerSpriteSnapshot (wire-protocol.md ID=3, "Full").
 */
export function captureSpriteSnapshotOne(sprite, parts, serverTick) {
    const num = sprite.num;
    return {
        kind: "full",
        num,
        serverTick,
        pos: readPos(parts, num),
        velocity: readVelocity(parts, num),
        aim: aimOf(sprite),
        posture: postureFromPosition(sprite.position),
        buttons: buttonsFromControl(sprite.control),
        cosmetics: cosmeticsOf(sprite),
        health: sprite.health,
        vest: sprite.vest,
        weapon: weaponOf(sprite),
    };
}
/**
 * Capture the whole World into a batch of `spriteSnapshot` messages — one `full`
 * snapshot per active, non-sentinel sprite (slot 0 is the dead sentinel; see
 * @soldat/sim world.ts INDEXING CONTRACT).
 *
 * Returns a flat list of {@link Message}s ready to frame + send. `serverTick`
 * defaults to the world's authoritative serverTickCounter.
 */
export function captureSpriteSnapshot(world, serverTick = world.serverTickCounter) {
    const parts = world.spriteParts;
    if (parts === null) {
        return [];
    }
    const out = [];
    // 1-based: slot 0 is the never-live sentinel; iterate 1..MAX.
    for (let i = 1; i < world.sprites.length; i++) {
        const sprite = world.sprites[i];
        if (sprite === undefined || !sprite.active) {
            continue;
        }
        out.push({
            kind: "spriteSnapshot",
            snapshot: captureSpriteSnapshotOne(sprite, parts, serverTick),
        });
    }
    return out;
}
// ---------------------------------------------------------------------------
// FULL snapshot: apply back onto a World (server -> client).
// ---------------------------------------------------------------------------
/**
 * Apply a `full` snapshot onto a World, reconstructing the authoritative sprite
 * state. Marks the target sprite active and seeds its COM particle position /
 * velocity so the next integrate continues smoothly.
 *
 * Accepts either a bare {@link SpriteSnapshotFull} or a `spriteSnapshot`
 * {@link Message} wrapping one (the form `captureSpriteSnapshot` emits).
 */
export function applySpriteSnapshot(world, msg) {
    const snap = "kind" in msg && msg.kind === "spriteSnapshot" ? msg.snapshot : msg;
    if (snap.kind !== "full") {
        // A delta cannot be applied as a full snapshot; fold it with applySpriteDelta
        // against a prior full first.
        throw new Error(`applySpriteSnapshot: expected a full snapshot, got "${snap.kind}"`);
    }
    const parts = world.spriteParts;
    if (parts === null) {
        throw new Error("applySpriteSnapshot: world.spriteParts is not initialised");
    }
    const num = snap.num;
    const sprite = world.sprites[num];
    if (sprite === undefined) {
        throw new Error(`applySpriteSnapshot: sprite ${num} out of range`);
    }
    sprite.active = true;
    sprite.num = num;
    // COM particle: mark active and seed position/velocity. We also reset oldPos
    // to the new position to avoid a phantom Verlet velocity (Parts.pas:210).
    parts.active[num] = true;
    writePos(parts, num, snap.pos);
    writeVelocity(parts, num, snap.velocity);
    parts.oldX[num] = snap.pos.x;
    parts.oldY[num] = snap.pos.y;
    sprite.health = snap.health;
    sprite.vest = snap.vest;
    sprite.position = positionFromPosture(snap.posture);
    sprite.control.mouseAimX = snap.aim.x;
    sprite.control.mouseAimY = snap.aim.y;
    // Soldat derives facing from aim: positive aim.x faces right (+1), else left.
    sprite.direction = snap.aim.x >= 0 ? 1 : -1;
    writeButtonsToControl(sprite.control, snap.buttons);
    sprite.wearHelmet = snap.cosmetics.wearHelmet ? 1 : 0;
    sprite.hasCigar = snap.cosmetics.cigar ? 1 : 0;
    sprite.selWeapon = snap.weapon.weaponNum;
    sprite.lastWeaponStyle = snap.weapon.secondaryWeaponNum;
    sprite.bulletCount = snap.weapon.ammoCount;
    sprite.grenadeCanThrow = snap.weapon.grenadeCount > 0;
}
// ---------------------------------------------------------------------------
// DELTA path.
// ---------------------------------------------------------------------------
function vec2Equal(a, b) {
    return a.x === b.x && a.y === b.y;
}
function aimEqual(a, b) {
    return a.x === b.x && a.y === b.y;
}
function buttonsEqual(a, b) {
    return (a.left === b.left &&
        a.right === b.right &&
        a.up === b.up &&
        a.down === b.down &&
        a.fire === b.fire &&
        a.jetpack === b.jetpack &&
        a.throwNade === b.throwNade &&
        a.changeWeapon === b.changeWeapon &&
        a.throwWeapon === b.throwWeapon &&
        a.reload === b.reload &&
        a.flagThrow === b.flagThrow);
}
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
export function diffSpriteSnapshot(prev, curr) {
    const delta = {
        kind: "delta",
        num: curr.num,
        serverTick: curr.serverTick,
    };
    if (!vec2Equal(prev.pos, curr.pos)) {
        delta.pos = curr.pos;
    }
    if (!vec2Equal(prev.velocity, curr.velocity)) {
        delta.velocity = curr.velocity;
    }
    if (!aimEqual(prev.aim, curr.aim)) {
        delta.aim = curr.aim;
    }
    if (prev.posture !== curr.posture) {
        delta.posture = curr.posture;
    }
    if (!buttonsEqual(prev.buttons, curr.buttons)) {
        delta.buttons = curr.buttons;
    }
    if (prev.health !== curr.health) {
        delta.health = curr.health;
    }
    if (prev.weapon.weaponNum !== curr.weapon.weaponNum ||
        prev.weapon.secondaryWeaponNum !== curr.weapon.secondaryWeaponNum) {
        delta.weapon = {
            weaponNum: curr.weapon.weaponNum,
            secondaryWeaponNum: curr.weapon.secondaryWeaponNum,
        };
    }
    if (prev.cosmetics.wearHelmet !== curr.cosmetics.wearHelmet) {
        delta.wearHelmet = curr.cosmetics.wearHelmet;
    }
    return delta;
}
/**
 * Fold a `delta` onto a prior `full` snapshot (`base`), returning a NEW full
 * snapshot equal to the state the delta was diffed against. `base` is not
 * mutated. Fields absent from the delta are inherited unchanged from `base`;
 * present fields overwrite. The `serverTick` advances to the delta's tick.
 *
 * This reproduces the later snapshot from (earlier full + delta) — the receive
 * side of the delta path. The result can then be fed to applySpriteSnapshot.
 */
export function applySpriteDelta(base, delta) {
    const weapon = delta.weapon !== undefined
        ? {
            weaponNum: delta.weapon.weaponNum,
            secondaryWeaponNum: delta.weapon.secondaryWeaponNum,
            // ammo/grenade are not part of the delta; inherit from base.
            ammoCount: base.weapon.ammoCount,
            grenadeCount: base.weapon.grenadeCount,
        }
        : base.weapon;
    const cosmetics = delta.wearHelmet !== undefined
        ? { wearHelmet: delta.wearHelmet, cigar: base.cosmetics.cigar }
        : base.cosmetics;
    return {
        kind: "full",
        num: delta.num,
        serverTick: delta.serverTick,
        pos: delta.pos ?? base.pos,
        velocity: delta.velocity ?? base.velocity,
        aim: delta.aim ?? base.aim,
        posture: delta.posture ?? base.posture,
        buttons: delta.buttons ?? base.buttons,
        health: delta.health ?? base.health,
        vest: base.vest,
        weapon,
        cosmetics,
    };
}
//# sourceMappingURL=snapshot.js.map