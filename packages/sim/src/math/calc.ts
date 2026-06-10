/**
 * Geometry / collision-math helpers — port of `shared/Calc.pas`.
 *
 * These are the helpers used by Sprites/Bullets/Things/PolyMap that are NOT
 * already covered by `./vec2.ts`. Vec2 and its ops are imported from `./vec2`;
 * all physics arithmetic is wrapped in `f()` so STRICT_F32 reproduces Pascal
 * `Single` results bit-for-bit (plain f64 otherwise).
 *
 * Naming and behaviour mirror the Pascal originals (PascalCase function names
 * kept verbatim for cross-referencing). Provenance comments point at the exact
 * source lines in `shared/Calc.pas`.
 */
import { f } from '../scalar';
import type { Vec2 } from './vec2';
import { vec2 } from './vec2';

// PORT: shared/Calc.pas:17-20 — TIntersectionResult record.
export interface IntersectionResult {
  /** array [0..1] of TVector2 — at most two intersection points. */
  points: [Vec2, Vec2];
  /** NumIntersections: Byte — 0, 1, or 2. */
  numIntersections: number;
}

/**
 * FreePascal `Math.InRange(AValue, AMin, AMax)`:
 *   (AValue >= AMin) and (AValue <= AMax)
 * Used internally by IsLineIntersectingCircle.
 */
const inRange = (value: number, min: number, max: number): boolean =>
  value >= min && value <= max;

// PORT: shared/Calc.pas:40-163 — IsLineIntersectingCircle.
// Finds where segment Line1->Line2 crosses the circle (CircleCenter, Radius).
export function isLineIntersectingCircle(
  line1: Vec2,
  line2: Vec2,
  circleCenter: Vec2,
  radius: number,
): IntersectionResult {
  // PORT: shared/Calc.pas:48-49 — Result := Default(...); FillChar(..,#0).
  const result: IntersectionResult = {
    points: [vec2(), vec2()],
    numIntersections: 0,
  };

  // Work on local copies because the flip below mutates the coordinates.
  let l1x = line1.x;
  let l1y = line1.y;
  let l2x = line2.x;
  let l2y = line2.y;
  let ccx = circleCenter.x;
  let ccy = circleCenter.y;

  // PORT: shared/Calc.pas:51-52.
  let diffx = f(l2x - l1x);
  let diffy = f(l2y - l1y);

  // PORT: shared/Calc.pas:54-57 — degenerate (zero-length) line: bail out.
  if (Math.abs(diffx) < 0.00001 && Math.abs(diffy) < 0.00001) {
    return result;
  }

  // PORT: shared/Calc.pas:63-83 — if steeper than 45deg, flip x<->y so the
  // line stays a function of x (vertical lines would break the algebra).
  let flipped = false;
  if (Math.abs(diffy) > Math.abs(diffx)) {
    flipped = true;
    let temp = l1x;
    l1x = l1y;
    l1y = temp;

    temp = l2x;
    l2x = l2y;
    l2y = temp;

    temp = ccx;
    ccx = ccy;
    ccy = temp;

    temp = diffx;
    diffx = diffy;
    diffy = temp;
  }

  // PORT: shared/Calc.pas:87 — a := diffy/diffx.
  const a = f(diffy / diffx);
  // PORT: shared/Calc.pas:89 — b := y - a*x.
  const b = f(l1y - f(a * l1x));
  // PORT: shared/Calc.pas:96 — A = a^2 + 1.
  const a1 = f(f(a * a) + 1);
  // PORT: shared/Calc.pas:98 — B = 2(ab - a*y1 - x1).
  const b1 = f(2 * f(f(a * b) - f(a * ccy) - ccx));
  // PORT: shared/Calc.pas:100 — C = y1^2 - r^2 + x1^2 - 2*b*y1 + b^2.
  const c1 = f(
    f(ccy * ccy) - f(radius * radius) + f(ccx * ccx) - f(2 * f(b * ccy)) + f(b * b),
  );
  // PORT: shared/Calc.pas:102 — delta := B^2 - 4AC.
  const delta = f(f(b1 * b1) - f(f(4 * a1) * c1));

  // PORT: shared/Calc.pas:106-107 — delta < 0: no intersection.
  if (delta < 0) {
    return result;
  }

  // PORT: shared/Calc.pas:109-129 — segment bounding box.
  let minx: number;
  let maxx: number;
  if (l1x < l2x) {
    minx = l1x;
    maxx = l2x;
  } else {
    minx = l2x;
    maxx = l1x;
  }

  let miny: number;
  let maxy: number;
  if (l1y < l2y) {
    miny = l1y;
    maxy = l2y;
  } else {
    miny = l2y;
    maxy = l1y;
  }

  // PORT: shared/Calc.pas:133-134.
  const sqrtdelta = f(Math.sqrt(delta));
  const a2 = f(2 * a1);

  // PORT: shared/Calc.pas:135-148 — first root x = (-B - sqrt)/2A.
  let ix = f(f(-b1 - sqrtdelta) / a2);
  let iy = f(f(a * ix) + b);
  if (inRange(ix, minx, maxx) && inRange(iy, miny, maxy)) {
    const out = flipped ? vec2(iy, ix) : vec2(ix, iy);
    result.points[result.numIntersections === 0 ? 0 : 1] = out;
    result.numIntersections += 1;
  }

  // PORT: shared/Calc.pas:150-162 — second root x = (-B + sqrt)/2A.
  ix = f(f(-b1 + sqrtdelta) / a2);
  iy = f(f(a * ix) + b);
  if (inRange(ix, minx, maxx) && inRange(iy, miny, maxy)) {
    const out = flipped ? vec2(iy, ix) : vec2(ix, iy);
    result.points[result.numIntersections === 0 ? 0 : 1] = out;
    result.numIntersections += 1;
  }

  return result;
}

