/**
 * World <-> snapshot replication tests (Track B / M6).
 *
 * Validates the capture/apply seam between @soldat/sim state and the clean
 * @soldat/protocol sprite-snapshot messages:
 *
 *   1. FULL round-trip: capture a World with two active sprites, apply the
 *      snapshots onto a FRESH World, assert positions / velocity / health /
 *      posture / aim / buttons / weapons match (server -> client reconstruction).
 *   2. DELTA path: diff two snapshots of the same sprite, fold the delta onto the
 *      earlier full, and assert the result reproduces the later full state.
 *   3. Delta minimality: an unchanged field is omitted; a changed one is present.
 */
import { describe, it, expect } from "vitest";
import { createWorld, initSimWorld, vec2, POS_STAND, POS_PRONE } from "@soldat/sim";
import { Posture } from "@soldat/protocol";
import {
  captureSpriteSnapshot,
  captureSpriteSnapshotOne,
  applySpriteSnapshot,
  diffSpriteSnapshot,
  applySpriteDelta,
} from "./snapshot";

const SEED = 0x1234abcd;

/**
 * Build a world with one active sprite `num` placed at `pos` with `vel`,
 * `health`, and a distinctive control/weapon fingerprint so the round-trip is
 * unambiguous.
 */
function spawnSprite(
  world: ReturnType<typeof createWorld>,
  num: number,
  pos: { x: number; y: number },
  vel: { x: number; y: number },
  health: number,
): void {
  const parts = world.spriteParts!;
  parts.createPart(vec2(pos.x, pos.y), vec2(vel.x, vel.y), 1, num);

  const sprite = world.sprites[num]!;
  sprite.active = true;
  sprite.num = num;
  sprite.style = 1;
  sprite.position = POS_STAND;
  sprite.direction = 1;
  sprite.health = health;
  sprite.vest = 17 + num;
  sprite.selWeapon = 3 + num;
  sprite.lastWeaponStyle = 1;
  sprite.bulletCount = 25 + num;
  sprite.grenadeCanThrow = true;
  sprite.wearHelmet = 1;
  sprite.hasCigar = 0;
  sprite.control.mouseAimX = 100 * num;
  sprite.control.mouseAimY = -50 * num;
  sprite.control.fire = true;
  sprite.control.right = true;
}

describe("captureSpriteSnapshot / applySpriteSnapshot (full round-trip)", () => {
  it("reconstructs two active sprites onto a fresh world", () => {
    const src = createWorld();
    initSimWorld(src, { seed: SEED });
    src.serverTickCounter = 42;

    spawnSprite(src, 1, { x: 10, y: -20 }, { x: 1.5, y: -0.25 }, 150);
    spawnSprite(src, 2, { x: -300, y: 88 }, { x: -2, y: 3 }, 90);

    const messages = captureSpriteSnapshot(src);
    expect(messages).toHaveLength(2);

    // Fresh destination world — no sprites spawned.
    const dst = createWorld();
    initSimWorld(dst, { seed: SEED });
    for (const msg of messages) {
      expect(msg.kind).toBe("spriteSnapshot");
      if (msg.kind === "spriteSnapshot") {
        applySpriteSnapshot(dst, msg);
      }
    }

    for (const num of [1, 2]) {
      const s = src.sprites[num]!;
      const d = dst.sprites[num]!;
      const sp = src.spriteParts!;
      const dp = dst.spriteParts!;

      expect(d.active).toBe(true);
      // Position from the COM particle.
      expect(dp.posX[num]).toBe(sp.posX[num]);
      expect(dp.posY[num]).toBe(sp.posY[num]);
      // Velocity from the COM particle.
      expect(dp.velocityX[num]).toBe(sp.velocityX[num]);
      expect(dp.velocityY[num]).toBe(sp.velocityY[num]);
      // Health.
      expect(d.health).toBe(s.health);
      expect(d.vest).toBe(s.vest);
      // Aim / direction / posture.
      expect(d.control.mouseAimX).toBe(s.control.mouseAimX);
      expect(d.control.mouseAimY).toBe(s.control.mouseAimY);
      expect(d.position).toBe(s.position);
      // Buttons.
      expect(d.control.fire).toBe(s.control.fire);
      expect(d.control.right).toBe(s.control.right);
      expect(d.control.left).toBe(false);
      // Weapons / cosmetics.
      expect(d.selWeapon).toBe(s.selWeapon);
      expect(d.bulletCount).toBe(s.bulletCount);
      expect(d.wearHelmet).toBe(s.wearHelmet);
    }
  });

  it("translates prone posture across the wire encoding", () => {
    const src = createWorld();
    initSimWorld(src, { seed: SEED });
    spawnSprite(src, 1, { x: 0, y: 0 }, { x: 0, y: 0 }, 100);
    src.sprites[1]!.position = POS_PRONE;

    const snap = captureSpriteSnapshotOne(src.sprites[1]!, src.spriteParts!, 7);
    expect(snap.posture).toBe(Posture.Prone);

    const dst = createWorld();
    initSimWorld(dst, { seed: SEED });
    applySpriteSnapshot(dst, snap);
    expect(dst.sprites[1]!.position).toBe(POS_PRONE);
  });
});

