/**
 * The unified per-tick simulation spine — one full 60 Hz tick over every
 * subsystem, in the exact order the engine runs them.
 *
 * PORT: server/ServerLoop.pas:270-311 (UpdateFrame, the core game-simulation
 * sub-steps) and docs/rewrite-reference/tick-pipeline.md §"UpdateFrame Sub-Steps".
 * The canonical ordering this mirrors:
 *
 *   1. (OldSpritePos ring shift)            — ServerLoop.pas:286-290  [lag comp;
 *                                              DEFERRED, see note below]
 *   2. SpriteParts.DoEulerTimeStepFor(j)    — ServerLoop.pas:292-295
 *   3. Sprite[j].Update                     — ServerLoop.pas:297-299
 *   4. Bullet[j].Update                     — ServerLoop.pas:302-304
 *   5. BulletParts.DoEulerTimeStep          — ServerLoop.pas:306
 *   6. Spark[j].Update                      — client UpdateFrame.pas:76-82
 *                                              (server has no sparks; we run them
 *                                              here so the shared spine drives the
 *                                              full client tick)
 *   7. Thing[j].Update                      — ServerLoop.pas:309-311
 *
 * Steps 2 and 3 are FUSED for sprites in this port: updateSpriteMovement
 * (sprite.ts) already calls DoEulerTimeStepFor internally before resolving
 * collision/friction (see applyGravityAndFriction). So the no-map path calls
 * updateSpriteMovement alone (NOT a second DoEulerTimeStepFor — that would
 * double-integrate). The map path runs DoEulerTimeStepFor explicitly and then
 * collideSpriteAgainstMap (which does the pushout but does NOT integrate),
 * matching the engine's integrate-then-collide split.
 *
 * Periodic ServerLoop maintenance (bonus spawns, flag cleanup, mode scoring,
 * timers, network sends) is NOT part of this entity-physics spine and is
 * DEFERRED to higher-level game-mode/network layers. This module advances the
 * deterministic physics core only.
 */
import type { World } from './world';
export interface StepOptions {
    /**
     * World Y of the flat-floor collision stand-in used when world.map is null.
     * PORT: M2 sprite path (updateSpriteMovement floorY argument). When a PolyMap
     * is loaded this is ignored and collideSpriteAgainstMap is used instead.
     * Defaults to Number.POSITIVE_INFINITY (no floor) so a free-fall trajectory is
     * never clipped unless a floor is explicitly requested.
     */
    floorY?: number;
    /**
     * Sprite collision radius for the PolyMap path (collideSpriteAgainstMap).
     * Only used when world.map is non-null. PORT: Sprites.pas skeleton radius
     * (full multi-point port pending; the M3 approximation collides the COM).
     */
    spriteRadius?: number;
    /**
     * Whether to resolve bullet guns from the REALISTIC stat table. PORT: the
     * server resolves Guns[...] from the active mode; bullets need their owning
     * gun's stat block for damage/degradation. Defaults to false (NORMAL table).
     */
    realistic?: boolean;
}
/**
 * Run ONE 60 Hz simulation tick over all active entities, in UpdateFrame order.
 *
 * PORT: server/ServerLoop.pas:270-311 (UpdateFrame entity sub-steps).
 */
export declare function stepWorld(world: World, opts?: StepOptions): void;
/**
 * Convenience: run `n` ticks back-to-back. Equivalent to calling stepWorld n
 * times with the same options.
 */
export declare function stepWorldN(world: World, n: number, opts?: StepOptions): void;
//# sourceMappingURL=step.d.ts.map