import { snapshotFrame } from './trace';
import { DEFAULT_GOALTICKS } from '../constants';
/**
 * A configured, replayable scenario. `run()` is idempotent: it rebuilds the
 * system from `setup()` on every call, so two `run()`s of the same runner are
 * byte-identical (internal determinism).
 */
export class ScenarioRunner {
    config;
    constructor(config) {
        this.config = config;
    }
    get scenario() {
        return this.config.scenario;
    }
    /**
     * Step the simulation deterministically and record a `GoldenTrace`.
     *
     * Frame 0 captures the initial post-setup state; thereafter each tick `t`
     * applies `control(system, t)`, runs `doEulerTimeStep()` (Parts.pas:97-104),
     * and snapshots the result as frame `t`.
     */
    run() {
        const { scenario, ticks, control, setup } = this.config;
        const tickRate = this.config.tickRate ?? DEFAULT_GOALTICKS;
        const system = setup();
        const frames = [];
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
//# sourceMappingURL=runner.js.map