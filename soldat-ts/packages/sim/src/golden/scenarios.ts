/**
 * Golden-master reference scenarios.
 *
 * Each scenario returns a configured `ScenarioRunner`. They are the canonical
 * fixtures the golden suite replays and asserts against. Everything here is
 * deterministic: fixed initial conditions, no RNG, no clock.
 */
import { ParticleSystem } from '../physics/particles';
import { vec2 } from '../math/vec2';
import { DEFAULT_GRAVITY } from '../constants';
import { ScenarioRunner } from './runner';

/** Gravity used by the reference scenarios (Parts default GRAV, 0.06). */
export const FREEFALL_GRAVITY = DEFAULT_GRAVITY;

/**
 * Single particle in free fall under constant gravity.
 *
 * Configuration: one active particle (id 1), `oneOverMass = 1` (mass 1),
 * `timeStep = 1`, `gravity = 0.06`.
 *
 * NOTE ON DAMPING: the closed-form solution the golden test asserts
 *   v_n = n*g,   y_n = g * n * (n+1) / 2
 * holds only when velocity damping is the identity, i.e. `eDamping = 1`. The
 * conventional RKV value (0.98, shared/Parts.pas:32) is the spark/body Euler
 * damping used in-game; with RKV the velocity would decay geometrically and the
 * trace would no longer match the textbook free-fall recurrence. We therefore
 * pin `eDamping = 1` here so the scenario exercises the exact analytic motion.
 */
export function freeFallScenario(ticks = 600): ScenarioRunner {
  return new ScenarioRunner({
    scenario: 'freeFall',
    ticks,
    setup: () => {
      const sys = new ParticleSystem();
      sys.timeStep = 1;
      sys.gravity = FREEFALL_GRAVITY;
      sys.vDamping = 0;
      sys.eDamping = 1; // identity damping -> textbook free fall (see note above)
      sys.createPart(vec2(0, 0), vec2(0, 0), 1, 1);
      return sys;
    },
  });
}

/**
 * Two particles joined by a distance constraint, falling under gravity.
 *
 * Particle 1 (the anchor) is mass-infinite (`oneOverMass = 0`) so the
 * constraint solver never moves it (Parts.pas:165/190 guard on
 * `OneOverMass[PartA] > 0`); particle 2 hangs below it. Each tick we run the
 * Euler step then satisfy the constraint, mirroring the Verlet-style
 * integrate-then-constrain pattern but driven by the Euler integrator so the
 * scenario shares the same per-tick path as free fall.
 *
 * Rest length is the initial separation, so the pair should settle toward
 * swinging/stretching about that length rather than free-falling apart.
 */
export function twoParticleConstraint(ticks = 600): ScenarioRunner {
  const restLength = 10;
  return new ScenarioRunner({
    scenario: 'twoParticleConstraint',
    ticks,
    setup: () => {
      const sys = new ParticleSystem();
      sys.timeStep = 1;
      sys.gravity = FREEFALL_GRAVITY;
      sys.vDamping = 0;
      sys.eDamping = 1;
      // Anchor: infinite mass. createPart sets oneOverMass = 1/mass, so we
      // overwrite slot 1 to 0 to pin it (matches Pascal's `OneOverMass > 0`
      // guards which skip immovable parts).
      sys.createPart(vec2(0, 0), vec2(0, 0), 1, 1);
      sys.oneOverMass[1] = 0;
      // Hanging part, restLength below the anchor.
      sys.createPart(vec2(0, restLength), vec2(0, 0), 1, 2);
      sys.makeConstraint(1, 2, restLength);
      return sys;
    },
    // Apply the distance constraint after each Euler integration step.
    control: (sys) => {
      // Constraint is satisfied at the END of the previous tick's record via
      // this callback running BEFORE the next integration; satisfy here so the
      // recorded frame already reflects the constraint solve of the prior step.
      sys.satisfyConstraints();
    },
  });
}
