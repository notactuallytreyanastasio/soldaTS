/**
 * Ported game constants for the OpenSoldat web rewrite.
 *
 * Faithful-first port: values, names, and 1-indexing conventions mirror the
 * FreePascal source. Each block carries a `// PORT:` provenance comment with the
 * exact source file:line and the exact value quoted from that source.
 *
 * Derived physics constants (e.g. RUNSPEEDUP = RUNSPEED / 6) are wrapped in
 * `f(...)` so that STRICT_F32 reproduces Pascal `Single` rounding at the point
 * the constant is computed. Pure integer/cap constants are plain literals.
 */

import { f } from './scalar';

// ===========================================================================
// Hard caps (world-state array sizes; 1-based indexing, index 0 reserved)
// ===========================================================================

// PORT: shared/network/Net.pas:104 — MAX_PLAYERS = 32;
export const MAX_PLAYERS = 32 as const;

// PORT: shared/mechanics/Sprites.pas:19 — MAX_SPRITES = MAX_PLAYERS; (= 32)
export const MAX_SPRITES = MAX_PLAYERS;

// PORT: shared/mechanics/Sprites.pas:20 — MAX_BULLETS = 254;
export const MAX_BULLETS = 254 as const;

// PORT: shared/mechanics/Sprites.pas:21 — MAX_SPARKS = 558;
export const MAX_SPARKS = 558 as const;

// PORT: shared/mechanics/Sprites.pas:22 — MAX_THINGS = 90;
export const MAX_THINGS = 90 as const;

// PORT: shared/Parts.pas:31 — NUM_PARTICLES = 560; (> MAX_SPARKS, 2 buffer parts)
export const NUM_PARTICLES = 560 as const;

// ===========================================================================
// Timing (60 Hz simulation heartbeat)
// ===========================================================================

// PORT: shared/Constants.pas:27 — DEFAULT_GOALTICKS = 60;
export const DEFAULT_GOALTICKS = 60 as const;

// PORT: shared/Constants.pas:84 — SECOND = 60;
export const SECOND = 60 as const;

// PORT: shared/Constants.pas:83 — PERMANENT = -1000;
export const PERMANENT = -1000 as const;

// PORT: shared/Constants.pas:85 — HALF_MINUTE = SECOND * 30; (= 1800)
export const HALF_MINUTE = SECOND * 30;

// PORT: shared/Constants.pas:86 — MINUTE = SECOND * 60; (= 3600)
export const MINUTE = SECOND * 60;

// ===========================================================================
// Core physics constants
// ===========================================================================

// PORT: shared/Parts.pas:32 — RKV = 0.98; (Verlet integrator velocity damping)
export const RKV = f(0.98);

// PORT: shared/Cvar.pas:985 / docs physics-and-balance-constants.md — sv_gravity = 0.06
// Base gravity (CVAR_SYNC). Hardcoded default applied to all physics subsystems.
export const DEFAULT_GRAVITY = f(0.06);

// Surface friction coefficients (applied when a sprite is in motion on ground).
// PORT: shared/mechanics/Sprites.pas:24 — SURFACECOEFX = 0.970;
export const SURFACECOEFX = f(0.97);
// PORT: shared/mechanics/Sprites.pas:25 — SURFACECOEFY = 0.970;
export const SURFACECOEFY = f(0.97);
// PORT: shared/mechanics/Sprites.pas:26 — CROUCHMOVESURFACECOEFX = 0.850;
export const CROUCHMOVESURFACECOEFX = f(0.85);
// PORT: shared/mechanics/Sprites.pas:27 — CROUCHMOVESURFACECOEFY = 0.970;
export const CROUCHMOVESURFACECOEFY = f(0.97);
// PORT: shared/mechanics/Sprites.pas:28 — STANDSURFACECOEFX = 0.000;
export const STANDSURFACECOEFX = f(0.0);
// PORT: shared/mechanics/Sprites.pas:29 — STANDSURFACECOEFY = 0.000;
export const STANDSURFACECOEFY = f(0.0);
// PORT: shared/mechanics/Sprites.pas:30 — GRENADE_SURFACECOEF = 0.880;
export const GRENADE_SURFACECOEF = f(0.88);
// PORT: shared/mechanics/Sprites.pas:31 — SPARK_SURFACECOEF = 0.700;
export const SPARK_SURFACECOEF = f(0.7);

