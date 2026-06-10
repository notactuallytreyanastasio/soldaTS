// Keyboard + mouse input → a sim Control snapshot.
//
// GLUE module (no faithful provenance to a single Pascal file): OpenSoldat reads
// raw keyboard/mouse state in Control.pas (PlayerControl) and packs it into the
// per-sprite TControl record each tick. Here we mirror that shape: we listen to
// DOM key/mouse events, keep a small live state object, and hand back a freshly
// built Control via readControl() that the game loop copies onto the player
// sprite each tick (sim Control = packages/sim entities/types.ts TControl).
//
// We never mutate the sprite directly here; readControl() returns a plain
// snapshot so the caller stays in charge of ordering (read → set → step).
//
// KEYBOARD-ONLY PLAY. The game is fully playable with no mouse, using only
// W A S D, I J K L, Tab, Space and Shift:
//
//   A / D   move left / right        I J K L  aim up / left / down / right
//   W       jump (engine "up")       Space    FIRE (hold = full-auto)
//   S       crouch / down            Tab / B  switch weapon (AK-74 ⇄ SPAS-12)
//   Shift   jetpack (hold)           R        reload
//
// Shift carries the longest-held action and Space the most critical one on
// purpose: this scheme holds 4+ keys at once and cheap membrane keyboards
// ghost under that load, but modifier keys and Space are the most
// rollover-safe positions. All matching is on e.code so Shift-chords can't
// change what the other keys report.
//
// Aim contract: the sim consumes Control.mouseAimX/mouseAimY, an integer
// OFFSET VECTOR from the player's screen position. Keyboard aim therefore
// keeps a continuous angle (radians, screen convention: 0 = right,
// +PI/2 = DOWN because canvas y grows downward) and emits
// cos/sin · AIM_RADIUS through the exact same fields — game.ts ballistics,
// the crosshair draw and the sim are untouched, and the mouse stays as a
// fully optional secondary input.
//
// The IJKL aim state machine (mechanics in readControl):
//   * Held chords steer toward one of 8 octant targets (I+L etc. are the
//     diagonals; opposing keys cancel that axis) with a two-phase rate: a
//     slow "nudge" for the first AIM_NUDGE_MS after every chord change
//     (taps = fine ~3–9° adjustments), then a fast "swing" (90° in ~175 ms).
//     Releasing mid-swing parks the continuous angle anywhere in between, so
//     every angle in [0, 2π) is reachable, not just the 8 reference lines.
//   * Releasing everything FREEZES the angle. Mandatory: game.ts normalises
//     the aim vector per bullet, so a zeroed/reset aim would snap fire back
//     to horizontal and ruin spray control.
//   * A pure-horizontal press against the current facing mirror-flips the
//     angle across the vertical axis instantly (π − angle), preserving
//     elevation — the keyboard equivalent of whipping the mouse across the
//     body in a reaction duel.
//   * ALL rotation is rad/s scaled by real dt: readControl runs once per
//     RENDER frame (requestAnimationFrame), not per 60 Hz sim tick, so
//     per-frame constants would aim twice as fast on a 120 Hz display.
//
// Mouse handoff: moving the mouse more than MOUSE_TAKEOVER_PX (accumulated)
// reclaims aim for the cursor — the threshold stops desk vibration from
// yanking aim away mid-spray. Any IJKL press hands aim back to the keyboard,
// seeded from the last emitted offset so the crosshair never teleports.

import type { Control } from '@soldat/sim';

// --- Keyboard-aim tuning (exported for tests) ---------------------------

/**
 * Keyboard aim ring radius in screen px. Integer rounding error at r=120 is
 * atan(0.5/120) ≈ 0.24°, below game.ts SPREAD_BASE (0.86°), and far above
 * game.ts's len<1e-3 degenerate-aim guard. The crosshair draws at a readable
 * distance from the body.
 */
