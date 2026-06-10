// PORT: shared/Weapons.pas — assertions against quoted source stat values.
import { describe, it, expect } from 'vitest';
import { f } from '../scalar';
import {
  getGun,
  WeaponIndex,
  WeaponNum,
  BulletStyle,
  TOTAL_WEAPONS,
  ORIGINAL_WEAPONS,
  BULLET_TIMEOUT,
  GRENADE_TIMEOUT,
  MELEE_TIMEOUT,
} from './guns';

describe('WeaponIndex / WeaponNum enums', () => {
  it('primary weapon indices match nums 1..10 (Weapons.pas:90-99)', () => {
    expect(WeaponIndex.EAGLE).toBe(1);
    expect(WeaponNum.EAGLE).toBe(1);
    expect(WeaponIndex.MINIGUN).toBe(10);
    expect(WeaponNum.MINIGUN).toBe(10);
  });

  it('documents the COLT index=11 vs num=0 quirk (Weapons.pas:66,100)', () => {
    expect(WeaponIndex.COLT).toBe(11);
    expect(WeaponNum.COLT).toBe(0);
  });

  it('secondary weapon renumbering (Weapons.pas:101-106)', () => {
    expect(WeaponIndex.KNIFE).toBe(12);
    expect(WeaponNum.KNIFE).toBe(11);
    expect(WeaponIndex.FLAMER).toBe(17);
    expect(WeaponNum.FLAMER).toBe(14);
    expect(WeaponIndex.BOW).toBe(16);
    expect(WeaponNum.BOW).toBe(15);
    expect(WeaponIndex.BOW2).toBe(15);
    expect(WeaponNum.BOW2).toBe(16);
  });

  it('counts (Weapons.pas:86-87)', () => {
    expect(ORIGINAL_WEAPONS).toBe(20);
    expect(TOTAL_WEAPONS).toBe(23);
  });

  it('BulletStyle enum (Weapons.pas:115-128)', () => {
    expect(BulletStyle.PLAIN).toBe(1);
    expect(BulletStyle.M79).toBe(4);
    expect(BulletStyle.KNIFE).toBe(11);
    expect(BulletStyle.M2).toBe(14);
  });
});

describe('NORMAL mode stats (Weapons.pas:492-875)', () => {
  it('Desert Eagle (Weapons.pas:498-513)', () => {
    const g = getGun(WeaponIndex.EAGLE, false);
    expect(g.name).toBe('Desert Eagles');
    expect(g.num).toBe(1);
    expect(g.hitMultiply).toBe(f(1.81));
    expect(g.fireInterval).toBe(24);
    expect(g.ammo).toBe(7);
    expect(g.reloadTime).toBe(87);
    expect(g.bulletSpeed).toBe(f(19));
    expect(g.bulletStyle).toBe(BulletStyle.PLAIN);
    expect(g.movementAcc).toBe(f(0.009));
    expect(g.push).toBe(f(0.0176));
    expect(g.modifierHead).toBe(f(1.1));
    expect(g.modifierChest).toBe(f(0.95));
    expect(g.modifierLegs).toBe(f(0.85));
    expect(g.recoil).toBe(0); // normal mode recoil always 0
  });

  it('AK-74 (Weapons.pas:536-551)', () => {
    const g = getGun(WeaponIndex.AK74, false);
    expect(g.hitMultiply).toBe(f(1.004));
    expect(g.fireInterval).toBe(10);
    expect(g.ammo).toBe(35);
    expect(g.reloadTime).toBe(165);
    expect(g.bulletSpeed).toBe(f(24.6));
    expect(g.bink).toBe(-12);
    expect(g.bulletSpread).toBe(f(0.025));
  });

  it('Barrett M82A1 (Weapons.pas:631-646)', () => {
    const g = getGun(WeaponIndex.BARRETT, false);
    expect(g.hitMultiply).toBe(f(4.45));
    expect(g.fireInterval).toBe(225);
    expect(g.ammo).toBe(10);
    expect(g.reloadTime).toBe(70);
    expect(g.bulletSpeed).toBe(f(55));
    expect(g.startUpTime).toBe(19);
    expect(g.bink).toBe(65);
    expect(g.modifierHead).toBe(f(1));
    expect(g.modifierChest).toBe(f(1));
    expect(g.modifierLegs).toBe(f(1));
  });

  it('M79 grenade launcher (Weapons.pas:612-627)', () => {
    const g = getGun(WeaponIndex.M79, false);
    expect(g.hitMultiply).toBe(f(1550));
    expect(g.fireInterval).toBe(6);
    expect(g.ammo).toBe(1);
    expect(g.bulletStyle).toBe(BulletStyle.M79);
    expect(g.bulletSpeed).toBe(f(10.7));
  });

  it('USSOCOM / Colt (Weapons.pas:688-703)', () => {
    const g = getGun(WeaponIndex.COLT, false);
    expect(g.name).toBe('USSOCOM');
    expect(g.num).toBe(0); // quirk
    expect(g.hitMultiply).toBe(f(1.49));
    expect(g.fireInterval).toBe(10);
    expect(g.ammo).toBe(14);
    expect(g.reloadTime).toBe(60);
  });

  it('Minigun (Weapons.pas:669-684)', () => {
    const g = getGun(WeaponIndex.MINIGUN, false);
    expect(g.hitMultiply).toBe(f(0.468));
    expect(g.fireInterval).toBe(3);
    expect(g.ammo).toBe(100);
    expect(g.reloadTime).toBe(480);
    expect(g.startUpTime).toBe(25);
    expect(g.movementAcc).toBe(f(0.0625));
  });
});

