// Match telemetry — records a bot match as structured JSON so an agent (or a
// future real backend) can do math on the gameplay: flight patterns, hit
// rates, death clustering, engagement distances, pacing.
//
// GLUE module (no Pascal provenance). The recorder observes, never steers:
// it hangs off three notification hooks (world.onDamage, Game.onShot, and the
// client's onKill consumer calling recordKill) plus a periodic position
// sample, and serializes everything under a VERSIONED schema id. Consumers
// pull it from `window.__match.dump()` in spectate mode (CDP-friendly) or
// download it with the T key; `soldat-ts/tools/analyze-match.mjs` turns a
// dump into a readable report. Keep the schema stable — bump SCHEMA when the
// shape changes, never mutate it silently.

import type { Game } from './game';
import { subjectName } from './director';

export const SCHEMA = 'soldat-match-telemetry/1';

/** How often positions are sampled (sim ticks). 30 = 2 Hz at the 60 Hz sim. */
export const SAMPLE_EVERY_TICKS = 30;

/** One sprite's state at a sample instant. */
export interface SpriteSample {
  i: number; // sprite index
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  jetFuel: number;
  jetting: boolean; // jet control held this tick
  firing: boolean;
  air: boolean; // not on the ground
}

export interface Sample {
  tick: number;
  sprites: SpriteSample[]; // live sprites only
}

export interface KillEvent {
  tick: number;
  killer: number; // 0 = unattributed
  victim: number;
  killerPos: { x: number; y: number } | null;
  victimPos: { x: number; y: number };
  /** Killer→victim distance at the kill tick (null when unattributed). */
  dist: number | null;
}

/** The full match dump. Everything an analyst needs, nothing renderer-bound. */
export interface MatchDump {
  schema: typeof SCHEMA;
  meta: {
    map: string;
    botCount: number;
    spectate: boolean;
    /** Bot-AI engine id(s) driving this match ('+'-joined when mixed). */
    engine: string;
    /** Per-bot engine assignment (mixed matches split the roster). */
    botEngines: Record<number, string>;
    tickHz: 60;
    sampleEveryTicks: number;
    names: Record<number, string>;
  };
  durationTicks: number;
  shotsBy: Record<number, number>;
  hitsBy: Record<number, number>; // damaging bullets landed (attributed)
  damageBy: Record<number, number>; // total damage dealt
  kills: KillEvent[];
  samples: Sample[];
  derived: DerivedStats;
}

// ---------------------------------------------------------------------------
// Derived statistics (pure — unit tested)
// ---------------------------------------------------------------------------

export interface SpriteDerived {
  name: string;
  shots: number;
  hits: number;
  /** hits / shots (0 when no shots). The "percentage hit rate". */
  hitRate: number;
  damage: number;
  kills: number;
  deaths: number;
  /** Fraction of sampled live time with the jet burning. */
  jetUsePct: number;
  /** Fraction of sampled live time airborne — "how they are flying about". */
  airTimePct: number;
  /** Mean |velocity| across samples (px/tick). */
  avgSpeed: number;
  /** Vertical reach: stddev of sampled y (px) — flat fights score low. */
  ySpread: number;
}

export interface DeathCluster {
  /** Cluster centroid (px). */
  x: number;
  y: number;
  count: number;
}

export interface DerivedStats {
  perSprite: Record<number, SpriteDerived>;
  killsPerMin: number;
  /** Killer→victim distance distribution over attributed kills (px). */
  killDist: { median: number; p25: number; p75: number } | null;
  /** Death hot-spots: grid-binned victim positions, biggest first. */
  deathClusters: DeathCluster[];
}

/** Inclusive linear-interpolated percentile of an unsorted list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return (sorted[lo] ?? 0) * (1 - frac) + (sorted[hi] ?? 0) * frac;
}

/**
 * Grid-bin death positions into clusters ("clusterings of deaths"). Cells of
 * `cellSize` px; each non-empty cell becomes a cluster at the centroid of its
 * members. Sorted by count, biggest first.
 */
