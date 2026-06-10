import type { Vec2 } from './vec2';
export interface IntersectionResult {
    /** array [0..1] of TVector2 — at most two intersection points. */
    points: [Vec2, Vec2];
    /** NumIntersections: Byte — 0, 1, or 2. */
    numIntersections: number;
}
export declare function isLineIntersectingCircle(line1: Vec2, line2: Vec2, circleCenter: Vec2, radius: number): IntersectionResult;
export declare function lineCircleCollision(startPoint: Vec2, endPoint: Vec2, circleCenter: Vec2, radius: number): Vec2 | null;
export declare function pointLineDistance(p1: Vec2, p2: Vec2, p3: Vec2): number;
export declare function angle2Points(p1: Vec2, p2: Vec2): number;
export declare function distance(x1: number, y1: number, x2: number, y2: number): number;
export declare function distanceV(p1: Vec2, p2: Vec2): number;
export declare function sqrDist(x1: number, y1: number, x2: number, y2: number): number;
export declare function sqrDistV(p1: Vec2, p2: Vec2): number;
export declare function greaterPowerOf2(n: number): number;
export declare function roundFair(value: number): number;
//# sourceMappingURL=calc.d.ts.map