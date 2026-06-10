/**
 * Golden-master trace format — the SHARED, JSON-serializable record of a
 * deterministic simulation run.
 *
 * Track A owns this type; Track E documents the identical schema. A trace is a
 * sequence of per-tick frames; each frame snapshots every active particle's
 * position and velocity, 1-indexed by the particle id `i` (mirroring Pascal's
 * `[1..NUM_PARTICLES]` indexing — see shared/Parts.pas:42-46).
 *
 * The format is intentionally minimal and free of class instances so a trace
 * can be `JSON.stringify`'d, checked into a fixtures dir, and compared
 * byte-for-byte across runs / platforms.
 */
import type { ParticleSystem } from '../physics/particles';
import { NUM_PARTICLES } from '../constants';

/** One active particle's kinematic state inside a frame. */
export interface GoldenParticle {
  /** 1-indexed particle id (matches Pascal `[1..NUM_PARTICLES]`). */
  i: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** All active particles at a single tick. */
export interface GoldenFrame {
  tick: number;
  particles: GoldenParticle[];
}

/** A full deterministic run: tick rate, scenario name, and the recorded frames. */
export interface GoldenTrace {
  tickRate: number;
  scenario: string;
  frames: GoldenFrame[];
}

/**
 * Snapshot the active particles of a `ParticleSystem` into a `GoldenFrame`.
 *
 * Iterates `[1..NUM_PARTICLES]` in ascending id order so the frame's particle
 * list is deterministic regardless of insertion order. Only `active[i]`
 * particles are recorded — matching the Pascal loops that skip inactive slots
 * (e.g. shared/Parts.pas:80-82).
 */
export function snapshotFrame(system: ParticleSystem, tick: number): GoldenFrame {
  const particles: GoldenParticle[] = [];
  for (let i = 1; i <= NUM_PARTICLES; i++) {
    if (system.active[i]) {
      particles.push({
        i,
        x: system.posX[i]!,
        y: system.posY[i]!,
        vx: system.velocityX[i]!,
        vy: system.velocityY[i]!,
      });
    }
  }
  return { tick, particles };
}
