/**
 * Sparks — faithful port of `shared/mechanics/Sparks.pas` (the visual / gameplay
 * particle layer: shell casings, smoke, blood, fire, explosion debris, etc.).
 *
 * A spark is a thin record (`Spark`, see ../entities/types) paired 1:1 with a
 * particle in the shared `SparkParts` ParticleSystem (world.sparkParts) at index
 * = spark.num, exactly as Pascal `SparkParts[Num]`. The record holds the
 * lifetime / style / owner bookkeeping; the ParticleSystem holds the moving
 * position & velocity.
 *
 * SCOPE (M4). This file ports the SIMULATION spine of CreateSpark and
 * TSpark.Update:
 *
 *   1. createSpark        — allocate a free slot, activate the record and the
 *                           paired SparkParts particle (Sparks.pas:35-98).
 *   2. updateSpark        — per-tick advance of one spark: Euler integration
 *                           (skipped for the NONEULER styles), out-of-bounds
 *                           kill, optional map-collision bounce for COLLIDABLE
 *                           styles, then the Life countdown -> Kill
 *                           (Sparks.pas:101-161 + CheckMapCollision 420-551 +
 *                           Kill 553-559 + CheckOutOfBounds 561-572).
 *
 * DEFERRED (client / render only — intentionally OMITTED):
 *   - CreateSpark's camera-visibility culling (Sparks.pas:42-57 PointVisible /
 *     PointVisible2) and the `r_maxsparks` throttling thresholds
 *     (Sparks.pas:59-68): these depend on CameraFollowSprite / a render cvar and
 *     do not change simulated positions. We allocate against the world array cap.
 *   - TSpark.Render (Sparks.pas:163-418): pure drawing.
 *   - The screen-wobble on explosion (Sparks.pas:121-133): camera-only.
 *   - Sound effects in CheckMapCollision (PlaySound ...): client audio. The
 *     bounce PHYSICS and the spawned child sparks are ported; the PlaySound
 *     calls that accompany them are omitted.
 *   - The smoke/iskry spark-spawning side effects (Sparks.pas:136-155) are
 *     gated on `r_maxsparks` (render cvar) and Random; they spawn render-only
 *     child sparks and are DEFERRED with the render layer.
 *
 * Determinism: all physics arithmetic is wrapped in f() (sim scalar module);
 * vector math reuses ../math/vec2. The integration / damping config of
 * SparkParts mirrors Anims.pas:382-385 (TimeStep=1, Gravity=GRAV/1.4,
 * EDamping=0.998) and is applied by configureSparkParts.
 */
import { f } from '../scalar';
import { vec2, normalize, scale, sub } from '../math/vec2';
import { MAX_SPARKS, DEFAULT_GRAVITY, SPARK_SURFACECOEF } from '../constants';
import { isBackground, POLY_TYPE_BOUNCY } from '../map/polymap';
// ===========================================================================
// Style sets — PORT: Sparks.pas:103-107 (NONEULER_STYLE / COLLIDABLE_STYLE).
// ===========================================================================
// PORT: shared/mechanics/Sparks.pas:103 — NONEULER_STYLE set.
// These styles do NOT get a SparkParts Euler step (they are positioned by their
// render code / stay put): explosions, big smokes, spawn sparks, flames, etc.
const NONEULER_STYLE = new Set([
    12, 13, 14, 15, 17, 24, 25, 28, 29, 31, 36, 37, 50, 54, 56, 60,
]);
// PORT: shared/mechanics/Sparks.pas:105-107 — COLLIDABLE_STYLE set.
// These styles run CheckMapCollision and bounce off the map.
const COLLIDABLE_STYLE = new Set([
    2, 4, 5, 6, 7, 8, 9, 10, 11, 13, 16, 18, 19, 20, 21, 22, 23, 30, 32, 33, 34,
    40, 41, 42, 43, 48, 49, 51, 52, 57, 62, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73,
]);
// ===========================================================================
// SparkParts configuration — PORT: shared/Anims.pas:382-385.
//   SparkParts.TimeStep := 1;
//   SparkParts.Gravity  := GRAV / 1.4;
//   SparkParts.EDamping := 0.998;
// GRAV is the sv_gravity default 0.06 (Cvar.pas:985 / constants DEFAULT_GRAVITY).
// ===========================================================================
// PORT: shared/Anims.pas:384 — SparkParts.Gravity := GRAV / 1.4;
export const SPARK_GRAVITY = f(DEFAULT_GRAVITY / 1.4);
// PORT: shared/Anims.pas:385 — SparkParts.EDamping := 0.998;
export const SPARK_EDAMPING = f(0.998);
/**
 * Configure a ParticleSystem to act as the SparkParts system.
 * PORT: shared/Anims.pas:382-385.
 */
