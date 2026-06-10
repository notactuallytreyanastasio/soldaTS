// The client package's HEADLESS surface (goal node 170) — every module
// re-exported here is DOM- and pixi-free (the node-env unit tests are the
// proof: Game/telemetry/arena/director/tournament all construct and run under
// vitest's node environment). @soldat/arena consumes the game exclusively
// through this barrel, so the boundary between "runs anywhere" and "needs a
// browser" stays a single, auditable file.
export {
  Game,
  DEFAULT_TUNING,
  decideRoundWinner,
  applyAimAssist,
  type GameOptions,
  type GameTuning,
  type RoundResult,
} from './app/game';
export {
  MatchRecorder,
  SCHEMA as TELEMETRY_SCHEMA,
  deriveStats,
  type MatchDump,
  type KillEvent,
} from './app/telemetry';
export { buildArena, ARENA_SPAWNS, generateArena } from './app/arena';
export { subjectName } from './app/director';
export { VARIANTS, resolveVariant, type Variant } from './app/tournament';
// Registers classic/pilot/reaper on import (side effect) and re-exports the
// engine registry + per-brain default configs.
export * from './ai';