// ===========================================================================
// Player movement speeds
// PORT: shared/Constants.pas:40-49
// ===========================================================================

// PORT: shared/Constants.pas:40 — RUNSPEED = 0.118;
export const RUNSPEED = f(0.118);
// PORT: shared/Constants.pas:41 — RUNSPEEDUP = RUNSPEED / 6;
export const RUNSPEEDUP = f(RUNSPEED / 6);
// PORT: shared/Constants.pas:42 — FLYSPEED = 0.03;
export const FLYSPEED = f(0.03);
// PORT: shared/Constants.pas:43 — JUMPSPEED = 0.66;
export const JUMPSPEED = f(0.66);
// PORT: shared/Constants.pas:44 — CROUCHRUNSPEED = RUNSPEED / 0.6;
export const CROUCHRUNSPEED = f(RUNSPEED / 0.6);
// PORT: shared/Constants.pas:45 — PRONESPEED = RUNSPEED * 4.0;
export const PRONESPEED = f(RUNSPEED * 4.0);
// PORT: shared/Constants.pas:46 — ROLLSPEED = RUNSPEED / 1.2;
export const ROLLSPEED = f(RUNSPEED / 1.2);
// PORT: shared/Constants.pas:47 — JUMPDIRSPEED = 0.30;
export const JUMPDIRSPEED = f(0.3);
// PORT: shared/Constants.pas:48 — JETSPEED = 0.10;
export const JETSPEED = f(0.1);

// ===========================================================================
// Game styles (game modes)
// PORT: shared/Constants.pas:347-353
// ===========================================================================

export const GameStyle = {
  DEATHMATCH: 0, // PORT: shared/Constants.pas:347 — GAMESTYLE_DEATHMATCH = 0;
  POINTMATCH: 1, // PORT: shared/Constants.pas:348 — GAMESTYLE_POINTMATCH = 1;
  TEAMMATCH: 2, //  PORT: shared/Constants.pas:349 — GAMESTYLE_TEAMMATCH  = 2;
  CTF: 3, //        PORT: shared/Constants.pas:350 — GAMESTYLE_CTF        = 3;
  RAMBO: 4, //      PORT: shared/Constants.pas:351 — GAMESTYLE_RAMBO      = 4;
  INF: 5, //        PORT: shared/Constants.pas:352 — GAMESTYLE_INF        = 5;
  HTF: 6, //        PORT: shared/Constants.pas:353 — GAMESTYLE_HTF        = 6;
} as const;
export type GameStyle = (typeof GameStyle)[keyof typeof GameStyle];

// ===========================================================================
// Player teams
// PORT: shared/Constants.pas:339-344
// ===========================================================================

export const Team = {
  NONE: 0, //      PORT: shared/Constants.pas:339 — TEAM_NONE      = 0;
  ALPHA: 1, //     PORT: shared/Constants.pas:340 — TEAM_ALPHA     = 1;
  BRAVO: 2, //     PORT: shared/Constants.pas:341 — TEAM_BRAVO     = 2;
  CHARLIE: 3, //   PORT: shared/Constants.pas:342 — TEAM_CHARLIE   = 3;
  DELTA: 4, //     PORT: shared/Constants.pas:343 — TEAM_DELTA     = 4;
  SPECTATOR: 5, // PORT: shared/Constants.pas:344 — TEAM_SPECTATOR = 5;
} as const;
export type Team = (typeof Team)[keyof typeof Team];

// ===========================================================================
// Game objects (Thing styles: flags, weapon pickups, kits, stationary)
// PORT: shared/Constants.pas:390-419
// ===========================================================================

// PORT: shared/Constants.pas:390 — OBJECT_NUM_NONWEAPON = 12;
export const OBJECT_NUM_NONWEAPON = 12 as const;
// PORT: shared/Constants.pas:391 — OBJECT_NUM_FLAGS = 3;
export const OBJECT_NUM_FLAGS = 3 as const;

