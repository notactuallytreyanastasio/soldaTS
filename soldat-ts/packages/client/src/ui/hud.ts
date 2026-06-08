// Hud — the in-game interface overlay (health / jet / ammo / weapon / scores /
// kill-feed / FPS), rendered as a single pixi v8 Container that sits on top of
// the world.
//
// GLUE module: pixi.js is touched here only to draw the HUD. The simulation
// feeds it a plain `HudState` snapshot each frame (see below); the HUD owns no
// game logic and never mutates sim state.
//
// PORT: client/InterfaceGraphics.pas — RenderInterface / RenderBar. The original
// authors the interface against a 640x480 design space and scales every
// coordinate by `_iscala`. Bars (health, jet, reload/ammo) are drawn by clipping
// a texture to value/max of its width. We reproduce the *intent* — bar
// positions, fill ratios, ammo + weapon name, team / personal score, a small
// kill log, and an FPS counter — with pixi primitives rather than the original
// bitmap interface skins (skins are a later asset-pipeline concern).

import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  barFillRatio,
  formatAmmo,
  formatScore,
  formatTeamScore,
  interfaceScale,
  START_HEALTH,
} from './helpers';

// ---------------------------------------------------------------------------
// Public state contract
// ---------------------------------------------------------------------------
//
// Defined HERE, decoupled from Track A's GameState. Callers project whatever
// game/score source they have onto this flat snapshot. All fields are required
// so the HUD never has to guess (exactOptionalPropertyTypes-friendly).

/** One entry in the kill feed, e.g. "Killer [weapon] Victim". */
export interface KillFeedEntry {
  /** Name of the killer (empty string for world/suicide). */
  readonly killer: string;
  /** Name of the victim. */
  readonly victim: string;
  /** Short weapon / cause label shown between the two names. */
  readonly cause: string;
  /** Whether the local player was the killer (used to tint the entry). */
  readonly byLocalPlayer: boolean;
}

/** Team / round score source. */
export interface HudScores {
  /** Alpha team score (red). */
  readonly alpha: number;
  /** Bravo team score (blue). */
  readonly bravo: number;
  /** Local player's personal kill count. */
  readonly playerKills: number;
  /** True when the local player currently leads the scoreboard. */
  readonly leading: boolean;
  /** Signed kill gap to the runner-up (if leading) or to the leader. */
  readonly gap: number;
}

/** Everything the HUD needs for one frame. Decoupled from sim/GameState. */
export interface HudState {
  /** Local player current health (sim Sprite.health). */
  readonly health: number;
  /** Full-health reference (defaults to START_HEALTH when omitted upstream). */
  readonly maxHealth: number;
  /** Current jet fuel (sim Sprite.jetsCountReal). */
  readonly jet: number;
  /** Map's starting jet fuel — the jet bar denominator (Map.StartJet). */
  readonly maxJet: number;
  /** Current magazine ammo (Weapon.AmmoCount). */
  readonly ammo: number;
  /** Display name of the equipped weapon (GunDisplayName[Weapon.Num]). */
  readonly weaponName: string;
  /** Score / round state. */
  readonly scores: HudScores;
  /** Most-recent-first kill feed; HUD renders up to KILL_FEED_MAX. */
  readonly killFeed: readonly KillFeedEntry[];
  /** Frames per second, already smoothed by the caller. */
  readonly fps: number;
}

// ---------------------------------------------------------------------------
// Layout / style constants (design-space, pre-scale)
// ---------------------------------------------------------------------------

// PORT: InterfaceGraphics.pas:182-218 — default bar geometry / positions.
const HEALTH_BAR = { x: 45, y: 449, w: 115, h: 9 } as const; // HealthBar_X/Y/Width/Height
const JET_BAR = { x: 520, y: 449, w: 115, h: 9 } as const; // JetBar_X/Y/Width/Height
// PORT: InterfaceGraphics.pas:236-237 — Ping_X/Y (top-right readout slot); reused
// here for the FPS counter.
const FPS_POS = { x: 600, y: 18 } as const;

const KILL_FEED_MAX = 5;

const RED = 0xff3732; // ~RGBA(255,55,50) — Alpha team / personal score
const GREEN = 0x58ff5a; // ~RGBA(88,255,90) — rank line
const BLUE = 0x7278ff; // ~RGBA(114,120,255) — Bravo team / kill limit
const WHITE = 0xffffff;
const DIM = 0xb0b0b0;
const BAR_BG = 0x202020;

function smallStyle(fill: number): TextStyle {
  return new TextStyle({
    fontFamily: 'monospace',
    fontSize: 12,
    fill,
  });
}

// ---------------------------------------------------------------------------
// Hud
// ---------------------------------------------------------------------------

export class Hud extends Container {
  // Current viewport size and derived design->screen scale.
  private viewW: number = DESIGN_WIDTH;
  private viewH: number = DESIGN_HEIGHT;
  private scale_ = 1;

  // Bars are immediate-mode Graphics redrawn each update.
  private readonly healthBar = new Graphics();
  private readonly jetBar = new Graphics();

  // Text nodes (created once, retargeted each frame).
  private readonly ammoText = new Text({ text: '', style: smallStyle(WHITE) });
  private readonly weaponText = new Text({ text: '', style: smallStyle(WHITE) });
  private readonly teamScoreText = new Text({ text: '', style: smallStyle(WHITE) });
  private readonly playerScoreText = new Text({ text: '', style: smallStyle(RED) });
  private readonly fpsText = new Text({ text: '', style: smallStyle(DIM) });
  private readonly killFeedText: Text[] = [];

