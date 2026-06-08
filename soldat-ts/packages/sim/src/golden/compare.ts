/**
 * Golden-master trace comparison.
 *
 * `compareTraces` walks two traces frame-by-frame, particle-by-particle, and
 * reports whether every per-particle x/y/vx/vy stays within `epsilon`. It is
 * "windowed" in the sense that it reports the FIRST tick whose worst delta
 * exceeds `epsilon` (the divergence point), while still scanning the remaining
 * frames to compute the overall `maxDelta`.
 *
 * Pure and allocation-light; no side effects.
 */
import type { GoldenTrace, GoldenFrame, GoldenParticle } from './trace';

export interface CompareResult {
  /** True iff no per-particle field ever exceeded `epsilon`. */
  match: boolean;
  /** First tick whose max delta exceeded `epsilon`, or null if none. */
  firstDivergenceTick: number | null;
  /** Largest absolute per-field delta seen across all compared frames. */
  maxDelta: number;
}

/** Index a frame's particles by their 1-based id for O(1) lookup. */
function byId(frame: GoldenFrame): Map<number, GoldenParticle> {
  const m = new Map<number, GoldenParticle>();
  for (const p of frame.particles) {
    m.set(p.i, p);
  }
  return m;
}

/** Worst absolute per-field delta between two particles. */
function particleDelta(a: GoldenParticle, b: GoldenParticle): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.vx - b.vx),
    Math.abs(a.vy - b.vy),
  );
}

/**
 * Compare two traces within `epsilon`.
 *
 * A structural mismatch (differing frame count, differing tick numbers, or a
 * particle present in one frame but absent in the other) is treated as an
 * infinite divergence at that tick: `match` is false, `maxDelta` is Infinity,
 * and `firstDivergenceTick` is set to that tick.
 */
export function compareTraces(
  a: GoldenTrace,
  b: GoldenTrace,
  epsilon: number,
): CompareResult {
  let maxDelta = 0;
  let firstDivergenceTick: number | null = null;

  const noteDivergence = (tick: number, delta: number): void => {
    if (firstDivergenceTick === null) {
      firstDivergenceTick = tick;
    }
    if (delta > maxDelta) {
      maxDelta = delta;
    }
  };

  // Structural: frame counts must match.
  const frameCount = Math.min(a.frames.length, b.frames.length);
  if (a.frames.length !== b.frames.length) {
    const tick =
      a.frames[frameCount]?.tick ?? b.frames[frameCount]?.tick ?? frameCount;
    noteDivergence(tick, Number.POSITIVE_INFINITY);
  }

  for (let fi = 0; fi < frameCount; fi++) {
    const fa = a.frames[fi]!;
    const fb = b.frames[fi]!;
    const tick = fa.tick;

    if (fa.tick !== fb.tick) {
      noteDivergence(tick, Number.POSITIVE_INFINITY);
      continue;
    }

    const mapB = byId(fb);
    let frameWorst = 0;
    let frameDiverged = false;

    // a -> b: matched + missing-in-b.
    for (const pa of fa.particles) {
      const pb = mapB.get(pa.i);
      if (pb === undefined) {
        frameDiverged = true;
        frameWorst = Number.POSITIVE_INFINITY;
        continue;
      }
      const d = particleDelta(pa, pb);
      if (d > frameWorst) {
        frameWorst = d;
      }
      if (d > epsilon) {
        frameDiverged = true;
      }
    }

    // present-in-b but missing-in-a.
    if (fa.particles.length !== fb.particles.length) {
      const mapA = byId(fa);
      for (const pb of fb.particles) {
        if (!mapA.has(pb.i)) {
          frameDiverged = true;
          frameWorst = Number.POSITIVE_INFINITY;
        }
      }
    }

    if (frameWorst > maxDelta) {
      maxDelta = frameWorst;
    }
    if (frameDiverged && firstDivergenceTick === null) {
      firstDivergenceTick = tick;
    }
  }

  return {
    match: firstDivergenceTick === null,
    firstDivergenceTick,
    maxDelta,
  };
}
