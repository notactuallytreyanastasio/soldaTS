// Startup controls screen — a full-screen DOM overlay listing the bindings.
//
// GLUE module (no Pascal provenance; the original showed controls in a config
// tool, not in-game). The listing is rendered from CONTROL_BINDINGS — the same
// table input.test.ts verifies against the real InputController — so what the
// player reads here cannot drift from what the keys actually do.
//
// A plain DOM overlay (not PIXI/HUD) on purpose: it sits above the canvas,
// costs nothing per frame, and disappears at the first keypress. The game
// keeps running underneath; the dismissing key also acts in game, which is
// the right feel for a fast drop-in shooter.

import { CONTROL_BINDINGS } from '../input/input';

/**
 * Treat EVERY startup as a first start. The control scheme is still in flux,
 * so we want the screen exercised on every launch — both to onboard and to
 * catch a stale listing immediately. When the scheme stabilises, flip this to
 * false and the localStorage gate below takes over.
 */
export const ALWAYS_SHOW = true;

const SEEN_KEY = 'soldat.controlsSeen';

/** Storage slice (test seam; localStorage satisfies it structurally). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Whether the controls screen should appear on this startup. */
export function shouldShowControls(storage: StorageLike | null = null): boolean {
  if (ALWAYS_SHOW) return true;
  const store = storage ?? safeLocalStorage();
  return store === null || store.getItem(SEEN_KEY) === null;
}

/** localStorage throws in some privacy modes; treat that as "no storage". */
function safeLocalStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Show the controls overlay; it removes itself on the first keydown or
 * pointerdown anywhere (that input also acts in game) and records that the
 * player has seen it.
 */
export function showControlsScreen(onDismiss?: () => void): void {
  const overlay = document.createElement('div');
  overlay.id = 'controls-screen';
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:1000',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'background:rgba(10,12,16,0.82)',
    'color:#e8e4d8',
    'font-family:ui-monospace,Menlo,monospace',
    'user-select:none',
    'pointer-events:none', // clicks fall through to the canvas
  ].join(';');

  const title = document.createElement('div');
  title.textContent = 'CONTROLS';
  title.style.cssText =
    'font-size:28px;letter-spacing:0.4em;margin-bottom:24px;color:#fff';
  overlay.appendChild(title);

  const table = document.createElement('table');
  table.style.cssText = 'border-collapse:collapse;font-size:16px';
  for (const binding of CONTROL_BINDINGS) {
    const row = document.createElement('tr');
    const keyCell = document.createElement('td');
    keyCell.style.cssText =
      'padding:6px 24px 6px 0;text-align:right;white-space:nowrap';
    for (const [i, key] of binding.keys.entries()) {
      if (i > 0) keyCell.append(' ');
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      kbd.style.cssText = [
        'display:inline-block',
        'min-width:1.6em',
        'padding:2px 8px',
        'border:1px solid #777',
        'border-radius:4px',
        'background:#1d212a',
        'text-align:center',
        'color:#fff',
      ].join(';');
      keyCell.appendChild(kbd);
    }
    const actionCell = document.createElement('td');
    actionCell.textContent = binding.action;
    actionCell.style.cssText = 'padding:6px 0;max-width:34em';
    row.append(keyCell, actionCell);
    table.appendChild(row);
  }
  overlay.appendChild(table);

  const footer = document.createElement('div');
  footer.textContent = 'press any key to drop in';
  footer.style.cssText =
    'margin-top:28px;font-size:14px;color:#9aa3b2;animation:none';
  overlay.appendChild(footer);

  const dismiss = (): void => {
    overlay.remove();
    window.removeEventListener('keydown', dismiss, true);
    window.removeEventListener('pointerdown', dismiss, true);
    try {
      safeLocalStorage()?.setItem(SEEN_KEY, '1');
    } catch {
      // Storage write denied: the ALWAYS_SHOW path doesn't need it anyway.
    }
    onDismiss?.();
  };
  // Capture phase so dismissal works regardless of where focus sits; the
  // event still reaches the InputController, so the key also acts in game.
  window.addEventListener('keydown', dismiss, true);
  window.addEventListener('pointerdown', dismiss, true);

  document.body.appendChild(overlay);
}