  constructor() {
    super();

    for (let i = 0; i < KILL_FEED_MAX; i++) {
      const t = new Text({ text: '', style: smallStyle(WHITE) });
      this.killFeedText.push(t);
      this.addChild(t);
    }

    this.addChild(
      this.healthBar,
      this.jetBar,
      this.ammoText,
      this.weaponText,
      this.teamScoreText,
      this.playerScoreText,
      this.fpsText,
    );

    this.resize(DESIGN_WIDTH, DESIGN_HEIGHT);
  }

  /**
   * Handle a viewport resize. Recomputes the design->screen scale and
   * repositions the fixed (text) elements; bars reposition on the next update().
   *
   * PORT: InterfaceGraphics.pas — `_iscala` is recomputed from the render size
   * and every interface coordinate is multiplied by it.
   */
  resize(width: number, height: number): void {
    this.viewW = width;
    this.viewH = height;
    this.scale_ = interfaceScale(width, height);

    const s = this.scale_;

    // Ammo + weapon name: bottom-right of the design space (near the jet bar).
    // PORT: InterfaceGraphics.pas:930-950 — ammo count then GunDisplayName,
    // drawn near the ammo icon at the right of the bar strip.
    this.ammoText.position.set((JET_BAR.x + JET_BAR.w + 4) * s, (JET_BAR.y - 16) * s);
    this.weaponText.position.set(JET_BAR.x * s, (JET_BAR.y - 16) * s);

    // Team score: top-centre.
    this.teamScoreText.anchor.set(0.5, 0);
    this.teamScoreText.position.set(width / 2, 8 * s);

    // Personal score: bottom-centre.
    // PORT: InterfaceGraphics.pas:1015 — status line drawn around 190x435.
    this.playerScoreText.anchor.set(0.5, 1);
    this.playerScoreText.position.set(width / 2, height - 6 * s);

    // FPS counter: top-right (Ping slot).
    this.fpsText.anchor.set(1, 0);
    this.fpsText.position.set(FPS_POS.x * s, FPS_POS.y * s);

    // Kill feed: stacked top-right under the FPS counter.
    const feedX = width - 8 * s;
    const lineH = 14 * s;
    for (let i = 0; i < this.killFeedText.length; i++) {
      const t = this.killFeedText[i];
      if (!t) continue;
      t.anchor.set(1, 0);
      t.position.set(feedX, (FPS_POS.y + 16) * s + i * lineH);
    }

    // Keep text legible at large viewports without re-laying-out per-glyph.
    const textScale = Math.max(1, s);
    for (const t of [
      this.ammoText,
      this.weaponText,
      this.teamScoreText,
      this.playerScoreText,
      this.fpsText,
      ...this.killFeedText,
    ]) {
      t.scale.set(textScale);
    }
  }

  /**
   * Refresh the HUD from a frame snapshot.
   *
   * PORT: InterfaceGraphics.pas — RenderInterface reads SpriteMe.Health /
   * STARTHEALTH, SpriteMe.JetsCountReal / Map.StartJet, Weapon.AmmoCount /
   * Weapon.Ammo, etc., and clamps each ratio to [0,1] in RenderBar.
   */
  update(state: HudState): void {
    const s = this.scale_;

    // Health bar (left). PORT: InterfaceGraphics.pas:2031-2038.
    const maxHealth = state.maxHealth > 0 ? state.maxHealth : START_HEALTH;
    this.drawBar(
      this.healthBar,
      HEALTH_BAR.x * s,
      HEALTH_BAR.y * s,
      HEALTH_BAR.w * s,
      HEALTH_BAR.h * s,
      barFillRatio(state.health, maxHealth),
      RED,
    );

    // Jet bar (right). PORT: InterfaceGraphics.pas:2116-2123.
    this.drawBar(
      this.jetBar,
      JET_BAR.x * s,
      JET_BAR.y * s,
      JET_BAR.w * s,
      JET_BAR.h * s,
      barFillRatio(state.jet, state.maxJet),
      BLUE,
    );

    // Ammo + weapon name.
    this.ammoText.text = formatAmmo(state.ammo);
    this.weaponText.text = state.weaponName;

    // Scores.
    this.teamScoreText.text = formatTeamScore(state.scores.alpha, state.scores.bravo);
    this.playerScoreText.text = formatScore(
      state.scores.playerKills,
      state.scores.leading,
      state.scores.gap,
    );

    // FPS.
    this.fpsText.text = `${Math.round(state.fps)} FPS`;

    // Kill feed (most recent first, capped). PORT: InterfaceGraphics.pas:954+
    // status / kill area; here a dedicated rolling feed.
    for (let i = 0; i < this.killFeedText.length; i++) {
      const node = this.killFeedText[i];
      if (!node) continue;
      const entry = state.killFeed[i];
      if (entry === undefined) {
        node.text = '';
        node.visible = false;
        continue;
      }
      node.visible = true;
      node.text = entry.killer
        ? `${entry.killer} [${entry.cause}] ${entry.victim}`
        : `${entry.cause} ${entry.victim}`;
      node.style.fill = entry.byLocalPlayer ? GREEN : WHITE;
    }
  }

  /** Draw a horizontal fill bar with a dim background track. */
  private drawBar(
    g: Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
    ratio: number,
    color: number,
  ): void {
    g.clear();
    g.rect(x, y, w, h).fill({ color: BAR_BG, alpha: 0.6 });
    if (ratio > 0) {
      g.rect(x, y, w * ratio, h).fill({ color });
    }
  }
}
