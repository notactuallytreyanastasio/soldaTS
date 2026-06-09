/**
 * Kill-attribution bookkeeping in the damage core: applyHealthHit records the
 * owner of the damaging bullet on the victim (Sprite.lastHitBy), on EVERY hit
 * (last hit wins), so death consumers can credit the killer when deadMeat
 * flips.
 */
import { describe, it, expect } from 'vitest';

import { createWorld } from '../world';
import { applyHealthHit, STARTHEALTH } from './damage';

/** A world with a live victim in slot 2 and bullets owned by slots 3 / 4. */
function arrangedWorld() {
  const world = createWorld();
  const victim = world.sprites[2]!;
  victim.active = true;
  victim.health = STARTHEALTH;

  const bulletA = world.bullets[1]!;
  bulletA.active = true;
  bulletA.num = 1;
  bulletA.owner = 3;

  const bulletB = world.bullets[2]!;
  bulletB.active = true;
  bulletB.num = 2;
  bulletB.owner = 4;

  return { world, victim };
}

describe('applyHealthHit — lastHitBy attribution', () => {
  it('records the bullet owner on a non-lethal hit', () => {
    const { world, victim } = arrangedWorld();
    applyHealthHit(world, 2, 50, 1);
    expect(victim.lastHitBy).toBe(3);
    expect(victim.health).toBe(STARTHEALTH - 50);
    expect(victim.deadMeat).toBe(false);
  });

  it('last hit wins when a second shooter lands a hit', () => {
    const { world, victim } = arrangedWorld();
    applyHealthHit(world, 2, 50, 1);
    applyHealthHit(world, 2, 30, 2);
    expect(victim.lastHitBy).toBe(4);
  });

  it('the lethal hit credits its owner alongside deadMeat', () => {
    const { world, victim } = arrangedWorld();
    applyHealthHit(world, 2, 40, 1);
    applyHealthHit(world, 2, 500, 2);
    expect(victim.deadMeat).toBe(true);
    expect(victim.lastHitBy).toBe(4);
  });

  it('leaves lastHitBy untouched when the bullet slot is missing', () => {
    const { world, victim } = arrangedWorld();
    victim.lastHitBy = 7;
    applyHealthHit(world, 2, 10, 999);
    expect(victim.lastHitBy).toBe(7);
  });
});