describe("diffSpriteSnapshot / applySpriteDelta (delta path)", () => {
  it("a delta applied to the earlier full reproduces the later full", () => {
    const w0 = createWorld();
    initSimWorld(w0, { seed: SEED });
    w0.serverTickCounter = 100;
    spawnSprite(w0, 1, { x: 0, y: 0 }, { x: 0, y: 0 }, 100);
    const prev = captureSpriteSnapshotOne(w0.sprites[1]!, w0.spriteParts!, 100);

    // Advance the same sprite: move, take damage, change aim + buttons + weapon.
    const w1 = createWorld();
    initSimWorld(w1, { seed: SEED });
    w1.serverTickCounter = 130;
    spawnSprite(w1, 1, { x: 64, y: -12 }, { x: 2.5, y: 1.0 }, 73);
    const s1 = w1.sprites[1]!;
    s1.control.mouseAimX = 999;
    s1.control.left = true;
    s1.control.right = false;
    s1.selWeapon = 11;
    const curr = captureSpriteSnapshotOne(s1, w1.spriteParts!, 130);

    const delta = diffSpriteSnapshot(prev, curr);
    const reproduced = applySpriteDelta(prev, delta);

    expect(reproduced).toEqual(curr);

    // And the reproduced full applies onto a fresh world to the later state.
    const dst = createWorld();
    initSimWorld(dst, { seed: SEED });
    applySpriteSnapshot(dst, reproduced);
    const dp = dst.spriteParts!;
    expect(dp.posX[1]).toBe(64);
    expect(dp.posY[1]).toBe(-12);
    expect(dst.sprites[1]!.health).toBe(73);
    expect(dst.sprites[1]!.selWeapon).toBe(11);
  });

  it("omits unchanged fields and carries changed ones", () => {
    const w = createWorld();
    initSimWorld(w, { seed: SEED });
    spawnSprite(w, 1, { x: 5, y: 5 }, { x: 0, y: 0 }, 100);
    const base = captureSpriteSnapshotOne(w.sprites[1]!, w.spriteParts!, 1);

    // Identical state -> delta carries only num + serverTick.
    const noChange = diffSpriteSnapshot(base, { ...base, serverTick: 2 });
    expect(noChange.pos).toBeUndefined();
    expect(noChange.health).toBeUndefined();
    expect(noChange.buttons).toBeUndefined();
    expect(noChange.serverTick).toBe(2);

    // Only health changed.
    const hurt = diffSpriteSnapshot(base, { ...base, health: 40, serverTick: 3 });
    expect(hurt.health).toBe(40);
    expect(hurt.pos).toBeUndefined();
    expect(hurt.velocity).toBeUndefined();
  });
});
