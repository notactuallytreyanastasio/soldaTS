/**
 * Bullet damage application — port of the `Sprite[j].HealthHit(...)` call sites
 * in `TBullet.CheckSpriteCollision` together with the damage core of
 * `TSprite.HealthHit` (shared/mechanics/Sprites.pas:3250-3362).
 *
 * Faithful-first: the damage *amount* is computed exactly as the engine does for
 * a plain/shotgun/punch/knife/M2 body hit —
 *
 *   Amount := Speed * HitMultiply * HitboxModifier
 *
 * where Speed = |bullet velocity|, HitMultiply is the bullet's per-shot damage
 * multiplier (already degraded by distance in `updateBullet`), and the hitbox
 * modifier is selected by the hit body part (`Where`):
 *
 *   Where <= 4  -> ModifierLegs    (legs / lower body)
 *   Where <= 11 -> ModifierChest   (torso)
 *   else        -> ModifierHead    (head)   (PORT: Bullets.pas:1617-1622)
 *
 * The health-reduction core mirrors `TSprite.HealthHit`:
 *   - vest absorption (Sprites.pas:3289-3294),
 *   - berserker 4x (Sprites.pas:3296-3301),
 *   - Health := Health - HM (Sprites.pas:3308),
 *   - health clamps + death threshold (Sprites.pas:3349-3362).
 *
 * OMITTED here (client/script/server-only, not part of the sim damage core):
 *   friendly-fire / rambo-mode gating (Sprites.pas:3263-3285), the script
 *   OnPlayerDamage hook (3303-3306), helmet-fall (3337-3347), WepStats bookkeeping
 *   and the full `Die` ragdoll/respawn pipeline. We collapse "death" to setting
 *   `deadMeat = true` once Health < 1 (Sprites.pas:3357), which is what the kill
 *   bookkeeping the simulation needs keys off.
 *
 * Track A owns `weapons/guns.ts`. To stay decoupled while that lands, the hitbox
 * modifiers are passed in via a small {@link GunModifiers} contract that is
 * structurally a subset of the SHARED WEAPON CONTRACT `Gun` (so a resolved
 * `getGun(...)` can be handed straight in).
 */
import { f } from '../scalar';
import type { World } from '../world';
import type { Vec2 } from '../math/vec2';
import { length as vec2Length } from '../math/vec2';

// PORT: shared/Constants.pas:75-77 — health clamp / death thresholds.
export const STARTHEALTH = 150 as const; // Constants.pas:75 — STARTHEALTH = 150
export const BRUTALDEATHHEALTH = -400 as const; // Constants.pas:77 — BRUTALDEATHHEALTH = -400

/**
 * The slice of the SHARED WEAPON CONTRACT `Gun` that damage needs: the three
 * body-part multipliers and the per-shot `hitMultiply`. A resolved `Gun` from
 * Track A's `getGun(...)` satisfies this structurally.
 */
export interface GunModifiers {
  hitMultiply: number;
  modifierHead: number;
  modifierChest: number;
  modifierLegs: number;
}

// PORT: shared/mechanics/Bullets.pas:1617-1622 — hitbox modifier by body part.
//   Where <= 4  -> ModifierLegs
//   Where <= 11 -> ModifierChest
//   else        -> ModifierHead
export function hitboxModifier(gun: GunModifiers, where: number): number {
  if (where <= 4) {
    return gun.modifierLegs;
  }
  if (where <= 11) {
    return gun.modifierChest;
  }
  return gun.modifierHead;
}

/**
 * Apply a single plain-bullet body hit to sprite `spriteIndex`, faithfully
 * reproducing the damage amount of the BULLET_STYLE_PLAIN/SHOTGUN/PUNCH/KNIFE/M2
 * branch (Bullets.pas:1624-1630) and the health-reduction core of
 * `TSprite.HealthHit` (Sprites.pas:3287-3362).
 *
 * @param world        the world state (sprites + spriteParts not required here)
 * @param bulletIndex  the firing bullet (provides velocity, hitMultiply, owner)
 * @param spriteIndex  the victim sprite (1-based)
 * @param hitPart      `Where` body-part id (3..12 in the Pascal priority set)
 * @param gun          the owner weapon's hitbox modifiers (Track A contract)
 * @returns the damage actually subtracted from health (`HM`), for callers/tests.
 *
 * PORT: shared/mechanics/Bullets.pas:1616-1631, shared/mechanics/Sprites.pas:3287-3362.
 */
