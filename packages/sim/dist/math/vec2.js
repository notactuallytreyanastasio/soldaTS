/**
 * 2D vector — port of `TVector2` (`shared/Vector.pas`, a `packed record x, y: Single`).
 *
 * Shared foundation: this file has a single author (the scaffold) so every
 * package agrees on one Vec2 API. Additional geometry helpers (point/line
 * distance, angles, intersections) belong in `./calc.ts`, not here.
 *
 * All arithmetic is wrapped in `f()` so it carries Pascal `Single` semantics
 * under the golden master (STRICT_F32) and is plain f64 in production.
 */
import { f } from '../scalar';
export const vec2 = (x = 0, y = 0) => ({ x, y });
export const clone = (a) => ({ x: a.x, y: a.y });
export const add = (a, b) => ({ x: f(a.x + b.x), y: f(a.y + b.y) });
export const sub = (a, b) => ({ x: f(a.x - b.x), y: f(a.y - b.y) });
export const scale = (a, s) => ({ x: f(a.x * s), y: f(a.y * s) });
export const dot = (a, b) => f(f(a.x * b.x) + f(a.y * b.y));
export const lengthSq = (a) => dot(a, a);
export const length = (a) => f(Math.sqrt(lengthSq(a)));
/** Returns a unit vector; the zero vector maps to (0, 0). */
export const normalize = (a) => {
    const len = length(a);
    return len > 0 ? scale(a, f(1 / len)) : vec2();
};
// Distance between two points lives in ./calc as `distanceV` (faithful port of
// Calc.pas `Distance`); not duplicated here to keep one canonical API.
//# sourceMappingURL=vec2.js.map