/**
 * Bot brain — faithful-first TS port of `shared/AI.pas` (ControlBot /
 * SimpleDecision / GoToThing / CheckDistance).
 *
 * The bot produces a {@link Control} the *same shape a human produces*: it sets
 * the movement booleans (left/right/up/down/jetpack...) and the aim fields
 * (mouseAimX/mouseAimY) plus `fire`. The downstream movement path
 * (entities/sprite.ts `applyControl`) consumes that Control identically for a
 * bot and a human — this module never touches physics directly.
 *
 * PORT mapping of the Pascal world accessors used by AI.pas:
 *   SpriteParts.Pos[i]      -> world.spriteParts.posX[i] / posY[i]   (COM particle)
 *   SpriteParts.Velocity[i] -> world.spriteParts.velocityX[i] / velocityY[i]
 *   Sprite[i].Skeleton.Pos[12] (look/head point) -> COM position (see DEFERRED)
 *   Sprite[i].Control       -> world.sprites[i].control
 *   Sprite[i].Brain         -> the {@link BotState} brain passed in by the caller
 *
 * DEFERRED (intentionally not ported in this milestone; commented at each site):
 *   - Full ray-cast line-of-sight `Map.RayCast(LookPoint, StartPoint, D2, 651)`
 *     (AI.pas:562). PolyMap has no RayCast yet (Track concurrent); we approximate
 *     with a coarse segment sample against solid polys (`hasLineOfSight`).
 *   - The 12-point physics skeleton: AI.pas reads Skeleton.Pos[12] as the eye/
 *     muzzle. Our minimal Sprite has no skeleton, so we use the COM position.
 *   - Weapon model (Weapon.Speed, Weapon.AmmoCount, Weapon.Num, BARRETT/RUGER/
 *     MINIGUN/BOW special-casing), grenade/knife throwing (Control.ThrowNade /
 *     ThrowWeapon), weapon switching, reload, prone toggling, realistic-mode
 *     burst fire. A nominal `weaponSpeed` lives on BotState as a stand-in for
 *     `Weapon.Speed` in the aim lead computation (AI.pas:405-409).
 *   - Thing/flag seeking (GoToThing, the "see flag?" loop AI.pas:908-1003),
 *     grenade dodging (AI.pas:1010-1026), camping/PissedOff/Friend/team logic,
 *     bot chat, fall-damage jetpack save.
 *   - bots_difficulty cvar gates: folded into BotState.accuracy /
 *     BotState.reactionTicks instead of a global cvar.
 *
 * Determinism: every random draw goes through world.rng (never Math.random),
 * mirroring AI.pas `Random(n)` with `world.rng.nextInt(n)`.
 */
import { f } from '../scalar';
import { vec2 } from '../math/vec2';
import { isBackground, isOnlyBullets } from '../map/polymap';
// ===========================================================================
// Distance bands — PORT: shared/AI.pas:16-27
// ===========================================================================
export const DIST_AWAY = 731;
export const DIST_TOO_FAR = 730;
export const DIST_VERY_FAR = 500;
export const DIST_FAR = 350;
export const DIST_ROCK_THROW = 180;
export const DIST_CLOSE = 95;
export const DIST_VERY_CLOSE = 55;
export const DIST_TOO_CLOSE = 35;
// PORT: shared/AI.pas:26-27 — collide / prone-stop bands (unused until prone port).
export const DIST_COLLIDE = 20;
export const DIST_STOP_PRONE = 25;
/**
 * Quantizes the absolute one-axis distance into a band.
 * PORT: shared/AI.pas:41-69 — CheckDistance(PosA, PosB).
 */