export const AIM_RADIUS = 120;
/** rad/s, fine-adjust phase. One 60 Hz-frame tap ≈ 2.9°; a 50 ms tap ≈ 8.6°. */
export const AIM_NUDGE_RATE = 3.0;
/** rad/s, fast phase. 90° in ~175 ms. */
export const AIM_SWING_RATE = 14.0;
/**
 * The nudge phase lasts this long after each chord change, then the swing
 * rate applies (a step, no ramp).
 */
export const AIM_NUDGE_MS = 80;
/** Mirror-flip only when aim is >~15° away from vertical (|cos| above this). */
export const AIM_FLIP_COS_GUARD = 0.26;
/** Accumulated mousemove distance (px) needed to steal aim back to the mouse. */
export const MOUSE_TAKEOVER_PX = 3;
/** Clamp dt so a stalled frame / tab-back can't teleport the aim. */
export const MAX_AIM_DT_MS = 50;

// --- Control bindings (single source of truth for the controls screen) --
// KEEP IN SYNC WITH the onKey switch below — input.test.ts asserts that
// every code listed here is actually handled by the controller (handled
// keys call preventDefault, unhandled ones don't), so the startup controls
// screen can never silently drift from the real bindings.

/** One row of the player-facing controls listing. */
export interface ControlBinding {
  /** Human-readable key labels shown on the controls screen. */
  keys: string[];
  /** KeyboardEvent.code values the controller handles for this action (empty for mouse-only rows). */
  codes: string[];
  /** What the keys do, in player terms. */
  action: string;
}

export const CONTROL_BINDINGS: readonly ControlBinding[] = [
  { keys: ['A', 'D'], codes: ['KeyA', 'KeyD'], action: 'Move left / right' },
  { keys: ['W'], codes: ['KeyW'], action: 'Jump' },
  { keys: ['S'], codes: ['KeyS'], action: 'Crouch' },
  {
    keys: ['Shift'],
    codes: ['ShiftLeft', 'ShiftRight'],
    action: 'Jetpack (hold)',
  },
  {
    keys: ['I', 'J', 'K', 'L'],
    codes: ['KeyI', 'KeyJ', 'KeyK', 'KeyL'],
    action:
      'Aim up / left / down / right — combine for diagonals; aim stays where you leave it',
  },
  { keys: ['Space'], codes: ['Space'], action: 'Fire (hold for full-auto)' },
  {
    keys: ['Tab', 'B'],
    codes: ['Tab', 'KeyB'],
    action: 'Switch weapon (AK-74 / SPAS-12)',
  },
  { keys: ['R'], codes: ['KeyR'], action: 'Reload' },
  {
    keys: ['Mouse'],
    codes: [],
    action: 'Optional — move to take over aim, left button fires',
  },
];

// --- Structural DOM slices (so tests can run without a DOM) -------------
// vitest runs in a plain node environment; the controller therefore depends
// only on these minimal shapes. Real Window / HTMLCanvasElement satisfy them
// structurally. The listener parameter is `(e: any) => void` on purpose: it
// is the only type both the DOM's overloaded addEventListener declarations
// and our narrow KeyEventLike/MouseEventLike handlers are assignable to
// under strictFunctionTypes (a `never`/`unknown` param fails one direction
// or the other).

/** The slice of Window the controller needs. */
export interface WindowLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: (e: any) => void): void;
}

/** The slice of HTMLCanvasElement the controller needs. */
export interface CanvasLike extends WindowLike {
  getBoundingClientRect(): { left: number; top: number };
}

/** The slice of KeyboardEvent the controller reads. */
export interface KeyEventLike {
  readonly code: string;
  preventDefault(): void;
}

/** The slice of MouseEvent the controller reads. */
export interface MouseEventLike {
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
  preventDefault(): void;
}

