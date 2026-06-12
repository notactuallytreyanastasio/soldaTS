// Determinism (goal node 170): same MatchConfig ⇒ byte-identical artifacts.
// This is the dataset's reproducibility guarantee — a manifest (config +
// seed) fully determines every replay byte.
import { describe, it, expect } from 'vitest';
import { WILDCARD_WEAPONS, rollWildcard, pickWildcardWeapon, } from '@soldat/client/headless';
import { runMatch } from './runner';
import { buildManifest } from './store';
const CONFIG = {
    seed: 11,
    teams: [{ engine: 'pilot', tweaks: { RANGE_MAX: 500 } }, { engine: 'reaper' }],
    botCount: 4,
    roundTicks: 600,
};
describe('runMatch determinism', () => {
    it('identical config ⇒ byte-identical replay, events, telemetry', () => {
        const a = runMatch(CONFIG);
        const b = runMatch(CONFIG);
        expect(a.replayJsonl === b.replayJsonl).toBe(true); // strict string equality
        expect(b.events).toEqual(a.events);
        expect(b.telemetry).toEqual(a.telemetry);
        expect(b.round).toEqual(a.round);
    });
    it('different seed ⇒ different replay', () => {
        const a = runMatch(CONFIG);
        const c = runMatch({ ...CONFIG, seed: 12 });
        expect(c.replayJsonl).not.toBe(a.replayJsonl);
    });
});
describe('shotgun wildcard determinism', () => {
    const WILD = { ...CONFIG, wildcard: 'shotgun' };
    it('identical wildcard config ⇒ byte-identical artifacts', () => {
        const a = runMatch(WILD);
        const b = runMatch(WILD);
        expect(a.replayJsonl === b.replayJsonl).toBe(true);
        expect(b.events).toEqual(a.events);
        expect(b.telemetry).toEqual(a.telemetry);
        expect(b.round).toEqual(a.round);
    });
    it('explicit wildcard: undefined ⇒ byte-identical to the default config', () => {
        const a = runMatch(CONFIG);
        const b = runMatch({ ...CONFIG, wildcard: undefined });
        expect(a.replayJsonl === b.replayJsonl).toBe(true);
        expect(b.events).toEqual(a.events);
    });
    it('wildcard kills carry a weapon tag; default kills never do', () => {
        const wild = runMatch(WILD);
        const plain = runMatch(CONFIG);
        const wildKills = wild.events.filter((e) => e.type === 'kill' && e.killer > 0);
        for (const k of wildKills) {
            expect('weapon' in k && (k.weapon === 'AK74' || k.weapon === 'SPAS12')).toBe(true);
        }
        for (const k of plain.events.filter((e) => e.type === 'kill')) {
            expect('weapon' in k).toBe(false);
        }
    });
    it('the manifest records the wildcard (null when stock)', () => {
        const results = [runMatch(WILD)];
        const base = {
            runId: 'wild-test',
            teams: WILD.teams,
            results,
            variantName: 'baseline',
            botCount: 4,
            roundTicks: 600,
            maxTicks: 1200,
        };
        expect(buildManifest({ ...base, wildcard: 'shotgun' }).wildcard).toBe('shotgun');
        expect(buildManifest(base).wildcard).toBeNull();
        // 'none' is an explicit stock request — normalized to null like absence.
        expect(buildManifest({ ...base, wildcard: 'none' }).wildcard).toBeNull();
        // Per-match RESOLVED values ride on matches[] (chance runs vary by seed).
        expect(buildManifest({ ...base, wildcard: 'shotgun' }).matches[0]?.wildcard).toBe('shotgun');
    });
});
describe("'chance' wildcard mode (all games get a shot at shotgun play)", () => {
    it('resolves purely from the seed: same config ⇒ byte-identical artifacts', () => {
        const a = runMatch({ ...CONFIG, wildcard: 'chance' });
        const b = runMatch({ ...CONFIG, wildcard: 'chance' });
        expect(a.replayJsonl === b.replayJsonl).toBe(true);
        expect(b.events).toEqual(a.events);
        expect(a.wildcard).toBe(b.wildcard);
    });
    it('arms SOME seeds and not others, and records which on the result', () => {
        const armed = rollWildcard(CONFIG.seed);
        const r = runMatch({ ...CONFIG, wildcard: 'chance', roundTicks: 600 });
        expect(r.wildcard).toBe(armed ? 'shotgun' : null);
        // The roll is a real chance: both outcomes occur across nearby seeds.
        const rolls = Array.from({ length: 40 }, (_, i) => rollWildcard(i + 1));
        expect(rolls.some(Boolean)).toBe(true);
        expect(rolls.some((x) => !x)).toBe(true);
    });
    it("'none' mode is byte-identical to no wildcard at all", () => {
        const a = runMatch(CONFIG);
        const b = runMatch({ ...CONFIG, wildcard: 'none' });
        expect(a.replayJsonl === b.replayJsonl).toBe(true);
    });
});
describe('rifle wildcard determinism (Barrett, goal node 382)', () => {
    const RIFLE = { ...CONFIG, wildcard: 'rifle' };
    it('identical rifle config ⇒ byte-identical artifacts', () => {
        const a = runMatch(RIFLE);
        const b = runMatch(RIFLE);
        expect(a.replayJsonl === b.replayJsonl).toBe(true);
        expect(b.events).toEqual(a.events);
        expect(b.telemetry).toEqual(a.telemetry);
        expect(b.round).toEqual(a.round);
    });
    it('a rifle match differs from the same seed forced to shotgun (the weapon matters)', () => {
        const a = runMatch(RIFLE);
        const b = runMatch({ ...CONFIG, wildcard: 'shotgun' });
        expect(a.replayJsonl).not.toBe(b.replayJsonl);
    });
    it('rifle kills carry weapon tags from the three-gun label set', () => {
        const r = runMatch({ ...RIFLE, roundTicks: 3600 });
        expect(r.wildcard).toBe('rifle');
        const kills = r.events.filter((e) => e.type === 'kill' && e.killer > 0);
        for (const k of kills) {
            expect('weapon' in k && ['AK74', 'SPAS12', 'BARRETT'].includes(k.weapon)).toBe(true);
        }
    });
    it("the manifest records 'rifle' (run-level and per match)", () => {
        const results = [runMatch(RIFLE)];
        const base = {
            runId: 'rifle-test',
            teams: RIFLE.teams,
            results,
            variantName: 'baseline',
            botCount: 4,
            roundTicks: 600,
            maxTicks: 1200,
        };
        expect(buildManifest({ ...base, wildcard: 'rifle' }).wildcard).toBe('rifle');
        expect(buildManifest({ ...base, wildcard: 'rifle' }).matches[0]?.wildcard).toBe('rifle');
    });
});
describe("'chance' mode six-way split (none | the five WILDCARD_WEAPONS)", () => {
    it('resolves to rollWildcard ? pickWildcardWeapon : stock — recorded on the result', () => {
        const expected = rollWildcard(CONFIG.seed)
            ? pickWildcardWeapon(CONFIG.seed)
            : null;
        const r = runMatch({ ...CONFIG, wildcard: 'chance' });
        expect(r.wildcard).toBe(expected);
    });
    it('stock and ALL FIVE weapons occur across seeds', () => {
        const outcomes = new Set();
        for (let seed = 1; seed <= 400; seed++) {
            outcomes.add(rollWildcard(seed) ? pickWildcardWeapon(seed) : 'none');
        }
        expect(outcomes).toEqual(new Set(['none', ...WILDCARD_WEAPONS]));
    });
    it("old-seed SHOTGUN replays are safe: forced-'shotgun' resolution and arming are untouched", () => {
        // Recorded chance-era artifacts (manifests + watch URLs) carry the
        // RESOLVED value 'shotgun', never the mode — and forcing 'shotgun' for
        // an old seed reproduces the exact same match as the chance-era run.
        // (The PICK for an armed seed may differ now that the hash spans five
        // weapons — by design; nothing recorded ever re-rolls the pick.)
        const forced = runMatch({ ...CONFIG, wildcard: 'shotgun' });
        const again = runMatch({ ...CONFIG, wildcard: 'shotgun' });
        expect(forced.replayJsonl === again.replayJsonl).toBe(true);
        expect(forced.wildcard).toBe('shotgun');
        // And the arming hash itself is the shotgun-era one (pinned inline).
        const legacyRoll = (seed) => (Math.imul(seed ^ 0x9e3779b9, 2654435761) >>> 0) % 100 < 35;
        for (let seed = 1; seed <= 300; seed++) {
            expect(rollWildcard(seed)).toBe(legacyRoll(seed));
        }
    });
});
describe('three-gun-era wildcards (rocket | ricochet | chainsaw, goal node 440)', () => {
    for (const wildcard of ['rocket', 'ricochet', 'chainsaw']) {
        it(`'${wildcard}': identical config ⇒ byte-identical artifacts`, () => {
            const a = runMatch({ ...CONFIG, wildcard });
            const b = runMatch({ ...CONFIG, wildcard });
            expect(a.replayJsonl === b.replayJsonl).toBe(true);
            expect(b.events).toEqual(a.events);
            expect(b.telemetry).toEqual(a.telemetry);
            expect(b.round).toEqual(a.round);
            expect(a.wildcard).toBe(wildcard);
        });
        it(`'${wildcard}' differs from the same seed forced to shotgun (the weapon matters)`, () => {
            const a = runMatch({ ...CONFIG, wildcard });
            const b = runMatch({ ...CONFIG, wildcard: 'shotgun' });
            expect(a.replayJsonl).not.toBe(b.replayJsonl);
        });
    }
    it('kill tags come from the six-gun label set (self-kills — rocket jumps gone wrong — stay untagged)', () => {
        const LABELS = ['AK74', 'SPAS12', 'BARRETT', 'ROCKET', 'RICOCHET', 'CHAINSAW'];
        for (const wildcard of ['rocket', 'ricochet', 'chainsaw']) {
            const r = runMatch({ ...CONFIG, wildcard, roundTicks: 3600 });
            for (const k of r.events.filter((e) => e.type === 'kill')) {
                if (k.killer > 0 && k.killer !== k.victim) {
                    expect('weapon' in k && LABELS.includes(k.weapon)).toBe(true);
                }
                else {
                    expect('weapon' in k).toBe(false); // unattributed/self: no tag
                }
            }
        }
    });
});
//# sourceMappingURL=determinism.test.js.map