export function checkDistance(posA, posB) {
    let result = DIST_AWAY;
    const dist = f(Math.abs(f(posA - posB)));
    if (dist <= DIST_TOO_CLOSE)
        result = DIST_TOO_CLOSE;
    else if (dist <= DIST_VERY_CLOSE)
        result = DIST_VERY_CLOSE;
    else if (dist <= DIST_CLOSE)
        result = DIST_CLOSE;
    else if (dist <= DIST_ROCK_THROW)
        result = DIST_ROCK_THROW;
    else if (dist <= DIST_FAR)
        result = DIST_FAR;
    else if (dist <= DIST_VERY_FAR)
        result = DIST_VERY_FAR;
    else if (dist <= DIST_TOO_FAR)
        result = DIST_TOO_FAR;
    return result;
}
/** Allocate a fresh brain. `accuracy`/`weaponSpeed` default to a mid bot. */
export function createBotState(overrides = {}) {
    return {
        targetNum: 0,
        currentWaypoint: 0,
        nextWaypoint: 0,
        oldWaypoint: 0,
        lastWaypoint: 0,
        waypointTime: 0,
        accuracy: 12,
        weaponSpeed: 18,
        camper: 0,
        jetBurstTicks: 0,
        ...overrides,
    };
}
// ===========================================================================
// Perception helpers
// ===========================================================================
/**
 * Resolve a waypoint id (as returned by nearestTo/stepToward) to its record.
 * The WaypointGraph keeps its id->slot map private, so we scan the 1-based
 * `waypoints` store for the matching active id. Returns undefined if absent.
 */
function waypointById(graph, id) {
    if (id <= 0)
        return undefined;
    for (let i = 1; i < graph.waypoints.length; i++) {
        const wp = graph.waypoints[i];
        if (wp !== undefined && wp.active && wp.id === id) {
            return wp;
        }
    }
    return undefined;
}
/** COM position of sprite `i` (PORT: SpriteParts.Pos[i]). */
function spritePos(world, i) {
    const parts = world.spriteParts;
    if (parts === null)
        return { x: 0, y: 0 };
    return { x: parts.posX[i] ?? 0, y: parts.posY[i] ?? 0 };
}
/** COM velocity of sprite `i` (PORT: SpriteParts.Velocity[i]). */
function spriteVel(world, i) {
    const parts = world.spriteParts;
    if (parts === null)
        return { x: 0, y: 0 };
    return { x: parts.velocityX[i] ?? 0, y: parts.velocityY[i] ?? 0 };
}
/**
 * Approximate line-of-sight between two world points.
 *
 * PORT (approximation): shared/AI.pas:562 `Map.RayCast(LookPoint, StartPoint,
 * D2, 651)`. PolyMap exposes no RayCast yet, so we sample the segment at a few
 * points and report blocked if any sample lands inside a *solid* polygon
 * (non-background, not bullets-only). This is a coarse stand-in; the faithful
 * ray-cast (which also returns the hit distance D2) is DEFERRED to the PolyMap
 * track. With no map (world.map === null) sight is always clear.
 */
export function hasLineOfSight(world, from, to) {
    const map = world.map;
    if (map === null) {
        return true;
    }
    // Solid = blocks players. Background and bullets-only polys don't occlude.
    const solid = (polyType) => !isBackground(polyType) && !isOnlyBullets(polyType);
    const samples = 16;
    for (let s = 1; s < samples; s++) {
        const t = s / samples;
        const px = f(from.x + f(f(to.x - from.x) * t));
        const py = f(from.y + f(f(to.y - from.y) * t));
        if (map.collidePoint(vec2(px, py), solid) !== null) {
            return false;
        }
    }
    return true;
}
/**
 * Pick the nearest *visible* active enemy.
 *
 * PORT: shared/AI.pas:544-604 — the "see?" loop. We keep the core structure
 * (iterate all sprites, skip self/inactive/dead/spectators, line-of-sight test,
 * keep the closest) and DEFER the team/friend/rambo-bow/dead-kill refinements
 * (AI.pas:549-601). Returns the chosen target sprite index, or 0 if none seen.
 */
