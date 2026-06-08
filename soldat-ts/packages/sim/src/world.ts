/**
 * The world state — TS port of OpenSoldat's global game-handling arrays and
 * tick counters (the former unit-level `var` block of `shared/Game.pas`).
 *
 * PORT: shared/Game.pas:114-119 — the four 1-based fixed entity arrays:
 *   Sprite: array[1..MAX_SPRITES] of TSprite;   (Game.pas:114)
 *   Bullet: array[1..MAX_BULLETS] of TBullet;    (Game.pas:115)
 *   Spark:  array[1..MAX_SPARKS]  of TSpark;     (Game.pas:117, client-only)
 *   Thing:  array[1..MAX_THINGS]  of TThing;     (Game.pas:119)
 *
 * INDEXING CONTRACT (docs/rewrite-reference/global-state-and-caps.md §3):
 * 1-based with index 0 reserved as an unused sentinel. We model each array with
 * length CAP+1 so that valid indices are exactly 1..CAP and slot 0 is never a
 * live entity. Game.pas:111-113 warns explicitly against making these 0-based.
 *
 * This module holds DATA ONLY. It does not implement physics or the particle
 * subsystem; those live elsewhere and are referenced here as placeholder types.
 */

import { MAX_SPRITES, MAX_BULLETS, MAX_SPARKS, MAX_THINGS } from './constants';
import type { Sprite, Bullet, Spark, Thing } from './entities/types';
import type { ParticleSystem } from './physics/particles';
import type { PolyMap } from './map/polymap';
import { Rng } from './rng';
import { vec2 } from './math/vec2';

export interface World {
  // PORT: shared/Game.pas:114 — Sprite[1..MAX_SPRITES]. Length MAX_SPRITES+1; [0] sentinel.
  sprites: Sprite[];
  // PORT: shared/Game.pas:115 — Bullet[1..MAX_BULLETS]. Length MAX_BULLETS+1; [0] sentinel.
  bullets: Bullet[];
  // PORT: shared/Game.pas:119 — Thing[1..MAX_THINGS]. Length MAX_THINGS+1; [0] sentinel.
  things: Thing[];
  // PORT: shared/Game.pas:117 — Spark[1..MAX_SPARKS] ({$IFNDEF SERVER}). Length MAX_SPARKS+1; [0] sentinel.
  sparks: Spark[];

  // --- Tick counters ---
  // PORT: shared/network/Net.pas:817 — MainTickCounter: Integer.
  mainTickCounter: number;
  // PORT: shared/network/Net.pas:840 — ServerTickCounter: Integer.
  serverTickCounter: number;
  // PORT: shared/network/Net.pas:822 — ClientTickCount: LongInt.
  clientTickCount: number;
  // PORT: shared/Game.pas:31 — Ticks: Integer (the main game-clock tick counter).
  ticks: number;

  // --- Subsystem placeholders (not implemented in this module) ---
  // PORT: shared/Game.pas:93 — Map: TPolyMap.
  map: PolyMap | null;
  // PORT: shared/Game.pas:38 — SpriteParts: ParticleSystem (1:1 with sprites).
  spriteParts: ParticleSystem | null;
  // PORT: shared/Game.pas:38 — BulletParts: ParticleSystem.
  bulletParts: ParticleSystem | null;
  // PORT: shared/Game.pas:38 — SparkParts: ParticleSystem.
  sparkParts: ParticleSystem | null;
  // PORT: shared/Game.pas — ThingParts: ParticleSystem (flag/kit skeletons).
  thingParts: ParticleSystem | null;

  // --- Deterministic randomness (replaces Pascal global Random) ---
  // The sim must never call Math.random; all randomness flows through here.
  rng: Rng;
}

// --- Sentinel/empty record factories ---------------------------------------
// Index 0 of every array holds an inert "sentinel" record (active = false).
// All non-sentinel slots are likewise allocated inactive until spawned.

