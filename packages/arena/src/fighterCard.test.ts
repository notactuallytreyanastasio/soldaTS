// Claude Arena fighter cards: validation + the watch-URL builder.

import { describe, it, expect } from 'vitest';
import { buildWatchUrl, tweaksToParam, validateCard } from './fighterCard';

const good = {
  schema: 'soldat-fighter-card/1',
  coach: 'VEGA',
  engine: 'pilot',
  tweaks: { RANGE_MAX: 360 },
  rationale: 'tight band',
};

describe('validateCard', () => {
  it('accepts a valid card and resolves the full config', () => {
    const { card, resolved } = validateCard(good);
    expect(card.coach).toBe('VEGA');
    expect(resolved['RANGE_MAX']).toBe(360);
    expect(resolved['RANGE_MIN']).toBe(200); // default carried through
  });

  it('rejects wrong schema, missing coach, unknown engine, bad knobs', () => {
    expect(() => validateCard({ ...good, schema: 'nope' })).toThrow(/schema/);
    expect(() => validateCard({ ...good, coach: '' })).toThrow(/coach/);
    expect(() => validateCard({ ...good, engine: 'gpt' })).toThrow(/engine/);
    expect(() => validateCard({ ...good, tweaks: { NOT_A_KNOB: 1 } })).toThrow(
      /unknown knob/,
    );
    expect(() => validateCard({ ...good, tweaks: { RANGE_MAX: NaN } })).toThrow(
      /finite/,
    );
  });

  it('empty tweaks = factory defaults', () => {
    const { resolved } = validateCard({ ...good, tweaks: {} });
    expect(resolved['RANGE_MAX']).toBe(420);
  });
});

describe('watch URL', () => {
  it('encodes engines, seeds, both tweak sets, and coach names', () => {
    const a = validateCard(good).card;
    const b = validateCard({
      schema: 'soldat-fighter-card/1',
      coach: 'OKONKWO',
      engine: 'reaper',
      tweaks: { KILL_RANGE: 150 },
    }).card;
    const url = buildWatchUrl('http://localhost:5173', a, b, {
      seed: 3001,
      roundSecs: 90,
      arenaSeed: 7,
    });
    expect(url).toContain('ai=pilot%2Creaper');
    expect(url).toContain('seed=3001');
    expect(url).toContain('arena=7');
    expect(url).toContain('coach-a=VEGA');
    expect(url).toContain(encodeURIComponent('KILL_RANGE=150'));
  });

  it('tweaksToParam round-trips the KEY=V,KEY=V format', () => {
    expect(tweaksToParam({ A: 1, B: 2.5 })).toBe('A=1,B=2.5');
    expect(tweaksToParam({})).toBe('');
  });

  it('carries the gameplay variant EXPLICITLY when given, omits it when not (pre-era URLs)', () => {
    const a = validateCard(good).card;
    const b = validateCard({
      schema: 'soldat-fighter-card/1',
      coach: 'OKONKWO',
      engine: 'reaper',
      tweaks: {},
    }).card;
    const opts = { seed: 1, roundSecs: 60, arenaSeed: 0 };
    // SIDEARM ERA: new fights pass the variant so future replays are exact.
    const withVariant = new URL(buildWatchUrl('http://x', a, b, { ...opts, variant: 'sidearm' }));
    expect(withVariant.searchParams.get('variant')).toBe('sidearm');
    // No variant → no param: URLs without ?variant resolve to baseline,
    // which is how every pre-era recorded watch URL stays untouched.
    const without = new URL(buildWatchUrl('http://x', a, b, opts));
    expect(without.searchParams.has('variant')).toBe(false);
  });
});