export function findTarget(world, selfNum) {
    const self = world.sprites[selfNum];
    if (self === undefined) {
        return 0;
    }
    const lookPoint = spritePos(world, selfNum);
    // PORT: AI.pas:545-546 — D := 999999; track the closest seen enemy.
    let bestDist = 999999;
    let target = 0;
    for (let i = 1; i < world.sprites.length; i++) {
        if (i === selfNum)
            continue;
        const other = world.sprites[i];
        if (other === undefined || !other.active)
            continue;
        // PORT: AI.pas:552-554 — skip the dead (DeadKill refinement DEFERRED).
        if (other.deadMeat)
            continue;
        // PORT: AI.pas team refinement (previously deferred): teammates are not
        // targets when both sides carry a real team (0 = FFA, fights everyone).
        if (self.team > 0 && other.team === self.team)
            continue;
        // PORT: AI.pas:550 — invisible sprites aren't seen (alpha 255 = opaque).
        if (other.alpha !== 255 && other.holdedThing === 0)
            continue;
        const startPoint = spritePos(world, i);
        // PORT: AI.pas:562 — if NOT blocked by the map, the enemy is visible.
        if (!hasLineOfSight(world, lookPoint, startPoint))
            continue;
        // PORT: AI.pas:573-602 — keep the closest. Distance is squared-free here
        // (we only need an ordering); the Pascal D is the ray-cast hit distance.
        const dx = f(startPoint.x - lookPoint.x);
        const dy = f(startPoint.y - lookPoint.y);
        const d = f(f(dx * dx) + f(dy * dy));
        if (d < bestDist) {
            bestDist = d;
            target = i;
        }
    }
    return target;
}
// ===========================================================================
// Combat — PORT: shared/AI.pas:71-456 (SimpleDecision)
// ===========================================================================
/**
 * Sets movement + fire + aim for an in-sight target. Faithful port of the
 * movement-critical core of SimpleDecision (AI.pas:71-456): horizontal approach,
 * the X-distance band ladder (fire / crouch / advance / retreat), the Y-distance
 * jetpack rise, and the lead/drop aim. Reload, camper-prone, minigun/realistic
 * burst, grenade/knife, and the BARRETT/RUGER "impossible" branch are DEFERRED
 * (commented at their sites) since they need the weapon model.
 *
 * Assumes `brain.targetNum` is a valid, in-sight enemy.
 */
