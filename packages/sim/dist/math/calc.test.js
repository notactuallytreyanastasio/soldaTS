/**
 * Table-driven tests for the `shared/Calc.pas` geometry helpers ported into
 * `./calc.ts`. These run in plain f64 (STRICT_F32 off) and assert the same
 * results the Pascal originals produce.
 */
import { describe, it, expect } from 'vitest';
import { vec2 } from './vec2';
import { angle2Points, distance, distanceV, greaterPowerOf2, isLineIntersectingCircle, lineCircleCollision, pointLineDistance, roundFair, sqrDist, sqrDistV, } from './calc';
const TOL = 1e-5;
describe('distance / sqrDist', () => {
    const cases = [
        // [x1, y1, x2, y2, expectedDistance]
        [0, 0, 3, 4, 5],
        [0, 0, 0, 0, 0],
        [-1, -1, 2, 3, 5],
        [10, 10, 13, 14, 5],
    ];
    it.each(cases)('distance(%f,%f,%f,%f) = %f', (x1, y1, x2, y2, expected) => {
        expect(distance(x1, y1, x2, y2)).toBeCloseTo(expected, 5);
        expect(distanceV(vec2(x1, y1), vec2(x2, y2))).toBeCloseTo(expected, 5);
    });
    it.each(cases)('sqrDist(%f,%f,%f,%f) = dist^2', (x1, y1, x2, y2, expected) => {
        expect(sqrDist(x1, y1, x2, y2)).toBeCloseTo(expected * expected, 4);
        expect(sqrDistV(vec2(x1, y1), vec2(x2, y2))).toBeCloseTo(expected * expected, 4);
    });
});
describe('pointLineDistance', () => {
    // Distance from P3 to the infinite line through P1->P2 (not clamped).
    const cases = [
        // horizontal line through origin, point 3 above midpoint
        [[0, 0], [10, 0], [5, 3], 3],
        // point exactly on the line
        [[0, 0], [10, 0], [4, 0], 0],
        // vertical line
        [[0, 0], [0, 10], [4, 5], 4],
        // 45-degree line y=x, point (1,0) -> distance = sqrt(2)/2
        [[0, 0], [10, 10], [1, 0], Math.SQRT1_2],
    ];
    it.each(cases)('P1=%o P2=%o P3=%o -> %f', (p1, p2, p3, expected) => {
        const d = pointLineDistance(vec2(p1[0], p1[1]), vec2(p2[0], p2[1]), vec2(p3[0], p3[1]));
        expect(d).toBeCloseTo(expected, 5);
    });
    it('measures distance to the infinite line, not the clamped segment', () => {
        // P3 beyond P2 along the line direction: still 0 because it's on the line.
        const d = pointLineDistance(vec2(0, 0), vec2(10, 0), vec2(20, 0));
        expect(d).toBeCloseTo(0, 5);
    });
});
describe('angle2Points', () => {
    const cases = [
        [[0, 0], [1, 0], 0], // due +x
        [[0, 0], [1, 1], Math.PI / 4], // down-right (screen y is down)
        [[0, 0], [-1, 0], Math.PI], // due -x: atan(0)+pi
        [[0, 0], [0, 1], Math.PI / 2], // straight down
        [[0, 0], [0, -1], -Math.PI / 2], // straight up
        [[0, 0], [0, 0], 0], // coincident
        [[0, 0], [-1, 1], (3 * Math.PI) / 4], // atan(-1)+pi
    ];
    it.each(cases)('P1=%o P2=%o -> %f', (p1, p2, expected) => {
        const a = angle2Points(vec2(p1[0], p1[1]), vec2(p2[0], p2[1]));
        expect(a).toBeCloseTo(expected, TOL);
    });
});
describe('isLineIntersectingCircle', () => {
    it('finds two intersections for a chord through the centre (horizontal)', () => {
        const r = isLineIntersectingCircle(vec2(-10, 0), vec2(10, 0), vec2(0, 0), 5);
        expect(r.numIntersections).toBe(2);
        const xs = [r.points[0].x, r.points[1].x].sort((a, b) => a - b);
        expect(xs[0]).toBeCloseTo(-5, 5);
        expect(xs[1]).toBeCloseTo(5, 5);
        expect(r.points[0].y).toBeCloseTo(0, 5);
        expect(r.points[1].y).toBeCloseTo(0, 5);
    });
    it('finds two intersections for a vertical chord (exercises the flip path)', () => {
        const r = isLineIntersectingCircle(vec2(0, -10), vec2(0, 10), vec2(0, 0), 5);
        expect(r.numIntersections).toBe(2);
        const ys = [r.points[0].y, r.points[1].y].sort((a, b) => a - b);
        expect(ys[0]).toBeCloseTo(-5, 5);
        expect(ys[1]).toBeCloseTo(5, 5);
        expect(r.points[0].x).toBeCloseTo(0, 5);
        expect(r.points[1].x).toBeCloseTo(0, 5);
    });
    it('returns a single intersection when only one end is inside the circle', () => {
        // Segment from centre out to (10,0): enters/exits but only the +5 root
        // lies within the segment bounds.
        const r = isLineIntersectingCircle(vec2(0, 0), vec2(10, 0), vec2(0, 0), 5);
        expect(r.numIntersections).toBe(1);
        expect(r.points[0].x).toBeCloseTo(5, 5);
        expect(r.points[0].y).toBeCloseTo(0, 5);
    });
    it('returns no intersection when the line misses the circle', () => {
        const r = isLineIntersectingCircle(vec2(-10, 20), vec2(10, 20), vec2(0, 0), 5);
        expect(r.numIntersections).toBe(0);
    });
    it('returns no intersection for a degenerate (zero-length) line', () => {
        const r = isLineIntersectingCircle(vec2(1, 1), vec2(1, 1), vec2(0, 0), 5);
        expect(r.numIntersections).toBe(0);
    });
});
describe('lineCircleCollision', () => {
    it('returns the start point when the start is already inside the circle', () => {
        const c = lineCircleCollision(vec2(1, 0), vec2(10, 0), vec2(0, 0), 5);
        expect(c).not.toBeNull();
        expect(c?.x).toBeCloseTo(1, 5);
        expect(c?.y).toBeCloseTo(0, 5);
    });
    it('returns the end point when only the end is inside', () => {
        const c = lineCircleCollision(vec2(-10, 0), vec2(-1, 0), vec2(0, 0), 5);
        expect(c).not.toBeNull();
        expect(c?.x).toBeCloseTo(-1, 5);
        expect(c?.y).toBeCloseTo(0, 5);
    });
    it('returns the nearest intersection to the start for a pass-through chord', () => {
        // Travelling +x from outside through the circle: nearest hit is x = -5.
        const c = lineCircleCollision(vec2(-10, 0), vec2(10, 0), vec2(0, 0), 5);
        expect(c).not.toBeNull();
        expect(c?.x).toBeCloseTo(-5, 5);
        expect(c?.y).toBeCloseTo(0, 5);
    });
    it('returns null when the segment misses the circle entirely', () => {
        const c = lineCircleCollision(vec2(-10, 20), vec2(10, 20), vec2(0, 0), 5);
        expect(c).toBeNull();
    });
});
describe('greaterPowerOf2', () => {
    const cases = [
        [1, 1],
        [2, 2],
        [3, 4],
        [5, 8],
        [8, 8],
        [9, 16],
        [100, 128],
        [256, 256],
    ];
    it.each(cases)('greaterPowerOf2(%i) = %i', (n, expected) => {
        expect(greaterPowerOf2(n)).toBe(expected);
    });
});
describe('roundFair', () => {
    // Floor(Value + 0.5): no banker's rounding, ties go toward +infinity.
    const cases = [
        [0.5, 1],
        [1.5, 2],
        [2.5, 3],
        [-0.5, 0],
        [-1.5, -1],
        [-2.5, -2],
        [2.4, 2],
        [2.6, 3],
        [0, 0],
    ];
    it.each(cases)('roundFair(%f) = %i', (value, expected) => {
        expect(roundFair(value)).toBe(expected);
    });
});
//# sourceMappingURL=calc.test.js.map