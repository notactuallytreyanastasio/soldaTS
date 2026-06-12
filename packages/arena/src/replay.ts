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

import {
  nearestThreatBullet,
  type Game,
  type RelativeBullet,
} from '@soldat/client/headless';

export const REPLAY_SCHEMA = 'soldat-arena-replay/2';

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
  /** v2: held weapon label ('AK74' | 'SPAS12' | 'BARRETT' | 'ROCKET' |
   *  'RICOCHET' | 'CHAINSAW') — exact, no magazine-size sleuthing. */
  weapon: string;
  /** v2: own spray bloom (radians, 0..0.16), 4 decimals — the heat the
   *  written brains' tap cadence manages, finally visible to students. */
  heat: number;
  /** v2: nearest-incoming-bullet-threat present flag. The winner of the SAME
   *  closest-approach scan the runtime dodge organs run (nearestThreatBullet,
   *  neuralFeaturesV3.ts) over live enemy bullets at the post-think seam.
   *  When true, btx/bty/btvx/btvy carry the bullet's kinematics RELATIVE to
   *  this bot (px and px/tick, 2 decimals); when false they are absent —
   *  rows stay compact, like the kill event's optional weapon tag. */
  btt: boolean;
  btx?: number;
  bty?: number;
  btvx?: number;
  btvy?: number;
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
      /** Killer's weapon label ('AK74' | 'SPAS12'); present only in
       *  wildcard runs so default event streams keep their exact shape. */
      weapon?: string;
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
  const px = parts.posX[botIndex] ?? 0;
  const py = parts.posY[botIndex] ?? 0;
  // v2 threat scan — the EXACT bullet set every brain saw this tick (rows
  // sample post-think, pre-firing: no bullet has spawned or moved since the
  // brains ran). Same filters as the runtime engines (skip own bullets and,
  // in team games, teammates'), same winner selection (nearestThreatBullet).
  const world = game.world;
  const bp = world.bulletParts;
  const rel: RelativeBullet[] = [];
  if (bp !== null) {
    for (let i = 1; i < world.bullets.length; i++) {
      const b = world.bullets[i];
      if (b === undefined || !b.active) continue;
      if (b.owner === botIndex) continue;
      const owner = world.sprites[b.owner];
      if (owner !== undefined && s.team > 0 && owner.team === s.team) continue;
      rel.push({
        rx: (bp.posX[b.num] ?? 0) - px,
        ry: (bp.posY[b.num] ?? 0) - py,
        vx: bp.velocityX[b.num] ?? 0,
        vy: bp.velocityY[b.num] ?? 0,
      });
    }
  }
  const bt = nearestThreatBullet(rel);
  return {
    tick,
    bot: botIndex,
    team: game.teamOf(botIndex),
    engine: game.engineOf(botIndex),
    x: Number(px.toFixed(2)),
    y: Number(py.toFixed(2)),
    vx: Number((parts.velocityX[botIndex] ?? 0).toFixed(2)),
    vy: Number((parts.velocityY[botIndex] ?? 0).toFixed(2)),
    fuel: s.jetsCount,
    hp: Number(s.health.toFixed(1)),
    ammo: game.ammoOf(botIndex),
    reloading: game.reloadingOf(botIndex),
    onGround: s.onGround,
    weapon: game.weaponNameOf(botIndex),
    heat: Number(game.sprayHeatOf(botIndex).toFixed(4)),
    btt: bt !== null,
    ...(bt !== null
      ? {
          btx: Number(bt.rx.toFixed(2)),
          bty: Number(bt.ry.toFixed(2)),
          btvx: Number(bt.vx.toFixed(2)),
          btvy: Number(bt.vy.toFixed(2)),
        }
      : {}),
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