/** Live key/pointer state, updated by DOM listeners. */
interface InputState {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  /**
   * Fire is split per source so a Space keyup can't cancel a held mouse
   * button (and vice versa); readControl ORs them into Control.fire.
   */
  fireKey: boolean;
  fireMouse: boolean;
  jetpack: boolean;
  throwNade: boolean;
  reload: boolean;
  /** Weapon-swap key held (Tab / B); the game toggles on the rising edge. */
  changeWeapon: boolean;
  /** IJKL aim intent (held booleans; the angle math lives in readControl). */
  aimUp: boolean;
  aimDown: boolean;
  aimLeft: boolean;
  aimRight: boolean;
  /** Mouse position in CSS pixels relative to the canvas (cursor aim). */
  mouseX: number;
  mouseY: number;
}

/** Wrap an angle into (-PI, PI]. */
function normalizeAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/**
 * Handles raw DOM input and exposes a sim Control snapshot.
 *
 * Construct with the canvas element so mouse coordinates are canvas-relative
 * (matching where the player is drawn). Call {@link readControl} once per
 * render frame. The window parameter exists for tests (node has no DOM).
 */
export class InputController {
  private readonly state: InputState = {
    left: false,
    right: false,
    up: false,
    down: false,
    fireKey: false,
    fireMouse: false,
    jetpack: false,
    throwNade: false,
    reload: false,
    changeWeapon: false,
    aimUp: false,
    aimDown: false,
    aimLeft: false,
    aimRight: false,
    mouseX: 0,
    mouseY: 0,
  };

  private readonly canvas: CanvasLike;

  // --- Keyboard-aim state -----------------------------------------------
  /**
   * Aim angle in radians, screen convention: 0 = right, +PI/2 = DOWN (canvas
   * y grows down), -PI/2 = up. Init 0 matches game.ts's spawn default
   * mouseAimX=100, mouseAimY=0.
   */
  private aimAngle = 0;
  /** Horizontal facing memory for the vertical-aim ±1 px bias (see output). */
  private lastFacing: 1 | -1 = 1;
  /** Start in keys mode so the game is keyboard-playable from frame one. */
  private aimMode: 'keys' | 'mouse' = 'keys';
  /** Set on mouse→keys handoff; readControl seeds aimAngle from lastAimX/Y. */
  private seedFromLastOffset = false;
  /** 4-bit mask of held IJKL from the PREVIOUS readControl frame. */
  private prevChordMask = 0;
  /** When the current chord composition began (nudge-phase reference). */
  private chordStartMs = 0;
  private lastNowMs: number | null = null;
  /** Last emitted mouseAimX/Y (any source) — seeds the mouse→keys handoff. */
  private lastAimX = 100;
  private lastAimY = 0;
  /** Accumulated mousemove px while in keys mode (keys→mouse takeover). */
  private mouseTakeoverAccum = 0;
  /**
   * False until the first mousemove. mouseX/mouseY start at 0,0, which is NOT
   * where the cursor is — without this flag the first event of a session
   * would count the cursor's absolute canvas position (hundreds of px) as
   * "travel" and instantly steal aim from the keyboard on a sub-pixel
   * physical movement. The first sample is baseline-only.
   */
  private hasMouseSample = false;

  constructor(canvas: CanvasLike, win: WindowLike = window) {
    this.canvas = canvas;
    this.attach(win);
  }

