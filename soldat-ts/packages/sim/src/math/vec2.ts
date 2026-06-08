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

export interface Vec2 {
  x: number;
  y: number;
}

export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y });

export const clone = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: f(a.x + b.x), y: f(a.y + b.y) });

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: f(a.x - b.x), y: f(a.y - b.y) });

export const scale = (a: Vec2, s: number): Vec2 => ({ x: f(a.x * s), y: f(a.y * s) });

export const dot = (a: Vec2, b: Vec2): number => f(f(a.x * b.x) + f(a.y * b.y));

export const lengthSq = (a: Vec2): number => dot(a, a);

export const length = (a: Vec2): number => f(Math.sqrt(lengthSq(a)));

/** Returns a unit vector; the zero vector maps to (0, 0). */
export const normalize = (a: Vec2): Vec2 => {
  const len = length(a);
  return len > 0 ? scale(a, f(1 / len)) : vec2();
};

export const distance = (a: Vec2, b: Vec2): number => length(sub(a, b));
