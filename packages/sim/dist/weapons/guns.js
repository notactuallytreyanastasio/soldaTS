// PORT: shared/Weapons.pas — weapon stat tables (TGun, Guns[], normal & realistic modes)
// PORT: shared/Constants.pas — weapon id constants, BulletStyle, bullet-timeout constants
//
// This module ports the *balance* portion of OpenSoldat's Weapons unit: the per-weapon
// stat tables for NORMAL and REALISTIC modes, plus the index/num/BulletStyle enums.
// Rendering-only fields (TextureNum, FireStyle, ClipTextureNum, BulletImageStyle) and
// the runtime mutable counters (AmmoCount, FireIntervalCount, ...) are intentionally
// omitted; the BuildWeapons() derivations that produce them are reproduced where they
// affect static stats (ClipOutTime/ClipInTime, Timeout).
//
// Float stats are wrapped in f() to match the Pascal `Single` (32-bit) arithmetic so
// downstream physics stays bit-faithful.
import { f } from '../scalar';
// ---------------------------------------------------------------------------
// Weapon array-index constants. PORT: shared/Weapons.pas:56-78
// These are the 1-based indices into the Guns[] array (Pascal `array[1..TOTAL_WEAPONS]`).
// ---------------------------------------------------------------------------
export const WeaponIndex = {
    EAGLE: 1,
    MP5: 2,
    AK74: 3,
    STEYRAUG: 4,
    SPAS12: 5,
    RUGER77: 6,
    M79: 7,
    BARRETT: 8,
    M249: 9,
    MINIGUN: 10,
    COLT: 11,
    KNIFE: 12,
    CHAINSAW: 13,
    LAW: 14,
    BOW2: 15,
    BOW: 16,
    FLAMER: 17,
    M2: 18,
    NOWEAPON: 19,
    FRAGGRENADE: 20,
    CLUSTERGRENADE: 21,
    CLUSTER: 22,
    THROWNKNIFE: 23,
};
// PORT: shared/Weapons.pas:80-87
export const PRIMARY_WEAPONS = 10;
export const SECONDARY_WEAPONS = 4;
export const BONUS_WEAPONS = 3;
export const MAIN_WEAPONS = PRIMARY_WEAPONS + SECONDARY_WEAPONS; // 14
export const EXTENDED_WEAPONS = MAIN_WEAPONS + BONUS_WEAPONS; // 17
export const ORIGINAL_WEAPONS = 20;
export const TOTAL_WEAPONS = 23;
// ---------------------------------------------------------------------------
// Weapon "Num" constants. PORT: shared/Weapons.pas:90-112
//
// QUIRK: The array index (WeaponIndex.COLT = 11) does NOT equal the weapon's Num
// field (COLT_NUM = 0). For the ten primary weapons index == num, but the COLT
// (USSOCOM) lives at array index 11 while its Num is 0. The secondary/bonus weapons
// are likewise renumbered (e.g. KNIFE is index 12 but Num 11). The Pascal source flags
// this with `// FIXME(skoskav): Normalize weapons' num with their index`. Network code
// and savefiles use Num; the Guns[] array uses index. WeaponNum is the on-wire / ini
// identity; WeaponIndex is the storage slot.
// ---------------------------------------------------------------------------
export const WeaponNum = {
    EAGLE: 1,
    MP5: 2,
    AK74: 3,
    STEYRAUG: 4,
    SPAS12: 5,
    RUGER77: 6,
    M79: 7,
    BARRETT: 8,
    M249: 9,
    MINIGUN: 10,
    COLT: 0, // <-- COLT_NUM = 0 (NOT 11). See QUIRK note above.
    KNIFE: 11,
    CHAINSAW: 12,
    LAW: 13,
    BOW2: 16,
    BOW: 15,
    FLAMER: 14,
    M2: 30,
    NOWEAPON: 255,
    FRAGGRENADE: 50,
    CLUSTERGRENADE: 51,
    CLUSTER: 52,
    THROWNKNIFE: 53,
};
// ---------------------------------------------------------------------------
// BulletStyle dispatch enum. PORT: shared/Weapons.pas:115-128
// ---------------------------------------------------------------------------
export const BulletStyle = {
    PLAIN: 1,
    FRAGNADE: 2,
    SHOTGUN: 3,
    M79: 4,
    FLAME: 5,
    PUNCH: 6,
    ARROW: 7,
    FLAMEARROW: 8,
    CLUSTERNADE: 9,
    CLUSTER: 10,
    KNIFE: 11,
    LAW: 12,
    THROWNKNIFE: 13,
    M2: 14,
};
// ---------------------------------------------------------------------------
// Bullet lifetime constants. PORT: shared/Constants.pas (BULLET_TIMEOUT etc.)
// Cross-checked against docs/rewrite-reference/physics-and-balance-constants.md:51-55.
// Used by BuildWeapons() to derive Gun.Timeout from BulletStyle.
// ---------------------------------------------------------------------------
export const BULLET_TIMEOUT = 420;
export const GRENADE_TIMEOUT = 180;
export const M2BULLET_TIMEOUT = 60;
export const FLAMER_TIMEOUT = 32;
export const MELEE_TIMEOUT = 1;
// PORT: CreateWeaponsBase (Weapons.pas:210-490) — only Name/Num/ClipReload are needed
// for the balance subset. Indexed by WeaponIndex.
const BASE = {
    [WeaponIndex.EAGLE]: { name: 'Desert Eagles', num: WeaponNum.EAGLE, clipReload: true },
    [WeaponIndex.MP5]: { name: 'HK MP5', num: WeaponNum.MP5, clipReload: true },
    [WeaponIndex.AK74]: { name: 'Ak-74', num: WeaponNum.AK74, clipReload: true },
    [WeaponIndex.STEYRAUG]: { name: 'Steyr AUG', num: WeaponNum.STEYRAUG, clipReload: true },
    [WeaponIndex.SPAS12]: { name: 'Spas-12', num: WeaponNum.SPAS12, clipReload: false },
    [WeaponIndex.RUGER77]: { name: 'Ruger 77', num: WeaponNum.RUGER77, clipReload: false },
    [WeaponIndex.M79]: { name: 'M79', num: WeaponNum.M79, clipReload: true },
    [WeaponIndex.BARRETT]: { name: 'Barrett M82A1', num: WeaponNum.BARRETT, clipReload: true },
    [WeaponIndex.M249]: { name: 'FN Minimi', num: WeaponNum.M249, clipReload: true },
    [WeaponIndex.MINIGUN]: { name: 'XM214 Minigun', num: WeaponNum.MINIGUN, clipReload: false },
    [WeaponIndex.COLT]: { name: 'USSOCOM', num: WeaponNum.COLT, clipReload: true },
    [WeaponIndex.KNIFE]: { name: 'Combat Knife', num: WeaponNum.KNIFE, clipReload: false },
    [WeaponIndex.CHAINSAW]: { name: 'Chainsaw', num: WeaponNum.CHAINSAW, clipReload: false },
    [WeaponIndex.LAW]: { name: 'LAW', num: WeaponNum.LAW, clipReload: true },
    [WeaponIndex.BOW2]: { name: 'Flame Bow', num: WeaponNum.BOW2, clipReload: false },
    [WeaponIndex.BOW]: { name: 'Bow', num: WeaponNum.BOW, clipReload: false },
    [WeaponIndex.FLAMER]: { name: 'Flamer', num: WeaponNum.FLAMER, clipReload: false },
    [WeaponIndex.M2]: { name: 'M2 MG', num: WeaponNum.M2, clipReload: false },
    [WeaponIndex.NOWEAPON]: { name: 'Hands', num: WeaponNum.NOWEAPON, clipReload: false },
    [WeaponIndex.FRAGGRENADE]: { name: 'Frag Grenade', num: WeaponNum.FRAGGRENADE, clipReload: false },
    [WeaponIndex.CLUSTERGRENADE]: { name: 'Frag Grenade', num: WeaponNum.CLUSTERGRENADE, clipReload: false },
    [WeaponIndex.CLUSTER]: { name: 'Frag Grenade', num: WeaponNum.CLUSTER, clipReload: false },
    [WeaponIndex.THROWNKNIFE]: { name: 'Combat Knife', num: WeaponNum.THROWNKNIFE, clipReload: false },
};
// PORT: CreateNormalWeapons (Weapons.pas:492-875)
// Floats wrapped in f() to mirror Single arithmetic; integers (ticks/ammo/bink) left raw.
const NORMAL = {
    // Desert Eagle — Weapons.pas:497-513
    [WeaponIndex.EAGLE]: { hitMultiply: f(1.81), fireInterval: 24, ammo: 7, reloadTime: 87, bulletSpeed: f(19), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: 0, movementAcc: f(0.009), bulletSpread: f(0.15), recoil: 0, push: f(0.0176), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(0.95), modifierLegs: f(0.85) },
    // MP5 — Weapons.pas:516-532
    [WeaponIndex.MP5]: { hitMultiply: f(1.01), fireInterval: 6, ammo: 30, reloadTime: 105, bulletSpeed: f(18.9), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: 0, movementAcc: f(0), bulletSpread: f(0.14), recoil: 0, push: f(0.0112), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(0.95), modifierLegs: f(0.85) },
    // AK-74 — Weapons.pas:535-551
    [WeaponIndex.AK74]: { hitMultiply: f(1.004), fireInterval: 10, ammo: 35, reloadTime: 165, bulletSpeed: f(24.6), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: -12, movementAcc: f(0.011), bulletSpread: f(0.025), recoil: 0, push: f(0.01376), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(0.95), modifierLegs: f(0.85) },
    // Steyr AUG — Weapons.pas:554-570
    [WeaponIndex.STEYRAUG]: { hitMultiply: f(0.71), fireInterval: 7, ammo: 25, reloadTime: 125, bulletSpeed: f(26), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: 0, movementAcc: f(0), bulletSpread: f(0.075), recoil: 0, push: f(0.0084), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(0.95), modifierLegs: f(0.85) },
    // SPAS-12 — Weapons.pas:573-589
    [WeaponIndex.SPAS12]: { hitMultiply: f(1.22), fireInterval: 32, ammo: 7, reloadTime: 175, bulletSpeed: f(14), bulletStyle: BulletStyle.SHOTGUN, startUpTime: 0, bink: 0, movementAcc: f(0), bulletSpread: f(0.8), recoil: 0, push: f(0.0188), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(0.95), modifierLegs: f(0.85) },
    // Ruger 77 — Weapons.pas:592-608
    [WeaponIndex.RUGER77]: { hitMultiply: f(2.49), fireInterval: 45, ammo: 4, reloadTime: 78, bulletSpeed: f(33), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: 0, movementAcc: f(0.03), bulletSpread: f(0), recoil: 0, push: f(0.012), inheritedVelocity: f(0.5), modifierHead: f(1.2), modifierChest: f(1.05), modifierLegs: f(1) },
    // M79 — Weapons.pas:611-627
    [WeaponIndex.M79]: { hitMultiply: f(1550), fireInterval: 6, ammo: 1, reloadTime: 178, bulletSpeed: f(10.7), bulletStyle: BulletStyle.M79, startUpTime: 0, bink: 0, movementAcc: f(0), bulletSpread: f(0), recoil: 0, push: f(0.036), inheritedVelocity: f(0.5), modifierHead: f(1.15), modifierChest: f(1), modifierLegs: f(0.9) },
    // Barrett M82A1 — Weapons.pas:630-646
    [WeaponIndex.BARRETT]: { hitMultiply: f(4.45), fireInterval: 225, ammo: 10, reloadTime: 70, bulletSpeed: f(55), bulletStyle: BulletStyle.PLAIN, startUpTime: 19, bink: 65, movementAcc: f(0.05), bulletSpread: f(0), recoil: 0, push: f(0.018), inheritedVelocity: f(0.5), modifierHead: f(1), modifierChest: f(1), modifierLegs: f(1) },
    // M249 — Weapons.pas:649-665
    [WeaponIndex.M249]: { hitMultiply: f(0.85), fireInterval: 9, ammo: 50, reloadTime: 250, bulletSpeed: f(27), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: 0, movementAcc: f(0.013), bulletSpread: f(0.064), recoil: 0, push: f(0.0128), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(0.95), modifierLegs: f(0.85) },
    // Minigun — Weapons.pas:668-684
    [WeaponIndex.MINIGUN]: { hitMultiply: f(0.468), fireInterval: 3, ammo: 100, reloadTime: 480, bulletSpeed: f(29), bulletStyle: BulletStyle.PLAIN, startUpTime: 25, bink: 0, movementAcc: f(0.0625), bulletSpread: f(0.3), recoil: 0, push: f(0.0104), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(0.95), modifierLegs: f(0.85) },
    // Colt 1911 / USSOCOM — Weapons.pas:687-703
    [WeaponIndex.COLT]: { hitMultiply: f(1.49), fireInterval: 10, ammo: 14, reloadTime: 60, bulletSpeed: f(18), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: 0, movementAcc: f(0), bulletSpread: f(0), recoil: 0, push: f(0.02), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(0.95), modifierLegs: f(0.85) },
    // Knife — Weapons.pas:706-722
    [WeaponIndex.KNIFE]: { hitMultiply: f(2150), fireInterval: 6, ammo: 1, reloadTime: 3, bulletSpeed: f(6), bulletStyle: BulletStyle.KNIFE, startUpTime: 0, bink: 0, movementAcc: f(0), bulletSpread: f(0), recoil: 0, push: f(0.12), inheritedVelocity: f(0), modifierHead: f(1.15), modifierChest: f(1), modifierLegs: f(0.9) },
    // Chainsaw — Weapons.pas:725-741
    [WeaponIndex.CHAINSAW]: { hitMultiply: f(50), fireInterval: 2, ammo: 200, reloadTime: 110, bulletSpeed: f(8), bulletStyle: BulletStyle.KNIFE, startUpTime: 0, bink: 0, movementAcc: f(0), bulletSpread: f(0), recoil: 0, push: f(0.0028), inheritedVelocity: f(0), modifierHead: f(1.15), modifierChest: f(1), modifierLegs: f(0.9) },
    // M72 LAW — Weapons.pas:744-760
    [WeaponIndex.LAW]: { hitMultiply: f(1550), fireInterval: 6, ammo: 1, reloadTime: 300, bulletSpeed: f(23), bulletStyle: BulletStyle.LAW, startUpTime: 13, bink: 0, movementAcc: f(0), bulletSpread: f(0), recoil: 0, push: f(0.028), inheritedVelocity: f(0.5), modifierHead: f(1.15), modifierChest: f(1), modifierLegs: f(0.9) },
    // Rambo Bow with flame (BOW2) — Weapons.pas:763-779
    [WeaponIndex.BOW2]: { hitMultiply: f(8), fireInterval: 10, ammo: 1, reloadTime: 39, bulletSpeed: f(18), bulletStyle: BulletStyle.FLAMEARROW, startUpTime: 0, bink: 0, movementAcc: f(0), bulletSpread: f(0), recoil: 0, push: f(0), inheritedVelocity: f(0.5), modifierHead: f(1.15), modifierChest: f(1), modifierLegs: f(0.9) },
    // Rambo Bow (BOW) — Weapons.pas:782-798
    [WeaponIndex.BOW]: { hitMultiply: f(12), fireInterval: 10, ammo: 1, reloadTime: 25, bulletSpeed: f(21), bulletStyle: BulletStyle.ARROW, startUpTime: 0, bink: 0, movementAcc: f(0), bulletSpread: f(0), recoil: 0, push: f(0.0148), inheritedVelocity: f(0.5), modifierHead: f(1.15), modifierChest: f(1), modifierLegs: f(0.9) },
    // Flamethrower — Weapons.pas:801-817
    [WeaponIndex.FLAMER]: { hitMultiply: f(19), fireInterval: 6, ammo: 200, reloadTime: 5, bulletSpeed: f(10.5), bulletStyle: BulletStyle.FLAME, startUpTime: 0, bink: 0, movementAcc: f(0), bulletSpread: f(0), recoil: 0, push: f(0.016), inheritedVelocity: f(0.5), modifierHead: f(1.15), modifierChest: f(1), modifierLegs: f(0.9) },
    // M2 — Weapons.pas:820-836
    [WeaponIndex.M2]: { hitMultiply: f(1.8), fireInterval: 10, ammo: 100, reloadTime: 366, bulletSpeed: f(36), bulletStyle: BulletStyle.M2, startUpTime: 0, bink: 0, movementAcc: f(0), bulletSpread: f(0), recoil: 0, push: f(0.0088), inheritedVelocity: f(0), modifierHead: f(1.1), modifierChest: f(0.95), modifierLegs: f(0.85) },
    // No weapon / Punch — Weapons.pas:839-855
    [WeaponIndex.NOWEAPON]: { hitMultiply: f(330), fireInterval: 6, ammo: 1, reloadTime: 3, bulletSpeed: f(5), bulletStyle: BulletStyle.PUNCH, startUpTime: 0, bink: 0, movementAcc: f(0), bulletSpread: f(0), recoil: 0, push: f(0), inheritedVelocity: f(0), modifierHead: f(1.15), modifierChest: f(1), modifierLegs: f(0.9) },
    // Frag grenade — Weapons.pas:858-874
    [WeaponIndex.FRAGGRENADE]: { hitMultiply: f(1500), fireInterval: 80, ammo: 1, reloadTime: 20, bulletSpeed: f(5), bulletStyle: BulletStyle.FRAGNADE, startUpTime: 0, bink: 0, movementAcc: f(0), bulletSpread: f(0), recoil: 0, push: f(0), inheritedVelocity: f(1), modifierHead: f(1), modifierChest: f(1), modifierLegs: f(1) },
};
// PORT: CreateRealisticWeapons (Weapons.pas:877-1260)
const REALISTIC = {
    // Desert Eagle — Weapons.pas:882-898
    [WeaponIndex.EAGLE]: { hitMultiply: f(1.66), fireInterval: 27, ammo: 7, reloadTime: 106, bulletSpeed: f(19), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: 0, movementAcc: f(0.02), bulletSpread: f(0.1), recoil: 55, push: f(0.0164), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // MP5 — Weapons.pas:901-917
    [WeaponIndex.MP5]: { hitMultiply: f(0.94), fireInterval: 6, ammo: 30, reloadTime: 110, bulletSpeed: f(18.9), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: -10, movementAcc: f(0.01), bulletSpread: f(0.03), recoil: 9, push: f(0.0164), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // AK-74 — Weapons.pas:920-936
    [WeaponIndex.AK74]: { hitMultiply: f(1.08), fireInterval: 11, ammo: 35, reloadTime: 158, bulletSpeed: f(24), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: -10, movementAcc: f(0.02), bulletSpread: f(0), recoil: 13, push: f(0.0132), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // Steyr AUG — Weapons.pas:939-955
    [WeaponIndex.STEYRAUG]: { hitMultiply: f(0.68), fireInterval: 7, ammo: 30, reloadTime: 126, bulletSpeed: f(26), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: -9, movementAcc: f(0.01), bulletSpread: f(0), recoil: 11, push: f(0.012), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // SPAS-12 — Weapons.pas:958-974
    [WeaponIndex.SPAS12]: { hitMultiply: f(1.2), fireInterval: 35, ammo: 7, reloadTime: 175, bulletSpeed: f(13.2), bulletStyle: BulletStyle.SHOTGUN, startUpTime: 0, bink: 0, movementAcc: f(0.01), bulletSpread: f(0.8), recoil: 65, push: f(0.0224), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // Ruger 77 — Weapons.pas:977-993
    [WeaponIndex.RUGER77]: { hitMultiply: f(2.22), fireInterval: 52, ammo: 4, reloadTime: 104, bulletSpeed: f(33), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: 14, movementAcc: f(0.03), bulletSpread: f(0), recoil: 54, push: f(0.0096), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // M79 — Weapons.pas:996-1012
    [WeaponIndex.M79]: { hitMultiply: f(1600), fireInterval: 6, ammo: 1, reloadTime: 173, bulletSpeed: f(11.4), bulletStyle: BulletStyle.M79, startUpTime: 0, bink: 45, movementAcc: f(0.03), bulletSpread: f(0), recoil: 420, push: f(0.024), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // Barrett M82A1 — Weapons.pas:1015-1031
    [WeaponIndex.BARRETT]: { hitMultiply: f(4.95), fireInterval: 200, ammo: 10, reloadTime: 170, bulletSpeed: f(55), bulletStyle: BulletStyle.PLAIN, startUpTime: 16, bink: 80, movementAcc: f(0.07), bulletSpread: f(0), recoil: 0, push: f(0.0056), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // M249 — Weapons.pas:1034-1050
    [WeaponIndex.M249]: { hitMultiply: f(0.81), fireInterval: 10, ammo: 50, reloadTime: 261, bulletSpeed: f(27), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: -8, movementAcc: f(0.02), bulletSpread: f(0), recoil: 8, push: f(0.0116), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // Minigun — Weapons.pas:1053-1069
    [WeaponIndex.MINIGUN]: { hitMultiply: f(0.43), fireInterval: 4, ammo: 100, reloadTime: 320, bulletSpeed: f(29), bulletStyle: BulletStyle.PLAIN, startUpTime: 33, bink: -2, movementAcc: f(0.01), bulletSpread: f(0.1), recoil: 4, push: f(0.0108), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // Colt 1911 / USSOCOM — Weapons.pas:1072-1088
    [WeaponIndex.COLT]: { hitMultiply: f(1.30), fireInterval: 12, ammo: 12, reloadTime: 72, bulletSpeed: f(18), bulletStyle: BulletStyle.PLAIN, startUpTime: 0, bink: 0, movementAcc: f(0.02), bulletSpread: f(0), recoil: 28, push: f(0.0172), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // Knife — Weapons.pas:1091-1107
    [WeaponIndex.KNIFE]: { hitMultiply: f(2250), fireInterval: 6, ammo: 1, reloadTime: 3, bulletSpeed: f(6), bulletStyle: BulletStyle.KNIFE, startUpTime: 0, bink: 0, movementAcc: f(0.01), bulletSpread: f(0), recoil: 10, push: f(0.028), inheritedVelocity: f(0), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // Chainsaw — Weapons.pas:1110-1126
    [WeaponIndex.CHAINSAW]: { hitMultiply: f(21), fireInterval: 2, ammo: 200, reloadTime: 110, bulletSpeed: f(7.6), bulletStyle: BulletStyle.KNIFE, startUpTime: 0, bink: 0, movementAcc: f(0.01), bulletSpread: f(0), recoil: 1, push: f(0.0028), inheritedVelocity: f(0), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // M72 LAW — Weapons.pas:1129-1145
    [WeaponIndex.LAW]: { hitMultiply: f(1500), fireInterval: 30, ammo: 1, reloadTime: 495, bulletSpeed: f(23), bulletStyle: BulletStyle.LAW, startUpTime: 12, bink: 0, movementAcc: f(0.01), bulletSpread: f(0), recoil: 9, push: f(0.012), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // Rambo Bow with flame (BOW2) — Weapons.pas:1148-1164
    [WeaponIndex.BOW2]: { hitMultiply: f(8), fireInterval: 10, ammo: 1, reloadTime: 39, bulletSpeed: f(18), bulletStyle: BulletStyle.FLAMEARROW, startUpTime: 0, bink: 0, movementAcc: f(0.01), bulletSpread: f(0), recoil: 10, push: f(0), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // Rambo Bow (BOW) — Weapons.pas:1167-1183
    [WeaponIndex.BOW]: { hitMultiply: f(12), fireInterval: 10, ammo: 1, reloadTime: 25, bulletSpeed: f(21), bulletStyle: BulletStyle.ARROW, startUpTime: 0, bink: 0, movementAcc: f(0.01), bulletSpread: f(0), recoil: 10, push: f(0.0148), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // Flamethrower — Weapons.pas:1186-1202
    [WeaponIndex.FLAMER]: { hitMultiply: f(12), fireInterval: 6, ammo: 200, reloadTime: 5, bulletSpeed: f(12.5), bulletStyle: BulletStyle.FLAME, startUpTime: 0, bink: 0, movementAcc: f(0.01), bulletSpread: f(0), recoil: 10, push: f(0.016), inheritedVelocity: f(0.5), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // M2 — Weapons.pas:1205-1221
    [WeaponIndex.M2]: { hitMultiply: f(1.55), fireInterval: 14, ammo: 100, reloadTime: 366, bulletSpeed: f(36), bulletStyle: BulletStyle.M2, startUpTime: 21, bink: 0, movementAcc: f(0.01), bulletSpread: f(0), recoil: 10, push: f(0.0088), inheritedVelocity: f(0), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // No weapon / Punch — Weapons.pas:1224-1240
    [WeaponIndex.NOWEAPON]: { hitMultiply: f(330), fireInterval: 6, ammo: 1, reloadTime: 3, bulletSpeed: f(5), bulletStyle: BulletStyle.PUNCH, startUpTime: 0, bink: 0, movementAcc: f(0.01), bulletSpread: f(0), recoil: 10, push: f(0), inheritedVelocity: f(0), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
    // Frag grenade — Weapons.pas:1243-1259
    [WeaponIndex.FRAGGRENADE]: { hitMultiply: f(1500), fireInterval: 80, ammo: 1, reloadTime: 20, bulletSpeed: f(5), bulletStyle: BulletStyle.FRAGNADE, startUpTime: 0, bink: 0, movementAcc: f(0.01), bulletSpread: f(0), recoil: 10, push: f(0), inheritedVelocity: f(1), modifierHead: f(1.1), modifierChest: f(1), modifierLegs: f(0.6) },
};
// PORT: BuildWeapons (Weapons.pas:1339-1350) — derive bullet lifetime from BulletStyle.
function timeoutForStyle(style) {
    switch (style) {
        case BulletStyle.FRAGNADE:
        case BulletStyle.CLUSTERNADE:
            return GRENADE_TIMEOUT;
        case BulletStyle.FLAME:
            return FLAMER_TIMEOUT;
        case BulletStyle.PUNCH:
        case BulletStyle.KNIFE:
            return MELEE_TIMEOUT;
        case BulletStyle.M2:
            return M2BULLET_TIMEOUT;
        default:
            return BULLET_TIMEOUT;
    }
}
// PORT: BuildWeapons (Weapons.pas:1328-1336) — derive clip in/out timings.
// Trunc() == truncate toward zero; for positive ReloadTime this is Math.floor.
function deriveGun(index, stats) {
    const base = BASE[index];
    if (base === undefined) {
        throw new Error(`No BASE entry for weapon index ${index}`);
    }
    const clipOutTime = base.clipReload ? Math.trunc(stats.reloadTime * 0.8) : 0;
    const clipInTime = base.clipReload ? Math.trunc(stats.reloadTime * 0.3) : 0;
    return {
        name: base.name,
        num: base.num,
        clipReload: base.clipReload,
        hitMultiply: stats.hitMultiply,
        bulletSpeed: stats.bulletSpeed,
        startUpTime: stats.startUpTime,
        reloadTime: stats.reloadTime,
        ammo: stats.ammo,
        fireInterval: stats.fireInterval,
        movementAcc: stats.movementAcc,
        bink: stats.bink,
        recoil: stats.recoil,
        push: stats.push,
        inheritedVelocity: stats.inheritedVelocity,
        modifierHead: stats.modifierHead,
        modifierChest: stats.modifierChest,
        modifierLegs: stats.modifierLegs,
        bulletSpread: stats.bulletSpread,
        bulletStyle: stats.bulletStyle,
        timeout: timeoutForStyle(stats.bulletStyle),
        clipOutTime,
        clipInTime,
    };
}
// Build the full 1..23 table for a mode. PORT: CreateWeaponsBase + Create*Weapons +
// BuildWeapons cluster/thrown-knife inheritance (Weapons.pas:1268-1314).
function buildTable(rows) {
    const table = new Map();
    // Indices 1..20 (ORIGINAL_WEAPONS) come straight from the mode rows.
    for (const key of Object.keys(rows)) {
        const index = Number(key);
        const row = rows[index];
        if (row === undefined) {
            continue;
        }
        table.set(index, deriveGun(index, row));
    }
    // CLUSTERGRENADE inherits FRAGGRENADE stats but overrides BulletStyle. PORT: Weapons.pas:1269-1282
    const frag = rows[WeaponIndex.FRAGGRENADE];
    if (frag !== undefined) {
        table.set(WeaponIndex.CLUSTERGRENADE, deriveGun(WeaponIndex.CLUSTERGRENADE, { ...frag, bulletStyle: BulletStyle.CLUSTERNADE }));
        // CLUSTER inherits CLUSTERGRENADE stats, overrides BulletStyle. PORT: Weapons.pas:1285-1298
        table.set(WeaponIndex.CLUSTER, deriveGun(WeaponIndex.CLUSTER, { ...frag, bulletStyle: BulletStyle.CLUSTER }));
    }
    // THROWNKNIFE inherits KNIFE stats, overrides BulletStyle. PORT: Weapons.pas:1301-1314
    const knife = rows[WeaponIndex.KNIFE];
    if (knife !== undefined) {
        table.set(WeaponIndex.THROWNKNIFE, deriveGun(WeaponIndex.THROWNKNIFE, { ...knife, bulletStyle: BulletStyle.THROWNKNIFE }));
    }
    return table;
}
const NORMAL_TABLE = buildTable(NORMAL);
const REALISTIC_TABLE = buildTable(REALISTIC);
/**
 * Return the Gun stats for a weapon array index in the requested mode.
 * PORT: equivalent to indexing Guns[] after CreateDefaultWeapons(RealisticMode).
 * @param index 1-based WeaponIndex (1..TOTAL_WEAPONS)
 * @param realistic true for realistic-mode stats, false for normal mode
 */
export function getGun(index, realistic) {
    const table = realistic ? REALISTIC_TABLE : NORMAL_TABLE;
    const gun = table.get(index);
    if (gun === undefined) {
        throw new Error(`Unknown weapon index: ${index}`);
    }
    return gun;
}
//# sourceMappingURL=guns.js.map