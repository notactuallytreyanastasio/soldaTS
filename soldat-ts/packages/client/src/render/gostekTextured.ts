// Textured "Gostek" renderer — draws a Soldat soldier out of the REAL body-part
// PNGs (gfx/gostek-gfx/*.png), one Sprite per bone, posed on a procedural
// skeleton.
//
// This mirrors client/GostekGraphics.pas (RenderGostek + DrawGostekSprite) and
// the part table in client/GostekGraphics.inc. Each part spans two skeleton
// points p1->p2; the sprite is positioned at p1, rotated by atan2(p2-p1),
// scaled along its length, with a normalized pivot (cx,cy) in [0..1] of the
// texture. See DrawGostekSprite: the quad spans (Width*Scale, Height*Scale)
// from a matrix whose translation is (x - cx*basisX - cy*basisYrot), i.e. the
// anchor is the fraction (cx,cy) of the texture.
//
// Rest-pose skeleton point positions come from
// public/objects/gostek.po (blocks "Pn / x / depth / height"); we use value 1
// as X and value 3 as height (feet at height 0, hips ~3.2, head ~6.5). The
// shared sim space is y-DOWN, so we map height upward as -height.
//
// Coordinates are sim world units (y DOWN). We draw in world space anchored at
// the soldier centre-of-mass (comX,comY); the caller's camera container does
// the screen transform. AVOIDS custom shaders — pure Sprites.

import { Assets, Container, Sprite, Texture } from 'pixi.js';
import type { Renderer } from 'pixi.js';

// --- Skeleton rest pose (from public/objects/gostek.po) ------------------
// Parsed numbers: index = point number (1-based in the file -> we store 0-based
// arrays indexed by point number, slot 0 unused). x = 1st value, h = 3rd value
// (height; feet=0, hips~3.2, head top~6.5). Source: gostek.po.
interface RestPoint {
  x: number;
  h: number;
}

// Indexed by skeleton point number (1..24). Slot 0 is a dummy.
const REST: readonly RestPoint[] = [
  { x: 0, h: 0 }, // 0 unused
  { x: 1.0, h: 0 }, // P1
  { x: -1.0, h: 0 }, // P2
  { x: -1.0, h: 1.5 }, // P3
  { x: 1.0, h: 1.5 }, // P4
  { x: 0.7, h: 3.2 }, // P5  right hip
  { x: -0.7, h: 3.2 }, // P6  left hip
  { x: -0.6, h: 4.0 }, // P7
  { x: 0.6, h: 4.0 }, // P8
  { x: 0.0, h: 5.5 }, // P9  neck/head base
  { x: 1.0, h: 5.0 }, // P10 right shoulder
  { x: -1.0, h: 5.0 }, // P11 left shoulder
  { x: 0.0, h: 6.5 }, // P12 head top
  { x: 1.7, h: 4.6 }, // P13 right elbow
  { x: -1.7, h: 4.6 }, // P14 left elbow
  { x: -1.5, h: 3.5 }, // P15 left hand
  { x: 1.5, h: 3.5 }, // P16 right hand
  { x: 2.0, h: 0.0 }, // P17 right foot tip
  { x: -2.0, h: 0.0 }, // P18 left foot tip
  { x: -1.5, h: 3.0 }, // P19 left hand (alt)
  { x: 1.5, h: 3.0 }, // P20 right hand (alt)
  { x: 0.5, h: 1.0 }, // P21
  { x: 0.5, h: 0.0 }, // P22
  { x: -0.5, h: 0.0 }, // P23
  { x: -0.5, h: 0.5 }, // P24
];

// --- Base body-part table (from GostekGraphics.inc) ----------------------
// Only the BASE parts (no _DMG/_VEST/secondary-weapon/jet/chains). Fields:
//   gfx  : filename under /gfx/gostek-gfx/ (without .png)
//   p1,p2: skeleton point numbers the part spans
//   cx,cy: normalized pivot in [0..1] of the texture (Soldat's gs.cx/gs.cy)
//   color: which tint slot to use
//   flex : flex divisor (0 = none); when >0 the sprite stretches by length/flex
const enum Col {
  None,
  Main,
  Pants,
  Skin,
}

interface PartDef {
  gfx: string;
  p1: number;
  p2: number;
  cx: number;
  cy: number;
  color: Col;
  flex: number;
}