export const ObjectStyle = {
  ALPHA_FLAG: 1, //      PORT: shared/Constants.pas:393 — OBJECT_ALPHA_FLAG      = 1;
  BRAVO_FLAG: 2, //      PORT: shared/Constants.pas:394 — OBJECT_BRAVO_FLAG      = 2;
  POINTMATCH_FLAG: 3, // PORT: shared/Constants.pas:395 — OBJECT_POINTMATCH_FLAG = 3;
  USSOCOM: 4, //         PORT: shared/Constants.pas:396 — OBJECT_USSOCOM         = 4;
  DESERT_EAGLE: 5, //    PORT: shared/Constants.pas:397 — OBJECT_DESERT_EAGLE    = 5;
  HK_MP5: 6, //          PORT: shared/Constants.pas:398 — OBJECT_HK_MP5          = 6;
  AK74: 7, //            PORT: shared/Constants.pas:399 — OBJECT_AK74            = 7;
  STEYR_AUG: 8, //       PORT: shared/Constants.pas:400 — OBJECT_STEYR_AUG       = 8;
  SPAS12: 9, //          PORT: shared/Constants.pas:401 — OBJECT_SPAS12          = 9;
  RUGER77: 10, //        PORT: shared/Constants.pas:402 — OBJECT_RUGER77         = 10;
  M79: 11, //            PORT: shared/Constants.pas:403 — OBJECT_M79             = 11;
  BARRET_M82A1: 12, //   PORT: shared/Constants.pas:404 — OBJECT_BARRET_M82A1    = 12;
  MINIMI: 13, //         PORT: shared/Constants.pas:405 — OBJECT_MINIMI          = 13;
  MINIGUN: 14, //        PORT: shared/Constants.pas:406 — OBJECT_MINIGUN         = 14;
  RAMBO_BOW: 15, //      PORT: shared/Constants.pas:407 — OBJECT_RAMBO_BOW       = 15;
  MEDICAL_KIT: 16, //    PORT: shared/Constants.pas:408 — OBJECT_MEDICAL_KIT     = 16;
  GRENADE_KIT: 17, //    PORT: shared/Constants.pas:409 — OBJECT_GRENADE_KIT     = 17;
  FLAMER_KIT: 18, //     PORT: shared/Constants.pas:410 — OBJECT_FLAMER_KIT      = 18;
  PREDATOR_KIT: 19, //   PORT: shared/Constants.pas:411 — OBJECT_PREDATOR_KIT    = 19;
  VEST_KIT: 20, //       PORT: shared/Constants.pas:412 — OBJECT_VEST_KIT        = 20;
  BERSERK_KIT: 21, //    PORT: shared/Constants.pas:413 — OBJECT_BERSERK_KIT     = 21;
  CLUSTER_KIT: 22, //    PORT: shared/Constants.pas:414 — OBJECT_CLUSTER_KIT     = 22;
  PARACHUTE: 23, //      PORT: shared/Constants.pas:415 — OBJECT_PARACHUTE       = 23;
  COMBAT_KNIFE: 24, //   PORT: shared/Constants.pas:416 — OBJECT_COMBAT_KNIFE    = 24;
  CHAINSAW: 25, //       PORT: shared/Constants.pas:417 — OBJECT_CHAINSAW        = 25;
  LAW: 26, //            PORT: shared/Constants.pas:418 — OBJECT_LAW             = 26;
  STATIONARY_GUN: 27, // PORT: shared/Constants.pas:419 — OBJECT_STATIONARY_GUN  = 27;
} as const;
export type ObjectStyle = (typeof ObjectStyle)[keyof typeof ObjectStyle];

// ===========================================================================
// Bonus styles (powerups carried by a sprite)
// PORT: shared/Constants.pas:194-200
// ===========================================================================

export const Bonus = {
  NONE: 0, //      PORT: shared/Constants.pas:194 — BONUS_NONE      = 0;
  GRENADES: 17, // PORT: shared/Constants.pas:195 — BONUS_GRENADES  = 17;
  FLAMEGOD: 18, // PORT: shared/Constants.pas:196 — BONUS_FLAMEGOD  = 18;
  PREDATOR: 19, // PORT: shared/Constants.pas:197 — BONUS_PREDATOR  = 19;
  VEST: 20, //     PORT: shared/Constants.pas:198 — BONUS_VEST      = 20;
  BERSERKER: 21, //PORT: shared/Constants.pas:199 — BONUS_BERSERKER = 21;
  CLUSTERS: 22, // PORT: shared/Constants.pas:200 — BONUS_CLUSTERS  = 22;
} as const;
export type Bonus = (typeof Bonus)[keyof typeof Bonus];
