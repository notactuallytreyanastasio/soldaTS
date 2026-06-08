// @soldat/sim — the deterministic OpenSoldat simulation core.
// Platform-pure: no DOM, no Node APIs. Runs identically in browser, worker,
// and server. See ../../../docs/PORT-PLAN.md.
export * from './scalar';
export * from './rng';
export * from './constants';
export * from './math/vec2';
export * from './math/calc';
export * from './entities/types';
export * from './entities/sprite';
export * from './map/collision';
export * from './map/polymap';
export * from './map/buildPolyMap';
export * from './world';
export * from './physics/particles';
export * from './weapons/guns';
export * from './entities/bullet';
export * from './entities/spark';
export * from './combat/damage';
// Golden-master harness (determinism validation; see tools/golden-master/).
export * from './golden/trace';
export * from './golden/runner';
export * from './golden/compare';
export * from './golden/scenarios';
