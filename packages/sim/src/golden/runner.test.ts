/**
 * ScenarioRunner contract tests.
 *
 * Covers the documented orchestration contract:
 *   - frame 0 is the PRE-integration initial state,
 *   - control runs on every tick 1..ticks (inclusive, 1-based) BEFORE the
 *     Euler step of that tick,
 *   - frame N carries tick number N for N in [0, ticks],
 *   - scenario name / tickRate (default 60, overridable) are recorded,
 *   - run() is idempotent (setup() rebuilds the system every call).
 */
import { describe, it, expect } from 'vitest';
import { ParticleSystem } from '../physics/particles';
import { vec2 } from '../math/vec2';
import { ScenarioRunner } from './runner';

/** One unit-mass particle at the origin; identity damping, no gravity. */
function quietSystem(): ParticleSystem {
  const sys = new ParticleSystem();
  sys.timeStep = 1;
  sys.gravity = 0;
  sys.vDamping = 0;
  sys.eDamping = 1;
  sys.createPart(vec2(0, 0), vec2(0, 0), 1, 1);
  return sys;
}

describe('ScenarioRunner.run — frame capture', () => {
  it('captures frame 0 BEFORE any integration (initial state survives gravity)', () => {
    const runner = new ScenarioRunner({
      scenario: 'frame0',
      ticks: 3,
      setup: () => {
        const sys = quietSystem();
        sys.gravity = 0.06; // would move the particle on the first step
        return sys;
      },
    });
    const trace = runner.run();
    const f0 = trace.frames[0]!;
    expect(f0.tick).toBe(0);
    expect(f0.particles[0]!.y).toBe(0);
    expect(f0.particles[0]!.vy).toBe(0);
    // ...and the very next frame HAS integrated.
    expect(trace.frames[1]!.particles[0]!.vy).toBeGreaterThan(0);
  });

  it('records ticks+1 frames, frame N labeled with tick N', () => {
    const trace = new ScenarioRunner({
      scenario: 'labels',
      ticks: 5,
      setup: quietSystem,
    }).run();
    expect(trace.frames).toHaveLength(6);
    trace.frames.forEach((frame, n) => {
      expect(frame.tick).toBe(n);
    });
  });

  it('records scenario name and the default tickRate of 60', () => {
    const runner = new ScenarioRunner({
      scenario: 'meta',
      ticks: 1,
      setup: quietSystem,
    });
    expect(runner.scenario).toBe('meta');
    const trace = runner.run();
    expect(trace.scenario).toBe('meta');
    expect(trace.tickRate).toBe(60);
  });

  it('honours an explicit tickRate override', () => {
    const trace = new ScenarioRunner({
      scenario: 'meta30',
      ticks: 1,
      tickRate: 30,
      setup: quietSystem,
    }).run();
    expect(trace.tickRate).toBe(30);
  });

  it('ticks: 0 yields only the initial frame and never calls control', () => {
    const calls: number[] = [];
    const trace = new ScenarioRunner({
      scenario: 'zero',
      ticks: 0,
      setup: quietSystem,
      control: (_sys, t) => calls.push(t),
    }).run();
    expect(trace.frames).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});

describe('ScenarioRunner.run — control callback contract', () => {
  it('calls control once per tick, 1-based, in ascending order', () => {
    const calls: number[] = [];
    new ScenarioRunner({
      scenario: 'order',
      ticks: 4,
      setup: quietSystem,
      control: (_sys, t) => calls.push(t),
    }).run();
    expect(calls).toEqual([1, 2, 3, 4]);
  });

  it('control runs BEFORE the integration step of its tick', () => {
    // On tick 2 the control sets a velocity; if control ran before the step,
    // frame 2 already shows the displacement (pos += velocity in euler()).
    const trace = new ScenarioRunner({
      scenario: 'pre-step',
      ticks: 3,
      setup: quietSystem,
      control: (sys, t) => {
        if (t === 2) {
          sys.velocityX[1] = 5;
        }
      },
    }).run();
    expect(trace.frames[1]!.particles[0]!.x).toBe(0); // untouched on tick 1
    expect(trace.frames[2]!.particles[0]!.x).toBe(5); // moved within tick 2
    expect(trace.frames[3]!.particles[0]!.x).toBe(10); // velocity persists (eDamping 1)
  });

  it('forces applied in control are consumed by the SAME tick', () => {
    const trace = new ScenarioRunner({
      scenario: 'force',
      ticks: 2,
      setup: quietSystem,
      control: (sys, t) => {
        if (t === 1) {
          sys.forceX[1] = 3; // mass 1, timeStep 1 -> velocity += 3, pos += 3
        }
      },
    }).run();
    expect(trace.frames[1]!.particles[0]!.vx).toBe(3);
    expect(trace.frames[1]!.particles[0]!.x).toBe(3);
    // Forces are zeroed by euler(); tick 2 adds no further impulse.
    expect(trace.frames[2]!.particles[0]!.vx).toBe(3);
    expect(trace.frames[2]!.particles[0]!.x).toBe(6);
  });

  it('control receives the live system built by setup()', () => {
    let built: ParticleSystem | null = null;
    let seen: ParticleSystem | null = null;
    new ScenarioRunner({
      scenario: 'identity',
      ticks: 1,
      setup: () => {
        built = quietSystem();
        return built;
      },
      control: (sys) => {
        seen = sys;
      },
    }).run();
    expect(seen).not.toBeNull();
    expect(seen).toBe(built);
  });
});

describe('ScenarioRunner.run — idempotence', () => {
  it('two runs produce byte-identical traces and re-invoke setup()', () => {
    let setupCalls = 0;
    const runner = new ScenarioRunner({
      scenario: 'twice',
      ticks: 10,
      setup: () => {
        setupCalls++;
        const sys = quietSystem();
        sys.gravity = 0.06;
        return sys;
      },
    });
    const a = runner.run();
    const b = runner.run();
    expect(setupCalls).toBe(2);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
