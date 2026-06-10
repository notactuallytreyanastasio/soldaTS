import type { World } from '../world';
export declare const STARTHEALTH: 150;
export declare const BRUTALDEATHHEALTH: -400;
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
export declare function hitboxModifier(gun: GunModifiers, where: number): number;
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
export declare function applyBulletDamage(world: World, bulletIndex: number, spriteIndex: number, hitPart: number, gun: GunModifiers): number;
/**
 * The health-reduction core of `TSprite.HealthHit` (Sprites.pas:3287-3362),
 * minus the client/script/server-only gating. Subtracts the (vest/berserker
 * adjusted) damage from `Health`, clamps, and marks `deadMeat` on death.
 *
 * @returns HM — the amount actually subtracted from `Health`.
 *
 * PORT: shared/mechanics/Sprites.pas:3287-3362.
 */
export declare function applyHealthHit(world: World, spriteIndex: number, amount: number, bulletIndex: number): number;
//# sourceMappingURL=damage.d.ts.map