/**
 * Entity record types — faithful TS port of the OpenSoldat world-state objects.
 *
 * Mirrors the Pascal `object`/`record` declarations field-for-field (same names,
 * same order where practical). All `Single` fields become `number`; positions are
 * expressed with the shared {@link Vec2} type where the Pascal uses `TVector2`.
 *
 * Indexing convention (see docs/rewrite-reference/global-state-and-caps.md §3):
 * these records live in 1-based fixed arrays with index 0 as an unused sentinel.
 *
 * Client-only / render-only fields and the embedded `ParticleSystem` skeletons
 * are intentionally OMITTED here (noted per-record); the physics skeleton lives
 * in the particle subsystem, not in these records. AI brain data (TBotData) and
 * the embedded TPlayer object are likewise omitted — they are not part of the
 * minimal simulation record model this module describes.
 */

import type { Vec2 } from '../math/vec2';

// PORT: shared/mechanics/Sprites.pas:67 — TControl record.
// The per-sprite input snapshot. SmallInt aim fields become `number`.
export interface Control {
  // PORT: Sprites.pas:68-69 — movement / action booleans.
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  fire: boolean;
  jetpack: boolean;
  throwNade: boolean;
  changeWeapon: boolean;
  throwWeapon: boolean;
  reload: boolean;
  prone: boolean;
  flagThrow: boolean;
  // PORT: Sprites.pas:71 — MouseAimX, MouseAimY, MouseDist: SmallInt.
  mouseAimX: number;
  mouseAimY: number;
  mouseDist: number;
}