describe('REALISTIC mode stats (Weapons.pas:877-1260)', () => {
  it('Desert Eagle realistic (Weapons.pas:883-898)', () => {
    const g = getGun(WeaponIndex.EAGLE, true);
    expect(g.hitMultiply).toBe(f(1.66));
    expect(g.fireInterval).toBe(27);
    expect(g.ammo).toBe(7);
    expect(g.reloadTime).toBe(106);
    expect(g.recoil).toBe(55);
    expect(g.movementAcc).toBe(f(0.02));
    expect(g.bulletSpread).toBe(f(0.1));
    expect(g.modifierLegs).toBe(f(0.6)); // realistic legs modifier
    expect(g.modifierChest).toBe(f(1));
    expect(g.modifierHead).toBe(f(1.1));
  });

  it('AK-74 realistic (Weapons.pas:921-936)', () => {
    const g = getGun(WeaponIndex.AK74, true);
    expect(g.hitMultiply).toBe(f(1.08));
    expect(g.fireInterval).toBe(11);
    expect(g.reloadTime).toBe(158);
    expect(g.bulletSpeed).toBe(f(24));
    expect(g.bink).toBe(-10);
    expect(g.recoil).toBe(13);
  });

  it('Steyr AUG realistic ammo differs from normal (Weapons.pas:557 vs 942)', () => {
    expect(getGun(WeaponIndex.STEYRAUG, false).ammo).toBe(25);
    expect(getGun(WeaponIndex.STEYRAUG, true).ammo).toBe(30);
  });

  it('USSOCOM realistic ammo differs from normal (Weapons.pas:690 vs 1075)', () => {
    expect(getGun(WeaponIndex.COLT, false).ammo).toBe(14);
    expect(getGun(WeaponIndex.COLT, true).ammo).toBe(12);
  });

  it('M79 realistic recoil & damage (Weapons.pas:997-1012)', () => {
    const g = getGun(WeaponIndex.M79, true);
    expect(g.hitMultiply).toBe(f(1600));
    expect(g.recoil).toBe(420);
    expect(g.bink).toBe(45);
  });

  it('Barrett realistic differs from normal (Weapons.pas:1016-1031)', () => {
    const g = getGun(WeaponIndex.BARRETT, true);
    expect(g.hitMultiply).toBe(f(4.95));
    expect(g.fireInterval).toBe(200);
    expect(g.reloadTime).toBe(170);
    expect(g.startUpTime).toBe(16);
    expect(g.bink).toBe(80);
  });
});

describe('derived BuildWeapons fields (Weapons.pas:1268-1351)', () => {
  it('inherited bonus weapons override BulletStyle but inherit base stats', () => {
    const frag = getGun(WeaponIndex.FRAGGRENADE, false);
    const clusternade = getGun(WeaponIndex.CLUSTERGRENADE, false);
    const cluster = getGun(WeaponIndex.CLUSTER, false);
    const knife = getGun(WeaponIndex.KNIFE, false);
    const thrown = getGun(WeaponIndex.THROWNKNIFE, false);

    expect(clusternade.hitMultiply).toBe(frag.hitMultiply);
    expect(clusternade.bulletStyle).toBe(BulletStyle.CLUSTERNADE);
    expect(cluster.bulletStyle).toBe(BulletStyle.CLUSTER);
    expect(thrown.hitMultiply).toBe(knife.hitMultiply);
    expect(thrown.bulletStyle).toBe(BulletStyle.THROWNKNIFE);
  });

  it('Timeout derived from BulletStyle (Weapons.pas:1339-1350)', () => {
    expect(getGun(WeaponIndex.EAGLE, false).timeout).toBe(BULLET_TIMEOUT);
    expect(getGun(WeaponIndex.FRAGGRENADE, false).timeout).toBe(GRENADE_TIMEOUT);
    expect(getGun(WeaponIndex.KNIFE, false).timeout).toBe(MELEE_TIMEOUT);
    expect(getGun(WeaponIndex.NOWEAPON, false).timeout).toBe(MELEE_TIMEOUT);
  });

  it('ClipOutTime/ClipInTime: Trunc(reload*0.8/0.3) when clipReload (Weapons.pas:1330-1331)', () => {
    // Desert Eagle clipReload=true, reload=87 -> 69 / 26
    const eagle = getGun(WeaponIndex.EAGLE, false);
    expect(eagle.clipReload).toBe(true);
    expect(eagle.clipOutTime).toBe(Math.trunc(87 * 0.8)); // 69
    expect(eagle.clipInTime).toBe(Math.trunc(87 * 0.3)); // 26
    // Minigun clipReload=false -> 0/0
    const minigun = getGun(WeaponIndex.MINIGUN, false);
    expect(minigun.clipReload).toBe(false);
    expect(minigun.clipOutTime).toBe(0);
    expect(minigun.clipInTime).toBe(0);
  });

  it('all 23 indices resolve in both modes', () => {
    for (let i = 1; i <= TOTAL_WEAPONS; i++) {
      expect(() => getGun(i, false)).not.toThrow();
      expect(() => getGun(i, true)).not.toThrow();
    }
  });
});