function emptySprite(): Sprite {
  return {
    active: false,
    deadMeat: false,
    dummy: false,
    style: 0,
    num: 0,
    visible: 0,
    onGround: false,
    onGroundForLaw: false,
    onGroundLastFrame: false,
    onGroundPermanent: false,
    direction: 0,
    oldDirection: 0,
    health: 0,
    holdedThing: 0,
    flagGrabCooldown: 0,
    aimDistCoef: 0,
    fired: 0,
    alpha: 0,
    jetsCountReal: 0,
    jetsCount: 0,
    jetsCountPrev: 0,
    wearHelmet: 0,
    hasCigar: 0,
    canMercy: false,
    respawnCounter: 0,
    ceaseFireCounter: 0,
    selWeapon: 0,
    bonusStyle: 0,
    bonusTime: 0,
    multiKillTime: 0,
    multiKills: 0,
    vest: 0,
    idleTime: 0,
    idleRandom: 0,
    burstCount: 0,
    position: 0,
    onFire: 0,
    colliderDistance: 0,
    deadCollideCount: 0,
    deadTime: 0,
    para: 0,
    stat: 0,
    useTime: 0,
    halfDead: false,
    lastWeaponHM: 0,
    lastWeaponSpeed: 0,
    lastWeaponStyle: 0,
    lastWeaponFire: 0,
    lastWeaponReload: 0,
    control: {
      left: false,
      right: false,
      up: false,
      down: false,
      fire: false,
      jetpack: false,
      throwNade: false,
      changeWeapon: false,
      throwWeapon: false,
      reload: false,
      prone: false,
      flagThrow: false,
      mouseAimX: 0,
      mouseAimY: 0,
      mouseDist: 0,
    },
    grenadeCanThrow: false,
    isPlayerObjectOwner: false,
    typing: false,
    autoReloadWhenCanFire: false,
    canAutoReloadSpas: false,
    dontDrop: false,
    bulletCount: 0,
  };
}

function emptyBullet(): Bullet {
  return {
    active: false,
    style: 0,
    num: 0,
    owner: 0,
    ownerWeapon: 0,
    timeOutReal: 0,
    timeOut: 0,
    timeOutPrev: 0,
    hitMultiply: 0,
    hitMultiplyPrev: 0,
    velocityPrev: vec2(),
    whizzed: false,
    ownerPingTick: 0,
    hitBody: 0,
    hitSpot: vec2(),
    tracking: 0,
    imageStyle: 0,
    initial: vec2(),
    startUpTime: 0,
    ricochetCount: 0,
    degradeCount: 0,
    seed: 0,
    // PORT: Bullets.pas:32 — Set of 1..32 modeled as boolean[0..32], [0] unused.
    spriteCollisions: new Array<boolean>(MAX_SPRITES + 1).fill(false),
  };
}

function emptyThing(): Thing {
  return {
    active: false,
    style: 0,
    num: 0,
    owner: 0,
    holdingSprite: 0,
    ammoCount: 0,
    radius: 0,
    timeOut: 0,
    staticType: false,
    interest: 0,
    collideWithBullets: false,
    inBase: false,
    lastSpawn: 0,
    team: 0,
    // PORT: Things.pas:26 — array[1..4] modeled as length-5, [0] unused.
    collideCount: new Array<number>(5).fill(0),
  };
}

function emptySpark(): Spark {
  return {
    active: false,
    num: 0,
    lifeReal: 0,
    life: 0,
    lifePrev: 0,
    style: 0,
    owner: 0,
    collideCount: 0,
  };
}

/**
 * Allocate a fresh world. Each entity array has length CAP+1 (index 0 = unused
 * sentinel, valid indices 1..CAP). Every slot is initialized inactive.
 */
export function createWorld(): World {
  // length CAP+1 → indices 0..CAP; slot 0 is the never-live sentinel.
  const sprites = Array.from({ length: MAX_SPRITES + 1 }, emptySprite);
  const bullets = Array.from({ length: MAX_BULLETS + 1 }, emptyBullet);
  const things = Array.from({ length: MAX_THINGS + 1 }, emptyThing);
  const sparks = Array.from({ length: MAX_SPARKS + 1 }, emptySpark);

  return {
    sprites,
    bullets,
    things,
    sparks,
    mainTickCounter: 0,
    serverTickCounter: 0,
    clientTickCount: 0,
    ticks: 0,
    map: null,
    spriteParts: null,
    bulletParts: null,
    sparkParts: null,
    thingParts: null,
    rng: new Rng(),
  };
}