export function configureSparkParts(parts) {
    parts.timeStep = 1;
    parts.gravity = SPARK_GRAVITY;
    parts.eDamping = SPARK_EDAMPING;
}
// ===========================================================================
// 1. CreateSpark — PORT: shared/mechanics/Sparks.pas:35-98.
// ===========================================================================
/**
 * Allocate and activate a spark. Returns the 1-based spark index, or 0 if no
 * slot was free.
 *
 * Faithful to the allocation loop (Sparks.pas:59-80): find the first slot that
 * is inactive, has Style 0, and whose paired SparkParts particle is inactive.
 * The render-only camera culling and `r_maxsparks` throttling (Sparks.pas:42-68)
 * are DEFERRED (see file header); here we scan the full 1..MAX_SPARKS range.
 *
 * PORT: shared/mechanics/Sparks.pas:35-98
 */
export function createSpark(world, sPos, sVelocity, sStyle, sOwner, life) {
    const sparkParts = world.sparkParts;
    if (sparkParts === null) {
        return 0;
    }
    // PORT: Sparks.pas:40 — Result := 0;
    let result = 0;
    // PORT: Sparks.pas:59-80 — find a free slot.
    // (The `r_maxsparks` throttle guards at 61-72 and the `i = r_maxsparks.Value`
    //  random-recycle at 69-73 are render-cvar driven and DEFERRED. We scan slots
    //  1..MAX_SPARKS and take the first that is free.)
    for (let i = 1; i <= MAX_SPARKS; i++) {
        const spark = world.sparks[i];
        if (spark === undefined) {
            continue;
        }
        // PORT: Sparks.pas:74-79 — not Active and Style = 0 and not SparkParts.Active[i].
        if (!spark.active && spark.style === 0 && !sparkParts.active[i]) {
            result = i;
            break;
        }
    }
    if (result === 0) {
        return 0;
    }
    // PORT: Sparks.pas:82 — i is now the active sprite (i := Result).
    const i = result;
    const spark = world.sparks[i];
    if (spark === undefined) {
        return 0;
    }
    // PORT: Sparks.pas:85-90 — activate sprite.
    spark.active = true;
    spark.life = life;
    spark.style = sStyle;
    spark.num = i;
    spark.owner = sOwner;
    spark.collideCount = 0;
    // PORT: Sparks.pas:92 — M := 1; (mass)
    const m = 1;
    // PORT: Sparks.pas:95 — SparkParts.CreatePart(sPos, sVelocity, M, i);
    sparkParts.createPart(sPos, sVelocity, m, i);
    // PORT: Sparks.pas:97 — Result := i;
    return i;
}
// ===========================================================================
// Kill — PORT: shared/mechanics/Sparks.pas:553-559.
// ===========================================================================
/**
 * Deactivate a spark and its paired SparkParts particle.
 * PORT: shared/mechanics/Sparks.pas:553-559.
 */
export function killSpark(world, sparkIndex) {
    const spark = world.sparks[sparkIndex];
    if (spark === undefined) {
        return;
    }
    // PORT: Sparks.pas:555-556 — Active := False; Style := 0;
    spark.active = false;
    spark.style = 0;
    // PORT: Sparks.pas:557-558 — if Num > 0 then SparkParts.Active[Num] := False;
    if (spark.num > 0 && world.sparkParts !== null) {
        world.sparkParts.active[spark.num] = false;
    }
}
// ===========================================================================
// CheckOutOfBounds — PORT: shared/mechanics/Sparks.pas:561-572.
// ===========================================================================
/**
 * Kill the spark if its particle has left the map sector bounds.
 * PORT: shared/mechanics/Sparks.pas:561-572.
 */