  /** Wire up keyboard + mouse listeners on window / the canvas. */
  private attach(win: WindowLike): void {
    win.addEventListener('keydown', this.onKey(true));
    win.addEventListener('keyup', this.onKey(false));

    // Focus-loss hardening: if the page loses focus (Cmd+Tab, click outside),
    // the matching keyup/mouseup lands in another app and every held flag
    // would stick on (fire/jet/movement running away). Drop them all; keep
    // mouseX/mouseY and the aim angle — position is not a "held" input.
    win.addEventListener('blur', () => {
      const s = this.state;
      s.left = false;
      s.right = false;
      s.up = false;
      s.down = false;
      s.fireKey = false;
      s.fireMouse = false;
      s.jetpack = false;
      s.throwNade = false;
      s.reload = false;
      s.changeWeapon = false;
      s.aimUp = false;
      s.aimDown = false;
      s.aimLeft = false;
      s.aimRight = false;
    });

    // Mouse aim (optional secondary input): track the cursor in canvas-local
    // CSS pixels. While the keyboard owns aim, accumulate travel distance and
    // only steal aim back once it exceeds MOUSE_TAKEOVER_PX, so a nudged desk
    // doesn't yank a keyboard spray off-target.
    this.canvas.addEventListener('mousemove', (e: MouseEventLike) => {
      const rect = this.canvas.getBoundingClientRect();
      const nx = e.clientX - rect.left;
      const ny = e.clientY - rect.top;
      // The first event only establishes the baseline: mouseX/mouseY init to
      // 0,0 (not the real cursor position), so counting the jump from there
      // as travel would steal aim on page load from a sub-pixel movement.
      if (this.aimMode === 'keys' && this.hasMouseSample) {
        this.mouseTakeoverAccum +=
          Math.abs(nx - this.state.mouseX) + Math.abs(ny - this.state.mouseY);
        if (this.mouseTakeoverAccum > MOUSE_TAKEOVER_PX) {
          this.aimMode = 'mouse';
          this.mouseTakeoverAccum = 0;
        }
      }
      this.hasMouseSample = true;
      this.state.mouseX = nx;
      this.state.mouseY = ny;
    });

    // Fire: left mouse button (kept alongside Space; readControl ORs them).
    // Suppress the context menu for right-click nade.
    this.canvas.addEventListener('mousedown', (e: MouseEventLike) => {
      if (e.button === 0) this.state.fireMouse = true;
      if (e.button === 2) this.state.throwNade = true;
    });
    win.addEventListener('mouseup', (e: MouseEventLike) => {
      if (e.button === 0) this.state.fireMouse = false;
      if (e.button === 2) this.state.throwNade = false;
    });
    this.canvas.addEventListener('contextmenu', (e: MouseEventLike) => {
      e.preventDefault();
    });
  }

  /**
   * An IJKL key went down: the keyboard claims aim. If the mouse owned it,
   * arm the handoff seed so the next readControl starts from the last emitted
   * offset (no crosshair teleport). Resetting the takeover accumulator here
   * also stops slow cursor drift from banking up a takeover mid-keyboard-aim.
   */
  private claimKeyboardAim(): void {
    if (this.aimMode === 'mouse') {
      this.aimMode = 'keys';
      this.seedFromLastOffset = true;
    }
    this.mouseTakeoverAccum = 0;
  }