export function clusterDeaths(
  points: readonly { x: number; y: number }[],
  cellSize = 160,
): DeathCluster[] {
  const cells = new Map<string, { sx: number; sy: number; n: number }>();
  for (const p of points) {
    const key = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)}`;
    const cell = cells.get(key) ?? { sx: 0, sy: 0, n: 0 };
    cell.sx += p.x;
    cell.sy += p.y;
    cell.n += 1;
    cells.set(key, cell);
  }
  return [...cells.values()]
    .map((c) => ({ x: c.sx / c.n, y: c.sy / c.n, count: c.n }))
    .sort((a, b) => b.count - a.count);
}

/** Compute the derived block from the raw recordings (pure). */
export function deriveStats(
  raw: Pick<
    MatchDump,
    'shotsBy' | 'hitsBy' | 'damageBy' | 'kills' | 'samples' | 'durationTicks'
  >,
  names: Record<number, string>,
): DerivedStats {
  const perSprite: Record<number, SpriteDerived> = {};
  const indices = new Set<number>();
  for (const k of Object.keys(raw.shotsBy)) indices.add(Number(k));
  for (const s of raw.samples) for (const sp of s.sprites) indices.add(sp.i);
  for (const k of raw.kills) {
    if (k.killer > 0) indices.add(k.killer);
    indices.add(k.victim);
  }

  for (const i of indices) {
    let sampled = 0;
    let jetting = 0;
    let air = 0;
    let speedSum = 0;
    let ySum = 0;
    let ySqSum = 0;
    for (const s of raw.samples) {
      const sp = s.sprites.find((x) => x.i === i);
      if (sp === undefined) continue;
      sampled += 1;
      if (sp.jetting) jetting += 1;
      if (sp.air) air += 1;
      speedSum += Math.hypot(sp.vx, sp.vy);
      ySum += sp.y;
      ySqSum += sp.y * sp.y;
    }
    const shots = raw.shotsBy[i] ?? 0;
    const hits = raw.hitsBy[i] ?? 0;
    const meanY = sampled > 0 ? ySum / sampled : 0;
    perSprite[i] = {
      name: names[i] ?? `#${i}`,
      shots,
      hits,
      hitRate: shots > 0 ? hits / shots : 0,
      damage: raw.damageBy[i] ?? 0,
      kills: raw.kills.filter((k) => k.killer === i && k.victim !== i).length,
      deaths: raw.kills.filter((k) => k.victim === i).length,
      jetUsePct: sampled > 0 ? jetting / sampled : 0,
      airTimePct: sampled > 0 ? air / sampled : 0,
      avgSpeed: sampled > 0 ? speedSum / sampled : 0,
      ySpread: sampled > 0 ? Math.sqrt(Math.max(0, ySqSum / sampled - meanY * meanY)) : 0,
    };
  }

  const dists = raw.kills
    .map((k) => k.dist)
    .filter((d): d is number => d !== null);
  const minutes = raw.durationTicks / 60 / 60;
  return {
    perSprite,
    killsPerMin: minutes > 0 ? raw.kills.length / minutes : 0,
    killDist:
      dists.length > 0
        ? {
            median: percentile(dists, 0.5),
            p25: percentile(dists, 0.25),
            p75: percentile(dists, 0.75),
          }
        : null,
    deathClusters: clusterDeaths(raw.kills.map((k) => k.victimPos)),
  };
}

// ---------------------------------------------------------------------------
// Recorder (thin stateful shell over the pure derivations)
// ---------------------------------------------------------------------------

export class MatchRecorder {
  private readonly game: Game;
  private readonly meta: MatchDump['meta'];
  private readonly shotsBy: Record<number, number> = {};
  private readonly hitsBy: Record<number, number> = {};
  private readonly damageBy: Record<number, number> = {};
  private readonly kills: KillEvent[] = [];
  private readonly samples: Sample[] = [];
  private nextSampleTick = 0;
  private readonly startTick: number;