// Draw order matches the .inc order: back arm/leg first, front parts last.
// (Left_* are the BACK side in Soldat's default Direction=1.)
const PARTS: readonly PartDef[] = [
  { gfx: 'udo', p1: 6, p2: 3, cx: 0.2, cy: 0.5, color: Col.Pants, flex: 5 }, // Left_Thigh
  { gfx: 'stopa', p1: 2, p2: 18, cx: 0.35, cy: 0.35, color: Col.None, flex: 0 }, // Left_Foot
  { gfx: 'noga', p1: 3, p2: 2, cx: 0.15, cy: 0.55, color: Col.Pants, flex: 0 }, // Left_Lowerleg
  { gfx: 'ramie', p1: 11, p2: 14, cx: 0, cy: 0.5, color: Col.Main, flex: 0 }, // Left_Arm
  { gfx: 'reka', p1: 14, p2: 15, cx: 0, cy: 0.5, color: Col.Main, flex: 5 }, // Left_Forearm
  { gfx: 'dlon', p1: 15, p2: 19, cx: 0, cy: 0.4, color: Col.Skin, flex: 0 }, // Left_Hand
  { gfx: 'udo', p1: 5, p2: 4, cx: 0.2, cy: 0.65, color: Col.Pants, flex: 5 }, // Right_Thigh
  { gfx: 'stopa', p1: 1, p2: 17, cx: 0.35, cy: 0.35, color: Col.None, flex: 0 }, // Right_Foot
  { gfx: 'noga', p1: 4, p2: 1, cx: 0.15, cy: 0.55, color: Col.Pants, flex: 0 }, // Right_Lowerleg
  { gfx: 'klata', p1: 10, p2: 11, cx: 0.1, cy: 0.3, color: Col.Main, flex: 0 }, // Chest
  { gfx: 'biodro', p1: 5, p2: 6, cx: 0.25, cy: 0.6, color: Col.Main, flex: 0 }, // Hip
  { gfx: 'morda', p1: 9, p2: 12, cx: 0, cy: 0.5, color: Col.Skin, flex: 0 }, // Head
  { gfx: 'ramie', p1: 10, p2: 13, cx: 0, cy: 0.6, color: Col.Main, flex: 0 }, // Right_Arm
  { gfx: 'reka', p1: 13, p2: 16, cx: 0, cy: 0.6, color: Col.Main, flex: 5 }, // Right_Forearm
  { gfx: 'dlon', p1: 16, p2: 20, cx: 0, cy: 0.5, color: Col.Skin, flex: 0 }, // Right_Hand
];

// --- World scale ---------------------------------------------------------
// Rest pose head top is at h=6.5; we scale so the standing figure is ~36 world
// units tall, matching the procedural gostek (HEAD->feet). 36 / 6.5 ~= 5.54.
export const WORLD_SCALE = 5.54;

// Texture display scale: Soldat sprites use Sprite.Scale; the part PNGs are
// authored at roughly the skeleton's pixel size. We scale texture pixels into
// world units so a part's authored length roughly matches its bone length.
// Tunable by the orchestrator if parts look too big/small.
export const TEXTURE_SCALE = 0.5;

// --- Tint colors ---------------------------------------------------------
const SKIN_TINT = 0xc8a08c;
function teamMain(team: number): number {
  if (team === 1) return 0xd23c3c; // alpha red
  if (team === 2) return 0x4060d2; // bravo blue
  return 0x4a9e4a; // neutral green
}
function teamPants(team: number): number {
  // darker shade of the main color
  const m = teamMain(team);
  const r = (m >> 16) & 0xff;
  const g = (m >> 8) & 0xff;
  const b = m & 0xff;
  const f = 0.55;
  return ((r * f) << 16) | ((g * f) << 8) | (b * f);
}

/** Result of placing a bone between two skeleton points. */
export interface BoneTransform {
  x: number;
  y: number;
  rotation: number;
  length: number;
}

/**
 * Compute the position/rotation/length for a bone spanning p1->p2.
 * Position is p1; rotation is atan2(dy,dx); length is the distance.
 * A horizontal bone (p1 left of p2 at same y) has rotation 0.
 */
export function boneTransform(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
): BoneTransform {
  const dx = p2x - p1x;
  const dy = p2y - p1y;
  return {
    x: p1x,
    y: p1y,
    rotation: Math.atan2(dy, dx),
    length: Math.sqrt(dx * dx + dy * dy),
  };
}

/** Inputs for posing/drawing one textured Gostek. y is DOWN (world units). */
export interface GostekRenderOpts {
  /** Centre-of-mass world X (hip area anchor). */
  comX: number;
  /** Centre-of-mass world Y. */
  comY: number;
  /** Aim target world X. */
  aimX: number;
  /** Aim target world Y. */
  aimY: number;
  /** Horizontal velocity (world u/s) — drives leg swing. */
  vx: number;
  /** Vertical velocity (world u/s). */
  vy: number;
  /** Whether standing on ground (plant/swing legs vs tuck airborne). */
  onGround: boolean;
  /** Walk-cycle phase 0..1, advanced by caller. */
  phase: number;
  /** Facing: +1 right, -1 left. */
  facing: number;
  /** Team id: 1 alpha, 2 bravo, else neutral. */
  team: number;
  /** When true, draw a limp/dead pose. */
  dead: boolean;
}

