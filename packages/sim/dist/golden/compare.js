/** Index a frame's particles by their 1-based id for O(1) lookup. */
function byId(frame) {
    const m = new Map();
    for (const p of frame.particles) {
        m.set(p.i, p);
    }
    return m;
}
/** Worst absolute per-field delta between two particles. */
function particleDelta(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.vx - b.vx), Math.abs(a.vy - b.vy));
}
/**
 * Compare two traces within `epsilon`.
 *
 * A structural mismatch (differing frame count, differing tick numbers, or a
 * particle present in one frame but absent in the other) is treated as an
 * infinite divergence at that tick: `match` is false, `maxDelta` is Infinity,
 * and `firstDivergenceTick` is set to that tick.
 */
export function compareTraces(a, b, epsilon) {
    let maxDelta = 0;
    let firstDivergenceTick = null;
    const noteDivergence = (tick, delta) => {
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
        const tick = a.frames[frameCount]?.tick ?? b.frames[frameCount]?.tick ?? frameCount;
        noteDivergence(tick, Number.POSITIVE_INFINITY);
    }
    for (let fi = 0; fi < frameCount; fi++) {
        const fa = a.frames[fi];
        const fb = b.frames[fi];
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
//# sourceMappingURL=compare.js.map