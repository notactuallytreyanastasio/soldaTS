// InputController / keyboard-aim state machine tests.
//
// vitest runs in a plain node environment (no DOM), so the controller is
// constructed against tiny WindowLike/CanvasLike fakes that record listeners,
// and events are plain objects dispatched into them. Time is driven through
// readControl's explicit nowMs parameter — no real clocks, fully
// deterministic.

import { describe, it, expect } from 'vitest';
import type { Control } from '@soldat/sim';
import {
  InputController,
  AIM_RADIUS,
  AIM_NUDGE_RATE,
  AIM_SWING_RATE,
  AIM_NUDGE_MS,
  MAX_AIM_DT_MS,
  type CanvasLike,
  type WindowLike,
} from './input';

type Listener = (e: never) => void;
type ListenerMap = Map<string, Listener[]>;

interface Harness {
  input: InputController;
  /** Dispatch a keydown/keyup; returns whether preventDefault was called. */
  key(code: string, down: boolean, repeat?: boolean): boolean;
  mouseMove(clientX: number, clientY: number): void;
  mouseDown(button: number): void;
  mouseUp(button: number): void;
  blur(): void;
}

function makeHarness(): Harness {
  const winListeners: ListenerMap = new Map();
  const canvasListeners: ListenerMap = new Map();
  const adder =
    (map: ListenerMap) =>
    (type: string, listener: Listener): void => {
      const arr = map.get(type) ?? [];
      arr.push(listener);
      map.set(type, arr);
    };
  const win: WindowLike = { addEventListener: adder(winListeners) };
  const canvas: CanvasLike = {
    addEventListener: adder(canvasListeners),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const input = new InputController(canvas, win);

  const dispatch = (map: ListenerMap, type: string, e: unknown): void => {
    for (const l of map.get(type) ?? []) l(e as never);
  };

  return {
    input,
    key(code, down, repeat = false): boolean {
      let prevented = false;
      dispatch(winListeners, down ? 'keydown' : 'keyup', {
        code,
        repeat,
        preventDefault: () => {
          prevented = true;
        },
      });
      return prevented;
    },
    mouseMove(clientX, clientY): void {
      dispatch(canvasListeners, 'mousemove', {
        clientX,
        clientY,
        button: 0,
        preventDefault: () => {},
      });
    },
    mouseDown(button): void {
      dispatch(canvasListeners, 'mousedown', {
        button,
        clientX: 0,
        clientY: 0,
        preventDefault: () => {},
      });
    },
    mouseUp(button): void {
      dispatch(winListeners, 'mouseup', {
        button,
        clientX: 0,
        clientY: 0,
        preventDefault: () => {},
      });
    },
    blur(): void {
      dispatch(winListeners, 'blur', {});
    },
  };
}

/** Mutable clock + fixed-step frame driver. */
function makeClock(start = 1000): {
  read(h: Harness): Control;
  step(h: Harness, dtMs: number, frames: number): Control;
  now(): number;
} {
  let now = start;
  return {
    read: (h) => h.input.readControl(0, 0, now),
    step: (h, dtMs, frames) => {
      let c!: Control;
      for (let i = 0; i < frames; i++) {
        now += dtMs;
        c = h.input.readControl(0, 0, now);
      }
      return c;
    },
    now: () => now,
  };
}

describe('key mapping', () => {
  it('Tab sets reload and preventDefaults on both keydown and keyup', () => {
    const h = makeHarness();
    const clock = makeClock();
    expect(h.key('Tab', true)).toBe(true); // focus must NOT move
    expect(clock.read(h).reload).toBe(true);
    expect(h.key('Tab', false)).toBe(true);
    expect(clock.read(h).reload).toBe(false);
  });

  it('Shift+Tab sets BOTH jetpack and reload (e.code matching)', () => {
    const h = makeHarness();
    const clock = makeClock();
    h.key('ShiftLeft', true);
    expect(h.key('Tab', true)).toBe(true);
    const c = clock.read(h);
    expect(c.jetpack).toBe(true);
    expect(c.reload).toBe(true);
  });

  it('Space fires and does NOT jump; W jumps', () => {
    const h = makeHarness();
    const clock = makeClock();
    h.key('Space', true);
    let c = clock.read(h);
    expect(c.fire).toBe(true);
    expect(c.up).toBe(false);
    h.key('Space', false);
    h.key('KeyW', true);
    c = clock.read(h);
    expect(c.fire).toBe(false);
    expect(c.up).toBe(true);
  });

  it('fire is an OR of Space and left mouse button (independent release)', () => {
    const h = makeHarness();
    const clock = makeClock();
    h.mouseDown(0);
    h.key('Space', true);
    h.key('Space', false);
    expect(clock.read(h).fire).toBe(true); // mouse still held
    h.mouseUp(0);
    expect(clock.read(h).fire).toBe(false);
  });

  it('window blur clears all held inputs but keeps the aim angle', () => {
    const h = makeHarness();
    const clock = makeClock();
    h.input.setAimAngle(-Math.PI / 4);
    h.key('Space', true);
    h.key('ShiftLeft', true);
    h.key('KeyD', true);
    h.key('KeyL', true);
    h.blur();
    const c = clock.read(h);
    expect(c.fire).toBe(false);
    expect(c.jetpack).toBe(false);
    expect(c.right).toBe(false);
    // aimRight was cleared too: the angle must not have rotated, and it is
    // retained (cos/sin of -45° at r=120 rounds to (85, -85)).
    expect(h.input.aimAngleRad).toBeCloseTo(-Math.PI / 4, 12);
    expect(c.mouseAimX).toBe(85);
    expect(c.mouseAimY).toBe(-85);
  });
});

describe('keyboard aim state machine', () => {
  it('defaults to keys mode aiming right: (AIM_RADIUS, 0)', () => {
    const h = makeHarness();
    const c = makeClock().read(h);
    expect(c.mouseAimX).toBe(AIM_RADIUS);
    expect(c.mouseAimY).toBe(0);
  });

  it('rotates nudge-then-swing toward the target and settles exactly', () => {
    const h = makeHarness();
    const clock = makeClock();
    clock.read(h); // establish lastNowMs
    h.key('KeyI', true); // aim straight up: target -PI/2
    const dtMs = 16;
    const dt = dtMs / 1000;

    // First frame: chord just changed → nudge rate, rotating negative (up).
    clock.step(h, dtMs, 1);
    expect(h.input.aimAngleRad).toBeCloseTo(-AIM_NUDGE_RATE * dt, 12);

    // Frames at chord offsets 16..64 ms are still nudge (< AIM_NUDGE_MS).
    clock.step(h, dtMs, 4);
    expect(h.input.aimAngleRad).toBeCloseTo(-AIM_NUDGE_RATE * 5 * dt, 12);

    // Next frame crosses AIM_NUDGE_MS → swing rate.
    const before = h.input.aimAngleRad;
    clock.step(h, dtMs, 1);
    expect(h.input.aimAngleRad).toBeCloseTo(before - AIM_SWING_RATE * dt, 12);

    // Held long enough: clamps EXACTLY onto -PI/2, no overshoot, and the
    // output is the vertical ring point with the ±1 px facing bias.
    const c = clock.step(h, dtMs, 60);
    expect(h.input.aimAngleRad).toBe(-Math.PI / 2);
    expect(c.mouseAimY).toBe(-AIM_RADIUS);
    expect(c.mouseAimX).toBe(1); // facing bias, default right
  });

  it('vertical aim carries the last horizontal facing as a ±1 px bias', () => {
    const h = makeHarness();
    const clock = makeClock();
    clock.read(h);

    // Aim left (instant mirror-flip from 0 to PI), settle.
    h.key('KeyJ', true);
    let c = clock.step(h, 16, 5);
    expect(c.mouseAimX).toBe(-AIM_RADIUS);
    h.key('KeyJ', false);

    // Now straight up: bias must remember LEFT.
    h.key('KeyI', true);
    c = clock.step(h, 16, 80);
    expect(h.input.aimAngleRad).toBe(-Math.PI / 2);
    expect(c.mouseAimX).toBe(-1);
    expect(c.mouseAimY).toBe(-AIM_RADIUS);
  });

  it('persists the angle indefinitely once all aim keys are released', () => {
    const h = makeHarness();
    const clock = makeClock();
    clock.read(h);
    h.key('KeyI', true);
    h.key('KeyL', true);
    clock.step(h, 16, 60); // settle on the up-right diagonal
    h.key('KeyI', false);
    h.key('KeyL', false);
    for (let i = 0; i < 100; i++) {
      const c = clock.step(h, 16, 1);
      expect(c.mouseAimX).toBe(85); // round(120·cos45°)
      expect(c.mouseAimY).toBe(-85);
    }
    expect(h.input.aimAngleRad).toBe(-Math.PI / 4);
  });

  it('opposing aim keys cancel: angle does not move', () => {
    const h = makeHarness();
    const clock = makeClock();
    h.input.setAimAngle(0.7);
    clock.read(h);
    h.key('KeyJ', true);
    h.key('KeyL', true);
    clock.step(h, 16, 30);
    expect(h.input.aimAngleRad).toBeCloseTo(0.7, 12);
    h.key('KeyJ', false);
    h.key('KeyL', false);
    h.key('KeyI', true);
    h.key('KeyK', true);
    clock.step(h, 16, 30);
    expect(h.input.aimAngleRad).toBeCloseTo(0.7, 12);
  });

  it('I+L settles on the up-right diagonal: output (85, -85)', () => {
    const h = makeHarness();
    const clock = makeClock();
    clock.read(h);
    h.key('KeyI', true);
    h.key('KeyL', true);
    const c = clock.step(h, 16, 60);
    expect(h.input.aimAngleRad).toBe(-Math.PI / 4);
    expect(c.mouseAimX).toBe(85);
    expect(c.mouseAimY).toBe(-85);
  });

  it('mirror-flips instantly across the vertical axis, preserving elevation', () => {
    const h = makeHarness();
    const clock = makeClock();
    h.input.setAimAngle(-Math.PI / 6); // up-right, 30° elevation
    h.key('KeyJ', true); // pure-horizontal press against facing
    clock.read(h); // first frame ever → dt = 0, so only the mirror acts
    expect(h.input.aimAngleRad).toBeCloseTo((-5 * Math.PI) / 6, 12);
    // Elevation preserved: sin(-30°) === sin(-150°).
    expect(Math.sin(h.input.aimAngleRad)).toBeCloseTo(-0.5, 12);
  });

  it('does NOT mirror-flip within the near-vertical guard band', () => {
    const h = makeHarness();
    const clock = makeClock();
    const start = (-80 * Math.PI) / 180; // |cos| ≈ 0.17 < AIM_FLIP_COS_GUARD
    h.input.setAimAngle(start);
    h.key('KeyJ', true);
    clock.read(h); // dt = 0: no mirror means no movement at all
    expect(h.input.aimAngleRad).toBeCloseTo(start, 12);
    // Subsequent frames move smoothly by at most rate·dt (toward PI, via up).
    clock.step(h, 16, 1);
    expect(h.input.aimAngleRad).toBeCloseTo(start - AIM_NUDGE_RATE * 0.016, 12);
  });

  it('rotation is dt-independent (same duration, different frame rates)', () => {
    // Within the nudge phase (48 ms < AIM_NUDGE_MS) the comparison is exact.
    const angleAfter = (dtMs: number, frames: number): number => {
      const h = makeHarness();
      const clock = makeClock();
      clock.read(h);
      h.key('KeyI', true);
      clock.step(h, dtMs, frames);
      return h.input.aimAngleRad;
    };
    expect(Math.abs(angleAfter(16, 3) - angleAfter(8, 6))).toBeLessThan(1e-9);
    // And both frame rates settle on exactly the same target after ~1 s.
    expect(angleAfter(16, 60)).toBe(angleAfter(8, 120));
    expect(angleAfter(16, 60)).toBe(-Math.PI / 2);
  });

  it('clamps a stalled frame: 500 ms gap rotates at most swing·50ms', () => {
    const h = makeHarness();
    const clock = makeClock();
    clock.read(h);
    h.key('KeyI', true);
    clock.step(h, 1, 1); // chord starts; tiny nudge rotation
    const before = h.input.aimAngleRad;
    clock.step(h, 500, 1); // stalled frame
    const rotated = Math.abs(h.input.aimAngleRad - before);
    expect(rotated).toBeCloseTo(AIM_SWING_RATE * (MAX_AIM_DT_MS / 1000), 12);
    expect(rotated).toBeLessThanOrEqual(0.7 + 1e-12);
  });

  it('a chord change drops back to the nudge rate', () => {
    const h = makeHarness();
    const clock = makeClock();
    clock.read(h);
    h.key('KeyL', true); // target 0 = current angle: parked, clock running
    clock.step(h, 16, 13); // > AIM_NUDGE_MS held: swing phase reached
    h.key('KeyI', true); // chord changes → nudge phase restarts
    clock.step(h, 16, 1);
    expect(h.input.aimAngleRad).toBeCloseTo(-AIM_NUDGE_RATE * 0.016, 12);
    // After AIM_NUDGE_MS of the new chord, swing applies again.
    clock.step(h, 16, 5);
    const before = h.input.aimAngleRad;
    clock.step(h, 16, 1);
    expect(Math.abs(h.input.aimAngleRad - before)).toBeCloseTo(
      AIM_SWING_RATE * 0.016,
      12,
    );
  });

  it('keydown auto-repeat does not reset the chord clock', () => {
    const h = makeHarness();
    const clock = makeClock();
    clock.read(h);
    h.key('KeyI', true);
    clock.step(h, 16, 3);
    h.key('KeyI', true, true); // OS auto-repeat mid-hold
    clock.step(h, 16, 3); // chord offsets cross AIM_NUDGE_MS on schedule
    const before = h.input.aimAngleRad;
    h.key('KeyI', true, true);
    clock.step(h, 16, 1);
    // Still swing rate: a chordStart reset would have made this a nudge step.
    expect(Math.abs(h.input.aimAngleRad - before)).toBeCloseTo(
      AIM_SWING_RATE * 0.016,
      12,
    );
  });

  it('uses the documented 180° tie-break (up → down rotates by cos rule)', () => {
    const h = makeHarness();
    const clock = makeClock();
    h.input.setAimAngle(-Math.PI / 2); // straight up
    clock.read(h);
    h.key('KeyK', true); // straight down: exactly 180° away
    // cos(-PI/2) >= 0 → delta = -PI: rotation goes NEGATIVE (via the left).
    clock.step(h, 16, 1);
    const first = h.input.aimAngleRad;
    expect(first).toBeCloseTo(-Math.PI / 2 - AIM_NUDGE_RATE * 0.016, 12);
    // Stable across frames: keeps rotating the same way (no flip-flopping).
    clock.step(h, 16, 1);
    expect(h.input.aimAngleRad).toBeLessThan(first);
  });
});

describe('mouse handoff', () => {
  it('mouse steals aim only past the takeover threshold; IJKL seeds back', () => {
    const h = makeHarness();
    const clock = makeClock();
    clock.read(h);
    h.key('KeyI', true);
    h.key('KeyL', true);
    clock.step(h, 16, 60); // settle keys aim at -PI/4 → (85, -85)
    h.key('KeyI', false);
    h.key('KeyL', false);

    // Sub-threshold jitter does NOT steal aim. (The first event is
    // baseline-only — it establishes where the cursor is; the second adds
    // 1 px of travel.)
    h.mouseMove(1, 0);
    h.mouseMove(2, 0);
    let c = clock.step(h, 16, 1);
    expect(c.mouseAimX).toBe(85);
    expect(c.mouseAimY).toBe(-85);

    // A real move does: output becomes cursor minus player screen position.
    h.mouseMove(200, 50);
    c = clock.step(h, 16, 1);
    expect(c.mouseAimX).toBe(200);
    expect(c.mouseAimY).toBe(50);

    // Any aim key reclaims, seeded from the last emitted offset: the very
    // next frame (same nowMs → dt 0) starts at atan2 of that offset, so the
    // crosshair does not jump.
    h.key('KeyI', true);
    c = h.input.readControl(0, 0, clock.now());
    expect(h.input.aimAngleRad).toBeCloseTo(Math.atan2(50, 200), 12);
    expect(c.mouseAimX).toBe(Math.round(Math.cos(Math.atan2(50, 200)) * AIM_RADIUS));
    expect(c.mouseAimY).toBe(Math.round(Math.sin(Math.atan2(50, 200)) * AIM_RADIUS));
  });

  it('first mousemove at a realistic cursor position is baseline-only', () => {
    const h = makeHarness();
    const clock = makeClock();
    clock.read(h);
    h.key('KeyI', true);
    h.key('KeyL', true);
    clock.step(h, 16, 60); // settle keys aim at -PI/4 → (85, -85)
    h.key('KeyI', false);
    h.key('KeyL', false);

    // The very first mousemove of a session lands wherever the cursor
    // happens to sit — hundreds of px from the 0,0-initialised state. That
    // absolute jump must NOT count as travel: a keyboard-only player keeps
    // their aim.
    h.mouseMove(400, 300);
    let c = clock.step(h, 16, 1);
    expect(c.mouseAimX).toBe(85);
    expect(c.mouseAimY).toBe(-85);

    // Sub-threshold physical jitter from that baseline still doesn't steal
    // (1 px accumulated < MOUSE_TAKEOVER_PX).
    h.mouseMove(401, 300);
    c = clock.step(h, 16, 1);
    expect(c.mouseAimX).toBe(85);
    expect(c.mouseAimY).toBe(-85);

    // Real movement past the threshold takes over as usual.
    h.mouseMove(406, 300);
    c = clock.step(h, 16, 1);
    expect(c.mouseAimX).toBe(406);
    expect(c.mouseAimY).toBe(300);
  });
});