  /**
   * Wires itself onto world.onDamage and game.onShot (sole consumers today).
   * Kills arrive via {@link recordKill} from the client's onKill handler so
   * the recorder composes with the HUD kill board instead of stealing the
   * single Game.onKill slot.
   */
  constructor(game: Game, map: string, botCount: number, spectate: boolean) {
    this.game = game;
    this.startTick = game.world.mainTickCounter;
    const names: Record<number, string> = {};
    names[game.playerIndex] = 'You';
    for (const i of game.botIndices()) names[i] = subjectName(i, game.playerIndex);
    this.meta = {
      map,
      botCount,
      spectate,
      engine: game.aiEngineId,
      botEngines: {},
      tickHz: 60,
      sampleEveryTicks: SAMPLE_EVERY_TICKS,
      names,
    };

    game.onShot = (shooter): void => {
      this.shotsBy[shooter] = (this.shotsBy[shooter] ?? 0) + 1;
    };
    game.world.onDamage = (victim, attacker, amount): void => {
      if (attacker > 0 && attacker !== victim) {
        this.hitsBy[attacker] = (this.hitsBy[attacker] ?? 0) + 1;
        this.damageBy[attacker] = (this.damageBy[attacker] ?? 0) + amount;
      }
    };
  }

  /** Record a death (call from the client's Game.onKill consumer). */
  recordKill(killer: number, victim: number): void {
    const parts = this.game.world.spriteParts;
    const pos = (i: number): { x: number; y: number } => ({
      x: Math.round(parts?.posX[i] ?? 0),
      y: Math.round(parts?.posY[i] ?? 0),
    });
    const attributed = killer > 0 && killer !== victim;
    const victimPos = pos(victim);
    const killerPos = attributed ? pos(killer) : null;
    this.kills.push({
      tick: this.game.world.mainTickCounter,
      killer,
      victim,
      killerPos,
      victimPos,
      dist:
        killerPos !== null
          ? Math.round(Math.hypot(killerPos.x - victimPos.x, killerPos.y - victimPos.y))
          : null,
    });
  }

  /** Call once per render frame; samples when the sim clock crosses the next slot. */
  maybeSample(): void {
    const tick = this.game.world.mainTickCounter;
    if (tick < this.nextSampleTick) return;
    this.nextSampleTick = tick + SAMPLE_EVERY_TICKS;
    const parts = this.game.world.spriteParts;
    if (parts === null) return;
    const sprites: SpriteSample[] = [];
    for (const s of this.game.world.sprites) {
      if (!s.active || s.deadMeat) continue;
      sprites.push({
        i: s.num,
        x: Math.round(parts.posX[s.num] ?? 0),
        y: Math.round(parts.posY[s.num] ?? 0),
        vx: Number((parts.velocityX[s.num] ?? 0).toFixed(2)),
        vy: Number((parts.velocityY[s.num] ?? 0).toFixed(2)),
        hp: s.health,
        jetFuel: s.jetsCount,
        jetting: s.control.jetpack,
        firing: s.control.fire,
        air: !s.onGround,
      });
    }
    this.samples.push({ tick, sprites });
  }

  /** Serialize the full match (recompute derived stats fresh). */
  dump(): MatchDump {
    const raw = {
      shotsBy: this.shotsBy,
      hitsBy: this.hitsBy,
      damageBy: this.damageBy,
      kills: this.kills,
      samples: this.samples,
      durationTicks: this.game.world.mainTickCounter - this.startTick,
    };
    return {
      schema: SCHEMA,
      // engine fields re-read at dump time: the E-key hot-swap changes them.
      meta: {
        ...this.meta,
        engine: this.game.aiEngineId,
        botEngines: Object.fromEntries(
          this.game.botIndices().map((i) => [i, this.game.engineOf(i)]),
        ),
      },
      ...raw,
      derived: deriveStats(raw, this.meta.names),
    };
  }
}