export function simpleDecision(world, selfNum, brain) {
    const self = world.sprites[selfNum];
    if (self === undefined)
        return;
    const control = self.control;
    const m = spritePos(world, selfNum); // PORT: m := SpriteParts.Pos[SNum]
    const t = spritePos(world, brain.targetNum); // PORT: t := Pos[TargetNum]
    // PORT: AI.pas:82-90 — face the target (GoThing branch DEFERRED: always run
    // the "not GoThing" path).
    control.right = false;
    control.left = false;
    if (t.x > m.x)
        control.right = true;
    if (t.x < m.x)
        control.left = true;
    // PORT: AI.pas:93 — X-distance band.
    const distX = checkDistance(m.x, t.x);
    if (distX === DIST_TOO_CLOSE) {
        // PORT: AI.pas:95-107 — back off, keep firing.
        control.right = false;
        control.left = false;
        if (t.x < m.x)
            control.right = true;
        if (t.x > m.x)
            control.left = true;
        control.fire = true;
    }
    else if (distX === DIST_VERY_CLOSE) {
        // PORT: AI.pas:109-132 — hold ground, fire (reload-retreat DEFERRED).
        control.right = false;
        control.left = false;
        control.fire = true;
    }
    else if (distX === DIST_CLOSE) {
        // PORT: AI.pas:134-159 — crouch + fire.
        control.right = false;
        control.left = false;
        control.down = true;
        control.fire = true;
    }
    else if (distX === DIST_ROCK_THROW) {
        // PORT: AI.pas:161-181 — crouch + fire (advance toward).
        control.down = true;
        control.fire = true;
    }
    else if (distX === DIST_FAR) {
        // PORT: AI.pas:183-195 — fire; camper crouch DEFERRED (camper>127).
        control.fire = true;
        if (brain.camper > 127) {
            control.up = false;
            control.down = true;
        }
    }
    else if (distX === DIST_VERY_FAR) {
        // PORT: AI.pas:197-217 — close the gap (Up), fire ~half the time.
        control.up = true;
        if (world.rng.nextInt(2) === 0) {
            control.fire = true;
        }
    }
    else if (distX === DIST_TOO_FAR) {
        // PORT: AI.pas:219-238 — occasional fire while approaching.
        if (world.rng.nextInt(4) === 0) {
            control.fire = true;
        }
    }
    // PORT: AI.pas:317-321 — Y-distance: rise with jetpack if target is above.
    // DESIGN OVERRIDE (node 124): the faithful gate (only jet when the target is
    // a full DIST_ROCK_THROW=180px overhead) is why bots fought on the floor —
    // jet use measured 1.7-3.8% of alive time. This game is aerial: chase ANY
    // height advantage, and roll multi-tick jet BURSTS during engagements so
    // close fights leave the ground entirely.
    if (m.y > t.y + 40) {
        control.jetpack = true;
    }
    if (brain.jetBurstTicks > 0) {
        brain.jetBurstTicks -= 1;
        control.jetpack = true;
    }
    else if (self.jetsCount > 250 && // keep a reserve — don't strand a dry tank mid-air
        distX <= DIST_FAR &&
        world.rng.nextInt(75) === 0 // a burst every ~1.25s of close combat
    ) {
        brain.jetBurstTicks = 25 + world.rng.nextInt(20); // 0.4-0.75 s of thrust
    }
    // PORT: AI.pas:361-368 — frozen/stat: lock movement, keep firing. DEFERRED
    // (Sprite.stat freeze state); kept as a faithful guard.
    if (self.stat > 0) {
        control.right = false;
        control.left = false;
        control.up = false;
        control.down = false;
        control.fire = true;
    }
    // ----- Aim: lead the target and compensate projectile drop -----
    // PORT: AI.pas:400-409.
    const tv = spriteVel(world, brain.targetNum);
    // PORT: AI.pas:400-401 — Vec2Scale(tv, Velocity[Target], 10); t := t + tv.
    const leadX = f(t.x + f(tv.x * 10));
    const leadY = f(t.y + f(tv.y * 10));
    control.mouseAimX = Math.round(leadX);
    // PORT: AI.pas:404-409 — drop term scales with distance / weapon speed, minus
    // an accuracy jitter (random spread). weaponSpeed stands in for Weapon.Speed.
    const accJitter = f(-brain.accuracy + world.rng.nextInt(brain.accuracy + 1));
    const speed = brain.weaponSpeed > 0 ? brain.weaponSpeed : 1;
    if (distX < DIST_FAR) {
        control.mouseAimY = Math.round(f(leadY - f(f(f(0.5 * distX) / speed)) + accJitter));
    }
    else {
        control.mouseAimY = Math.round(f(leadY - f(f(f(1.75 * distX) / speed)) + accJitter));
    }
}
// ===========================================================================
// Navigation — PORT: shared/AI.pas:651-863 (the "GO WITH WAYPOINTS" block)
// ===========================================================================
/**
 * Walk the waypoint graph toward the bot's goal when no enemy is in sight.
 *
 * PORT (scoped): shared/AI.pas:651-863. We keep the essential behaviour — find
 * the closest waypoint, pick a next waypoint along its connections, face it, and
 * apply movement toward it — using the SHARED WAYPOINT CONTRACT
 * (`graph.nearestTo` / `graph.stepToward`). The per-gamemode PathNum selection
 * (CTF/INF/HTF, AI.pas:676-730), the per-waypoint Left/Right/Up/Down/Jetpack
 * action bytes, StopAndCamp / WaitNSeconds actions, the stuck-detection and
 * weapon-management tails (AI.pas:817-861) are DEFERRED.
 *
 * Movement is derived from the geometric direction to the next waypoint so a bot
 * with a navigation target sets left/right (and up if the target is above),
 * exactly as a human walking that way would.
 */
