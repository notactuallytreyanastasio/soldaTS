// menuScreen — URL gating, menu structure, and the navigation URLs the rows
// build. Runs against a hand-rolled fake DOM (node environment, no jsdom);
// Math.random is stubbed wherever a roll feeds an asserted URL so every test
// is deterministic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEARNED_MODELS, isBareUrl, showMenuScreen } from './menuScreen';
import { engineIds } from '../ai';

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

type Listener = (ev?: unknown) => void;

class FakeElement {
  readonly tagName: string;
  id = '';
  textContent = '';
  value = '';
  href = '';
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
    // Mirror the native <select>: the first appended <option> becomes the value.
    if (this.tagName === 'SELECT' && child.tagName === 'OPTION' && this.value === '') {
      this.value = child.value;
    }
    return child;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const n of nodes) {
      if (typeof n === 'string') this.children.push(n);
      else this.appendChild(n);
    }
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatch(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }

  byTag(tag: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      if (c.tagName === tag.toUpperCase()) out.push(c);
      out.push(...c.byTag(tag));
    }
    return out;
  }

  /** Own textContent plus all descendants', in document order. */
  fullText(): string {
    let s = this.textContent;
    for (const c of this.children) s += typeof c === 'string' ? c : c.fullText();
    return s;
  }
}

interface FakeWindow {
  location: { pathname: string; search: string; href: string };
}

let win: FakeWindow;
let body: FakeElement;

