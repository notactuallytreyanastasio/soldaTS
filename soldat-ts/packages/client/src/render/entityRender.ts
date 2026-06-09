// EntityRenderer — draws live sim entities (sprites, bullets, things) on top of
// the map, with tick→tick position interpolation.
//
// GLUE module (pixi v8 only; not a faithful port of a single Pascal renderer).
// OpenSoldat draws each sprite's skeleton, bullets as textured streaks, and
// things (flags / kits) as sprites (GameRendering.pas RenderSprites / Render
// Bullets / RenderThings). Here we draw simple markers — a body circle, bullet
// dots, thing squares — positioned from the sim particle systems
// (world.spriteParts / bulletParts / thingParts: Float32Array posX/posY indexed
// by entity num). Since the sim steps at a fixed 60 Hz but we render every
// animation frame, we cache each entity's previous-tick position and lerp
// prev→current by the Game's framePercent so motion looks smooth.

import { Container, Graphics } from 'pixi.js';
import {
  MAX_SPRITES,
  MAX_BULLETS,
  MAX_THINGS,
  type World,
} from '@soldat/sim';
import { drawGostek } from './gostek';
import { TexturedGostek } from './gostekTextured';

/** How many textured-Gostek instances to pre-build (player + bots + headroom). */
const GOSTEK_POOL = 12;
/** World-Y nudge so the textured figure's feet sit on the collision contact. */
const GOSTEK_Y_OFFSET = -8;

/**
 * Per-entity interpolation state. `prevX/prevY` is the entity's position at the
 * END of the previous sim tick (the lerp source); `curX/curY` is its position at
 * the end of the current tick (the lerp target). `tick` is the world.ticks value
 * for which `curX/curY` was recorded, so we can detect when a new tick has run
 * and roll current→previous.
 */
interface InterpState {
  prevX: number;
  prevY: number;
  curX: number;
  curY: number;
  tick: number;
}

/** How far above the collision COM to anchor the Gostek hips (world units), so
 *  the figure's feet land near the ground contact point instead of sinking. */
const FOOT_LIFT = 10;
/** Half-size (world units) of the square marker drawn for each thing. */
const THING_HALF = 6;
/** Radius (world units) of the dot drawn for each bullet. */
const BULLET_RADIUS = 2;

/**
 * Draws sim entities into a pixi Container (added to the renderer's world
 * container so it shares the map camera transform). Call {@link render} once per
 * frame with the current World and the Game's framePercent.
 */
export class EntityRenderer {
  /** Container holding all entity graphics; add to the camera/world container. */
  readonly container: Container = new Container();

  // One reusable Graphics per layer — cleared and redrawn each frame. Simple and
  // correct for the entity counts here (a few hundred max).
  private readonly spriteGfx: Graphics = new Graphics();
  private readonly bulletGfx: Graphics = new Graphics();
  private readonly thingGfx: Graphics = new Graphics();

  // Interpolation state for each entity, indexed by entity slot.
  private readonly spriteInterp: (InterpState | undefined)[] = [];
  private readonly bulletInterp: (InterpState | undefined)[] = [];
  private readonly thingInterp: (InterpState | undefined)[] = [];

  // Per-sprite walk-cycle phase (0..1), advanced by horizontal travel.
  private readonly spritePhase: number[] = [];

  /** 1-based index of the local player (drawn in the player tint). */
  playerIndex = 1;

  // Textured Gostek: a pre-loaded pool of figures (one per sprite slot). When
  // ready, sprites are drawn with the real part PNGs instead of vector limbs.
  private texturedReady = false;
  private readonly gostekLayer: Container = new Container();
  private readonly gostekPool: (TexturedGostek | undefined)[] = [];

  /**
   * Load the real Gostek part textures and pre-build a pool of figures. Call
   * once (async) during startup; until it resolves, sprites render with the
   * vector fallback. Safe to skip — on failure we keep the vector look.
   */
  async enableTextured(): Promise<void> {
    await TexturedGostek.load();
    for (let i = 1; i <= GOSTEK_POOL; i++) {
      const g = new TexturedGostek();
      await g.load();
      g.view.visible = false;
      this.gostekLayer.addChild(g.view);
      this.gostekPool[i] = g;
    }
    this.spriteGfx.visible = false; // hide vector limbs once textured is live
    this.texturedReady = true;
  }

  constructor() {
    // Draw order: things under bullets under sprites (players on top).
    this.container.addChild(this.thingGfx);
    this.container.addChild(this.bulletGfx);
    this.container.addChild(this.spriteGfx);
    this.container.addChild(this.gostekLayer);
  }

  /**
   * Redraw all active entities for the current frame, interpolating each
   * entity's position between its previous and current simulated-tick position
   * by `framePercent` in [0, 1).
   */
  render(world: World, framePercent: number): void {
    const t = clamp01(framePercent);
    this.renderSprites(world, t);
    this.renderBullets(world, t);
    this.renderThings(world, t);
  }

  // -------------------------------------------------------------------------
  // Sprites (player bodies)
  // -------------------------------------------------------------------------

