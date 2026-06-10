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
export declare const MAX_PLAYERS: 32;
export declare const MAX_SPRITES: 32;
export declare const MAX_BULLETS: 254;
export declare const MAX_SPARKS: 558;
export declare const MAX_THINGS: 90;
export declare const NUM_PARTICLES: 560;
export declare const DEFAULT_GOALTICKS: 60;
export declare const SECOND: 60;
export declare const PERMANENT: -1000;
export declare const HALF_MINUTE: number;
export declare const MINUTE: number;
export declare const RKV: number;
export declare const DEFAULT_GRAVITY: number;
export declare const SURFACECOEFX: number;
export declare const SURFACECOEFY: number;
export declare const CROUCHMOVESURFACECOEFX: number;
export declare const CROUCHMOVESURFACECOEFY: number;
export declare const STANDSURFACECOEFX: number;
export declare const STANDSURFACECOEFY: number;
export declare const GRENADE_SURFACECOEF: number;
export declare const SPARK_SURFACECOEF: number;
export declare const RUNSPEED: number;
export declare const RUNSPEEDUP: number;
export declare const FLYSPEED: number;
export declare const JUMPSPEED: number;
export declare const CROUCHRUNSPEED: number;
export declare const PRONESPEED: number;
export declare const ROLLSPEED: number;
export declare const JUMPDIRSPEED: number;
export declare const JETSPEED: number;
export declare const GameStyle: {
    readonly DEATHMATCH: 0;
    readonly POINTMATCH: 1;
    readonly TEAMMATCH: 2;
    readonly CTF: 3;
    readonly RAMBO: 4;
    readonly INF: 5;
    readonly HTF: 6;
};
export type GameStyle = (typeof GameStyle)[keyof typeof GameStyle];
export declare const Team: {
    readonly NONE: 0;
    readonly ALPHA: 1;
    readonly BRAVO: 2;
    readonly CHARLIE: 3;
    readonly DELTA: 4;
    readonly SPECTATOR: 5;
};
export type Team = (typeof Team)[keyof typeof Team];
export declare const OBJECT_NUM_NONWEAPON: 12;
export declare const OBJECT_NUM_FLAGS: 3;
export declare const ObjectStyle: {
    readonly ALPHA_FLAG: 1;
    readonly BRAVO_FLAG: 2;
    readonly POINTMATCH_FLAG: 3;
    readonly USSOCOM: 4;
    readonly DESERT_EAGLE: 5;
    readonly HK_MP5: 6;
    readonly AK74: 7;
    readonly STEYR_AUG: 8;
    readonly SPAS12: 9;
    readonly RUGER77: 10;
    readonly M79: 11;
    readonly BARRET_M82A1: 12;
    readonly MINIMI: 13;
    readonly MINIGUN: 14;
    readonly RAMBO_BOW: 15;
    readonly MEDICAL_KIT: 16;
    readonly GRENADE_KIT: 17;
    readonly FLAMER_KIT: 18;
    readonly PREDATOR_KIT: 19;
    readonly VEST_KIT: 20;
    readonly BERSERK_KIT: 21;
    readonly CLUSTER_KIT: 22;
    readonly PARACHUTE: 23;
    readonly COMBAT_KNIFE: 24;
    readonly CHAINSAW: 25;
    readonly LAW: 26;
    readonly STATIONARY_GUN: 27;
};
export type ObjectStyle = (typeof ObjectStyle)[keyof typeof ObjectStyle];
export declare const Bonus: {
    readonly NONE: 0;
    readonly GRENADES: 17;
    readonly FLAMEGOD: 18;
    readonly PREDATOR: 19;
    readonly VEST: 20;
    readonly BERSERKER: 21;
    readonly CLUSTERS: 22;
};
export type Bonus = (typeof Bonus)[keyof typeof Bonus];
//# sourceMappingURL=constants.d.ts.map