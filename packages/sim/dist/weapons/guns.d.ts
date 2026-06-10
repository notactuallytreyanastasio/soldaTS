export declare const WeaponIndex: {
    readonly EAGLE: 1;
    readonly MP5: 2;
    readonly AK74: 3;
    readonly STEYRAUG: 4;
    readonly SPAS12: 5;
    readonly RUGER77: 6;
    readonly M79: 7;
    readonly BARRETT: 8;
    readonly M249: 9;
    readonly MINIGUN: 10;
    readonly COLT: 11;
    readonly KNIFE: 12;
    readonly CHAINSAW: 13;
    readonly LAW: 14;
    readonly BOW2: 15;
    readonly BOW: 16;
    readonly FLAMER: 17;
    readonly M2: 18;
    readonly NOWEAPON: 19;
    readonly FRAGGRENADE: 20;
    readonly CLUSTERGRENADE: 21;
    readonly CLUSTER: 22;
    readonly THROWNKNIFE: 23;
};
export declare const PRIMARY_WEAPONS = 10;
export declare const SECONDARY_WEAPONS = 4;
export declare const BONUS_WEAPONS = 3;
export declare const MAIN_WEAPONS: number;
export declare const EXTENDED_WEAPONS: number;
export declare const ORIGINAL_WEAPONS = 20;
export declare const TOTAL_WEAPONS = 23;
export declare const WeaponNum: {
    readonly EAGLE: 1;
    readonly MP5: 2;
    readonly AK74: 3;
    readonly STEYRAUG: 4;
    readonly SPAS12: 5;
    readonly RUGER77: 6;
    readonly M79: 7;
    readonly BARRETT: 8;
    readonly M249: 9;
    readonly MINIGUN: 10;
    readonly COLT: 0;
    readonly KNIFE: 11;
    readonly CHAINSAW: 12;
    readonly LAW: 13;
    readonly BOW2: 16;
    readonly BOW: 15;
    readonly FLAMER: 14;
    readonly M2: 30;
    readonly NOWEAPON: 255;
    readonly FRAGGRENADE: 50;
    readonly CLUSTERGRENADE: 51;
    readonly CLUSTER: 52;
    readonly THROWNKNIFE: 53;
};
export declare const BulletStyle: {
    readonly PLAIN: 1;
    readonly FRAGNADE: 2;
    readonly SHOTGUN: 3;
    readonly M79: 4;
    readonly FLAME: 5;
    readonly PUNCH: 6;
    readonly ARROW: 7;
    readonly FLAMEARROW: 8;
    readonly CLUSTERNADE: 9;
    readonly CLUSTER: 10;
    readonly KNIFE: 11;
    readonly LAW: 12;
    readonly THROWNKNIFE: 13;
    readonly M2: 14;
};
export type BulletStyle = (typeof BulletStyle)[keyof typeof BulletStyle];
export declare const BULLET_TIMEOUT = 420;
export declare const GRENADE_TIMEOUT = 180;
export declare const M2BULLET_TIMEOUT = 60;
export declare const FLAMER_TIMEOUT = 32;
export declare const MELEE_TIMEOUT = 1;
export interface Gun {
    /** PORT: TGun.Name (Weapons.pas:37) — display name */
    name: string;
    /** PORT: TGun.Num (Weapons.pas:18) — on-wire / ini weapon identity (see QUIRK) */
    num: number;
    /** PORT: TGun.HitMultiply (Weapons.pas:40) — base damage multiplier */
    hitMultiply: number;
    /** PORT: TGun.Speed (Weapons.pas:39) — muzzle/bullet speed (contract: bulletSpeed) */
    bulletSpeed: number;
    /** PORT: TGun.StartUpTime (Weapons.pas:26) — ticks of windup before first shot */
    startUpTime: number;
    /** PORT: TGun.ReloadTime (Weapons.pas:28) — reload duration in ticks */
    reloadTime: number;
    /** PORT: TGun.Ammo (Weapons.pas:16) — magazine capacity */
    ammo: number;
    /** PORT: TGun.FireInterval (Weapons.pas:22) — ticks between shots */
    fireInterval: number;
    /** PORT: TGun.MovementAcc (Weapons.pas:19) — movement-induced inaccuracy */
    movementAcc: number;
    /** PORT: TGun.Bink (Weapons.pas:20) — accumulated-fire accuracy penalty (SmallInt, can be negative) */
    bink: number;
    /** PORT: TGun.Recoil (Weapons.pas:21) — recoil (realistic mode only; 0 in normal) */
    recoil: number;
    /** PORT: TGun.Push (Weapons.pas:42) — knockback applied to target */
    push: number;
    /** PORT: TGun.InheritedVelocity (Weapons.pas:43) — fraction of shooter velocity inherited by bullet */
    inheritedVelocity: number;
    /** PORT: TGun.ModifierHead (Weapons.pas:46) — headshot damage multiplier */
    modifierHead: number;
    /** PORT: TGun.ModifierChest (Weapons.pas:45) — chest damage multiplier */
    modifierChest: number;
    /** PORT: TGun.ModifierLegs (Weapons.pas:44) — legs damage multiplier */
    modifierLegs: number;
    /** PORT: TGun.BulletSpread (Weapons.pas:41) — base spread */
    bulletSpread: number;
    /** PORT: TGun.BulletStyle (Weapons.pas:50) — dispatch into bullet behaviour (BulletStyle.*) */
    bulletStyle: number;
    /** PORT: derived in BuildWeapons (Weapons.pas:1339-1350) — bullet lifetime in ticks */
    timeout: number;
    /** PORT: TGun.ClipReload (Weapons.pas:34) — whether the magazine animation runs */
    clipReload: boolean;
    /** PORT: derived in BuildWeapons (Weapons.pas:1330) — Trunc(ReloadTime*0.8) or 0 */
    clipOutTime: number;
    /** PORT: derived in BuildWeapons (Weapons.pas:1331) — Trunc(ReloadTime*0.3) or 0 */
    clipInTime: number;
}
/**
 * Return the Gun stats for a weapon array index in the requested mode.
 * PORT: equivalent to indexing Guns[] after CreateDefaultWeapons(RealisticMode).
 * @param index 1-based WeaponIndex (1..TOTAL_WEAPONS)
 * @param realistic true for realistic-mode stats, false for normal mode
 */
export declare function getGun(index: number, realistic: boolean): Gun;
//# sourceMappingURL=guns.d.ts.map