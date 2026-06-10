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
export interface Control {
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
    mouseAimX: number;
    mouseAimY: number;
    mouseDist: number;
}
export interface Sprite {
    active: boolean;
    deadMeat: boolean;
    lastHitBy: number;
    /**
     * GLUE (team dynamics, goal node 154): 0 = FFA, 1 = red (alpha),
     * 2 = blue (bravo). Pascal keeps team on TSprite too (Sprites.pas Player
     * record); the port deferred it until team modes landed.
     */
    team: number;
    dummy: boolean;
    style: number;
    num: number;
    visible: number;
    onGround: boolean;
    onGroundForLaw: boolean;
    onGroundLastFrame: boolean;
    onGroundPermanent: boolean;
    direction: number;
    oldDirection: number;
    health: number;
    holdedThing: number;
    flagGrabCooldown: number;
    aimDistCoef: number;
    fired: number;
    alpha: number;
    jetsCountReal: number;
    jetsCount: number;
    jetsCountPrev: number;
    jumpTicksLeft: number;
    wearHelmet: number;
    hasCigar: number;
    canMercy: boolean;
    respawnCounter: number;
    ceaseFireCounter: number;
    selWeapon: number;
    bonusStyle: number;
    bonusTime: number;
    multiKillTime: number;
    multiKills: number;
    vest: number;
    idleTime: number;
    idleRandom: number;
    burstCount: number;
    position: number;
    onFire: number;
    colliderDistance: number;
    deadCollideCount: number;
    deadTime: number;
    para: number;
    stat: number;
    useTime: number;
    halfDead: boolean;
    lastWeaponHM: number;
    lastWeaponSpeed: number;
    lastWeaponStyle: number;
    lastWeaponFire: number;
    lastWeaponReload: number;
    control: Control;
    grenadeCanThrow: boolean;
    isPlayerObjectOwner: boolean;
    typing: boolean;
    autoReloadWhenCanFire: boolean;
    canAutoReloadSpas: boolean;
    dontDrop: boolean;
    bulletCount: number;
}
export interface Bullet {
    active: boolean;
    style: number;
    num: number;
    owner: number;
    ownerWeapon: number;
    timeOutReal: number;
    timeOut: number;
    timeOutPrev: number;
    hitMultiply: number;
    hitMultiplyPrev: number;
    velocityPrev: Vec2;
    whizzed: boolean;
    ownerPingTick: number;
    hitBody: number;
    hitSpot: Vec2;
    tracking: number;
    imageStyle: number;
    initial: Vec2;
    startUpTime: number;
    ricochetCount: number;
    degradeCount: number;
    seed: number;
    spriteCollisions: boolean[];
}
export interface Thing {
    active: boolean;
    style: number;
    num: number;
    owner: number;
    holdingSprite: number;
    ammoCount: number;
    radius: number;
    timeOut: number;
    staticType: boolean;
    interest: number;
    collideWithBullets: boolean;
    inBase: boolean;
    lastSpawn: number;
    team: number;
    collideCount: number[];
}
export interface Spark {
    active: boolean;
    num: number;
    lifeReal: number;
    life: number;
    lifePrev: number;
    style: number;
    owner: number;
    collideCount: number;
}
//# sourceMappingURL=types.d.ts.map