  private renderSprites(world: World, t: number): void {
    const g = this.spriteGfx;
    if (!this.texturedReady) g.clear();
    const parts = world.spriteParts;
    if (parts === null) return;

    for (let i = 1; i <= MAX_SPRITES; i++) {
      const sprite = world.sprites[i];
      if (sprite === undefined || !sprite.active) {
        this.spriteInterp[i] = undefined;
        const pooled = this.gostekPool[i];
        if (pooled !== undefined) pooled.view.visible = false;
        continue;
      }
      const num = sprite.num;
      const cx = parts.posX[num] ?? 0;
      const cy = parts.posY[num] ?? 0;
      const [x, y] = this.interp(this.spriteInterp, i, cx, cy, world.ticks, t);

      const vx = parts.velocityX[num] ?? 0;
      const vy = parts.velocityY[num] ?? 0;

      // Advance the walk-cycle phase by horizontal travel (only while moving).
      let phase = this.spritePhase[i] ?? 0;
      if (Math.abs(vx) > 1) {
        phase = (phase + Math.abs(vx) * 0.03) % 1;
      }
      this.spritePhase[i] = phase;

      // Aim point = COM + the control's relative aim vector.
      const aimX = x + sprite.control.mouseAimX;
      const aimY = y + sprite.control.mouseAimY;
      const team = i === this.playerIndex ? 1 : 2;
      const facing = sprite.direction >= 0 ? 1 : -1;

      const pooled = this.texturedReady ? this.gostekPool[i] : undefined;
      if (pooled !== undefined) {
        pooled.view.visible = true;
        pooled.update({
          comX: x,
          comY: y + GOSTEK_Y_OFFSET,
          aimX,
          aimY,
          vx,
          vy,
          onGround: sprite.onGround,
          phase,
          facing,
          team,
          dead: sprite.deadMeat,
        });
      } else {
        // Vector fallback (textures not loaded / pool exhausted).
        drawGostek(g, {
          comX: x,
          comY: y - FOOT_LIFT,
          aimX,
          aimY,
          vx,
          vy,
          onGround: sprite.onGround,
          phase,
          team,
          alpha: sprite.deadMeat ? 0.45 : 1,
          dead: sprite.deadMeat,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Bullets
  // -------------------------------------------------------------------------

  private renderBullets(world: World, t: number): void {
    const g = this.bulletGfx;
    g.clear();
    const parts = world.bulletParts;
    if (parts === null) return;

    for (let i = 1; i <= MAX_BULLETS; i++) {
      const bullet = world.bullets[i];
      if (bullet === undefined || !bullet.active) {
        this.bulletInterp[i] = undefined;
        continue;
      }
      const num = bullet.num;
      const cx = parts.posX[num] ?? 0;
      const cy = parts.posY[num] ?? 0;
      const [x, y] = this.interp(this.bulletInterp, i, cx, cy, world.ticks, t);

      // Tracer: a short line along the bullet's velocity, plus a bright dot.
      const vx = parts.velocityX[num] ?? 0;
      const vy = parts.velocityY[num] ?? 0;
      const len = Math.hypot(vx, vy);
      if (len > 0.0001) {
        const ux = vx / len;
        const uy = vy / len;
        const tail = 6;
        g.moveTo(x - ux * tail, y - uy * tail)
          .lineTo(x, y)
          .stroke({ color: 0xfff0a0, width: 1.5 });
      }
      g.circle(x, y, BULLET_RADIUS).fill({ color: 0xffffff });
    }
  }

  // -------------------------------------------------------------------------
  // Things (flags / kits)
  // -------------------------------------------------------------------------

  private renderThings(world: World, t: number): void {
    const g = this.thingGfx;
    g.clear();
    const parts = world.thingParts;
    if (parts === null) return;

    for (let i = 1; i <= MAX_THINGS; i++) {
      const thing = world.things[i];
      if (thing === undefined || !thing.active) {
        this.thingInterp[i] = undefined;
        continue;
      }
      const num = thing.num;
      const cx = parts.posX[num] ?? 0;
      const cy = parts.posY[num] ?? 0;
      const [x, y] = this.interp(this.thingInterp, i, cx, cy, world.ticks, t);

      // Colour by team: 1=alpha (red), 2=bravo (blue), else neutral (green).
      const color =
        thing.team === 1 ? 0xff4040 : thing.team === 2 ? 0x4080ff : 0x40d060;
      g.rect(x - THING_HALF, y - THING_HALF, THING_HALF * 2, THING_HALF * 2).fill({
        color,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Interpolation
  // -------------------------------------------------------------------------

  /**
   * Interpolate an entity's draw position between the last two simulated ticks.
   *
   * The cache holds (prev = position at end of the prior tick, cur = position at
   * end of the current tick). Each rendered frame we lerp prev→cur by t
   * (framePercent). When a NEW sim tick is detected (tick advanced), the old cur
   * becomes the new prev and cur is updated to this tick's position — so the
   * "previous" reference always tracks the last completed tick, independent of
   * how many frames were drawn in between.
   *
   * On first sighting (no cache) we seed prev = cur = current and draw there.
   */
  private interp(
    cache: (InterpState | undefined)[],
    index: number,
    curX: number,
    curY: number,
    tick: number,
    t: number,
  ): [number, number] {
    const s = cache[index];
    if (s === undefined) {
      cache[index] = { prevX: curX, prevY: curY, curX, curY, tick };
      return [curX, curY];
    }
    if (tick !== s.tick) {
      // A new tick has run: roll current → previous, record the new target.
      s.prevX = s.curX;
      s.prevY = s.curY;
      s.curX = curX;
      s.curY = curY;
      s.tick = tick;
    } else {
      // Same tick, another render frame: keep the target fresh (no-op if equal).
      s.curX = curX;
      s.curY = curY;
    }
    const x = s.prevX + (s.curX - s.prevX) * t;
    const y = s.prevY + (s.curY - s.prevY) * t;
    return [x, y];
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