export function navigateWaypoints(world, selfNum, brain, graph) {
    const self = world.sprites[selfNum];
    if (self === undefined)
        return;
    const control = self.control;
    const m = spritePos(world, selfNum);
    // PORT: AI.pas:662-666 — FindClosest waypoint to the bot.
    const closest = graph.nearestTo(m.x, m.y);
    brain.oldWaypoint = brain.currentWaypoint;
    if (closest > 0) {
        brain.currentWaypoint = closest;
    }
    if (brain.currentWaypoint <= 0) {
        return; // no usable waypoint graph
    }
    // PORT: AI.pas:742-756 — on entering a new waypoint, choose the next node.
    // We use the contract's stepToward (BFS/connection walk) toward the target's
    // nearest waypoint when we have a target, else step along the graph.
    let goalWaypoint = brain.currentWaypoint;
    if (brain.targetNum > 0) {
        const tp = spritePos(world, brain.targetNum);
        const tw = graph.nearestTo(tp.x, tp.y);
        if (tw > 0) {
            goalWaypoint = tw;
        }
    }
    const next = graph.stepToward(brain.currentWaypoint, goalWaypoint);
    if (next > 0) {
        brain.nextWaypoint = next;
    }
    else if (brain.nextWaypoint <= 0) {
        brain.nextWaypoint = brain.currentWaypoint;
    }
    // PORT: AI.pas:758-763 — apply waypoint movement. The per-waypoint action
    // bytes are DEFERRED; we synthesize movement from the geometric direction to
    // the next waypoint so the bot walks toward it like a human.
    // NOTE: nearestTo/stepToward return waypoint *ids* (not array slots); resolve
    // the id to its record via a scan (the contract exposes no id->slot resolver).
    const wp = waypointById(graph, brain.nextWaypoint);
    control.left = false;
    control.right = false;
    control.up = false;
    control.down = false;
    control.jetpack = false;
    if (wp !== undefined && wp.active) {
        if (wp.x > m.x)
            control.right = true;
        if (wp.x < m.x)
            control.left = true;
        // Screen-space y is down-positive: a smaller y is higher. Rise toward it.
        if (wp.y < m.y)
            control.up = true;
        // PORT: AI.pas:752-754 — face the next waypoint with the aim.
        control.mouseAimX = Math.round(wp.x);
        control.mouseAimY = Math.round(wp.y);
    }
    // PORT: AI.pas:811-815 — stuck timer bookkeeping.
    if (brain.lastWaypoint === brain.currentWaypoint) {
        brain.waypointTime += 1;
    }
    else {
        brain.waypointTime = 0;
    }
    brain.lastWaypoint = brain.currentWaypoint;
}
// ===========================================================================
// Entry point — PORT: shared/AI.pas:518-1097 (ControlBot)
// ===========================================================================
/**
 * One AI tick for a single bot. Reads the world, updates the brain, and writes
 * the sprite's Control — the same Control a human would produce, so the shared
 * sprite movement path (applyControl) drives the bot identically.
 *
 * PORT: shared/AI.pas:518-1097 (ControlBot). The high-level flow is preserved:
 *   1. clear controls (FreeControls), AI.pas:532
 *   2. perception: pick the nearest visible enemy, AI.pas:544-604
 *   3. if an enemy is seen -> SimpleDecision (combat), AI.pas:865-901
 *      else -> navigate waypoints, AI.pas:651-863
 *
 * DEFERRED (commented in the helpers above): flag/thing seeking, grenade dodge,
 * camp/pissedoff/team logic, chat, fall-save, weapon management, full RayCast LOS.
 */
export function updateBot(world, selfNum, brain, graph) {
    const self = world.sprites[selfNum];
    // PORT: AI.pas:526-527 — only live, non-dummy bot sprites think.
    if (self === undefined || !self.active || self.deadMeat || self.dummy) {
        return;
    }
    const control = self.control;
    // PORT: AI.pas:532 — FreeControls: clear all inputs before deciding.
    freeControls(control);
    // PORT: AI.pas:544-604 — perception.
    brain.targetNum = findTarget(world, selfNum);
    if (brain.targetNum > 0) {
        // PORT: AI.pas:865-901 — sees a target -> combat.
        // AI.pas:867-869 drops a "None"-action waypoint when engaging.
        brain.waypointTime = 0;
        simpleDecision(world, selfNum, brain);
    }
    else {
        // PORT: AI.pas:651-863 — no target -> navigate.
        navigateWaypoints(world, selfNum, brain, graph);
    }
}
/**
 * Reset every control field to its neutral value.
 * PORT: shared/mechanics/Sprites.pas — TSprite.FreeControls (AI.pas:532 calls it).
 */
export function freeControls(control) {
    control.left = false;
    control.right = false;
    control.up = false;
    control.down = false;
    control.fire = false;
    control.jetpack = false;
    control.throwNade = false;
    control.changeWeapon = false;
    control.throwWeapon = false;
    control.reload = false;
    control.prone = false;
    control.flagThrow = false;
    // Aim fields are intentionally left as-is (the engine keeps the last aim until
    // a new decision overwrites MouseAimX/Y); SimpleDecision/navigate set them.
}
//# sourceMappingURL=bot.js.map