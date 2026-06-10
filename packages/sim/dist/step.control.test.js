import { describe, it, expect } from 'vitest';
import { createWorld, initSimWorld, stepWorld } from './index';
import { buildPolyMap } from './map/buildPolyMap';
/**
 * Regression: stepWorld's map path must apply control input. It previously only
 * integrated + collided (never calling applyControl), so on a map the player
 * could not move or jump — input did nothing. stepWorld now drives the full
 * updateSpriteMovementMap (integrate -> collide -> clamp -> applyControl).
 */
function landedPlayer() {
    const tri = (a, b, c) => ({
        vertices: [a, b, c].map(([x, y]) => ({
            x,
            y,
            z: 0,
            rhw: 1,
            color: [40, 40, 50, 255],
            u: 0,
            v: 0,
        })),
        normals: [
            { x: 0, y: 0, z: 1 },
            { x: 0, y: 0, z: 1 },
            { x: 0, y: 0, z: 1 },
        ],
        polyType: 0,
        textureIndex: 0,
    });
    const w = initSimWorld(createWorld(), { seed: 1 });
    w.map = buildPolyMap({
        polygons: [tri([-500, 240], [500, 240], [-500, 320]), tri([500, 240], [500, 320], [-500, 320])],
        sectorsDivision: 0,
        sectorsNum: 0,
        sectors: [],
    });
    const p = w.spriteParts;
    const s = w.sprites[1];
    s.active = true;
    s.num = 1;
    p.active[1] = true;
    p.posX[1] = 0;
    p.posY[1] = 0;
    p.oneOverMass[1] = 1;
    s.jetsCount = 250;
    for (let i = 0; i < 200; i++)
        stepWorld(w, { spriteRadius: 0 });
    return { w, p, s };
}
describe('stepWorld applies control on the map path', () => {
    it('control.right moves the player right', () => {
        const { w, p, s } = landedPlayer();
        const x0 = p.posX[1];
        s.control = { ...s.control, right: true };
        for (let i = 0; i < 60; i++)
            stepWorld(w, { spriteRadius: 0 });
        expect(p.posX[1]).toBeGreaterThan(x0 + 5);
    });
    it('control.up produces a real jump (not a one-tick hop)', () => {
        const { w, p, s } = landedPlayer();
        const ground = p.posY[1];
        let peak = ground;
        for (let i = 0; i < 120; i++) {
            s.control = { ...s.control, up: true };
            stepWorld(w, { spriteRadius: 0 });
            peak = Math.min(peak, p.posY[1]);
        }
        expect(ground - peak).toBeGreaterThan(60); // a real jump arc
    });
    it('control.jetpack lifts the player while it has fuel', () => {
        const { w, p, s } = landedPlayer();
        const ground = p.posY[1];
        let top = ground;
        for (let i = 0; i < 80; i++) {
            s.control = { ...s.control, jetpack: true };
            stepWorld(w, { spriteRadius: 0 });
            top = Math.min(top, p.posY[1]);
        }
        expect(ground - top).toBeGreaterThan(40); // lifted off
        expect(s.jetsCount).toBeLessThan(250); // burned fuel
    });
    // DESIGN OVERRIDE (decision node 94): rocket boots favor UP. While the jet
    // burns, vertical gain must dominate horizontal drift — the boost is "up +
    // steer", not "sideways with lift".
    it('jetting while holding a direction climbs more than it drifts', () => {
        const { w, p, s } = landedPlayer();
        const x0 = p.posX[1];
        const y0 = p.posY[1];
        for (let i = 0; i < 80; i++) {
            s.control = { ...s.control, jetpack: true, right: true };
            stepWorld(w, { spriteRadius: 0 });
        }
        const climb = y0 - p.posY[1]; // up is -y
        const drift = p.posX[1] - x0;
        expect(climb).toBeGreaterThan(60); // strong vertical boost
        expect(climb).toBeGreaterThan(drift * 1.5); // UP wins over sideways
    });
    // DESIGN OVERRIDE regressions (node 100): "boots still wrong" round.
    // All three bugs were later force assignments clobbering a stronger upward
    // force on the same tick.
    it('holding the jet does NOT nerf a jump (most-upward-wins)', () => {
        const jumpPeak = (jetpack) => {
            const { w, p, s } = landedPlayer();
            const ground = p.posY[1];
            let peak = ground;
            for (let i = 0; i < 120; i++) {
                s.control = { ...s.control, up: true, jetpack };
                stepWorld(w, { spriteRadius: 0 });
                peak = Math.min(peak, p.posY[1]);
            }
            return ground - peak;
        };
        // The jet ground-kick (-0.25) used to overwrite the jump force (-0.66).
        expect(jumpPeak(true)).toBeGreaterThanOrEqual(jumpPeak(false));
    });
    it('can take off while running (movement no longer clobbers jet lift)', () => {
        const { w, p, s } = landedPlayer();
        const ground = p.posY[1];
        let peak = ground;
        for (let i = 0; i < 90; i++) {
            s.control = { ...s.control, right: true, jetpack: true };
            stepWorld(w, { spriteRadius: 0 });
            peak = Math.min(peak, p.posY[1]);
        }
        // forceY = -RUNSPEEDUP (0.0197 < gravity) used to pin the runner down.
        expect(ground - peak).toBeGreaterThan(40);
    });
    it('a running jump clears like a standing jump (side-jump keeps 90% vertical)', () => {
        const sideJumpPeak = () => {
            const { w, p, s } = landedPlayer();
            const ground = p.posY[1];
            let peak = ground;
            for (let i = 0; i < 120; i++) {
                s.control = { ...s.control, up: true, right: true };
                stepWorld(w, { spriteRadius: 0 });
                peak = Math.min(peak, p.posY[1]);
            }
            return ground - peak;
        };
        const straightJumpPeak = () => {
            const { w, p, s } = landedPlayer();
            const ground = p.posY[1];
            let peak = ground;
            for (let i = 0; i < 120; i++) {
                s.control = { ...s.control, up: true };
                stepWorld(w, { spriteRadius: 0 });
                peak = Math.min(peak, p.posY[1]);
            }
            return ground - peak;
        };
        // Pascal side-jump vertical (0.25 vs 0.66) reached ~1/3 the height —
        // "I can't jump over basic land obstacles".
        expect(sideJumpPeak()).toBeGreaterThan(straightJumpPeak() * 0.7);
    });
    it('air control is restored once the fuel runs dry', () => {
        const { w, p, s } = landedPlayer();
        s.jetsCount = 0;
        // Get airborne with a jump, then hold right with the (empty) jet held.
        for (let i = 0; i < 10; i++) {
            s.control = { ...s.control, up: true };
            stepWorld(w, { spriteRadius: 0 });
        }
        const x0 = p.posX[1];
        for (let i = 0; i < 30; i++) {
            s.control = { ...s.control, up: false, jetpack: true, right: true };
            stepWorld(w, { spriteRadius: 0 });
        }
        // Full FLYSPEED air control applies (no thrust ticks happened).
        expect(p.posX[1] - x0).toBeGreaterThan(3);
        expect(s.jetsCount).toBe(0);
    });
});
//# sourceMappingURL=step.control.test.js.map