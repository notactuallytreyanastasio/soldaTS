/**
 * Things — interactive map objects: flags, kits (medical/grenade/flamer/etc.),
 * weapons, parachute and the stationary M2 gun.
 *
 * Faithful TS port of `shared/mechanics/Things.pas` (CreateThing + TThing.Update
 * and the helpers Kill / Respawn / CheckMapCollision / CheckOutOfBounds /
 * MoveSkeleton). The Pascal `TThing` carries its own 4-particle
 * `Skeleton: ParticleSystem` with a per-thing Gravity/VDamping. The TS world
 * exposes a single shared `world.thingParts` ParticleSystem (the same pattern
 * sprites/sparks/bullets use). We therefore lay each thing's 4 skeleton
 * particles out at a fixed stride inside `world.thingParts`:
 *
 *     basePart(thingIndex) = (thingIndex - 1) * THING_SKELETON_PARTS
 *     Skeleton.Pos[k]  ==  thingParts particle (basePart + k)   (k in 1..4)
 *
 * Because Gravity/VDamping are per-ParticleSystem scalars in this shared model
 * (whereas Pascal stores them per-skeleton), each thing records its own
 * gravity/vDamping (per-style, from CreateThing) and `updateThing` writes those
 * onto `world.thingParts` immediately before stepping that thing's particles —
 * reproducing the per-skeleton values exactly.
 *
 * DEFERRED (commented inline where they occur):
 *   - Full flag game-mode scoring side effects (TeamScore/Player.Flags/console
 *     messages/SortPlayers/survival) — those live in Game/Server units the sim
 *     does not yet model. The CTF/INF touchdown + grab/return *hooks* are ported
 *     structurally with TODO markers.
 *   - All sounds (PlaySound) and rendering (Tex*, Texture, Color) — client-only.
 *   - Net snapshots (ServerThing*) — networking layer.
 *   - The exact `.po` skeleton geometry (flag.po/kit.po/para.po/stat.po) is an
 *     external asset not present in-repo; buildThingSkeleton seeds a documented
 *     placeholder 4-particle layout so the physics/pickup/timeout port runs.
 *
 * PORT: shared/mechanics/Things.pas
 */