function checkOutOfBounds(world, sparkIndex) {
    const map = world.map;
    const sparkParts = world.sparkParts;
    if (map === null || sparkParts === null) {
        return;
    }
    const spark = world.sparks[sparkIndex];
    if (spark === undefined) {
        return;
    }
    // PORT: Sparks.pas:566 — Bound := Map.SectorsNum * Map.SectorsDivision - 10;
    const bound = f(f(map.sectorsNum * map.sectorsDivision) - 10);
    const px = sparkParts.posX[spark.num];
    const py = sparkParts.posY[spark.num];
    // PORT: Sparks.pas:569-571 — if Abs(X) > Bound or Abs(Y) > Bound then Kill;
    if (Math.abs(px) > bound || Math.abs(py) > bound) {
        killSpark(world, sparkIndex);
    }
}
// ===========================================================================
// CheckMapCollision — PORT: shared/mechanics/Sparks.pas:420-551.
// ===========================================================================
/**
 * Bounce the spark off the map and run its per-style collision behaviour.
 * Returns true if a collision occurred.
 *
 * PORT: shared/mechanics/Sparks.pas:420-551
 *
 * NOTE: the PlaySound calls that accompany several styles are client audio and
 * are OMITTED (see file header); the velocity reflection, child-spark spawns,
 * and CollideCount->Kill logic are ported.
 */
function checkMapCollision(world, sparkIndex, x, y) {
    const map = world.map;
    const sparkParts = world.sparkParts;
    if (map === null || sparkParts === null) {
        return false;
    }
    const spark = world.sparks[sparkIndex];
    if (spark === undefined) {
        return false;
    }
    const num = spark.num;
    const owner = spark.owner;
    // PORT: Sparks.pas:431-432 — Pos.X := X - 8; Pos.Y := Y - 1;
    const pos = vec2(f(x - 8), f(y - 1));
    // PORT: Sparks.pas:435-439 — sector lookup + bounds.
    const { kx, ky } = map.sectorIndex(pos);
    if (!map.sectorInBounds(kx, ky)) {
        return false;
    }
    // PORT: Sparks.pas:446 — if (Owner < 1) or (Owner > 32) then Exit;
    // (TeamCollides reads Sprite[Owner].Player.Team; without a live owner sprite
    //  the spark cannot collide. We require a valid owner index.)
    if (owner < 1 || owner > 32) {
        return false;
    }
    // PORT: Sparks.pas:441-442 — iterate the sector's polygons (1-based list).
    const indices = map.sectorPolys(kx, ky);
    for (const w of indices) {
        const polyIndex = w - 1; // .PMS stores 1-based; polys[] is 0-based.
        const poly = map.polys[polyIndex];
        if (poly === undefined) {
            continue;
        }
        const polyType = poly.polyType;
        // PORT: Sparks.pas:448 — teamcol := TeamCollides(w, Sprite[Owner].Player.Team, False);
        // Full team filtering depends on the owner's team and is DEFERRED with the
        // player object; we keep the geometric / poly-type collidability checks
        // below which mirror the inner guard (Sparks.pas:450-456).
        // PORT: Sparks.pas:451 — skip BOUNCY when owner holds nothing.
        // (HoldedThing is read on the owner sprite; we approximate via the sprite's
        //  holdedThing field if the owner sprite is present.)
        const ownerSprite = world.sprites[owner];
        const holdedThing = ownerSprite !== undefined ? ownerSprite.holdedThing : 0;
        if (polyType === POLY_TYPE_BOUNCY && holdedThing === 0) {
            continue;
        }
        // PORT: Sparks.pas:452-456 — skip ONLY_BULLETS / ONLY_PLAYER / DOESNT /
        // BACKGROUND / BACKGROUND_TRANSITION. (isBackground covers both BACKGROUND
        // and BACKGROUND_TRANSITION — polymap.ts:105-110.)
        if (polyType === 1 || // POLY_TYPE_ONLY_BULLETS
            polyType === 2 || // POLY_TYPE_ONLY_PLAYER
            polyType === 3 || // POLY_TYPE_DOESNT
            isBackground(polyType)) {
            continue;
        }
        // PORT: Sparks.pas:457 — if Map.PointInPolyEdges(Pos.X, Pos.Y, w) then ...
        if (!map.pointInPolyEdges(pos.x, pos.y, polyIndex)) {
            continue;
        }
        // PORT: Sparks.pas:459 — Perp := Map.ClosestPerpendicular(w, Pos, D, b);
        const cp = map.closestPerpendicular(polyIndex, pos);
        // PORT: Sparks.pas:461-462 — Vec2Normalize(Perp, Perp); Vec2Scale(Perp, Perp, D);
        let perp = normalize(cp.perp);
        perp = scale(perp, cp.distance);
        // PORT: Sparks.pas:464 — Velocity[Num] := Velocity[Num] - Perp;
        const vel = vec2(sparkParts.velocityX[num], sparkParts.velocityY[num]);
        let newVel = sub(vel, perp);
        // PORT: Sparks.pas:466 — Vec2Scale(Velocity[Num], Velocity[Num], SPARK_SURFACECOEF);
        newVel = scale(newVel, SPARK_SURFACECOEF);
        sparkParts.velocityX[num] = newVel.x;
        sparkParts.velocityY[num] = newVel.y;
        // PORT: Sparks.pas:468-543 — per-style collision behaviour.
        runStyleCollision(world, spark, perp, pos);
        // PORT: Sparks.pas:545 — Inc(CollideCount);
        spark.collideCount = f(spark.collideCount + 1);
        // PORT: Sparks.pas:547-548 — Result := True; Exit;
        return true;
    }
    return false;
}
/**
 * Per-style behaviour inside CheckMapCollision's matched-polygon branch.
 * PORT: shared/mechanics/Sparks.pas:468-543.
 *
 * The Random()-driven child-spark spawns and the perp manipulation are ported;
 * the accompanying PlaySound calls are OMITTED (client audio). `Math.random`
 * mirrors Pascal `Random` for the gameplay-affecting branches (kill counts are
 * deterministic; only the cosmetic child-spark spawns are random).
 */
