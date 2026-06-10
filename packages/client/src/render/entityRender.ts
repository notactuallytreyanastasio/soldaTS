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

import { Assets, Container, Graphics, Sprite, type Texture } from 'pixi.js';
import {
  MAX_SPRITES,
  MAX_BULLETS,
  MAX_THINGS,
  BulletStyle,
  WeaponIndex,
  WeaponNum,
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

  // SPAS-12 carrier overlay: the real spas12.png weapon sprite when the
  // weapons-gfx asset loads, otherwise a vector barrel (drawn in markerGfx).
  // An overlay layer — neither gostek path (textured or vector) is touched.
  private spasTexture: Texture | null = null;
  private readonly spasLayer: Container = new Container();
  private readonly spasPool: (Sprite | undefined)[] = [];

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
    // SPAS weapon sprite is best-effort: a missing asset falls back to the
    // vector barrel, never blocks (or breaks) the textured gostek path.
    try {
      this.spasTexture = await Assets.load<Texture>('/gfx/weapons-gfx/spas12.png');
    } catch {
      this.spasTexture = null;
    }
  }

  /** Team chevrons (drawn above heads) — legible at any zoom. */
  private readonly markerGfx: Graphics = new Graphics();

  constructor() {
    // Draw order: things under bullets under sprites (players on top),
    // team markers above everything.
    this.container.addChild(this.thingGfx);
    this.container.addChild(this.bulletGfx);
    this.container.addChild(this.spriteGfx);
    this.container.addChild(this.gostekLayer);
    this.container.addChild(this.spasLayer);
    this.container.addChild(this.markerGfx);
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
    this.markerGfx.clear();
    const parts = world.spriteParts;
    if (parts === null) return;

    for (let i = 1; i <= MAX_SPRITES; i++) {
      const sprite = world.sprites[i];
      if (sprite === undefined || !sprite.active) {
        this.spriteInterp[i] = undefined;
        const pooled = this.gostekPool[i];
        if (pooled !== undefined) pooled.view.visible = false;
        const spasView = this.spasPool[i];
        if (spasView !== undefined) spasView.visible = false;
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
      // Real team when assigned (red 1 / blue 2, goal node 154); FFA falls
      // back to the old player-red / bots-blue convention.
      const team =
        sprite.team > 0 ? sprite.team : i === this.playerIndex ? 1 : 2;
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

      // SPAS-12 carrier: a visible weapon difference at any zoom. The real
      // spas12.png aimed along the carrier's aim line when the asset loaded;
      // a two-tone vector barrel otherwise.
      this.drawSpasWeapon(i, sprite.selWeapon === WeaponIndex.SPAS12 && !sprite.deadMeat, x, y, aimX, aimY);
      // Barrett carrier: a LONG slim vector barrel + scope nub (no asset
      // dependency) so the sniper reads as a sniper at any zoom.
      if (sprite.selWeapon === WeaponIndex.BARRETT && !sprite.deadMeat) {
        this.drawBarrettWeapon(x, y, aimX, aimY);
      }

      // TEAM CHEVRON above the head (real teams only): the Gostek textures
      // read as dark camo at spectator zoom, so the tinted shirt pixels are
      // not enough to tell red from blue — this marker is legible at any
      // zoom (user question: "why isn't it blue characters vs red ones").
      if (sprite.team > 0 && !sprite.deadMeat) {
        const color = sprite.team === 1 ? 0xd23c3c : 0x4060d2;
        this.markerGfx
          .poly([x - 7, y - 42, x + 7, y - 42, x, y - 31])
          .fill({ color, alpha: 0.95 });
      }
    }
  }

  /** Hand height (world units above the COM) where the weapon overlay sits. */
  private static readonly SPAS_HAND_LIFT = 14;

  /** Show/update (or hide) sprite slot `i`'s SPAS-12 weapon overlay. */
  private drawSpasWeapon(
    i: number,
    carrying: boolean,
    x: number,
    y: number,
    aimX: number,
    aimY: number,
  ): void {
    const handY = y - EntityRenderer.SPAS_HAND_LIFT;
    let view = this.spasPool[i];
    if (carrying && this.spasTexture !== null) {
      if (view === undefined) {
        view = new Sprite(this.spasTexture);
        view.anchor.set(0.3, 0.5);
        this.spasPool[i] = view;
        this.spasLayer.addChild(view);
      }
      view.visible = true;
      view.position.set(x, handY);
      const ang = Math.atan2(aimY - handY, aimX - x);
      view.rotation = ang;
      // Flip across the barrel axis when aiming left so the gun stays upright.
      const flip = Math.cos(ang) < 0 ? -1 : 1;
      view.scale.set(0.55, 0.55 * flip);
      return;
    }
    if (view !== undefined) view.visible = false;
    if (!carrying) return;
    // Vector fallback: dark barrel + wooden pump along the aim line.
    const dx = aimX - x;
    const dy = aimY - handY;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    this.markerGfx
      .moveTo(x + ux * 2, handY + uy * 2)
      .lineTo(x + ux * 26, handY + uy * 26)
      .stroke({ color: 0x2e2a26, width: 4 })
      .moveTo(x + ux * 10, handY + uy * 10)
      .lineTo(x + ux * 18, handY + uy * 18)
      .stroke({ color: 0x8a5a2b, width: 6 });
  }

  /** Barrett carrier overlay: a long slim barrel + scope nub along the aim
   *  line (vector only — drawn into markerGfx like the SPAS fallback). */
  private drawBarrettWeapon(x: number, y: number, aimX: number, aimY: number): void {
    const handY = y - EntityRenderer.SPAS_HAND_LIFT;
    const dx = aimX - x;
    const dy = aimY - handY;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    this.markerGfx
      .moveTo(x + ux * 2, handY + uy * 2)
      .lineTo(x + ux * 38, handY + uy * 38)
      .stroke({ color: 0x1f242c, width: 3 })
      // Scope nub perpendicular to the barrel, mid-length.
      .moveTo(x + ux * 18 - uy * 2, handY + uy * 18 + ux * 2)
      .lineTo(x + ux * 18 - uy * 6, handY + uy * 18 + ux * 6)
      .stroke({ color: 0x4a5568, width: 3 });
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
      // SHOTGUN pellets get a stubbier, hotter-colored streak so a six-pellet
      // fan reads as one blast, not a burst of rifle rounds. BARRETT rounds
      // (PLAIN style, told apart by ownerWeapon — both AK and Barrett fire
      // PLAIN) get a LONG, thin, ice-bright streak: at 55 px/tick the round
      // crosses a screen in a blink, so the tracer IS the shot.
      const vx = parts.velocityX[num] ?? 0;
      const vy = parts.velocityY[num] ?? 0;
      const len = Math.hypot(vx, vy);
      const pellet = bullet.style === BulletStyle.SHOTGUN;
      const sniper = bullet.ownerWeapon === WeaponNum.BARRETT;
      if (len > 0.0001) {
        const ux = vx / len;
        const uy = vy / len;
        const tail = pellet ? 3.5 : sniper ? 30 : 6;
        g.moveTo(x - ux * tail, y - uy * tail)
          .lineTo(x, y)
          .stroke(
            pellet
              ? { color: 0xffa24a, width: 2.5 }
              : sniper
                ? { color: 0xd8f4ff, width: 1.2 }
                : { color: 0xfff0a0, width: 1.5 },
          );
      }
      if (pellet) {
        g.circle(x, y, 1.4).fill({ color: 0xffd9a0 });
      } else if (sniper) {
        g.circle(x, y, 1.6).fill({ color: 0xf2fbff });
      } else {
        g.circle(x, y, BULLET_RADIUS).fill({ color: 0xffffff });
      }
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
