/**
 * Tests for the simulation scalar policy (scalar.ts).
 *
 * The module binds `f` at evaluation time based on process.env.STRICT_F32, so
 * the two modes are exercised via vi.stubEnv + vi.resetModules + dynamic
 * import. The statically-imported bindings cover the mode-independent surface
 * (f32, EPSILON).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { f32, EPSILON } from './scalar';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Re-evaluate scalar.ts under a given STRICT_F32 env value. */
async function loadScalar(strictEnv: string | undefined) {
  if (strictEnv === undefined) {
    vi.stubEnv('STRICT_F32', undefined as unknown as string);
  } else {
    vi.stubEnv('STRICT_F32', strictEnv);
  }
  vi.resetModules();
  return import('./scalar');
}

describe('production mode (STRICT_F32 off)', () => {
  it('STRICT_F32 is false when the env var is unset', async () => {
    const scalar = await loadScalar(undefined);
    expect(scalar.STRICT_F32).toBe(false);
  });

  it('STRICT_F32 is false for values other than exactly "1"', async () => {
    const scalar = await loadScalar('true');
    expect(scalar.STRICT_F32).toBe(false);
  });

  it('f() is the identity: f64 values pass through bit-exact', async () => {
    const scalar = await loadScalar('');
    expect(scalar.STRICT_F32).toBe(false);
    // 0.1 is NOT representable in f32; identity must NOT round it.
    expect(scalar.f(0.1)).toBe(0.1);
    expect(scalar.f(0.1)).not.toBe(Math.fround(0.1));
    expect(scalar.f(1e300)).toBe(1e300); // would overflow f32 to Infinity
    expect(scalar.f(0)).toBe(0);
    expect(scalar.f(-1.5)).toBe(-1.5);
  });
});

describe('golden-master mode (STRICT_F32=1)', () => {
  it('STRICT_F32 is true and f() applies Math.fround', async () => {
    const scalar = await loadScalar('1');
    expect(scalar.STRICT_F32).toBe(true);
    expect(scalar.f).toBe(Math.fround);
    expect(scalar.f(0.1)).toBe(Math.fround(0.1));
    expect(scalar.f(0.1)).not.toBe(0.1);
  });

  it('f() saturates beyond f32 range, matching Pascal Single overflow', async () => {
    const scalar = await loadScalar('1');
    expect(scalar.f(1e300)).toBe(Infinity);
    expect(scalar.f(-1e300)).toBe(-Infinity);
  });

  it('values in the sim range survive f() with loss bounded well under EPSILON', async () => {
    const scalar = await loadScalar('1');
    // Typical sim magnitudes: positions/velocities are O(1)..O(1000).
    for (const x of [0.06, 1.234567, -987.654321, 0.0009765625]) {
      expect(Math.abs(scalar.f(x) - x)).toBeLessThan(EPSILON);
    }
  });
});

describe('mode-independent exports', () => {
  it('f32 always rounds to f32, regardless of STRICT_F32', async () => {
    expect(f32).toBe(Math.fround);
    expect(f32(0.1)).toBe(Math.fround(0.1));
    const prod = await loadScalar('');
    const strict = await loadScalar('1');
    expect(prod.f32(0.1)).toBe(Math.fround(0.1));
    expect(strict.f32(0.1)).toBe(Math.fround(0.1));
  });

  it('f32 round-trip is idempotent (storage boundary contract)', () => {
    const once = f32(123.456789);
    expect(f32(once)).toBe(once);
  });

  it('EPSILON matches the documented 1e-4 golden-master tolerance', () => {
    expect(EPSILON).toBe(1e-4);
  });

  it('EPSILON is wide enough to absorb single f32 rounding of sim-scale values', () => {
    // The intended use: |f64Result - f32Result| <= EPSILON in windowed
    // golden-master assertions. One fround of an O(100) value loses < 1e-4.
    const x = 123.45678901234;
    expect(Math.abs(Math.fround(x) - x)).toBeLessThan(EPSILON);
  });
});
