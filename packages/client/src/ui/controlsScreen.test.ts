// controlsScreen — DOM-overlay behavior, exercised against a tiny hand-rolled
// fake DOM (the vitest environment is plain node; no jsdom). The fakes mirror
// only what the module touches: createElement, append/appendChild, remove,
// style.cssText, and window add/removeEventListener + localStorage.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALWAYS_SHOW, shouldShowControls, showControlsScreen } from './controlsScreen';
import { CONTROL_BINDINGS } from '../input/input';

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

type Listener = (ev?: unknown) => void;

class FakeElement {
  readonly tagName: string;
  id = '';
  textContent = '';
  style: Record<string, string> = {};
  children: Array<FakeElement | string> = [];
  parentNode: FakeElement | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const n of nodes) {
      if (typeof n === 'string') this.children.push(n);
      else this.appendChild(n);
    }
  }

  remove(): void {
    if (this.parentNode !== null) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    }
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  /** Recursively collect descendant elements with a given tag. */
  byTag(tag: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      if (c.tagName === tag.toUpperCase()) out.push(c);
      out.push(...c.byTag(tag));
    }
    return out;
  }
}

interface WindowListener {
  fn: Listener;
  capture: boolean;
}

class FakeWindow {
  readonly listeners = new Map<string, WindowListener[]>();
  localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  private readonly store = new Map<string, string>();

  constructor() {
    const store = this.store;
    this.localStorage = {
      getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k, v) => {
        store.set(k, v);
      },
    };
  }

  stored(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  addEventListener(type: string, fn: Listener, capture = false): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: Listener, _capture = false): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => l.fn !== fn),
    );
  }

  dispatch(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l.fn();
  }
}

let win: FakeWindow;
let body: FakeElement;

beforeEach(() => {
  win = new FakeWindow();
  body = new FakeElement('body');
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeElement(tag),
    body,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function overlayIn(parent: FakeElement): FakeElement | undefined {
  return parent.children.find(
    (c): c is FakeElement => typeof c !== 'string' && c.id === 'controls-screen',
  );
}

// ---------------------------------------------------------------------------
// shouldShowControls
// ---------------------------------------------------------------------------

describe('shouldShowControls', () => {
  it('the module currently forces the screen on every startup', () => {
    expect(ALWAYS_SHOW).toBe(true);
  });

  it('returns true with no storage at all (privacy mode)', () => {
    expect(shouldShowControls(null)).toBe(true);
  });

  it('returns true even when the seen-key is already stored (ALWAYS_SHOW wins)', () => {
    // While ALWAYS_SHOW is true the storage gate below it is dead code; this
    // pins the short-circuit so flipping the flag is a visible behavior change.
    const seen = {
      getItem: (k: string) => (k === 'soldat.controlsSeen' ? '1' : null),
      setItem: () => undefined,
    };
    expect(shouldShowControls(seen)).toBe(true);
  });

  it('returns true for an empty storage', () => {
    expect(shouldShowControls({ getItem: () => null, setItem: () => undefined })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// showControlsScreen — structure
// ---------------------------------------------------------------------------

describe('showControlsScreen structure', () => {
  it('appends a fixed full-screen overlay with id controls-screen to body', () => {
    showControlsScreen();
    const overlay = overlayIn(body);
    expect(overlay).toBeDefined();
    expect(overlay?.style['cssText']).toContain('position:fixed');
    expect(overlay?.style['cssText']).toContain('pointer-events:none');
  });

  it('renders the CONTROLS title and the drop-in footer', () => {
    showControlsScreen();
    const overlay = overlayIn(body) as FakeElement;
    const texts = overlay.byTag('div').map((d) => d.textContent);
    expect(texts).toContain('CONTROLS');
    expect(texts).toContain('press any key to drop in');
  });

  it('renders one table row per CONTROL_BINDINGS entry', () => {
    showControlsScreen();
    const overlay = overlayIn(body) as FakeElement;
    const rows = overlay.byTag('tr');
    expect(rows.length).toBe(CONTROL_BINDINGS.length);
  });

  it('each row lists every key as a <kbd> and the action text', () => {
    showControlsScreen();
    const overlay = overlayIn(body) as FakeElement;
    const rows = overlay.byTag('tr');
    for (const [i, binding] of CONTROL_BINDINGS.entries()) {
      const row = rows[i] as FakeElement;
      const kbds = row.byTag('kbd');
      expect(kbds.map((k) => k.textContent)).toEqual([...binding.keys]);
      const cells = row.byTag('td');
      expect(cells[1]?.textContent).toBe(binding.action);
    }
  });

  it('registers capture-phase keydown and pointerdown listeners on window', () => {
    showControlsScreen();
    expect(win.listeners.get('keydown')?.length).toBe(1);
    expect(win.listeners.get('keydown')?.[0]?.capture).toBe(true);
    expect(win.listeners.get('pointerdown')?.length).toBe(1);
    expect(win.listeners.get('pointerdown')?.[0]?.capture).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// showControlsScreen — dismissal
// ---------------------------------------------------------------------------

describe('showControlsScreen dismissal', () => {
  it('any keydown removes the overlay, records seen, and calls onDismiss', () => {
    let dismissed = 0;
    showControlsScreen(() => dismissed++);
    win.dispatch('keydown');
    expect(overlayIn(body)).toBeUndefined();
    expect(win.stored('soldat.controlsSeen')).toBe('1');
    expect(dismissed).toBe(1);
  });

  it('a pointerdown dismisses too', () => {
    let dismissed = 0;
    showControlsScreen(() => dismissed++);
    win.dispatch('pointerdown');
    expect(overlayIn(body)).toBeUndefined();
    expect(dismissed).toBe(1);
  });

  it('dismiss unhooks both listeners so a second event is a no-op', () => {
    let dismissed = 0;
    showControlsScreen(() => dismissed++);
    win.dispatch('keydown');
    win.dispatch('keydown');
    win.dispatch('pointerdown');
    expect(dismissed).toBe(1);
    expect(win.listeners.get('keydown')).toEqual([]);
    expect(win.listeners.get('pointerdown')).toEqual([]);
  });

  it('works without an onDismiss callback', () => {
    showControlsScreen();
    expect(() => win.dispatch('keydown')).not.toThrow();
    expect(overlayIn(body)).toBeUndefined();
  });

  it('survives a localStorage write failure (quota / privacy mode)', () => {
    win.localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    let dismissed = 0;
    showControlsScreen(() => dismissed++);
    expect(() => win.dispatch('keydown')).not.toThrow();
    expect(overlayIn(body)).toBeUndefined();
    expect(dismissed).toBe(1);
  });

  it('survives window.localStorage ACCESS throwing (hard privacy mode)', () => {
    Object.defineProperty(win, 'localStorage', {
      get() {
        throw new Error('SecurityError');
      },
    });
    let dismissed = 0;
    showControlsScreen(() => dismissed++);
    expect(() => win.dispatch('pointerdown')).not.toThrow();
    expect(dismissed).toBe(1);
  });
});