function runStyleCollision(world, spark, perp, pos) {
    const style = spark.style;
    switch (style) {
        // PORT: Sparks.pas:469-482 — styles 2, 62 (fire / jetfire).
        case 2:
        case 62: {
            // Perp := Perp * 2.5; Perp.X += -0.5 + Random(11)/10; Perp.Y := -Perp.Y;
            let p = scale(perp, 2.5);
            p = vec2(f(p.x + f(-0.5 + f(world.rng.nextInt(11) / 10))), f(-p.y));
            if (world.rng.nextInt(2) === 0) {
                if (world.rng.nextInt(2) === 0) {
                    createSpark(world, pos, p, 26, spark.owner, 35);
                }
                else {
                    createSpark(world, pos, p, 27, spark.owner, 35);
                }
                // PORT: Sparks.pas:480 — PlaySound(SFX_TS, ...) OMITTED (client audio).
            }
            break;
        }
        // PORT: Sparks.pas:483-494 — styles 33, 34 (cigar / pin debris).
        case 33:
        case 34: {
            let p = scale(perp, 2.5);
            p = vec2(f(p.x + f(-0.5 + f(world.rng.nextInt(11) / 10))), f(-p.y));
            if (world.rng.nextInt(7) === 0) {
                createSpark(world, pos, p, 26, spark.owner, 35);
            }
            else {
                createSpark(world, pos, p, 27, spark.owner, 35);
            }
            // PORT: Sparks.pas:492-493 — if CollideCount > 4 then Kill;
            if (spark.collideCount > 4) {
                killSparkRecord(world, spark);
            }
            break;
        }
        // PORT: Sparks.pas:495-502 — styles 4, 5 (blood).
        case 4:
        case 5: {
            if (style === 5) {
                // PORT: Sparks.pas:498 — CreateSpark(Pos[Num], Velocity[Num], 55, Owner, 30).
                const sparkParts = world.sparkParts;
                if (sparkParts !== null && spark.num > 0) {
                    const ppos = vec2(sparkParts.posX[spark.num], sparkParts.posY[spark.num]);
                    const pvel = vec2(sparkParts.velocityX[spark.num], sparkParts.velocityY[spark.num]);
                    createSpark(world, ppos, pvel, 55, spark.owner, 30);
                }
            }
            // PORT: Sparks.pas:500-501 — if CollideCount > 1 then Kill;
            if (spark.collideCount > 1) {
                killSparkRecord(world, spark);
            }
            break;
        }
        // PORT: Sparks.pas:503-510 — style 6 (helmet/headcap).
        case 6: {
            // PORT: Sparks.pas:505-506 — PlaySound(SFX_CLIPFALL ...) OMITTED.
            if (spark.collideCount > 4) {
                killSparkRecord(world, spark);
            }
            break;
        }
        // PORT: Sparks.pas:511-516 — shells (7,21,22,16,30,52,65..73).
        case 7:
        case 21:
        case 22:
        case 16:
        case 30:
        case 52:
        case 65:
        case 66:
        case 67:
        case 68:
        case 69:
        case 70:
        case 71:
        case 72:
        case 73: {
            // PORT: Sparks.pas:513-514 — PlaySound(SFX_SHELL ...) OMITTED.
            if (spark.collideCount > 4) {
                killSparkRecord(world, spark);
            }
            break;
        }
        // PORT: Sparks.pas:517-521 — style 51 (gauge shell).
        case 51: {
            // PORT: Sparks.pas:519 — PlaySound(SFX_GAUGESHELL ...) OMITTED.
            if (spark.collideCount > 4) {
                killSparkRecord(world, spark);
            }
            break;
        }
        // PORT: Sparks.pas:522-526 — styles 32, 48, 49 (cloth/clip scraps).
        case 32:
        case 48:
        case 49: {
            if (spark.collideCount > 2) {
                killSparkRecord(world, spark);
            }
            break;
        }
        // PORT: Sparks.pas:527-533 — clips (9,10,11,18,19,20,23).
        case 9:
        case 10:
        case 11:
        case 18:
        case 19:
        case 20:
        case 23: {
            // PORT: Sparks.pas:529-530 — PlaySound(SFX_CLIPFALL ...) OMITTED.
            if (spark.collideCount > 4) {
                killSparkRecord(world, spark);
            }
            break;
        }
        // PORT: Sparks.pas:534-542 — style 57 (yellow odprysk).
        case 57: {
            // Perp := Perp * 0.75; Perp.X += -0.5 + Random(11)/10; Perp.Y := -Perp.Y;
            let p = scale(perp, 0.75);
            p = vec2(f(p.x + f(-0.5 + f(world.rng.nextInt(11) / 10))), f(-p.y));
            // PORT: Sparks.pas:539-541 — both branches CreateSpark 58 (Random no-op).
            createSpark(world, pos, p, 58, spark.owner, 50);
            break;
        }
        default:
            break;
    }
}
/** Kill via a spark record reference. PORT: Sparks.pas:553-559 (TSpark.Kill). */
function killSparkRecord(world, spark) {
    spark.active = false;
    spark.style = 0;
    if (spark.num > 0 && world.sparkParts !== null) {
        world.sparkParts.active[spark.num] = false;
    }
}
// ===========================================================================
// 2. updateSpark — PORT: shared/mechanics/Sparks.pas:101-161 (TSpark.Update).
// ===========================================================================
/**
 * Advance one spark by one tick: integrate (unless NONEULER), out-of-bounds
 * kill, map-collision bounce for COLLIDABLE styles, then the Life countdown to
 * Kill.
 *
 * PORT: shared/mechanics/Sparks.pas:101-161
 *
 * DEFERRED: the screen-wobble (121-133), the smoke/iskry random child-spark
 * spawns (136-155) — all render-cvar / camera driven (see file header).
 */
