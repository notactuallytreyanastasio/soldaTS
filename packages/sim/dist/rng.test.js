import { describe, it, expect } from 'vitest';
import { Rng } from './rng';
describe('Rng (deterministic sim randomness)', () => {
    it('produces the same sequence for the same seed', () => {
        const a = new Rng(12345);
        const b = new Rng(12345);
        const seqA = Array.from({ length: 16 }, () => a.nextInt(100));
        const seqB = Array.from({ length: 16 }, () => b.nextInt(100));
        expect(seqA).toEqual(seqB);
    });
    it('diverges for different seeds', () => {
        const a = Array.from({ length: 16 }, ((r) => () => r.nextInt(1000))(new Rng(1)));
        const b = Array.from({ length: 16 }, ((r) => () => r.nextInt(1000))(new Rng(2)));
        expect(a).not.toEqual(b);
    });
    it('nextInt(n) stays in [0, n)', () => {
        const r = new Rng(99);
        for (let i = 0; i < 1000; i++) {
            const v = r.nextInt(7);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(7);
            expect(Number.isInteger(v)).toBe(true);
        }
    });
    it('reseed restores the sequence', () => {
        const r = new Rng(5);
        const first = [r.next(), r.next(), r.next()];
        r.reseed(5);
        expect([r.next(), r.next(), r.next()]).toEqual(first);
    });
});
//# sourceMappingURL=rng.test.js.map