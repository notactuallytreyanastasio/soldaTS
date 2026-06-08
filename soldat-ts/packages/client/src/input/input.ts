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

import type { Control } from '@soldat/sim';

/** Live key/pointer state, updated by DOM listeners. */
interface InputState {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  fire: boolean;
  jetpack: boolean;
  throwNade: boolean;
  reload: boolean;
  /** Mouse position in CSS pixels relative to the canvas (cursor aim). */
  mouseX: number;
  mouseY: number;
}

/**
 * Handles raw DOM input and exposes a sim Control snapshot.
 *
 * Construct with the canvas element so mouse coordinates are canvas-relative
 * (matching where the player is drawn). Call {@link readControl} once per tick.
 */
export class InputController {
  private readonly state: InputState = {
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false,
    fire: false,
    jetpack: false,
    throwNade: false,
    reload: false,
    mouseX: 0,
    mouseY: 0,
  };

  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.attach();
  }

  /** Wire up keyboard + mouse listeners on window / the canvas. */
  private attach(): void {
    window.addEventListener('keydown', this.onKey(true));
    window.addEventListener('keyup', this.onKey(false));

    // Mouse aim: track the cursor in canvas-local CSS pixels.
    this.canvas.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      this.state.mouseX = e.clientX - rect.left;
      this.state.mouseY = e.clientY - rect.top;
    });

    // Fire: left mouse button. Suppress the context menu for right-click nade.
    this.canvas.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button === 0) this.state.fire = true;
      if (e.button === 2) this.state.throwNade = true;
    });
    window.addEventListener('mouseup', (e: MouseEvent) => {
      if (e.button === 0) this.state.fire = false;
      if (e.button === 2) this.state.throwNade = false;
    });
    this.canvas.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
    });
  }

  /** Build a keydown/keyup handler that flips the matching state flag. */
  private onKey(down: boolean): (e: KeyboardEvent) => void {
    return (e: KeyboardEvent): void => {
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
        // Up / aim-up: W / Up arrow.
        case 'KeyW':
        case 'ArrowUp':
          this.state.up = down;
          break;
        // Down / crouch: S / Down arrow.
        case 'KeyS':
        case 'ArrowDown':
          this.state.down = down;
          break;
        // Jump: Space (mapped to Control.up, the engine's "jump/jet" key).
        case 'Space':
          this.state.jump = down;
          break;
        // Jetpack: Shift.
        case 'ShiftLeft':
        case 'ShiftRight':
          this.state.jetpack = down;
          break;
        // Throw grenade: F (keyboard alternative to right mouse).
        case 'KeyF':
          this.state.throwNade = down;
          break;
        // Reload: R.
        case 'KeyR':
          this.state.reload = down;
          break;
        default:
          return; // Unhandled key: don't preventDefault.
      }
      // Stop the browser from scrolling on Space / arrows while playing.
      e.preventDefault();
    };
  }

  /**
   * Snapshot the current input as a sim {@link Control}.
   *
   * mouseAimX / mouseAimY are the cursor position relative to the player on
   * screen. The caller supplies the player's current SCREEN position (in the
   * same canvas-CSS-pixel space as the mouse) so aim is a direction vector from
   * the body to the cursor — the engine reads MouseAim as an offset from the
   * player (Control.pas PlayerControl mouse handling).
   */
  readControl(playerScreenX: number, playerScreenY: number): Control {
    const s = this.state;
    // Jump uses Space OR W (both feed the engine's "up" jump/jet control).
    const up = s.up || s.jump;
    return {
      left: s.left,
      right: s.right,
      up,
      down: s.down,
      fire: s.fire,
      jetpack: s.jetpack,
      throwNade: s.throwNade,
      changeWeapon: false,
      throwWeapon: false,
      reload: s.reload,
      prone: false,
      flagThrow: false,
      // Aim offset from the player toward the cursor (rounded to int, like the
      // SmallInt fields in TControl).
      mouseAimX: Math.round(s.mouseX - playerScreenX),
      mouseAimY: Math.round(s.mouseY - playerScreenY),
      mouseDist: 0,
    };
  }
}