// PORT: shared/mechanics/Sprites.pas:107 — TSprite object.
// OMITTED (client/render or non-sim sub-objects):
//   Skeleton: ParticleSystem            (Sprites.pas:146 — physics skeleton subsystem)
//   LegsAnimation, BodyAnimation        (Sprites.pas:147 — TAnimation)
//   Weapon, SecondaryWeapon, TertiaryWeapon (Sprites.pas:149 — TGun)
//   Brain: TBotData                     (Sprites.pas:151 — AI)
//   Player: TPlayer                     (Sprites.pas:152 — player object ref)
//   BGState: TBackgroundState           (Sprites.pas:157)
//   GattlingSoundChannel*/Reload/Jets   (Sprites.pas:162 — {$ELSE} client sound)
//   OldDeadMeat, Muted                  (Sprites.pas:163-164 — client)
//   NextPush, BulletCheck*              (Sprites.pas:167-172)
export interface Sprite {
  active: boolean; // PORT: Sprites.pas:108
  deadMeat: boolean; // PORT: Sprites.pas:108
  // DESIGN OVERRIDE: kill attribution. Sprite index of the owner of the last
  // bullet that damaged this sprite (0 = none yet). The Pascal engine threads
  // the killer through the Die()/HealthHit call chain instead; we don't port
  // that pipeline, so the last damaging hit is recorded here and the death
  // consumer (client respawn upkeep) reads it when deadMeat flips.
  lastHitBy: number;
  dummy: boolean; // PORT: Sprites.pas:108
  style: number; // PORT: Sprites.pas:109 — Byte
  num: number; // PORT: Sprites.pas:110 — Byte
  visible: number; // PORT: Sprites.pas:111 — Byte
  onGround: boolean; // PORT: Sprites.pas:112
  onGroundForLaw: boolean; // PORT: Sprites.pas:112
  onGroundLastFrame: boolean; // PORT: Sprites.pas:113
  onGroundPermanent: boolean; // PORT: Sprites.pas:114
  direction: number; // PORT: Sprites.pas:115 — SmallInt
  oldDirection: number; // PORT: Sprites.pas:115 — SmallInt
  health: number; // PORT: Sprites.pas:116 — Single
  holdedThing: number; // PORT: Sprites.pas:117 — Byte (Thing index held, 0 = none)
  flagGrabCooldown: number; // PORT: Sprites.pas:118 — Integer
  aimDistCoef: number; // PORT: Sprites.pas:119 — Single
  fired: number; // PORT: Sprites.pas:120 — Byte
  alpha: number; // PORT: Sprites.pas:121 — Byte
  jetsCountReal: number; // PORT: Sprites.pas:122 — Single
  jetsCount: number; // PORT: Sprites.pas:123 — SmallInt
  jetsCountPrev: number; // PORT: Sprites.pas:123 — SmallInt
  // Jump-force window (ticks remaining). Stands in for the Jump LegsAnimation
  // frames 9-14 over which Control.pas applies -JUMPSPEED; the animation system
  // is not ported, so a tick counter drives the sustained jump impulse.
  jumpTicksLeft: number;
  wearHelmet: number; // PORT: Sprites.pas:124 — Byte
  hasCigar: number; // PORT: Sprites.pas:125 — Byte
  canMercy: boolean; // PORT: Sprites.pas:126
  respawnCounter: number; // PORT: Sprites.pas:127 — SmallInt
  ceaseFireCounter: number; // PORT: Sprites.pas:127 — SmallInt
  selWeapon: number; // PORT: Sprites.pas:128 — Byte
  bonusStyle: number; // PORT: Sprites.pas:129 — Integer
  bonusTime: number; // PORT: Sprites.pas:129 — Integer
  multiKillTime: number; // PORT: Sprites.pas:130 — Integer
  multiKills: number; // PORT: Sprites.pas:130 — Integer
  vest: number; // PORT: Sprites.pas:131 — Single
  idleTime: number; // PORT: Sprites.pas:132 — Integer
  idleRandom: number; // PORT: Sprites.pas:133 — ShortInt
  burstCount: number; // PORT: Sprites.pas:134 — Byte
  position: number; // PORT: Sprites.pas:135 — Byte (POS_STAND/CROUCH/PRONE)
  onFire: number; // PORT: Sprites.pas:136 — Byte
  colliderDistance: number; // PORT: Sprites.pas:137 — Byte
  deadCollideCount: number; // PORT: Sprites.pas:138 — Integer
  deadTime: number; // PORT: Sprites.pas:139 — Integer
  para: number; // PORT: Sprites.pas:140 — Byte
  stat: number; // PORT: Sprites.pas:140 — Byte
  useTime: number; // PORT: Sprites.pas:141 — SmallInt
  halfDead: boolean; // PORT: Sprites.pas:142
  lastWeaponHM: number; // PORT: Sprites.pas:143 — Single
  lastWeaponSpeed: number; // PORT: Sprites.pas:143 — Single
  lastWeaponStyle: number; // PORT: Sprites.pas:144 — Byte
  lastWeaponFire: number; // PORT: Sprites.pas:145 — Word
  lastWeaponReload: number; // PORT: Sprites.pas:145 — Word
  control: Control; // PORT: Sprites.pas:148 — TControl
  grenadeCanThrow: boolean; // PORT: Sprites.pas:150
  isPlayerObjectOwner: boolean; // PORT: Sprites.pas:153
  typing: boolean; // PORT: Sprites.pas:154
  autoReloadWhenCanFire: boolean; // PORT: Sprites.pas:155
  canAutoReloadSpas: boolean; // PORT: Sprites.pas:156
  dontDrop: boolean; // PORT: Sprites.pas:166
  bulletCount: number; // PORT: Sprites.pas:168 — Word
}

