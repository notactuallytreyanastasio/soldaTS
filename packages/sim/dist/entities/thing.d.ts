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
import type { Vec2 } from '../math/vec2';
import type { World } from '../world';
import type { ParticleSystem } from '../physics/particles';
/**
 * Configure the shared Thing particle system. TimeStep := 1 mirrors the per-skeleton
 * default set in CreateThing (Things.pas:124 `Skeleton.TimeStep := 1`). Gravity /
 * VDamping are per-thing and are written onto the system per-thing in updateThing,
 * so they are left at 0 here. Things use Verlet integration (DoVerletTimeStep,
 * Things.pas:733), so EDamping is unused.
 *
 * PORT: shared/mechanics/Things.pas:124 + shared/Anims.pas:374-375 (BoxSkeleton).
 */
export declare function configureThingParts(parts: ParticleSystem): void;
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
export declare function createThing(world: World, sPos: Vec2, owner: number, sStyle: number, n: number): number;
/**
 * Deactivate a thing and free its skeleton particles.
 * PORT: shared/mechanics/Things.pas:1450-1463.
 */
export declare function killThing(world: World, thingIndex: number): void;
/**
 * Advance one Thing's physics / pickup / scoring for a tick. Track B's
 * stepWorld calls this for each active thing.
 *
 * PORT: shared/mechanics/Things.pas:665-1033.
 */
export declare function updateThing(world: World, thingIndex: number): void;
//# sourceMappingURL=thing.d.ts.map