// Determinism (goal node 170): same MatchConfig ⇒ byte-identical artifacts.
// This is the dataset's reproducibility guarantee — a manifest (config +
// seed) fully determines every replay byte.

import { describe, it, expect } from 'vitest';
import { runMatch, type MatchConfig } from './runner';

const CONFIG: MatchConfig = {
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