// PORT: shared/mechanics/Bullets.pas:9 — TBullet object.
// OMITTED (client/render or non-sim):
//   HasHit                              (Bullets.pas:12 — {$IFNDEF SERVER})
//   ThingCollisions: array of TThingCollision (Bullets.pas:31 — dynamic; collision subsystem)
//   DontCheat                           (Bullets.pas:34 — {$IFDEF SERVER})
//   PingAdd, PingAddStart               (Bullets.pas:36 — client)
// NOTE: SpriteCollisions (Bullets.pas:32, `Set of 1..32`) is modeled as a
// boolean array indexed 0..32 (index 0 unused) to preserve 1-based sprite
// indexing semantics.
export interface Bullet {
  active: boolean; // PORT: Bullets.pas:10
  style: number; // PORT: Bullets.pas:14 — Byte
  num: number; // PORT: Bullets.pas:15 — SmallInt
  owner: number; // PORT: Bullets.pas:16 — Byte (firing sprite index, 0 = none)
  ownerWeapon: number; // PORT: Bullets.pas:17 — Byte
  timeOutReal: number; // PORT: Bullets.pas:18 — Single
  timeOut: number; // PORT: Bullets.pas:19 — SmallInt
  timeOutPrev: number; // PORT: Bullets.pas:19 — SmallInt
  hitMultiply: number; // PORT: Bullets.pas:20 — Single
  hitMultiplyPrev: number; // PORT: Bullets.pas:20 — Single
  velocityPrev: Vec2; // PORT: Bullets.pas:21 — TVector2
  whizzed: boolean; // PORT: Bullets.pas:22
  ownerPingTick: number; // PORT: Bullets.pas:23 — Byte
  hitBody: number; // PORT: Bullets.pas:24 — Byte
  hitSpot: Vec2; // PORT: Bullets.pas:25 — TVector2
  tracking: number; // PORT: Bullets.pas:26 — Byte
  imageStyle: number; // PORT: Bullets.pas:27 — Byte
  initial: Vec2; // PORT: Bullets.pas:28 — TVector2
  startUpTime: number; // PORT: Bullets.pas:29 — Integer
  ricochetCount: number; // PORT: Bullets.pas:29 — Integer
  degradeCount: number; // PORT: Bullets.pas:29 — Integer
  seed: number; // PORT: Bullets.pas:30 — Word
  // PORT: Bullets.pas:32 — `SpriteCollisions: Set of 1..32`.
  // Length-33 boolean array; spriteCollisions[i] for sprite i in 1..32, [0] unused.
  spriteCollisions: boolean[];
}

// PORT: shared/mechanics/Things.pas:13 — TThing object.
// OMITTED (client/render or non-sim sub-objects):
//   Skeleton: ParticleSystem            (Things.pas:25 — physics skeleton subsystem)
//   Polys: array[1..2] of TMapPolygon   (Things.pas:27 — map geometry cache)
//   BGState: TBackgroundState           (Things.pas:28)
//   Tex1, Tex2, Texture, Color          (Things.pas:30-32 — {$IFNDEF SERVER} render)
export interface Thing {
  active: boolean; // PORT: Things.pas:14
  style: number; // PORT: Things.pas:15 — Byte
  num: number; // PORT: Things.pas:15 — Byte
  owner: number; // PORT: Things.pas:15 — Byte
  holdingSprite: number; // PORT: Things.pas:16 — Byte (sprite index holding it, 0 = none)
  ammoCount: number; // PORT: Things.pas:17 — Byte
  radius: number; // PORT: Things.pas:18 — Single
  timeOut: number; // PORT: Things.pas:19 — Integer
  staticType: boolean; // PORT: Things.pas:20
  interest: number; // PORT: Things.pas:21 — Integer
  collideWithBullets: boolean; // PORT: Things.pas:22
  inBase: boolean; // PORT: Things.pas:23
  lastSpawn: number; // PORT: Things.pas:24 — Byte
  team: number; // PORT: Things.pas:24 — Byte
  // PORT: Things.pas:26 — CollideCount: array[1..4] of Byte.
  // Length-5 array; collideCount[i] for i in 1..4, [0] unused.
  collideCount: number[];
}

// PORT: shared/mechanics/Sparks.pas:8 — TSpark object (client-side only).
export interface Spark {
  active: boolean; // PORT: Sparks.pas:9
  num: number; // PORT: Sparks.pas:10 — SmallInt
  lifeReal: number; // PORT: Sparks.pas:11 — Single
  life: number; // PORT: Sparks.pas:12 — Byte
  lifePrev: number; // PORT: Sparks.pas:12 — Byte
  style: number; // PORT: Sparks.pas:13 — Byte
  owner: number; // PORT: Sparks.pas:13 — Byte
  collideCount: number; // PORT: Sparks.pas:14 — Byte
}