export function updateSpark(world, sparkIndex) {
    const sparkParts = world.sparkParts;
    if (sparkParts === null) {
        return;
    }
    const spark = world.sparks[sparkIndex];
    if (spark === undefined || !spark.active) {
        return;
    }
    const num = spark.num;
    // PORT: Sparks.pas:111-112 — if not (Style in NONEULER_STYLE) then
    //   SparkParts.DoEulerTimeStepFor(Num);
    if (!NONEULER_STYLE.has(spark.style)) {
        sparkParts.doEulerTimeStepFor(num);
    }
    // PORT: Sparks.pas:114 — CheckOutOfBounds;
    checkOutOfBounds(world, sparkIndex);
    // CheckOutOfBounds may have killed the spark; mirror Pascal which still falls
    // through to the Life countdown (Kill only flips Active/Style — the countdown
    // below operates on the record either way and is idempotent post-Kill).
    // PORT: Sparks.pas:117-118 — if Style in COLLIDABLE_STYLE then
    //   CheckMapCollision(SparkParts.Pos[Num].X, SparkParts.Pos[Num].Y);
    if (COLLIDABLE_STYLE.has(spark.style)) {
        checkMapCollision(world, sparkIndex, sparkParts.posX[num], sparkParts.posY[num]);
    }
    // PORT: Sparks.pas:157-160 — LifePrev := Life; Life := Life - 1; if Life = 0 then Kill;
    spark.lifePrev = spark.life;
    spark.life = spark.life - 1;
    if (spark.life === 0) {
        killSpark(world, sparkIndex);
    }
}
// ===========================================================================
// Randomness now flows through World.rng (deterministic) — see ../rng.ts.
// Call sites use `world.rng.nextInt(n)` (PORT: Pascal `Random(N)`).
// ===========================================================================
//# sourceMappingURL=spark.js.map