beforeEach(() => {
  win = { location: { pathname: '/', search: '', href: '' } };
  body = new FakeElement('body');
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeElement(tag),
    body,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function overlay(): FakeElement {
  const el = body.children.find(
    (c): c is FakeElement => typeof c !== 'string' && c.id === 'menu-screen',
  );
  expect(el).toBeDefined();
  return el as FakeElement;
}

/** The menu column's buttons: [engine rows..., online, random]. */
function columnButtons(): FakeElement[] {
  return overlay().byTag('button');
}

function engineRows(): FakeElement[] {
  // Engine rows are built from child spans; the online/random buttons set
  // textContent directly and have no element children.
  return columnButtons().filter((b) => b.children.length > 0);
}

// ---------------------------------------------------------------------------
// isBareUrl
// ---------------------------------------------------------------------------

describe('isBareUrl', () => {
  it('is true for an empty / bare search string', () => {
    expect(isBareUrl('')).toBe(true);
    expect(isBareUrl('?')).toBe(true);
  });

  it('is true for unknown params only', () => {
    expect(isBareUrl('?foo=1&bar=2')).toBe(true);
  });

  it.each([
    'play',
    'online',
    'spectate',
    'duel',
    'tournament',
    'ai',
    'seed',
    'map',
    'arena',
    'variant',
    'wildcard',
    'teams',
    'round',
    'tweak-a',
    'tweak-b',
  ])('is false when ?%s is present', (param) => {
    expect(isBareUrl(`?${param}`)).toBe(false);
    expect(isBareUrl(`?${param}=x`)).toBe(false);
    expect(isBareUrl(`?foo=1&${param}=x`)).toBe(false);
  });

  it('a mode word as a VALUE (not a key) stays bare', () => {
    expect(isBareUrl('?mode=play')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// showMenuScreen — structure
// ---------------------------------------------------------------------------

describe('showMenuScreen structure', () => {
  it('appends the overlay with title, subtitle, and one row per engine', () => {
    showMenuScreen();
    const o = overlay();
    expect(o.fullText()).toContain('SOLDAT');
    expect(o.fullText()).toContain('NEW GAME — pick your opponent');
    expect(engineRows().length).toBe(engineIds().length);
  });

  it('offers the full wildcard option list with chance preselected', () => {
    showMenuScreen();
    const select = overlay().byTag('select')[0] as FakeElement;
    const values = select.byTag('option').map((opt) => opt.value);
    expect(values).toEqual([
      'chance',
      'shotgun',
      'rifle',
      'rocket',
      'ricochet',
      'chainsaw',
      'none',
    ]);
    expect(select.value).toBe('chance');
  });

  it('badges every learned model row with LEARNED', () => {
    showMenuScreen();
    const rows = engineRows();
    const ids = engineIds();
    for (const [i, id] of ids.entries()) {
      const row = rows[i] as FakeElement;
      const badged = row.fullText().includes('LEARNED');
      expect(badged, `row for ${id}`).toBe(id in LEARNED_MODELS);
    }
  });

  it('shows the alias in quotes only when it differs from the id', () => {
    showMenuScreen();
    const rows = engineRows();
    const ids = engineIds();
    const neuralRow = rows[ids.indexOf('neural')] as FakeElement;
    expect(neuralRow.fullText()).toContain('NEURAL “MIMIC”');
    if (ids.includes('buttstein')) {
      // Alias equals the upper-cased id, so no quoted alias — just the badge.
      const row = rows[ids.indexOf('buttstein')] as FakeElement;
      expect(row.fullText()).not.toContain('“');
      expect(row.fullText()).toContain('LEARNED');
    }
  });

  it('links the broadcast and online modes through ordinary URLs', () => {
    showMenuScreen();
    const watch = overlay().byTag('a').find((a) => a.href.includes('spectate'));
    expect(watch?.href).toBe('/?spectate');
    const online = columnButtons().find((b) => b.textContent.includes('PLAY ONLINE'));
    expect(online).toBeDefined();
    online?.dispatch('click');
    expect(win.location.href).toBe('/?online');
  });
});

// ---------------------------------------------------------------------------
// showMenuScreen — startGame navigation
// ---------------------------------------------------------------------------

describe('startGame navigation', () => {
  it('clicking an engine row navigates to ?play with that ai, arena, and seed', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    showMenuScreen();
    const ids = engineIds();
    const first = ids[0] as string;
    engineRows()[0]?.dispatch('click');
    // roll(999) with r=0.5 → 1 + floor(499.5) = 500; roll(99999) → 50000.
    expect(win.location.href).toBe(`/?play&ai=${first}&arena=500&seed=50000`);
  });

  it('roll() bottoms out at 1 (never arena 0 — the canonical map)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    showMenuScreen();
    engineRows()[0]?.dispatch('click');
    expect(win.location.href).toContain('&arena=1&seed=1');
  });

  it('roll() tops out at max (999 / 99999) and stays an integer', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1 - Number.EPSILON);
    showMenuScreen();
    engineRows()[0]?.dispatch('click');
    expect(win.location.href).toContain('&arena=999&seed=99999');
  });

  it('omits the wildcard param for the chance default', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    showMenuScreen();
    engineRows()[0]?.dispatch('click');
    expect(win.location.href).not.toContain('wildcard');
  });

  it('carries a non-default wildcard selection into the URL', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    showMenuScreen();
    const select = overlay().byTag('select')[0] as FakeElement;
    select.value = 'shotgun';
    engineRows()[1]?.dispatch('click');
    expect(win.location.href).toContain('&wildcard=shotgun');
    expect(win.location.href).toContain(`?play&ai=${engineIds()[1]}`);
  });

  it('the random-opponent button picks an engine deterministically from random()', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    showMenuScreen();
    const ids = engineIds();
    const expected = ids[Math.floor(0.999999 * ids.length)] as string;
    const randomBtn = columnButtons().find((b) =>
      b.textContent.includes('RANDOM OPPONENT'),
    ) as FakeElement;
    randomBtn.dispatch('click');
    expect(win.location.href).toContain(`?play&ai=${expected}&`);
  });

  it('respects a non-root pathname (subpath deploys)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    win.location.pathname = '/arena/play/';
    showMenuScreen();
    engineRows()[0]?.dispatch('click');
    expect(win.location.href.startsWith('/arena/play/?play&ai=')).toBe(true);
  });
});