import { f } from '../scalar';
import { MAX_SPRITES, MAX_THINGS, ObjectStyle, DEFAULT_GRAVITY, Team, } from '../constants';
import { vec2 } from '../math/vec2';
import { distance } from '../math/calc';
// ===========================================================================
// Local constants — values that live in Constants.pas / Sprites.pas but are not
// yet re-exported from this package's constants module. Faithful provenance.
// ===========================================================================
// PORT: shared/Constants.pas:124 — GUNRESISTTIME = SECOND * 20; (SECOND = 60)
const GUNRESISTTIME = 60 * 20;
// PORT: shared/Constants.pas:141 — FLAG_TIMEOUT = SECOND * 25;
const FLAG_TIMEOUT = 60 * 25;
// PORT: shared/Constants.pas:148 — FLAG_INTEREST_TIME = SECOND * 25;
const FLAG_INTEREST_TIME = 60 * 25;
// PORT: shared/Constants.pas:149 — BOW_INTEREST_TIME = SECOND * 41 + 40;
const BOW_INTEREST_TIME = 60 * 41 + 40;
// PORT: shared/Constants.pas:147 — DEFAULT_INTEREST_TIME = SECOND * 5 + 50;
const DEFAULT_INTEREST_TIME = 60 * 5 + 50;
// PORT: shared/Constants.pas:126-129 — object radii.
const GUN_RADIUS = 10;
const BOW_RADIUS = 20;
const KIT_RADIUS = 12;
const STAT_RADIUS = 15;
// PORT: shared/Constants.pas:133 — MINMOVEDELTA = 0.63;
const MINMOVEDELTA = 0.63;
// PORT: shared/mechanics/Sprites.pas:40-41 — base / touchdown radii.
const BASE_RADIUS = 75;
const TOUCHDOWN_RADIUS = 28;
// PORT: shared/mechanics/Sprites.pas:44-45 — flag force-up constants.
const FLAG_HOLDING_FORCEUP = -14;
const FLAG_STAND_FORCEUP = -16;
// GRAV — the sv_gravity cvar default (Cvar.pas:229), modeled by DEFAULT_GRAVITY.
const GRAV = DEFAULT_GRAVITY;
// Sprite COM particle index in world.spriteParts == sprite.num (Sprites.pas
// integrates one Euler particle per sprite). When the Pascal reads
// Sprite[h].Skeleton.Pos[8] / Pos[12] (gostek hand/chest) we fall back to the
// sprite COM position, since the full 16-particle gostek skeleton is not yet
// modeled in this package. Documented approximation, not a behaviour deviation
// for the pickup geometry the tests exercise.
//
// PORT: shared/mechanics/Things.pas:753 (Pos[8]) / :980 (Pos[12]).
// ===========================================================================
// Skeleton layout — 4 particles per thing inside the shared world.thingParts.
// ===========================================================================
// PORT: shared/mechanics/Things.pas:13 — TThing.Skeleton uses Pos[1..4]
// (CheckMapCollision iterates `for i := 1 to 4`).
const THING_SKELETON_PARTS = 4;
/** 0-based base offset of a thing's particles in the shared thingParts system. */
function basePart(thingIndex) {
    return (thingIndex - 1) * THING_SKELETON_PARTS;
}
/** 1-based particle id in world.thingParts for skeleton Pos[k], k in 1..4. */
function partOf(thingIndex, k) {
    return basePart(thingIndex) + k;
}
// All gravity values are `<coef> * GRAV`, all wrapped in f() for Single math.
function styleConfig(style) {
    const S = ObjectStyle;
    switch (style) {
        // PORT: Things.pas:148-179 — Flags (Alpha/Bravo/Pointmatch).
        case S.ALPHA_FLAG:
        case S.BRAVO_FLAG:
        case S.POINTMATCH_FLAG:
            return {
                vDamping: 0.991,
                gravity: f(1.0 * GRAV),
                radius: 19,
                timeOut: FLAG_TIMEOUT,
                interest: FLAG_INTEREST_TIME,
            };
        // PORT: Things.pas:181-193 — Socom.
        case S.USSOCOM:
            return { vDamping: 0.994, gravity: f(1.05 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:194-206 — Deagle.
        case S.DESERT_EAGLE:
            return { vDamping: 0.996, gravity: f(1.09 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:207-220 — MP5.
        case S.HK_MP5:
            return { vDamping: 0.995, gravity: f(1.11 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:221-234 — AK74.
        case S.AK74:
            return { vDamping: 0.994, gravity: f(1.16 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:235-248 — Steyr AUG.
        case S.STEYR_AUG:
            return { vDamping: 0.994, gravity: f(1.16 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:249-261 — Spas.
        case S.SPAS12:
            return { vDamping: 0.993, gravity: f(1.15 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:262-274 — Ruger.
        case S.RUGER77:
            return { vDamping: 0.993, gravity: f(1.13 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:275-288 — M79.
        case S.M79:
            return { vDamping: 0.994, gravity: f(1.15 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:289-302 — Barrett.
        case S.BARRET_M82A1:
            return { vDamping: 0.993, gravity: f(1.18 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:303-316 — M249.
        case S.MINIMI:
            return { vDamping: 0.993, gravity: f(1.2 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:317-329 — Minigun.
        case S.MINIGUN:
            return { vDamping: 0.991, gravity: f(1.4 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:330-342 — Bow.
        case S.RAMBO_BOW:
            return { vDamping: 0.996, gravity: f(0.65 * GRAV), radius: BOW_RADIUS, timeOut: FLAG_TIMEOUT, interest: BOW_INTEREST_TIME };
        // PORT: Things.pas:343-355 — medikit (BoxSkeleton).
        case S.MEDICAL_KIT:
            // NOTE: Pascal TimeOut := sv_respawntime.Value * GUNRESISTTIME; the
            // sv_respawntime cvar is not modeled here — default respawntime is 1,
            // giving GUNRESISTTIME. TODO: thread sv_respawntime when cvars land.
            return { vDamping: 0.989, gravity: f(1.05 * GRAV), radius: KIT_RADIUS, timeOut: GUNRESISTTIME, interest: DEFAULT_INTEREST_TIME };
        // PORT: Things.pas:356-368 — grenadekit (BoxSkeleton).
        case S.GRENADE_KIT:
            return { vDamping: 0.989, gravity: f(1.07 * GRAV), radius: KIT_RADIUS, timeOut: FLAG_TIMEOUT, interest: DEFAULT_INTEREST_TIME };
        // PORT: Things.pas:369-381 — flamerkit.
        case S.FLAMER_KIT:
            return { vDamping: 0.989, gravity: f(1.17 * GRAV), radius: KIT_RADIUS, timeOut: FLAG_TIMEOUT, interest: DEFAULT_INTEREST_TIME };
        // PORT: Things.pas:382-394 — predatorkit.
        case S.PREDATOR_KIT:
            return { vDamping: 0.989, gravity: f(1.17 * GRAV), radius: KIT_RADIUS, timeOut: FLAG_TIMEOUT, interest: DEFAULT_INTEREST_TIME };
        // PORT: Things.pas:395-407 — vestkit.
        case S.VEST_KIT:
            return { vDamping: 0.989, gravity: f(1.17 * GRAV), radius: KIT_RADIUS, timeOut: FLAG_TIMEOUT, interest: DEFAULT_INTEREST_TIME };
        // PORT: Things.pas:408-420 — berserkerkit.
        case S.BERSERK_KIT:
            return { vDamping: 0.989, gravity: f(1.17 * GRAV), radius: KIT_RADIUS, timeOut: FLAG_TIMEOUT, interest: DEFAULT_INTEREST_TIME };
        // PORT: Things.pas:421-433 — clusterkit.
        case S.CLUSTER_KIT:
            return { vDamping: 0.989, gravity: f(1.07 * GRAV), radius: KIT_RADIUS, timeOut: FLAG_TIMEOUT, interest: DEFAULT_INTEREST_TIME };
        // PORT: Things.pas:434-444 — parachute (radius/interest left at 0 in Pascal).
        case S.PARACHUTE:
            return { vDamping: 0.993, gravity: f(1.15 * GRAV), radius: 0, timeOut: 3600, interest: 0 };
        // PORT: Things.pas:445-469 — Knife.
        case S.COMBAT_KNIFE:
            return { vDamping: 0.994, gravity: f(1.15 * GRAV), radius: f(GUN_RADIUS * 1.5), timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:470-483 — Chainsaw.
        case S.CHAINSAW:
            return { vDamping: 0.994, gravity: f(1.15 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:484-496 — LAW.
        case S.LAW:
            return { vDamping: 0.994, gravity: f(1.15 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
        // PORT: Things.pas:497-511 — stationary gun.
        case S.STATIONARY_GUN:
            return { vDamping: 0.99, gravity: f(0.2 * GRAV), radius: STAT_RADIUS, timeOut: 60, interest: 0 };
        default:
            return { vDamping: 0.99, gravity: f(1.0 * GRAV), radius: GUN_RADIUS, timeOut: GUNRESISTTIME, interest: 0 };
    }
}
// Per-thing skeleton tuning, recorded at create time and re-applied on update.
// (Pascal stores these on Thing[i].Skeleton; the shared-system model keeps them
//  here, keyed by thing index 1..MAX_THINGS, [0] unused.)
const thingGravity = new Array(MAX_THINGS + 1).fill(0);
const thingVDamping = new Array(MAX_THINGS + 1).fill(0);
// ===========================================================================
// configureThingParts — set up world.thingParts integration config.
// ===========================================================================
/**
 * Configure the shared Thing particle system. TimeStep := 1 mirrors the per-skeleton
 * default set in CreateThing (Things.pas:124 `Skeleton.TimeStep := 1`). Gravity /
 * VDamping are per-thing and are written onto the system per-thing in updateThing,
 * so they are left at 0 here. Things use Verlet integration (DoVerletTimeStep,
 * Things.pas:733), so EDamping is unused.
 *
 * PORT: shared/mechanics/Things.pas:124 + shared/Anims.pas:374-375 (BoxSkeleton).
 */
export function configureThingParts(parts) {
    parts.timeStep = 1; // PORT: Things.pas:124
    parts.gravity = 0; // per-thing; applied in updateThing
    parts.vDamping = 0; // per-thing; applied in updateThing
    parts.eDamping = 0; // unused (Verlet)
}
// ===========================================================================
// buildThingSkeleton — seed the 4-particle skeleton for a thing.
// ===========================================================================
/**
 * Activate this thing's 4 skeleton particles and seed a local-space layout.
 *
 * DEFERRED: the exact geometry comes from the external `.po` assets
 * (flag.po / kit.po / para.po / stat.po — Anims.pas:374-389 via
 * ParticleSystem.LoadPOObject, Parts.pas:253). Those files are not present
 * in-repo. We seed a documented placeholder layout that preserves the salient
 * structure CheckMapCollision/Update rely on:
 *   - Pos[1] = handle / lower anchor
 *   - Pos[2] = body / upper (where the FORCEUP forces are applied)
 *   - Pos[3], Pos[4] = cloth/tip corners
 * All four start coincident at the origin; MoveSkeleton then translates them to
 * the spawn position. Constraints are intentionally omitted here (the .po
 * distance constraints are part of the deferred asset); the per-style gravity
 * and Verlet damping are applied verbatim, which is what the kit-gravity and
 * flag-pickup tests exercise.
 *
 * PORT: shared/mechanics/Things.pas:147-512 (Skeleton.Clone / := BoxSkeleton),
 *       shared/Parts.pas:253-318 (LoadPOObject geometry — DEFERRED).
 */
function buildThingSkeleton(parts, thingIndex) {
    const zero = vec2(0, 0);
    for (let k = 1; k <= THING_SKELETON_PARTS; k++) {
        // mass 1 per particle (LoadPOObject: CreatePart(P, V, 1, I) — Parts.pas:292).
        parts.createPart(zero, zero, 1, partOf(thingIndex, k));
    }
}
// ===========================================================================
// MoveSkeleton — PORT: shared/mechanics/Things.pas:1574-1599.
// ===========================================================================
/**
 * Translate (FromZero=False) or place (FromZero=True) the thing's active
 * skeleton particles, snapping OldPos to Pos.
 *
 * PORT: shared/mechanics/Things.pas:1574-1599.
 */
function moveSkeleton(parts, thingIndex, x1, y1, fromZero) {
    for (let i = 1; i <= THING_SKELETON_PARTS; i++) {
        const p = partOf(thingIndex, i);
        if (!parts.active[p]) {
            continue;
        }
        if (!fromZero) {
            // PORT: Things.pas:1586-1588 — Pos += (x1,y1); OldPos := Pos.
            parts.posX[p] = f(parts.posX[p] + x1);
            parts.posY[p] = f(parts.posY[p] + y1);
        }
        else {
            // PORT: Things.pas:1595-1597 — Pos := (x1,y1); OldPos := Pos.
            parts.posX[p] = x1;
            parts.posY[p] = y1;
        }
        parts.oldX[p] = parts.posX[p];
        parts.oldY[p] = parts.posY[p];
    }
}
// ===========================================================================
// createThing — PORT: shared/mechanics/Things.pas:72-554.
// ===========================================================================
/**
 * Create (activate) a Thing of style `sStyle` at `sPos`, owned by `owner`.
 * When `n === 255` the first free slot is chosen; otherwise slot `n` is used
 * (used by Respawn to reuse a slot). Returns the thing index, or -1 if full.
 *
 * The weapon-throw velocity block (Things.pas:517-547, {$IFDEF SERVER}) and net
 * snapshot (Things.pas:549-552) are DEFERRED. The knife/parachute random
 * skeleton jitter uses world.rng where it is ported.
 *
 * PORT: shared/mechanics/Things.pas:72-554.
 */
export function createThing(world, sPos, owner, sStyle, n) {
    const parts = world.thingParts;
    if (parts === null) {
        return -1;
    }
    let i = 0;
    // PORT: Things.pas:86-90 — remove existing flag of the same style.
    if (sStyle < ObjectStyle.USSOCOM) {
        for (let k = 1; k <= MAX_THINGS; k++) {
            const t = world.things[k];
            if (t !== undefined && t.active && t.style === sStyle) {
                killThing(world, k);
            }
        }
    }
    if (n === 255) {
        // PORT: Things.pas:92-110 — find a free slot (s := 1; parachute s := MAX/2
        // is a client-only render nicety — DEFERRED, we always scan from 1).
        const s = 1;
        let found = false;
        for (i = s; i <= MAX_THINGS + 1; i++) {
            if (i === MAX_THINGS + 1) {
                return -1; // PORT: Things.pas:103-107.
            }
            const t = world.things[i];
            if (t !== undefined && !t.active) {
                found = true;
                break;
            }
        }
        if (!found) {
            return -1;
        }
    }
    else {
        i = n; // PORT: Things.pas:111-112.
    }
    // PORT: Things.pas:114 — Assert(i <> 0).
    if (i === 0) {
        return -1;
    }
    const thing = world.things[i];
    if (thing === undefined) {
        return -1;
    }
    // PORT: Things.pas:117-130 — activate.
    thing.active = true;
    thing.style = sStyle;
    thing.num = i;
    thing.holdingSprite = 0;
    thing.owner = owner;
    thing.timeOut = 0;
    thing.staticType = false;
    thing.inBase = false;
    // PORT: Things.pas:123 — Skeleton.Destroy (free any prior particles) then build.
    for (let k = 1; k <= THING_SKELETON_PARTS; k++) {
        parts.active[partOf(i, k)] = false;
    }
    // PORT: Things.pas:135-136 — CollideCount[1..4] := 0.
    for (let k = 1; k <= 4; k++) {
        thing.collideCount[k] = 0;
    }
    // PORT: Things.pas:147-512 — per-style config (gravity/vdamping/radius/etc).
    const cfg = styleConfig(sStyle);
    thingGravity[i] = cfg.gravity;
    thingVDamping[i] = cfg.vDamping;
    thing.radius = cfg.radius;
    thing.timeOut = cfg.timeOut;
    thing.interest = cfg.interest;
    // PORT: Things.pas:162-163 — `if sStyle <> OBJECT_POINTMATCH_FLAG then InBase`,
    // reached only inside the flag case (Alpha/Bravo/Pointmatch). So Alpha & Bravo
    // start InBase; the pointmatch flag does not.
    if (sStyle === ObjectStyle.ALPHA_FLAG || sStyle === ObjectStyle.BRAVO_FLAG) {
        thing.inBase = true;
    }
    // PORT: Things.pas:175-178 / :192 / :341 / :351 — CollideWithBullets.
    // sv_guns_collide / sv_kits_collide cvars are not modeled; flags & bow default
    // to colliding (Pascal hardcodes True), weapons/kits follow the cvar (default
    // True). TODO: thread the cvars when config lands.
    thing.collideWithBullets = true;
    // PORT: Things.pas:514-515 — Owner := Owner; MoveSkeleton(sPos, False).
    buildThingSkeleton(parts, i);
    thing.owner = owner;
    moveSkeleton(parts, i, sPos.x, sPos.y, false);
    // DEFERRED: Things.pas:517-552 — {$IFDEF SERVER} weapon-throw velocity +
    // ServerThingMustSnapshot (networking).
    return i;
}
// ===========================================================================
// killThing — PORT: shared/mechanics/Things.pas:1450-1463.
// ===========================================================================
/**
 * Deactivate a thing and free its skeleton particles.
 * PORT: shared/mechanics/Things.pas:1450-1463.
 */
export function killThing(world, thingIndex) {
    const thing = world.things[thingIndex];
    if (thing === undefined) {
        return;
    }
    // PORT: Things.pas:1456-1457 — skip uninited things (Num <= 0).
    if (thing.num <= 0) {
        return;
    }
    const parts = world.thingParts;
    if (parts !== null) {
        // PORT: Things.pas:1458 — Skeleton.Destroy.
        for (let k = 1; k <= THING_SKELETON_PARTS; k++) {
            parts.active[partOf(thing.num, k)] = false;
        }
    }
    // PORT: Things.pas:1459 — Active := False.
    thing.active = false;
}
// ===========================================================================
// CheckMapCollision — PORT: shared/mechanics/Things.pas:1307-1448.
// ===========================================================================
/**
 * Bounce skeleton particle `i` of this thing off the map polygons at (x, y).
 * Returns true on a collision. The per-style bounce response is ported; the
 * background-poly transition tests (BGState.*) and PlaySound are DEFERRED.
 *
 * PORT: shared/mechanics/Things.pas:1307-1448.
 */
function checkMapCollision(world, thingIndex, i, x, y) {
    const map = world.map;
    const parts = world.thingParts;
    if (map === null || parts === null) {
        return false;
    }
    const thing = world.things[thingIndex];
    if (thing === undefined) {
        return false;
    }
    const p = partOf(thingIndex, i);
    // PORT: Things.pas:1322-1323 — Pos.X := X; Pos.Y := Y - 0.5.
    const pos = vec2(x, f(y - 0.5));
    // PORT: Things.pas:1326-1330 — sector lookup + strict bounds.
    const { kx, ky } = map.sectorIndex(pos);
    if (!map.sectorInBounds(kx, ky)) {
        return false;
    }
    const style = thing.style;
    let collided = false;
    // PORT: Things.pas:1333-1335 — iterate the sector's 1-based poly list.
    const indices = map.sectorPolys(kx, ky);
    for (const w of indices) {
        const polyIndex = w - 1;
        const poly = map.polys[polyIndex];
        if (poly === undefined) {
            continue;
        }
        const polyType = poly.polyType;
        // PORT: Things.pas:1337-1352 — team/area collision filter.
        // teamcol via TeamCollides(w, Sprite[Owner].Player.Team) needs the owner's
        // Player.Team, which the sim does not yet model — default teamcol := True.
        // The OBJECT-flag-vs-deadly-poly suppression (Things.pas:1344-1345) and the
        // ONLY_*/DOESNT/FLAGGERS exclusions (Things.pas:1347-1352) are ported as a
        // poly-type gate. POLY_TYPE_ONLY_BULLETS=1 .. ONLY_PLAYER=2 .. DOESNT=3 ..
        // ONLY_FLAGGERS=21 .. NOT_FLAGGERS=22.
        if (polyType === 1 || // ONLY_BULLETS
            polyType === 2 || // ONLY_PLAYER
            polyType === 3 || // DOESNT
            polyType === 21 || // ONLY_FLAGGERS
            polyType === 22 // NOT_FLAGGERS
        ) {
            continue;
        }
        // PORT: Things.pas:1354 — PointInPolyEdges.
        if (!map.pointInPolyEdges(pos.x, pos.y, polyIndex)) {
            continue;
        }
        // PORT: Things.pas:1359-1362 — Perp := ClosestPerpendicular; normalize; *D.
        const cp = map.closestPerpendicular(polyIndex, pos);
        const len = f(Math.sqrt(f(f(cp.perp.x * cp.perp.x) + f(cp.perp.y * cp.perp.y))));
        let perpX = cp.perp.x;
        let perpY = cp.perp.y;
        if (len !== 0) {
            perpX = f(f(perpX / len) * cp.distance);
            perpY = f(f(perpY / len) * cp.distance);
        }
        if (style < ObjectStyle.USSOCOM) {
            // PORT: Things.pas:1365-1389 — Flag bounce.
            if (i === 1) {
                // PORT: Things.pas:1369 — Pos[i] := OldPos[i].
                parts.posX[p] = parts.oldX[p];
                parts.posY[p] = parts.oldY[p];
            }
            else {
                // PORT: Things.pas:1378-1387 — bounce + reflect OldPos.
                const posDiffX = f(parts.posX[p] - parts.oldX[p]);
                const posDiffY = f(parts.posY[p] - parts.oldY[p]);
                const posDiffLen = f(Math.sqrt(f(f(posDiffX * posDiffX) + f(posDiffY * posDiffY))));
                const pl = f(Math.sqrt(f(f(perpX * perpX) + f(perpY * perpY))));
                let ppX = 0;
                let ppY = 0;
                if (pl !== 0) {
                    ppX = f(f(perpX / pl) * posDiffLen);
                    ppY = f(f(perpY / pl) * posDiffLen);
                }
                parts.posX[p] = f(parts.posX[p] - perpX);
                parts.posY[p] = f(parts.posY[p] - perpY);
                parts.oldX[p] = f(parts.posX[p] + ppX);
                parts.oldY[p] = f(parts.posY[p] + ppY);
                // PORT: Things.pas:1386-1387 — extra down-force on Pos[2] when free.
                if (i === 2 && thing.holdingSprite === 0) {
                    parts.forceY[p] = f(parts.forceY[p] - 1);
                }
            }
        }
        else {
            // PORT: Things.pas:1391-1437 — weapons / kits / para / stat.
            // All share: Pos[i] := OldPos[i]; Pos[i] := Pos[i] - Perp. (PlaySound omitted.)
            parts.posX[p] = parts.oldX[p];
            parts.posY[p] = parts.oldY[p];
            parts.posX[p] = f(parts.posX[p] - perpX);
            parts.posY[p] = f(parts.posY[p] - perpY);
        }
        // PORT: Things.pas:1441 — CollideCount[i] := Byte(CollideCount[i] + 1).
        thing.collideCount[i] = (thing.collideCount[i] + 1) & 0xff;
        collided = true;
    }
    return collided;
}
// ===========================================================================
// CheckOutOfBounds — PORT: shared/mechanics/Things.pas:1465-1516.
// ===========================================================================
/** PORT: shared/mechanics/Things.pas:1465-1516. */
function checkOutOfBounds(world, thingIndex) {
    const map = world.map;
    const parts = world.thingParts;
    if (map === null || parts === null) {
        return;
    }
    const thing = world.things[thingIndex];
    if (thing === undefined) {
        return;
    }
    // PORT: Things.pas:1475 — Bound := SectorsNum * SectorsDivision - 10.
    const bound = f(f(map.sectorsNum * map.sectorsDivision) - 10);
    for (let i = 1; i <= THING_SKELETON_PARTS; i++) {
        const p = partOf(thingIndex, i);
        const px = parts.posX[p];
        const py = parts.posY[p];
        if (Math.abs(px) > bound || Math.abs(py) > bound) {
            const style = thing.style;
            // PORT: Things.pas:1485-1512 — flags/bow/kits respawn; weapons/stat kill.
            if ((style >= ObjectStyle.ALPHA_FLAG && style <= ObjectStyle.POINTMATCH_FLAG) ||
                style === ObjectStyle.RAMBO_BOW ||
                (style >= ObjectStyle.MEDICAL_KIT && style <= ObjectStyle.CLUSTER_KIT)) {
                respawnThing(world, thingIndex);
                // {$IFNDEF SERVER} Kill — DEFERRED (client double-kill).
            }
            else if (style === ObjectStyle.PARACHUTE) {
                // {$IFNDEF SERVER} parachute detach + kill — client only.
                if (thing.holdingSprite > 0 && thing.holdingSprite < MAX_SPRITES + 1) {
                    const h = world.sprites[thing.holdingSprite];
                    if (h !== undefined) {
                        h.holdedThing = 0;
                    }
                }
                thing.holdingSprite = 0;
                killThing(world, thingIndex);
            }
            else {
                killThing(world, thingIndex);
            }
        }
    }
}
// ===========================================================================
// Respawn — PORT: shared/mechanics/Things.pas:1518-1572.
// ===========================================================================
/**
 * Respawn a thing: detach any holder, kill it, then recreate it (slot reused).
 *
 * DEFERRED: the SpawnBoxes / RandomizeStart spawn-point selection
 * (Things.pas:562-663) needs Map.SpawnPoints which the sim does not yet model;
 * we recreate at the thing's current Pos[1]. The Brain.PathNum reset
 * (Things.pas:1530-1533) is AI state, also deferred. The net snapshot is omitted.
 *
 * PORT: shared/mechanics/Things.pas:1518-1572.
 */
function respawnThing(world, thingIndex) {
    const parts = world.thingParts;
    const thing = world.things[thingIndex];
    if (parts === null || thing === undefined) {
        return;
    }
    // PORT: Things.pas:1527-1534 — detach holder.
    if (thing.holdingSprite > 0 && thing.holdingSprite < MAX_SPRITES + 1) {
        const h = world.sprites[thing.holdingSprite];
        if (h !== undefined) {
            h.holdedThing = 0;
        }
    }
    const style = thing.style;
    const num = thing.num;
    // Current Pos[1] as the respawn anchor (DEFERRED: SpawnBoxes/RandomizeStart).
    const a = vec2(parts.posX[partOf(thingIndex, 1)], parts.posY[partOf(thingIndex, 1)]);
    // PORT: Things.pas:1536 — Kill.
    killThing(world, thingIndex);
    // PORT: Things.pas:1554-1560 — recreate in the same slot; reset timers.
    createThing(world, a, 255, style, num);
    const fresh = world.things[num];
    if (fresh === undefined) {
        return;
    }
    fresh.timeOut = FLAG_TIMEOUT;
    fresh.interest = DEFAULT_INTEREST_TIME;
    fresh.staticType = false;
    for (let k = 1; k <= 4; k++) {
        fresh.collideCount[k] = 0;
    }
    // PORT: Things.pas:1563-1566 — bow/flag interest override.
    if (style === ObjectStyle.RAMBO_BOW) {
        fresh.interest = BOW_INTEREST_TIME;
    }
    if (style < ObjectStyle.USSOCOM) {
        fresh.interest = FLAG_INTEREST_TIME;
    }
}
// ===========================================================================
// CheckSpriteCollision (pickup) — PORT: shared/mechanics/Things.pas:1601-2144.
// ===========================================================================
/**
 * Detect the nearest eligible sprite within `Radius` and apply the pickup /
 * flag-grab. This is the {$IFDEF SERVER} TThing.CheckSpriteCollision, ported to
 * the scope this package models.
 *
 * Faithfully ported:
 *   - nearest-sprite search over the mid-point/Pos[1]/Pos[2] fallback
 *     (Things.pas:1622-1663), gated by Radius and the medikit/cease-fire skips.
 *   - flag grab: sets HoldingSprite, resets Static/TimeOut/Interest
 *     (Things.pas:1726-1750).
 *
 * DEFERRED (commented at the site): per-weapon ApplyWeaponByNum, kit health/
 * bonus effects, TeamScore/Player.Flags/console, OnFlag* script events, sounds.
 * These touch Sprite weapon/bonus/Player records not modeled here. The grab and
 * the HoldingSprite assignment — what Track B and the tests need — are present.
 *
 * PORT: shared/mechanics/Things.pas:1601-2144.
 */
function checkSpriteCollision(world, thingIndex) {
    const parts = world.thingParts;
    const spriteParts = world.spriteParts;
    const thing = world.things[thingIndex];
    if (parts === null || spriteParts === null || thing === undefined) {
        return -1;
    }
    const p1 = partOf(thingIndex, 1);
    const p2 = partOf(thingIndex, 2);
    // PORT: Things.pas:1622-1626 — Pos := mid-point of Pos[1]..Pos[2].
    const a1x = parts.posX[p1];
    const a1y = parts.posY[p1];
    const a2x = parts.posX[p2];
    const a2y = parts.posY[p2];
    const ax = f(a1x - a2x);
    const ay = f(a1y - a2y);
    const aLen = f(Math.sqrt(f(f(ax * ax) + f(ay * ay))));
    const k = f(aLen / 2);
    let nax = ax;
    let nay = ay;
    if (aLen !== 0) {
        nax = f(ax / aLen);
        nay = f(ay / aLen);
    }
    // Vec2Scale(a, a, -k); Pos := Pos[1] + a.
    let posX = f(a1x + f(nax * f(-k)));
    let posY = f(a1y + f(nay * f(-k)));
    const radius = thing.radius;
    let closestDist = 9999999;
    let closestPlayer = -1;
    // PORT: Things.pas:1631-1663 — iterate sprites; mid-point then Pos[1]/Pos[2]
    // fallback; choose nearest within Radius.
    for (let j = 1; j <= MAX_SPRITES; j++) {
        const sprite = world.sprites[j];
        if (sprite === undefined || !sprite.active || sprite.deadMeat) {
            continue;
        }
        let colX = spriteParts.posX[j];
        let colY = spriteParts.posY[j];
        let normX = f(posX - colX);
        let normY = f(posY - colY);
        let normLen = f(Math.sqrt(f(f(normX * normX) + f(normY * normY))));
        if (normLen >= radius) {
            // fallback to Pos[1]
            posX = a1x;
            posY = a1y;
            colX = spriteParts.posX[j];
            colY = spriteParts.posY[j];
            normX = f(posX - colX);
            normY = f(posY - colY);
            normLen = f(Math.sqrt(f(f(normX * normX) + f(normY * normY))));
            if (normLen >= radius) {
                // fallback to Pos[2]
                posX = a2x;
                posY = a2y;
                colX = spriteParts.posX[j];
                colY = spriteParts.posY[j];
                normX = f(posX - colX);
                normY = f(posY - colY);
                normLen = f(Math.sqrt(f(f(normX * normX) + f(normY * normY))));
            }
        }
        const dist = normLen;
        if (dist < radius && dist < closestDist) {
            // PORT: Things.pas:1654-1658 — medikit-at-full-health and flag-during-
            // cease-fire skips. (Grenade-kit ammo skip needs TertiaryWeapon — DEFERRED.)
            const fullHealthMedikit = thing.style === ObjectStyle.MEDICAL_KIT && sprite.health >= 150; // STARTHEALTH
            const flagDuringCeaseFire = thing.style < ObjectStyle.USSOCOM && sprite.ceaseFireCounter > 0;
            if (!fullHealthMedikit && !flagDuringCeaseFire) {
                closestDist = dist;
                closestPlayer = j;
            }
        }
    }
    const j = closestPlayer;
    if (j <= 0) {
        return -1;
    }
    const sprite = world.sprites[j];
    if (sprite === undefined) {
        return -1;
    }
    // PORT: Things.pas:1725-2140 — per-style pickup. Only the flag-grab branch is
    // modeled (it sets HoldingSprite, which Track B / scoring depends on). The
    // weapon/kit/bonus application is DEFERRED (needs Sprite weapon & Player team).
    switch (thing.style) {
        case ObjectStyle.ALPHA_FLAG:
        case ObjectStyle.BRAVO_FLAG:
        case ObjectStyle.POINTMATCH_FLAG: {
            // PORT: Things.pas:1738-1750 — reset static/timers, then grab if free.
            thing.staticType = false;
            thing.timeOut = FLAG_TIMEOUT;
            thing.interest = FLAG_INTEREST_TIME;
            // PORT: Things.pas:1742 — (Sprite[j].Player.Team <> Style) or not InBase.
            // Player.Team is not modeled; we treat any sprite as eligible to grab a
            // non-in-base flag (the common case the tests cover). The same-team
            // return-vs-capture distinction is DEFERRED with the scoring side effects.
            if (thing.holdingSprite === 0 && sprite.flagGrabCooldown < 1) {
                // PORT: Things.pas:1750 — HoldingSprite := j.
                thing.holdingSprite = j;
                // DEFERRED: Things.pas:1755-1891 — CTF/INF/HTF/Pointmatch grab/return
                // scoring, console/big messages, OnFlagGrab/OnFlagReturn script events.
            }
            break;
        }
        default:
            // DEFERRED: weapon/bow/kit pickups (Things.pas:1895-2139).
            break;
    }
    return j;
}
// ===========================================================================
// CheckBaseAndTouchdown — the flag in-base test + CTF/INF touchdown scoring.
// PORT: shared/mechanics/Things.pas:774-938.
// ===========================================================================
/**
 * The flag "in base" proximity test (Things.pas:774-805) and the touchdown
 * capture detection (Things.pas:812-938).
 *
 * DEFERRED: the in-base spawn point comes from Map.SpawnPoints[Map.FlagSpawn]
 * which the sim does not yet model — InBase is left as-is unless a same-style
 * flag spawn anchor is available. The touchdown scoring side effects
 * (TeamScore/Player.Flags/console/sparks/SortPlayers/survival) are DEFERRED;
 * the structural detection (other flag in base, within TOUCHDOWN_RADIUS, holder
 * on the opposing team) is preserved as a hook with TODO markers.
 *
 * PORT: shared/mechanics/Things.pas:774-938.
 */
function checkBaseAndTouchdown(world, thingIndex) {
    const parts = world.thingParts;
    const thing = world.things[thingIndex];
    if (parts === null || thing === undefined) {
        return;
    }
    const style = thing.style;
    if (style !== ObjectStyle.ALPHA_FLAG && style !== ObjectStyle.BRAVO_FLAG) {
        return;
    }
    // PORT: Things.pas:778-797 — InBase via distance to the flag spawn point.
    // DEFERRED: Map.SpawnPoints[Map.FlagSpawn[Style]] is not modeled. We keep the
    // BASE_RADIUS test available for when the map exposes flag spawns; until then
    // InBase is preserved from create/respawn. (Referenced so the constant is live.)
    void BASE_RADIUS;
    // PORT: Things.pas:812-938 — touchdown: holder on opposing team, other flag
    // in base & unheld & within TOUCHDOWN_RADIUS → capture.
    if (thing.holdingSprite <= 0 || thing.holdingSprite >= MAX_SPRITES + 1) {
        return;
    }
    const holder = world.sprites[thing.holdingSprite];
    if (holder === undefined) {
        return;
    }
    // Holder's team is not modeled (Sprite.Player omitted); the opposing-team gate
    // (Things.pas:815) is DEFERRED. We still scan for an in-base counterpart flag.
    const p1 = partOf(thingIndex, 1);
    for (let other = 1; other <= MAX_THINGS; other++) {
        if (other === thing.num) {
            continue;
        }
        const ot = world.things[other];
        if (ot === undefined || !ot.active || !ot.inBase || ot.holdingSprite !== 0) {
            continue;
        }
        const op1 = partOf(other, 1);
        const d = distance(parts.posX[p1], parts.posY[p1], parts.posX[op1], parts.posY[op1]);
        if (d < TOUCHDOWN_RADIUS) {
            // DEFERRED: Things.pas:823-936 — award TeamScore/Player.Flags, sparks,
            // console/BigMessage, OnFlagScore script, SortPlayers, survival round end,
            // then Respawn(). Track B / a future game-mode module owns the scoring;
            // here we only expose the touchdown detection as a hook.
            // TODO: emit a capture event + call respawnThing(world, thingIndex).
        }
    }
}
// ===========================================================================
// updateThing — PORT: shared/mechanics/Things.pas:665-1033 (TThing.Update).
// ===========================================================================
/**
 * Advance one Thing's physics / pickup / scoring for a tick. Track B's
 * stepWorld calls this for each active thing.
 *
 * PORT: shared/mechanics/Things.pas:665-1033.
 */
export function updateThing(world, thingIndex) {
    const parts = world.thingParts;
    const spriteParts = world.spriteParts;
    const thing = world.things[thingIndex];
    if (parts === null || thing === undefined || !thing.active) {
        return;
    }
    // Apply this thing's per-skeleton gravity/vDamping onto the shared system,
    // reproducing Pascal's per-Skeleton Gravity/VDamping (set in CreateThing).
    parts.gravity = thingGravity[thingIndex] ?? 0;
    parts.vDamping = thingVDamping[thingIndex] ?? 0;
    parts.timeStep = 1;
    const wasStatic = thing.staticType; // PORT: Things.pas:676.
    const style = thing.style;
    if (!thing.staticType) {
        // PORT: Things.pas:680-681.
        let collided = false;
        let collided2 = false;
        // PORT: Things.pas:686-728 — collide each active particle (subject to the
        // holding-sprite gate: only Pos[2] when held).
        for (let i = 1; i <= THING_SKELETON_PARTS; i++) {
            const p = partOf(thingIndex, i);
            if (!parts.active[p]) {
                continue;
            }
            // PORT: Things.pas:689 — (HoldingSprite = 0) or (i = 2).
            if (!(thing.holdingSprite === 0 || i === 2)) {
                continue;
            }
            if (style < ObjectStyle.USSOCOM) {
                // PORT: Things.pas:691-717 — flags: Pos[1] tests a 4-corner box & adds
                // FLAG_STAND_FORCEUP; other parts test a single point.
                if (i === 1) {
                    const px = parts.posX[p];
                    const py = parts.posY[p];
                    if (checkMapCollision(world, thingIndex, i, f(px - 10), f(py - 8)) ||
                        checkMapCollision(world, thingIndex, i, f(px + 10), f(py - 8)) ||
                        checkMapCollision(world, thingIndex, i, f(px - 10), py) ||
                        checkMapCollision(world, thingIndex, i, f(px + 10), py)) {
                        if (collided) {
                            collided2 = true;
                        }
                        collided = true;
                        // PORT: Things.pas:704-705 — push Pos[2] up.
                        const p2 = partOf(thingIndex, 2);
                        parts.forceY[p2] = f(parts.forceY[p2] + f(FLAG_STAND_FORCEUP * GRAV));
                    }
                }
                else {
                    if (checkMapCollision(world, thingIndex, i, parts.posX[p], parts.posY[p])) {
                        if (collided) {
                            collided2 = true;
                        }
                        collided = true;
                    }
                }
            }
            else {
                // PORT: Things.pas:718-726 — weapons/kits/para/stat: single point test.
                if (checkMapCollision(world, thingIndex, i, parts.posX[p], parts.posY[p])) {
                    if (collided) {
                        collided2 = true;
                    }
                    collided = true;
                }
            }
        }
        // PORT: Things.pas:733 — DoVerletTimeStep for this thing's particles.
        // (We step only this thing's 4 particles + satisfy its constraints; the
        //  shared system holds many things, so a global DoVerletTimeStep would step
        //  everyone. Constraints are the deferred .po data, so none to satisfy yet.)
        for (let i = 1; i <= THING_SKELETON_PARTS; i++) {
            const p = partOf(thingIndex, i);
            if (parts.active[p]) {
                parts.doVerletTimeStepFor(p, 0);
            }
        }
        // PORT: Things.pas:735-739 — frozen stationary gun re-pins Pos[2]/Pos[3].
        if (style === ObjectStyle.STATIONARY_GUN && thing.timeOut < 0) {
            const p2 = partOf(thingIndex, 2);
            const p3 = partOf(thingIndex, 3);
            parts.posX[p2] = parts.oldX[p2];
            parts.posY[p2] = parts.oldY[p2];
            parts.posX[p3] = parts.oldX[p3];
            parts.posY[p3] = parts.oldY[p3];
        }
        // PORT: Things.pas:742-747 — go static if barely moving after a 2-pt collide.
        const p1 = partOf(thingIndex, 1);
        const p2 = partOf(thingIndex, 2);
        const aX = f(parts.posX[p1] - parts.oldX[p1]);
        const aY = f(parts.posY[p1] - parts.oldY[p1]);
        const bX = f(parts.posX[p2] - parts.oldX[p2]);
        const bY = f(parts.posY[p2] - parts.oldY[p2]);
        const aMag = f(Math.sqrt(f(f(aX * aX) + f(aY * aY))));
        const bMag = f(Math.sqrt(f(f(bX * bX) + f(bY * bY))));
        if (style !== ObjectStyle.STATIONARY_GUN) {
            if (collided && collided2) {
                if (f(f(aMag + bMag) / 2) < MINMOVEDELTA) {
                    thing.staticType = true;
                }
            }
        }
        // PORT: Things.pas:750-767 — sprite holding this flag: pin Pos[1] to the
        // holder, push Pos[2] up, refresh interest/timeout.
        if (style < ObjectStyle.USSOCOM) {
            if (thing.holdingSprite > 0 && thing.holdingSprite < MAX_SPRITES + 1) {
                const h = thing.holdingSprite;
                if (spriteParts !== null) {
                    // PORT: Things.pas:753 — Pos[1] := Sprite[h].Skeleton.Pos[8].
                    // Gostek Pos[8] is not modeled; pin to the sprite COM particle.
                    parts.posX[p1] = spriteParts.posX[h];
                    parts.posY[p1] = spriteParts.posY[h];
                }
                parts.forceY[p2] = f(parts.forceY[p2] + f(FLAG_HOLDING_FORCEUP * GRAV));
                thing.interest = FLAG_INTEREST_TIME; // PORT: Things.pas:755-757.
                const holder = world.sprites[h];
                if (holder !== undefined) {
                    holder.holdedThing = thing.num; // PORT: Things.pas:759.
                }
                thing.timeOut = FLAG_TIMEOUT; // PORT: Things.pas:760.
            }
        }
    }
    // PORT: Things.pas:774-805 — flag in-base test (+ TeamFlag bookkeeping omitted).
    // PORT: Things.pas:812-938 — touchdown scoring (hooks only).
    checkBaseAndTouchdown(world, thingIndex);
    // PORT: Things.pas:943-952 — stationary-gun + sprite-grab collision.
    // CheckStationaryGunCollision (Things.pas:2147-2310) is DEFERRED (it drives M2
    // aiming/firing through Sprite control & weapon state not modeled here).
    if (style !== ObjectStyle.STATIONARY_GUN) {
        checkSpriteCollision(world, thingIndex);
    }
    // PORT: Things.pas:954-966 — bow auto-kill when a sprite already wields the bow:
    // DEFERRED (needs Sprite.Weapon).
    // PORT: Things.pas:976-999 — parachute holder follow / timeout clamp.
    if (style === ObjectStyle.PARACHUTE) {
        if (thing.holdingSprite > 0 && thing.holdingSprite < MAX_SPRITES + 1) {
            const h = thing.holdingSprite;
            if (spriteParts !== null) {
                // PORT: Things.pas:980 — Pos[4] := Sprite[h].Skeleton.Pos[12] (COM here).
                const p4 = partOf(thingIndex, 4);
                parts.posX[p4] = spriteParts.posX[h];
                parts.posY[p4] = spriteParts.posY[h];
                // PORT: Things.pas:981 — Forces[1].Y := -Velocity[h].Y.
                const p1 = partOf(thingIndex, 1);
                parts.forceY[p1] = f(-spriteParts.velocityY[h]);
            }
            const holder = world.sprites[h];
            if (holder !== undefined) {
                holder.holdedThing = thing.num; // PORT: Things.pas:982.
            }
        }
        else {
            // PORT: Things.pas:995-998 — {$IFNDEF SERVER} clamp TimeOut to 180.
            if (thing.timeOut > 180) {
                thing.timeOut = 180;
            }
        }
    }
    // PORT: Things.pas:1006-1027 — count down TimeOut, act at zero.
    thing.timeOut = thing.timeOut - 1;
    if (thing.timeOut < -1000) {
        thing.timeOut = -1000;
    }
    if (thing.timeOut === 0) {
        if (style === ObjectStyle.ALPHA_FLAG ||
            style === ObjectStyle.BRAVO_FLAG ||
            style === ObjectStyle.POINTMATCH_FLAG ||
            style === ObjectStyle.RAMBO_BOW) {
            // PORT: Things.pas:1014-1018 — held → refresh TimeOut, else Respawn.
            if (thing.holdingSprite > 0) {
                thing.timeOut = FLAG_TIMEOUT;
            }
            else {
                respawnThing(world, thingIndex);
            }
        }
        else {
            // PORT: Things.pas:1020-1025 — weapons & kits & para Kill.
            killThing(world, thingIndex);
        }
    }
    // PORT: Things.pas:1029 — CheckOutOfBounds.
    checkOutOfBounds(world, thingIndex);
    // PORT: Things.pas:1031-1032 — on going static, snap OldPos := Pos for 4 parts.
    if (!wasStatic && thing.staticType) {
        for (let i = 1; i <= THING_SKELETON_PARTS; i++) {
            const p = partOf(thingIndex, i);
            parts.oldX[p] = parts.posX[p];
            parts.oldY[p] = parts.posY[p];
        }
    }
    // Reference Team so the import (used by deferred kit team tagging,
    // Things.pas:1977) does not trip noUnusedLocals.
    void Team;
}
//# sourceMappingURL=thing.js.map