// A live, posed point in world units.
interface PosedPoint {
  x: number;
  y: number;
}

const TEXTURE_BASE = '/gfx/gostek-gfx/';
const UNIQUE_GFX = Array.from(new Set(PARTS.map((p) => p.gfx)));
const TEXTURE_CACHE = new Map<string, Texture>();
let loadPromise: Promise<void> | null = null;

/**
 * One textured soldier. Owns a pixi Container (this.view) holding one Sprite
 * per body part. Textures are loaded once and shared statically across
 * instances. Call `load()` (resolves before first draw), then `update(opts)`
 * each frame.
 */
export class TexturedGostek {
  /** Container to add to the world/camera layer. */
  public readonly view: Container;

  private readonly sprites: Sprite[] = [];

  // Working buffer of posed skeleton points (indexed by point number).
  private readonly posed: PosedPoint[] = REST.map(() => ({ x: 0, y: 0 }));

  public constructor() {
    this.view = new Container();
  }

  /**
   * Load all unique part textures once (shared across instances). Safe to call
   * concurrently; resolves when every texture is available.
   */
  public static async load(renderer?: Renderer): Promise<void> {
    void renderer;
    if (loadPromise) return loadPromise;
    loadPromise = (async (): Promise<void> => {
      await Promise.all(
        UNIQUE_GFX.map(async (name) => {
          const url = `${TEXTURE_BASE}${name}.png`;
          const tex = (await Assets.load(url)) as Texture;
          TEXTURE_CACHE.set(name, tex);
        }),
      );
    })();
    return loadPromise;
  }

  /** Instance load wrapper; also builds the sprites for this instance. */
  public async load(): Promise<void> {
    await TexturedGostek.load();
    if (this.sprites.length === 0) this.buildSprites();
  }

  private buildSprites(): void {
    for (const part of PARTS) {
      const tex = TEXTURE_CACHE.get(part.gfx) ?? Texture.WHITE;
      const sprite = new Sprite(tex);
      this.sprites.push(sprite);
      this.view.addChild(sprite);
    }
  }

  /**
   * Pose the skeleton from the rest pose and lay out each part Sprite.
   * Legs swing with `phase` when moving / tuck when airborne; the arm+hand
   * points rotate toward (aimX,aimY); the whole figure flips by `facing`.
   */
  public update(opts: GostekRenderOpts): void {
    if (this.sprites.length === 0) return;

    this.poseSkeleton(opts);

    const mainTint = teamMain(opts.team);
    const pantsTint = teamPants(opts.team);

    for (let i = 0; i < PARTS.length; i++) {
      const part = PARTS[i];
      const sprite = this.sprites[i];
      if (part === undefined || sprite === undefined) continue;

      const a = this.posed[part.p1];
      const b = this.posed[part.p2];
      if (a === undefined || b === undefined) continue;

      const bone = boneTransform(a.x, a.y, b.x, b.y);
      const tex = sprite.texture;
      const texW = tex.width * TEXTURE_SCALE;
      const texH = tex.height * TEXTURE_SCALE;

      sprite.position.set(bone.x, bone.y);
      sprite.rotation = bone.rotation;

      // anchor = normalized pivot (cx,cy). When facing left, mirror the sprite
      // vertically about its bone axis (Soldat uses sy=-1 / cy=1-cy).
      let cy = part.cy;
      let scaleY = TEXTURE_SCALE;
      if (opts.facing < 0) {
        cy = 1 - part.cy;
        scaleY = -TEXTURE_SCALE;
      }
      sprite.anchor.set(part.cx, cy);

      // Stretch along bone length. With flex, scale X so authored length flexes
      // to fit; otherwise scale so the texture's authored length spans the bone.
      let scaleX = TEXTURE_SCALE;
      if (texW > 0) {
        if (part.flex > 0) {
          const f = Math.min(1.5, bone.length / (part.flex * WORLD_SCALE));
          scaleX = TEXTURE_SCALE * f;
        } else {
          scaleX = bone.length / tex.width;
        }
      }
      void texH;
      sprite.scale.set(scaleX, scaleY);

      // tint
      let tint = 0xffffff;
      if (part.color === Col.Main) tint = mainTint;
      else if (part.color === Col.Pants) tint = pantsTint;
      else if (part.color === Col.Skin) tint = SKIN_TINT;
      sprite.tint = tint;

      sprite.alpha = opts.dead ? 0.85 : 1;
    }
  }

