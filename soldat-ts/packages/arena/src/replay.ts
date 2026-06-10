// Replay/training log types + builders (goal node 170).
//
// One JSONL row per sim tick per LIVE bot: the observation the bot's brain
// acted on this tick plus the action it chose. Rows are sampled via
// Game.onBrainsTicked — after every brain wrote its control, BEFORE
// firing/physics mutate anything — so `{row minus control}` is exactly what
// the brain saw and `control` is exactly what it decided. This is the
// observation→action dataset a model trains on.
//
// DETERMINISM CONTRACT: same MatchConfig ⇒ byte-identical JSONL. Builders
// construct objects in the exact key order of the interfaces below
// (JSON.stringify preserves insertion order) and round floats with toFixed —
// never reorder keys or change rounding without bumping REPLAY_SCHEMA.

import type { Game } from '@soldat/client/headless';

export const REPLAY_SCHEMA = 'soldat-arena-replay/1';

export interface ReplayControl {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  fire: boolean;
  jetpack: boolean;
  reload: boolean;
  /** Aim as a RELATIVE offset from the bot (px, y down) — what brains write. */
  aimX: number;
  aimY: number;
}

/** One JSONL row: the observation a live bot's brain acted on this tick plus
 *  the action it chose. Sampled via Game.onBrainsTicked (post-think, pre-physics). */
export interface ReplayRow {
  tick: number; // sim tick (60 Hz, world.mainTickCounter)
  bot: number; // sprite index (stable across respawns)
  team: number; // 1 red, 2 blue
  engine: string; // engine id driving this bot
  x: number; // px, y down — rounded to 2 decimals
  y: number;
  vx: number; // px/tick — rounded to 2 decimals
  vy: number;
  fuel: number; // jet ticks remaining (sprite.jetsCount)
  hp: number; // health, 1 decimal (150 = full)
  ammo: number; // rounds left in magazine
  reloading: boolean;
  onGround: boolean;
  control: ReplayControl;
}

export type ArenaEvent =
  | { tick: number; type: 'shot'; bot: number }
  | { tick: number; type: 'hit'; attacker: number; victim: number; damage: number } // damage 1 decimal
  | {
      tick: number;
      type: 'kill';
      killer: number; // 0 = unattributed
      victim: number;
      killerPos: { x: number; y: number } | null;
      victimPos: { x: number; y: number };
      dist: number | null;
    };

/**
 * Build the replay row for `botIndex` at `tick`; null when the sprite is
 * missing, inactive, or dead (dead bots emit no rows — a tick gap for a bot
 * means it was dead/respawning).
 */
export function buildReplayRow(game: Game, botIndex: number, tick: number): ReplayRow | null {
  const s = game.world.sprites[botIndex];
  const parts = game.world.spriteParts;
  if (s === undefined || parts === null || !s.active || s.deadMeat) return null;
  const c = s.control;
  return {
    tick,
    bot: botIndex,
    team: game.teamOf(botIndex),
    engine: game.engineOf(botIndex),
    x: Number((parts.posX[botIndex] ?? 0).toFixed(2)),
    y: Number((parts.posY[botIndex] ?? 0).toFixed(2)),
    vx: Number((parts.velocityX[botIndex] ?? 0).toFixed(2)),
    vy: Number((parts.velocityY[botIndex] ?? 0).toFixed(2)),
    fuel: s.jetsCount,
    hp: Number(s.health.toFixed(1)),
    ammo: game.ammoOf(botIndex),
    reloading: game.reloadingOf(botIndex),
    onGround: s.onGround,
    control: {
      left: c.left,
      right: c.right,
      up: c.up,
      down: c.down,
      fire: c.fire,
      jetpack: c.jetpack,
      reload: c.reload,
      aimX: c.mouseAimX,
      aimY: c.mouseAimY,
    },
  };
}

/** Serialize rows as JSONL: one JSON object per line + trailing newline ('' for none). */
export function rowsToJsonl(rows: readonly ReplayRow[]): string {
  if (rows.length === 0) return '';
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** Serialize the event stream as JSONL (same contract as rowsToJsonl). */
export function eventsToJsonl(events: readonly ArenaEvent[]): string {
  if (events.length === 0) return '';
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}