// PORT: shared/Calc.pas:165-198 — LineCircleCollision.
// Returns the collision point (or null) for moving StartPoint->EndPoint vs a
// circle. Mirrors the Pascal var-parameter by returning the point instead.
export function lineCircleCollision(
  startPoint: Vec2,
  endPoint: Vec2,
  circleCenter: Vec2,
  radius: number,
): Vec2 | null {
  // PORT: shared/Calc.pas:171 — r2 := sqr(Radius).
  const r2 = f(radius * radius);

  // PORT: shared/Calc.pas:175-180 — start already inside circle.
  if (sqrDistV(startPoint, circleCenter) <= r2) {
    return { x: startPoint.x, y: startPoint.y };
  }

  // PORT: shared/Calc.pas:182-187 — end already inside circle.
  if (sqrDistV(endPoint, circleCenter) <= r2) {
    return { x: endPoint.x, y: endPoint.y };
  }

  // PORT: shared/Calc.pas:189-197.
  const ir = isLineIntersectingCircle(startPoint, endPoint, circleCenter, radius);
  if (ir.numIntersections > 0) {
    let collisionPoint = ir.points[0];
    if (
      ir.numIntersections === 2 &&
      sqrDistV(ir.points[0], startPoint) > sqrDistV(ir.points[1], startPoint)
    ) {
      collisionPoint = ir.points[1];
    }
    return { x: collisionPoint.x, y: collisionPoint.y };
  }

  return null;
}

// PORT: shared/Calc.pas:200-211 — PointLineDistance.
// Distance from P3 to the infinite line through P1,P2 (projection-based; not
// clamped to the segment — matches Pascal exactly).
export function pointLineDistance(p1: Vec2, p2: Vec2, p3: Vec2): number {
  const dx = f(p2.x - p1.x);
  const dy = f(p2.y - p1.y);
  // PORT: shared/Calc.pas:204-205.
  const u = f(
    f(f(f(p3.x - p1.x) * dx) + f(f(p3.y - p1.y) * dy)) / f(f(dx * dx) + f(dy * dy)),
  );

  // PORT: shared/Calc.pas:207-208.
  const x = f(p1.x + f(u * dx));
  const y = f(p1.y + f(u * dy));

  // PORT: shared/Calc.pas:210 — Sqrt(Sqr(X-P3.X) + Sqr(Y-P3.Y)).
  const ex = f(x - p3.x);
  const ey = f(y - p3.y);
  return f(Math.sqrt(f(f(ex * ex) + f(ey * ey))));
}

// PORT: shared/Calc.pas:213-230 — Angle2Points.
// Angle (radians) of the direction from P1 to P2. Note the y-axis is screen
// space (down-positive), matching the Pascal use sites.
export function angle2Points(p1: Vec2, p2: Vec2): number {
  const dx = f(p2.x - p1.x);
  if (dx !== 0) {
    const dy = f(p2.y - p1.y);
    if (p1.x > p2.x) {
      // PORT: shared/Calc.pas:218.
      return f(Math.atan(f(dy / dx)) + Math.PI);
    }
    // PORT: shared/Calc.pas:220.
    return f(Math.atan(f(dy / dx)));
  }
  // PORT: shared/Calc.pas:222-229 — vertical cases.
  if (p2.y > p1.y) {
    return f(Math.PI / 2);
  }
  if (p2.y < p1.y) {
    return f(-Math.PI / 2);
  }
  return 0;
}

// PORT: shared/Calc.pas:232-235 — Distance(X1,Y1,X2,Y2) overload.
export function distance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = f(x1 - x2);
  const dy = f(y1 - y2);
  return f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
}

// PORT: shared/Calc.pas:237-240 — Distance(P1,P2) overload.
export function distanceV(p1: Vec2, p2: Vec2): number {
  return distance(p1.x, p1.y, p2.x, p2.y);
}

// PORT: shared/Calc.pas:242-245 — SqrDist(X1,Y1,X2,Y2) overload.
export function sqrDist(x1: number, y1: number, x2: number, y2: number): number {
  const dx = f(x1 - x2);
  const dy = f(y1 - y2);
  return f(f(dx * dx) + f(dy * dy));
}

// PORT: shared/Calc.pas:247-250 — SqrDist(P1,P2) overload.
export function sqrDistV(p1: Vec2, p2: Vec2): number {
  return sqrDist(p1.x, p1.y, p2.x, p2.y);
}

// PORT: shared/Calc.pas:252-256 — GreaterPowerOf2.
// 2 ^ ceil(log2(N)). Integer-domain helper (texture sizing); no f() needed.
export function greaterPowerOf2(n: number): number {
  return Math.trunc(Math.pow(2, Math.ceil(Math.log2(n))));
}

// PORT: shared/Calc.pas:258-262 — RoundFair.
// Rounds without banker's rounding: Floor(Value + 0.5).
export function roundFair(value: number): number {
  return Math.floor(f(value + 0.5));
}
