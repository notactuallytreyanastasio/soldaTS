import { NUM_PARTICLES } from '../constants';
/**
 * Snapshot the active particles of a `ParticleSystem` into a `GoldenFrame`.
 *
 * Iterates `[1..NUM_PARTICLES]` in ascending id order so the frame's particle
 * list is deterministic regardless of insertion order. Only `active[i]`
 * particles are recorded — matching the Pascal loops that skip inactive slots
 * (e.g. shared/Parts.pas:80-82).
 */
export function snapshotFrame(system, tick) {
    const particles = [];
    for (let i = 1; i <= NUM_PARTICLES; i++) {
        if (system.active[i]) {
            particles.push({
                i,
                x: system.posX[i],
                y: system.posY[i],
                vx: system.velocityX[i],
                vy: system.velocityY[i],
            });
        }
    }
    return { tick, particles };
}
//# sourceMappingURL=trace.js.map