export function applyBulletDamage(
  world: World,
  bulletIndex: number,
  spriteIndex: number,
  hitPart: number,
  gun: GunModifiers,
): number {
  const bullet = world.bullets[bulletIndex];
  const sprite = world.sprites[spriteIndex];
  if (bullet === undefined || sprite === undefined) {
    return 0;
  }

  // Speed := Vec2Length(BulletVelocity)   (Bullets.pas:1624)
  // The bullet's live velocity lives in the BulletParts particle at index = num.
  let velocity: Vec2 = bullet.velocityPrev;
  const bp = world.bulletParts;
  if (bp !== null) {
    velocity = { x: bp.velocityX[bullet.num] ?? 0, y: bp.velocityY[bullet.num] ?? 0 };
  }
  const speed = vec2Length(velocity);

  const modifier = hitboxModifier(gun, hitPart);

  // Amount := Speed * HitMultiply * HitboxModifier   (Bullets.pas:1628-1630)
  const amount = f(f(speed * bullet.hitMultiply) * modifier);

  return applyHealthHit(world, spriteIndex, amount, bulletIndex);
}

/**
 * The health-reduction core of `TSprite.HealthHit` (Sprites.pas:3287-3362),
 * minus the client/script/server-only gating. Subtracts the (vest/berserker
 * adjusted) damage from `Health`, clamps, and marks `deadMeat` on death.
 *
 * @returns HM — the amount actually subtracted from `Health`.
 *
 * PORT: shared/mechanics/Sprites.pas:3287-3362.
 */
export function applyHealthHit(
  world: World,
  spriteIndex: number,
  amount: number,
  bulletIndex: number,
): number {
  const sprite = world.sprites[spriteIndex];
  if (sprite === undefined) {
    return 0;
  }

  // HM := Amount   (Sprites.pas:3287)
  let hm = amount;

  // Vest absorption (Sprites.pas:3289-3294).
  //   HM := Round(0.33*Amount); Vest := Vest - HM; HM := Round(0.25*Amount);
  if (sprite.vest > 0) {
    hm = Math.round(f(0.33 * amount));
    sprite.vest = f(sprite.vest - hm);
    hm = Math.round(f(0.25 * amount));
  }

  // Berserker 4x (Sprites.pas:3296-3301). The bullet owner being a berserker
  // quadruples the damage. `What <> Num` guard is the {$IFNDEF SERVER} branch;
  // we apply the server-side (unconditional) form.
  const bullet = world.bullets[bulletIndex];
  const owner = bullet !== undefined ? world.sprites[bullet.owner] : undefined;
  // DESIGN OVERRIDE: kill attribution — remember who landed the last damaging
  // bullet (last hit wins). Recorded on EVERY hit, not just the lethal one, so
  // whoever flips deadMeat below is credited by the death consumer.
  if (bullet !== undefined) {
    sprite.lastHitBy = bullet.owner;
  }
  // PORT: shared/Constants.pas:199 — BONUS_BERSERKER = 21.
  if (owner !== undefined && owner.bonusStyle === 21) {
    hm = f(4 * amount);
  }

  // Health := Health - HM   (Sprites.pas:3308)
  sprite.health = f(sprite.health - hm);

  // GLUE: telemetry observer — notification only, after the damage landed.
  world.onDamage?.(spriteIndex, bullet !== undefined ? bullet.owner : 0, hm);

  // safety precautions (Sprites.pas:3349-3353)
  if (sprite.health < BRUTALDEATHHEALTH - 1) {
    sprite.health = BRUTALDEATHHEALTH;
  }
  if (sprite.health > STARTHEALTH) {
    sprite.health = STARTHEALTH;
  }

  // death! (Sprites.pas:3357-3362). The full Die() pipeline is out of scope for
  // the sim damage core; we record the kill by flagging deadMeat.
  if (sprite.health < 1) {
    sprite.deadMeat = true;
  }

  return hm;
}