  /**
   * Build a keydown/keyup handler that flips the matching state flag.
   *
   * All matching is on e.code (physical key), so Shift-chords can't change
   * what a key reports, and every handler is an idempotent boolean assignment
   * — keydown auto-repeat (e.repeat) is harmless because no timing is ever
   * derived from events (the chord clock lives in readControl, recomputed
   * from held booleans each frame).
   */
  private onKey(down: boolean): (e: KeyEventLike) => void {
    return (e: KeyEventLike): void => {
      switch (e.code) {
        // Move left: A / Left arrow.
        case 'KeyA':
        case 'ArrowLeft':
          this.state.left = down;
          break;
        // Move right: D / Right arrow.
        case 'KeyD':
        case 'ArrowRight':
          this.state.right = down;
          break;
        // Jump: W / Up arrow (Control.up, the engine's "jump/jet" key).
        case 'KeyW':
        case 'ArrowUp':
          this.state.up = down;
          break;
        // Down / crouch: S / Down arrow.
        case 'KeyS':
        case 'ArrowDown':
          this.state.down = down;
          break;
        // FIRE: Space (hold = full-auto). Space is deliberately NOT jump.
        case 'Space':
          this.state.fireKey = down;
          break;
        // Jetpack: Shift (modifier keys report reliably under poor key
        // rollover — the longest-held action sits here by design).
        case 'ShiftLeft':
        case 'ShiftRight':
          this.state.jetpack = down;
          break;
        // Weapon swap: Tab / B (toggle AK-74 ⇄ SPAS-12). Landing in this
        // switch reaches the shared preventDefault below on BOTH keydown and
        // keyup, so the browser never moves focus on Tab; Shift+Tab is
        // swallowed too (e.code matching).
        case 'Tab':
        case 'KeyB':
          this.state.changeWeapon = down;
          break;
        // Aim: I/K/J/L = up/down/left/right (chords give the diagonals).
        case 'KeyI':
          this.state.aimUp = down;
          if (down) this.claimKeyboardAim();
          break;
        case 'KeyK':
          this.state.aimDown = down;
          if (down) this.claimKeyboardAim();
          break;
        case 'KeyJ':
          this.state.aimLeft = down;
          if (down) this.claimKeyboardAim();
          break;
        case 'KeyL':
          this.state.aimRight = down;
          if (down) this.claimKeyboardAim();
          break;
        // Throw grenade: F (keyboard alternative to right mouse).
        case 'KeyF':
          this.state.throwNade = down;
          break;
        // Reload: R (auto-reload on empty also exists; manual reload is R).
        case 'KeyR':
          this.state.reload = down;
          break;
        default:
          return; // Unhandled key: don't preventDefault.
      }
      // Stop the browser from acting on handled keys while playing (Space
      // scrolls, arrows scroll, Tab moves focus).
      e.preventDefault();
    };
  }

  /** Current keyboard aim angle in radians (test hook / debug overlay). */
  get aimAngleRad(): number {
    return this.aimAngle;
  }

  /** Force the keyboard aim angle (test hook). */
  setAimAngle(rad: number): void {
    this.aimAngle = normalizeAngle(rad);
  }

