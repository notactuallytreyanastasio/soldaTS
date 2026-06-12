/**
 * Barrel-module tests for @soldat/netcode (src/index.ts).
 *
 * The index re-exports ./snapshot and ./prediction wholesale; client and
 * server both import through this single entry point, so a broken re-export
 * breaks the whole netcode layer even when the underlying modules are fine.
 * Asserts (1) every public symbol is present on the barrel, (2) the barrel
 * exports ARE the underlying module's symbols (same references, not copies),
 * and (3) a consumer can actually drive a snapshot round-trip using only
 * barrel imports.
 */
import { describe, it, expect } from 'vitest';
import * as netcode from './index';
import * as snapshotModule from './snapshot';
import * as predictionModule from './prediction';
import {
  captureSpriteSnapshot,
  captureSpriteSnapshotOne,
  applySpriteSnapshot,
  PredictionBuffer,
  applyInputToSprite,
} from './index';
import { createWorld, initSimWorld, vec2, POS_STAND } from '@soldat/sim';

const SEED = 0x1234abcd;

/** Spawn one active sprite the way snapshot.test.ts does (COM part + fields). */
function spawnSprite(world: ReturnType<typeof createWorld>, num: number): void {
  const parts = world.spriteParts!;
  parts.createPart(vec2(64, -32), vec2(1, -0.5), 1, num);
  const sprite = world.sprites[num]!;
  sprite.active = true;
  sprite.num = num;
  sprite.position = POS_STAND;
  sprite.direction = 1;
  sprite.health = 120;
}

describe('@soldat/netcode barrel exports', () => {
  it('re-exports every snapshot function', () => {
    expect(typeof netcode.captureSpriteSnapshot).toBe('function');
    expect(typeof netcode.captureSpriteSnapshotOne).toBe('function');
    expect(typeof netcode.applySpriteSnapshot).toBe('function');
    expect(typeof netcode.diffSpriteSnapshot).toBe('function');
    expect(typeof netcode.applySpriteDelta).toBe('function');
  });

  it('re-exports every prediction symbol', () => {
    expect(typeof netcode.PredictionBuffer).toBe('function'); // class
    expect(typeof netcode.applyInputToSprite).toBe('function');
  });

  it('barrel symbols are identical references to the source modules', () => {
    // `export * from` must not wrap or shadow — identity proves the seam.
    expect(netcode.captureSpriteSnapshot).toBe(snapshotModule.captureSpriteSnapshot);
    expect(netcode.captureSpriteSnapshotOne).toBe(snapshotModule.captureSpriteSnapshotOne);
    expect(netcode.applySpriteSnapshot).toBe(snapshotModule.applySpriteSnapshot);
    expect(netcode.diffSpriteSnapshot).toBe(snapshotModule.diffSpriteSnapshot);
    expect(netcode.applySpriteDelta).toBe(snapshotModule.applySpriteDelta);
    expect(netcode.PredictionBuffer).toBe(predictionModule.PredictionBuffer);
    expect(netcode.applyInputToSprite).toBe(predictionModule.applyInputToSprite);
  });

  it('does not leak unexpected non-function exports', () => {
    // Everything public on the barrel is a function/class (types are erased).
    for (const [name, value] of Object.entries(netcode)) {
      expect(typeof value, `export '${name}'`).toBe('function');
    }
  });

  it('a consumer can run a snapshot round-trip using only barrel imports', () => {
    const world = createWorld();
    initSimWorld(world, { seed: SEED });
    spawnSprite(world, 1);

    const messages = captureSpriteSnapshot(world, 7);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.kind).toBe('spriteSnapshot');
    if (msg.kind !== 'spriteSnapshot') throw new Error('unreachable');
    expect(msg.snapshot.kind).toBe('full');
    if (msg.snapshot.kind !== 'full') throw new Error('unreachable');
    expect(msg.snapshot.num).toBe(1);
    expect(msg.snapshot.serverTick).toBe(7);

    const one = captureSpriteSnapshotOne(world.sprites[1]!, world.spriteParts!, 7);
    expect(one).toEqual(msg.snapshot);

    // Apply onto a fresh world (no sprites spawned) and re-capture: the
    // reconstruction must reproduce position and health.
    const fresh = createWorld();
    initSimWorld(fresh, { seed: SEED });
    applySpriteSnapshot(fresh, msg);
    const reCaptured = captureSpriteSnapshotOne(fresh.sprites[1]!, fresh.spriteParts!, 7);
    expect(reCaptured.pos).toEqual(one.pos);
    expect(reCaptured.health).toBe(one.health);
  });

  it('a consumer can construct a PredictionBuffer from the barrel', () => {
    const world = createWorld();
    initSimWorld(world, { seed: SEED });
    spawnSprite(world, 1);
    const buf = new PredictionBuffer(world, 1);
    expect(buf).toBeInstanceOf(PredictionBuffer);
    expect(buf.predictedWorld).toBe(world);
    expect(buf.pendingCount).toBe(0);
    expect(buf.acknowledgedServerTick).toBe(-1);
    expect(typeof applyInputToSprite).toBe('function');
  });
});
