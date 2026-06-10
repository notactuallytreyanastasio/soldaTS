/**
 * Golden-master scenario runner — drives a `ParticleSystem` through a fixed
 * number of deterministic 60 Hz ticks and records a `GoldenTrace`.
 *
 * The runner is PURE and DETERMINISTIC: no wall-clock, no `Date`, no RNG. The
 * tick loop mirrors the server's frame-rate-independent integration loop
 * (docs/rewrite-reference/tick-pipeline.md:187-189 — `DoEulerTimeStepFor` /
 * `DoEulerTimeStep` per tick). Any per-tick force or control input is supplied
 * by the caller's `control` callback, which runs BEFORE the integration step
 * each tick (mirroring force accumulation prior to `Euler`, Parts.pas:111).
 */
import type { ParticleSystem } from '../physics/particles';
import type { GoldenTrace, GoldenFrame } from './trace';
import { snapshotFrame } from './trace';
import { DEFAULT_GOALTICKS } from '../constants';

/**
 * Per-tick control callback. Receives the system and the tick index (1-based,
 * matching the Pascal `for MainControl := 1 to ...` loops). Apply forces / set
 * velocities here; it runs before the integration step on that tick.
 */
export type ControlFn = (system: ParticleSystem, tick: number) => void;

export interface ScenarioConfig {
  /** Scenario name recorded into the trace. */
  scenario: string;
  /** Number of 60 Hz ticks to simulate. */
  ticks: number;
  /** Tick rate recorded into the trace (defaults to GOALTICKS = 60). */
  tickRate?: number;
  /** Builds and configures the initial ParticleSystem (deterministic). */
  setup: () => ParticleSystem;
  /** Optional per-tick force / control input applied before integration. */
  control?: ControlFn;
}

/**
 * A configured, replayable scenario. `run()` is idempotent: it rebuilds the
 * system from `setup()` on every call, so two `run()`s of the same runner are
 * byte-identical (internal determinism).
 */
export class ScenarioRunner {
  constructor(private readonly config: ScenarioConfig) {}

  get scenario(): string {
    return this.config.scenario;
  }

  /**
   * Step the simulation deterministically and record a `GoldenTrace`.
   *
   * Frame 0 captures the initial post-setup state; thereafter each tick `t`
   * applies `control(system, t)`, runs `doEulerTimeStep()` (Parts.pas:97-104),
   * and snapshots the result as frame `t`.
   */
  run(): GoldenTrace {
    const { scenario, ticks, control, setup } = this.config;
    const tickRate = this.config.tickRate ?? DEFAULT_GOALTICKS;
    const system = setup();

    const frames: GoldenFrame[] = [];
    // Frame 0: initial state before any integration.
    frames.push(snapshotFrame(system, 0));

    for (let t = 1; t <= ticks; t++) {
      if (control !== undefined) {
        control(system, t);
      }
      // One 60 Hz tick of Euler integration (tick-pipeline.md:187-189).
      system.doEulerTimeStep();
      frames.push(snapshotFrame(system, t));
    }

    return { tickRate, scenario, frames };
  }
}