  /**
   * Snapshot the current input as a sim {@link Control}.
   *
   * mouseAimX / mouseAimY are an offset from the player on screen — toward
   * the cursor in mouse mode, or cos/sin(aimAngle)·AIM_RADIUS in keyboard
   * mode. The caller supplies the player's current SCREEN position (in the
   * same canvas-CSS-pixel space as the mouse) so aim is a direction vector
   * from the body (Control.pas PlayerControl mouse handling).
   *
   * @param nowMs Frame timestamp; defaults to performance.now(). Tests pass
   *   it explicitly to drive the aim state machine deterministically.
   */
  readControl(
    playerScreenX: number,
    playerScreenY: number,
    nowMs: number = performance.now(),
  ): Control {
    const s = this.state;

    // (a) Real elapsed seconds, clamped so a stalled frame / tab-back can't
    // teleport the aim across the circle.
    const dt =
      this.lastNowMs === null
        ? 0
        : Math.min(nowMs - this.lastNowMs, MAX_AIM_DT_MS) / 1000;
    this.lastNowMs = nowMs;

    // (b) Chord composition, recomputed from the held booleans every frame —
    // immune to keydown auto-repeat. Any change restarts the nudge phase.
    const mask =
      (s.aimUp ? 1 : 0) |
      (s.aimDown ? 2 : 0) |
      (s.aimLeft ? 4 : 0) |
      (s.aimRight ? 8 : 0);
    if (mask !== this.prevChordMask) {
      this.chordStartMs = nowMs;
      this.prevChordMask = mask;
    }

    // (c) Mouse → keys handoff seed: continue from wherever aim last pointed
    // so the crosshair doesn't jump when IJKL takes over.
    if (this.aimMode === 'keys' && this.seedFromLastOffset) {
      if (Math.hypot(this.lastAimX, this.lastAimY) > 1e-3) {
        this.aimAngle = Math.atan2(this.lastAimY, this.lastAimX);
      }
      this.seedFromLastOffset = false;
    }

    // (d) Aim intent. Screen y grows DOWN, so aim-up (I) gives iy = -1.
    // Opposing keys cancel that axis.
    const ix = (s.aimRight ? 1 : 0) - (s.aimLeft ? 1 : 0);
    const iy = (s.aimDown ? 1 : 0) - (s.aimUp ? 1 : 0);

    // (e) No intent (nothing held, or fully cancelled): the angle persists
    // untouched, indefinitely. game.ts normalises the vector per bullet, so
    // any reset here would snap fire horizontal and ruin spray control.
    if (ix !== 0 || iy !== 0) {
      // (f) Instant horizontal mirror-flip (the reaction-duel turnaround):
      // a purely horizontal press AGAINST the current facing mirrors the
      // angle across the vertical axis (π − angle), preserving elevation —
      // then smoothing continues below. Self-disarming: after the mirror the
      // cos sign matches the intent, so this is false next frame (a plain
      // level-triggered check is correct, no edge detection needed). The
      // guard band keeps near-vertical aims from mirroring on a small J/L
      // correction tap.
      if (iy === 0) {
        const cos = Math.cos(this.aimAngle);
        if (cos * ix < 0 && Math.abs(cos) > AIM_FLIP_COS_GUARD) {
          this.aimAngle = normalizeAngle(Math.PI - this.aimAngle);
        }
      }

      // (g) Ramped rotation toward the octant target: slow nudge right after
      // a chord change, fast swing after AIM_NUDGE_MS.
      const targetAngle = Math.atan2(iy, ix);
      const rate =
        nowMs - this.chordStartMs < AIM_NUDGE_MS
          ? AIM_NUDGE_RATE
          : AIM_SWING_RATE;
      let delta = normalizeAngle(targetAngle - this.aimAngle);
      // 180° tie-break (within ~1°): deterministic direction; for
      // horizontal-ish aims this rotates through the UPPER arc (the sky),
      // where duel aim lives.
      if (Math.abs(Math.abs(delta) - Math.PI) < 0.0175) {
        delta = (Math.cos(this.aimAngle) >= 0 ? -1 : 1) * Math.PI;
      }
      // Clamp to target: held chords settle EXACTLY on the 8 reference lines
      // (predictable spray angles), zero overshoot.
      const step = rate * dt;
      this.aimAngle =
        Math.abs(delta) <= step
          ? targetAngle
          : normalizeAngle(this.aimAngle + Math.sign(delta) * step);
    }

    // (i) Output: identical offset-from-player contract for both aim sources.
    let aimX: number;
    let aimY: number;
    if (this.aimMode === 'mouse') {
      // Aim offset toward the cursor (rounded to int, like the SmallInt
      // fields in TControl).
      aimX = Math.round(s.mouseX - playerScreenX);
      aimY = Math.round(s.mouseY - playerScreenY);
      if (aimX !== 0) this.lastFacing = aimX > 0 ? 1 : -1;
    } else {
      aimX = Math.round(Math.cos(this.aimAngle) * AIM_RADIUS);
      aimY = Math.round(Math.sin(this.aimAngle) * AIM_RADIUS);
      if (aimX !== 0) {
        this.lastFacing = aimX > 0 ? 1 : -1;
      } else {
        // Vertical-aim bias: game.ts sets sprite facing from the fired
        // bullet's dx sign, and an exact 0 would force facing right when
        // shooting straight up/down. ±1 px at r=120 is a 0.48° skew, under
        // SPREAD_BASE.
        aimX = this.lastFacing;
      }
    }
    this.lastAimX = aimX;
    this.lastAimY = aimY;

    return {
      left: s.left,
      right: s.right,
      up: s.up,
      down: s.down,
      fire: s.fireKey || s.fireMouse,
      jetpack: s.jetpack,
      throwNade: s.throwNade,
      changeWeapon: s.changeWeapon,
      throwWeapon: false,
      reload: s.reload,
      prone: false,
      flagThrow: false,
      mouseAimX: aimX,
      mouseAimY: aimY,
      mouseDist: 0,
    };
  }
}