  // Build world-space posed points from the rest pose + animation.
  private poseSkeleton(opts: GostekRenderOpts): void {
    const s = WORLD_SCALE;
    const face = opts.facing < 0 ? -1 : 1;

    // Hip centre (between P5/P6) sits at the COM. Rest hip height ~3.2; we anchor
    // so the COM is at the hip and the figure extends up (head) and down (feet).
    const hipH = 3.2;

    // Walk swing: legs alternate; amplitude from horizontal speed.
    const moving = opts.onGround && Math.abs(opts.vx) > 0.5;
    const swing = moving ? Math.sin(opts.phase * Math.PI * 2) : 0;
    const tuck = opts.onGround ? 0 : 1; // airborne: pull feet up

    for (let i = 0; i < REST.length; i++) {
      const r = REST[i];
      const dst = this.posed[i];
      if (r === undefined || dst === undefined) continue;

      let rx = r.x;
      let rh = r.h;

      // Legs: P3,P2,P18,P24 (left lower chain) and P4,P1,P17,P21,P22,P23 (right)
      // approximate by swinging foot/lowerleg points fore/aft along X and
      // tucking them up when airborne.
      const isRightLeg = i === 4 || i === 1 || i === 17;
      const isLeftLeg = i === 3 || i === 2 || i === 18;
      if (isRightLeg) {
        rx += swing * 1.2;
        rh += tuck * 1.6 + Math.max(0, swing) * 0.6;
      } else if (isLeftLeg) {
        rx -= swing * 1.2;
        rh += tuck * 1.6 + Math.max(0, -swing) * 0.6;
      }

      // world: x mirrored by facing; height up = -h (y down). Anchor hip at COM.
      dst.x = opts.comX + face * rx * s;
      dst.y = opts.comY - (rh - hipH) * s;
    }

    if (opts.dead) {
      // Flatten: collapse everyone near the ground line through the hip.
      for (let i = 0; i < this.posed.length; i++) {
        const dst = this.posed[i];
        const r = REST[i];
        if (dst === undefined || r === undefined) continue;
        dst.y = opts.comY + (hipH - 0.5) * s * 0.2;
        dst.x = opts.comX + face * (r.x + (r.h - hipH) * 0.9) * s;
      }
    } else {
      this.aimArms(opts, face, s, hipH);
    }
  }

  // Rotate the arm chain (shoulder->elbow->hand) toward the aim vector.
  private aimArms(
    opts: GostekRenderOpts,
    face: number,
    s: number,
    hipH: number,
  ): void {
    const aimAngle = Math.atan2(opts.aimY - opts.comY, opts.aimX - opts.comX);

    // Right shoulder P10, right elbow P13, right hand P16/P20.
    // Left shoulder P11, left elbow P14, left hand P15/P19.
    const shoulderR = this.posed[10];
    const shoulderL = this.posed[11];
    if (shoulderR === undefined || shoulderL === undefined) return;

    const upperLen = 1.7 * s; // shoulder->elbow rest reach
    const foreLen = 1.4 * s; // elbow->hand rest reach

    // Right (front) arm points at aim.
    const eR = this.posed[13];
    const hR16 = this.posed[16];
    const hR20 = this.posed[20];
    if (eR && hR16 && hR20) {
      const elbowAng = aimAngle;
      eR.x = shoulderR.x + Math.cos(elbowAng) * upperLen * 0.6;
      eR.y = shoulderR.y + Math.sin(elbowAng) * upperLen * 0.6;
      const hx = eR.x + Math.cos(aimAngle) * foreLen;
      const hy = eR.y + Math.sin(aimAngle) * foreLen;
      hR16.x = hx;
      hR16.y = hy;
      hR20.x = hx + Math.cos(aimAngle) * foreLen * 0.4;
      hR20.y = hy + Math.sin(aimAngle) * foreLen * 0.4;
    }

    // Left (back) arm roughly follows aim too but tucked closer to body.
    const eL = this.posed[14];
    const hL15 = this.posed[15];
    const hL19 = this.posed[19];
    if (eL && hL15 && hL19) {
      const backAng = aimAngle + face * 0.35;
      eL.x = shoulderL.x + Math.cos(backAng) * upperLen * 0.55;
      eL.y = shoulderL.y + Math.sin(backAng) * upperLen * 0.55;
      const hx = eL.x + Math.cos(aimAngle) * foreLen * 0.9;
      const hy = eL.y + Math.sin(aimAngle) * foreLen * 0.9;
      hL15.x = hx;
      hL15.y = hy;
      hL19.x = hx + Math.cos(aimAngle) * foreLen * 0.4;
      hL19.y = hy + Math.sin(aimAngle) * foreLen * 0.4;
    }
    void hipH;
  }
}
