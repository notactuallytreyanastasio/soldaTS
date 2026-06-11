// ONLINE 1v1 (goal node 450) — the `?online` boot mode: connect to the game
// server, get paired against another human, fight red vs blue.
//
// THE MODEL (decision node 455):
//   * The SERVER is authoritative: it runs the same headless Game
//     (humanCount: 2, botCount: 0) and streams FULL sprite snapshots at 20 Hz.
//   * YOUR sprite is client-side predicted with @soldat/netcode's
//     PredictionBuffer over a bare sim World: every sim tick records your
//     InputFrame (stepping the local world once for instant response) and
//     sends it to the server; each own-sprite snapshot arrives stamped with
//     the clientTick the server last applied, so the buffer snaps to the
//     authoritative state and replays only the unacknowledged inputs.
//   * The OPPONENT is dead-reckoned: every render frame their sprite is
//     pinned to (latest snapshot position + velocity × ticks-since), so the
//     local physics steps in between never accumulate drift.
//   * BULLETS are cosmetic client-side (spawned from each sprite's live fire
//     button with hitMultiply 0 — they render and collide with the map but
//     deal no local damage); hits, health, kills, and respawns are all
//     server truth carried by snapshots, heartbeats, and kill chats.
//
// V1 GAPS (shipped loudly, not silently): ammo/reload state rides only the
// snapshot's ammoCount, jet fuel is mirrored locally (not on the wire), and
// the chance wildcard never arms anyone (it arms BOTS; there are none) — both
// players start AK74 and may cycle weapons with Tab as usual.

import type { Control } from '@soldat/sim';
import {
  createWorld,
  initSimWorld,
  buildPolyMap,
  vec2,
  spawnBullet,
  getGun,
  POS_STAND,
  WeaponIndex,
  type World,
} from '@soldat/sim';
import {
  decodeMessage,
  encodeMessage,
  HandshakeResult,
  Posture,
  PROTOCOL_VERSION,
  type InputFrame,
  type Message,
  type SpriteSnapshotFull,
} from '@soldat/protocol';
import { PredictionBuffer, applySpriteSnapshot } from '@soldat/netcode';
import { buildMapMesh } from '../render/mapMesh';
import { MapRenderer } from '../render/renderer';
import { EntityRenderer } from '../render/entityRender';
import { BloodFx, Crosshair } from '../render/fx';
import { buildTexturedMap } from '../render/mapTextured';
import { InputController } from '../input/input';
import { Hud, type HudState } from '../ui/hud';
import { shouldShowControls, showControlsScreen } from '../ui/controlsScreen';
import { START_HEALTH } from '../ui/helpers';
import { applyKill, type KillBoard } from './director';
import { generateArena } from './arena';
import { DEFAULT_TUNING } from './game';

const TICK_HZ = 60;
const TICK_DT = 1 / TICK_HZ;
const MAX_TICKS_PER_FRAME = 4;
/** Cosmetic-fire cadence (the AK's stock fireInterval — visuals only). */
const COSMETIC_FIRE_INTERVAL = 6;
/** Muzzle stand-off, mirrors Game.MUZZLE_OFFSET. */
const MUZZLE_OFFSET = 14;
/** Dead-reckoning extrapolation cap (ticks) for the opponent sprite. */
const EXTRAPOLATE_MAX_TICKS = 12;

const TEAM_NAMES: Record<number, string> = { 1: 'RED', 2: 'BLUE' };
const TEAM_CSS: Record<number, string> = { 1: '#d23c3c', 2: '#4060d2' };
/** selWeapon (a sim WeaponIndex) → HUD/kill-feed label. */
const WEAPON_LABEL_BY_INDEX: Partial<Record<number, string>> = {
  [WeaponIndex.AK74]: 'AK74',
  [WeaponIndex.SPAS12]: 'SPAS12',
  [WeaponIndex.BARRETT]: 'BARRETT',
  [WeaponIndex.M79]: 'ROCKET',
  [WeaponIndex.RICOCHET]: 'RICOCHET',
  [WeaponIndex.CHAINSAW]: 'CHAINSAW',
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in online.test.ts)
// ---------------------------------------------------------------------------

/**
 * The game-server WebSocket URL for the page we're served from. Production
 * (https, behind Caddy) uses the same-origin /arena/ws route; local dev (the
 * vite server on http) dials the game server's own port directly.
 */
export function deriveWsUrl(loc: { protocol: string; host: string; hostname: string }): string {
  return loc.protocol === 'https:'
    ? `wss://${loc.host}/arena/ws`
    : `ws://${loc.hostname}:8902`;
}

/** Map a sim Control onto the wire InputFrame for `clientTick`. */
export function controlToInputFrame(clientTick: number, c: Control): InputFrame {
  return {
    clientTick,
    buttons: {
      left: c.left,
      right: c.right,
      up: c.up,
      down: c.down,
      fire: c.fire,
      jetpack: c.jetpack,
      throwNade: c.throwNade,
      changeWeapon: c.changeWeapon,
      throwWeapon: c.throwWeapon,
      reload: c.reload,
      flagThrow: c.flagThrow,
    },
    aim: { x: Math.round(c.mouseAimX), y: Math.round(c.mouseAimY) },
    posture: c.prone ? Posture.Prone : Posture.Standing,
  };
}

/** Parse the welcome's mapName recipe (`arena=<A>&seed=<S>`). */
export function parseMatchRecipe(mapName: string): { arenaSeed: number; seed: number } {
  const p = new URLSearchParams(mapName);
  const arenaSeed = parseInt(p.get('arena') ?? '', 10);
  const seed = parseInt(p.get('seed') ?? '', 10);
  return {
    arenaSeed: Number.isFinite(arenaSeed) ? arenaSeed : 1,
    seed: Number.isFinite(seed) ? seed : 1,
  };
}

/** Structured server chat lines (`kill:..`, `end:..`, `queue:waiting`). */
export type ServerEvent =
  | { type: 'waiting' }
  | { type: 'kill'; killer: number; victim: number; weapon: string }
  | { type: 'end'; reason: string; winnerNum: number }
  | { type: 'other'; text: string };

export function parseServerChat(text: string): ServerEvent {
  const parts = text.split(':');
  if (parts[0] === 'queue') return { type: 'waiting' };
  if (parts[0] === 'kill') {
    return {
      type: 'kill',
      killer: parseInt(parts[1] ?? '0', 10) || 0,
      victim: parseInt(parts[2] ?? '0', 10) || 0,
      weapon: parts[3] ?? 'AK74',
    };
  }
  if (parts[0] === 'end') {
    return {
      type: 'end',
      reason: parts[1] ?? 'unknown',
      winnerNum: parseInt(parts[2] ?? '0', 10) || 0,
    };
  }
  return { type: 'other', text };
}

// ---------------------------------------------------------------------------
// Local world setup
// ---------------------------------------------------------------------------

/** Spawn one online sprite (the slice of Game.spawnSprite the client needs). */
function spawnOnlineSprite(
  world: World,
  num: number,
  spawn: { x: number; y: number },
  team: number,
): void {
  const parts = world.spriteParts;
  if (parts === null) throw new Error('online: spriteParts not initialized');
  parts.createPart(vec2(spawn.x, spawn.y), vec2(0, 0), 1, num);
  const s = world.sprites[num];
  if (s === undefined) throw new Error(`online: sprite slot ${num} missing`);
  s.active = true;
  s.num = num;
  s.style = 1;
  s.position = POS_STAND;
  s.direction = 1;
  s.health = START_HEALTH;
  s.visible = 1;
  s.deadMeat = false;
  s.dummy = false;
  s.team = team;
  s.selWeapon = WeaponIndex.AK74;
  s.jetsCount = DEFAULT_TUNING.jetFuelMax;
  s.jetsCountReal = DEFAULT_TUNING.jetFuelMax;
  s.control = {
    left: false,
    right: false,
    up: false,
    down: false,
    fire: false,
    jetpack: false,
    throwNade: false,
    changeWeapon: false,
    throwWeapon: false,
    reload: false,
    prone: false,
    flagThrow: false,
    mouseAimX: num === 1 ? 100 : -100,
    mouseAimY: 0,
    mouseDist: 0,
  };
}

// ---------------------------------------------------------------------------
// DOM overlays
// ---------------------------------------------------------------------------

function makeOverlay(): { set(html: string, color?: string): void; hide(): void } {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:1000',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'background:rgba(10,12,16,0.92)',
    'color:#e8e4d8',
    'font-family:ui-monospace,Menlo,monospace',
    'font-size:22px',
    'letter-spacing:0.2em',
    'text-align:center',
    'line-height:2',
    'user-select:none',
  ].join(';');
  document.body.appendChild(el);
  return {
    set(html: string, color = '#e8e4d8'): void {
      el.innerHTML = html;
      el.style.color = color;
      el.style.display = 'flex';
    },
    hide(): void {
      el.style.display = 'none';
    },
  };
}

function showTeamBanner(myTeam: number): void {
  const el = document.createElement('div');
  const opp = myTeam === 1 ? 2 : 1;
  el.innerHTML =
    `<span style="color:${TEAM_CSS[myTeam]};font-weight:bold">${TEAM_NAMES[myTeam]} YOU</span>` +
    `<span style="color:#9aa3b2"> vs </span>` +
    `<span style="color:${TEAM_CSS[opp]};font-weight:bold">${TEAM_NAMES[opp]} STRANGER</span>`;
  el.style.cssText = [
    'position:fixed',
    'top:10px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:30',
    'font:14px ui-monospace,Menlo,monospace',
    'letter-spacing:0.18em',
    'background:rgba(10,12,16,0.65)',
    'padding:4px 12px',
    'border-radius:6px',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(el);
}

// ---------------------------------------------------------------------------
// The boot
// ---------------------------------------------------------------------------

export async function onlineMain(): Promise<void> {
  const overlay = makeOverlay();
  overlay.set('CONNECTING…');

  const ws = new WebSocket(deriveWsUrl(window.location));
  ws.binaryType = 'arraybuffer';

  let booted = false;
  let matchOver = false;

  ws.addEventListener('open', () => {
    overlay.set('FINDING AN OPPONENT…<br><span style="font-size:13px;color:#9aa3b2">first to arrive waits — send a friend to /arena/play/?online</span>');
    ws.send(
      encodeMessage({
        kind: 'handshake',
        handshake: {
          kind: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          gameVersion: '1',
          haveAntiCheat: false,
          hardwareId: '',
          password: '',
          name: 'stranger',
          team: 0,
          look: 0,
          modChecksum: '',
        },
      }),
    );
  });
  ws.addEventListener('close', () => {
    if (!matchOver) {
      overlay.set(
        booted
          ? 'CONNECTION LOST<br><span style="font-size:13px">reload to find a new match</span>'
          : 'GAME SERVER UNREACHABLE<br><span style="font-size:13px">try again in a minute</span>',
        '#ffb347',
      );
    }
  });

  // Pre-match messages: wait for the welcome, then hand off to bootMatch.
  const onLobbyMessage = (e: MessageEvent): void => {
    if (!(e.data instanceof ArrayBuffer)) return;
    let msg: Message;
    try {
      msg = decodeMessage(e.data);
    } catch {
      return;
    }
    if (msg.kind === 'chat' && parseServerChat(msg.text).type === 'waiting') {
      return; // already showing the waiting overlay
    }
    if (msg.kind !== 'handshake' || msg.handshake.kind !== 'welcome') return;
    const welcome = msg.handshake;
    if (welcome.result !== HandshakeResult.Ok || welcome.yourNum === undefined) {
      overlay.set(`REJECTED: ${welcome.reason ?? 'unknown'}`, '#ffb347');
      ws.close();
      return;
    }
    ws.removeEventListener('message', onLobbyMessage);
    booted = true;
    void bootMatch(welcome.yourNum, welcome.mapName ?? '');
  };
  ws.addEventListener('message', onLobbyMessage);

  // --- The match ------------------------------------------------------------

  async function bootMatch(myNum: number, mapName: string): Promise<void> {
    const { arenaSeed, seed } = parseMatchRecipe(mapName);
    const oppNum = myNum === 1 ? 2 : 1;
    const myTeam = myNum; // slot 1 = red, slot 2 = blue (server contract)

    const mount = document.getElementById('app');
    if (mount === null) throw new Error('#app element not found');
    const renderer = new MapRenderer({ container: mount });
    await renderer.init();

    const { map, spawns } = generateArena(arenaSeed);
    const mesh = buildMapMesh(map);
    renderer.setMap(mesh);
    try {
      const textured = await buildTexturedMap(map, mesh);
      if (textured.children.length > 0) renderer.world.addChildAt(textured, 1);
    } catch {
      /* flat colours are fine */
    }

    // Local predicted world: both sprites spawned exactly where the server
    // spawned them (same generateArena recipe, same spawn cycling).
    const world = createWorld();
    initSimWorld(world, { seed });
    world.map = buildPolyMap(map);
    spawnOnlineSprite(world, 1, spawns[0] ?? { x: 0, y: 0 }, 1);
    spawnOnlineSprite(world, 2, spawns[1 % spawns.length] ?? { x: 0, y: 0 }, 2);
    const buffer = new PredictionBuffer(world, myNum);

    const entityRenderer = new EntityRenderer();
    entityRenderer.playerIndex = myNum;
    renderer.world.addChild(entityRenderer.container);
    void entityRenderer.enableTextured().catch(() => undefined);

    const blood = new BloodFx();
    renderer.world.addChild(blood.gfx);
    world.onBulletHit = (_victim, x, y, vx, vy, damage, fatal): void => {
      blood.spawnHit(x, y, vx, vy, damage, fatal);
    };

    const crosshair = new Crosshair();
    renderer.world.addChild(crosshair);

    const hud = new Hud();
    const stage = renderer.app?.stage;
    if (stage !== undefined) {
      stage.addChild(hud);
      hud.resize(renderer.app?.canvas.width ?? 0, renderer.app?.canvas.height ?? 0);
    }

    const canvas = renderer.app?.canvas;
    if (canvas === undefined) throw new Error('renderer canvas missing after init()');
    const input = new InputController(canvas);
    if (shouldShowControls()) showControlsScreen();
    showTeamBanner(myTeam);
    overlay.hide();

    // --- Net state ---------------------------------------------------------
    const nameOf = (i: number): string => (i === myNum ? 'You' : 'Stranger');
    const board: KillBoard = { kills: new Map(), feed: [] };
    let teamScore: [number, number] = [0, 0];
    let ownAmmo = 30;
    let oppSnap: SpriteSnapshotFull | null = null;
    let oppSnapAtTick = 0;
    let clientTick = 0;

    const markVitals = (num: number, health: number): void => {
      const s = world.sprites[num];
      if (s !== undefined) s.deadMeat = health <= 0;
    };

    ws.addEventListener('message', (e: MessageEvent) => {
      if (!(e.data instanceof ArrayBuffer)) return;
      let msg: Message;
      try {
        msg = decodeMessage(e.data);
      } catch {
        return;
      }
      if (msg.kind === 'spriteSnapshot') {
        const snap = msg.snapshot;
        if (snap.kind !== 'full') return; // v1 servers send full snapshots only
        if (snap.num === myNum) {
          ownAmmo = snap.weapon.ammoCount;
          buffer.onSnapshot(snap.serverTick, (w) => {
            applySpriteSnapshot(w, snap);
          });
          markVitals(myNum, snap.health);
        } else {
          oppSnap = snap;
          oppSnapAtTick = clientTick;
          applySpriteSnapshot(world, snap);
          markVitals(snap.num, snap.health);
        }
        return;
      }
      if (msg.kind === 'heartbeat') {
        teamScore = [msg.teamScore[0] ?? 0, msg.teamScore[1] ?? 0];
        for (const row of msg.players) board.kills.set(row.num, row.kills);
        return;
      }
      if (msg.kind === 'chat') {
        const ev = parseServerChat(msg.text);
        if (ev.type === 'kill') {
          applyKill(board, ev.killer, ev.victim, nameOf, myNum, ev.weapon);
        } else if (ev.type === 'end') {
          matchOver = true;
          const won = ev.winnerNum === myNum;
          overlay.set(
            won
              ? 'STRANGER LEFT — YOU WIN<br><span style="font-size:13px">reload for a new match</span>'
              : 'MATCH OVER<br><span style="font-size:13px">reload for a new match</span>',
            won ? '#9be07f' : '#ffb347',
          );
        }
      }
    });

    // --- Cosmetic fire (visual bullets; hitMultiply 0 = zero local damage) --
    const nextCosmeticFire: number[] = [0, 0, 0];
    const cosmeticFire = (num: number): void => {
      const s = world.sprites[num];
      const parts = world.spriteParts;
      if (s === undefined || parts === null || !s.active || s.deadMeat) return;
      if (!s.control.fire || clientTick < (nextCosmeticFire[num] ?? 0)) return;
      let ax = s.control.mouseAimX;
      let ay = s.control.mouseAimY;
      const len = Math.hypot(ax, ay);
      if (len < 1e-3) {
        ax = s.direction >= 0 ? 1 : -1;
        ay = 0;
      } else {
        ax /= len;
        ay /= len;
      }
      const gun = getGun(
        WEAPON_LABEL_BY_INDEX[s.selWeapon] !== undefined ? s.selWeapon : WeaponIndex.AK74,
        false,
      );
      const px = (parts.posX[num] ?? 0) + ax * MUZZLE_OFFSET;
      const py = (parts.posY[num] ?? 0) + ay * MUZZLE_OFFSET;
      spawnBullet(world, {
        pos: vec2(px, py),
        velocity: vec2(ax * gun.bulletSpeed, ay * gun.bulletSpeed),
        owner: num,
        hitMultiply: 0,
        gun,
      });
      s.direction = ax >= 0 ? 1 : -1;
      nextCosmeticFire[num] = clientTick + COSMETIC_FIRE_INTERVAL;
    };

    /** Mirror the Game's jet refuel rule for the local HUD bar. */
    const jetRegen = (num: number): void => {
      const s = world.sprites[num];
      if (s === undefined || s.deadMeat || !s.active) return;
      if (!s.control.jetpack && s.jetsCount < DEFAULT_TUNING.jetFuelMax) {
        const regen = s.onGround
          ? DEFAULT_TUNING.jetRegenPerTick
          : DEFAULT_TUNING.jetAirRegenPerTick;
        s.jetsCount = Math.min(s.jetsCount + regen, DEFAULT_TUNING.jetFuelMax);
      }
    };

    /** Pin the opponent to (latest snapshot + velocity × elapsed ticks). */
    const deadReckonOpponent = (): void => {
      if (oppSnap === null) return;
      const parts = world.spriteParts;
      if (parts === null) return;
      const dt = Math.min(clientTick - oppSnapAtTick, EXTRAPOLATE_MAX_TICKS);
      const px = oppSnap.pos.x + oppSnap.velocity.x * dt;
      const py = oppSnap.pos.y + oppSnap.velocity.y * dt;
      parts.posX[oppNum] = px;
      parts.posY[oppNum] = py;
      parts.oldX[oppNum] = px - oppSnap.velocity.x;
      parts.oldY[oppNum] = py - oppSnap.velocity.y;
      parts.velocityX[oppNum] = oppSnap.velocity.x;
      parts.velocityY[oppNum] = oppSnap.velocity.y;
    };

    // --- Camera --------------------------------------------------------------
    const centerCamera = (): void => {
      const app = renderer.app;
      const parts = world.spriteParts;
      if (app === undefined || parts === null) return;
      const zoom = renderer.camera.zoom;
      renderer.camera.x = app.renderer.width / 2 - (parts.posX[myNum] ?? 0) * zoom;
      renderer.camera.y = app.renderer.height / 2 - (parts.posY[myNum] ?? 0) * zoom;
      renderer.panBy(0, 0);
    };
    canvas.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const clamped = Math.max(-160, Math.min(160, e.deltaY));
        renderer.zoomAt(Math.exp(-clamped * 0.0004), e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false },
    );
    centerCamera();

    // --- Main loop -----------------------------------------------------------
    let accumulator = 0;
    let last = performance.now();
    const mySprite = world.sprites[myNum];
    if (mySprite === undefined) throw new Error('online: my sprite missing');

    const frame = (now: number): void => {
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;

      const app = renderer.app;
      const parts = world.spriteParts;
      const zoom = renderer.camera.zoom;
      const px = parts !== null ? (parts.posX[myNum] ?? 0) : 0;
      const py = parts !== null ? (parts.posY[myNum] ?? 0) : 0;
      const control = input.readControl(
        px * zoom + renderer.camera.x,
        py * zoom + renderer.camera.y,
        now,
      );
      crosshair.moveTo(px + control.mouseAimX, py + control.mouseAimY);

      if (!matchOver && ws.readyState === WebSocket.OPEN) {
        accumulator += dt;
        let ran = 0;
        while (accumulator >= TICK_DT && ran < MAX_TICKS_PER_FRAME) {
          clientTick += 1;
          // Cosmetic muzzle output for both sides BEFORE the predicted step
          // moves the world (the opponent fires from their last-known state).
          const myFrame = controlToInputFrame(clientTick, control);
          cosmeticFire(oppNum);
          // Record + predict (applies control to my sprite, steps the world).
          buffer.recordInput(clientTick, myFrame);
          cosmeticFire(myNum);
          jetRegen(myNum);
          ws.send(encodeMessage({ kind: 'inputFrame', ...myFrame }));
          accumulator -= TICK_DT;
          ran += 1;
        }
        if (accumulator > TICK_DT) accumulator = 0;
      }

      deadReckonOpponent();
      entityRenderer.render(world, accumulator / TICK_DT);
      blood.update(dt);
      blood.draw();
      centerCamera();

      const hudState: HudState = {
        health: mySprite.health,
        maxHealth: START_HEALTH,
        jet: mySprite.jetsCount,
        maxJet: DEFAULT_TUNING.jetFuelMax,
        ammo: ownAmmo,
        weaponName:
          `${TEAM_NAMES[myTeam]} YOU · ` +
          (WEAPON_LABEL_BY_INDEX[mySprite.selWeapon] ?? 'AK74'),
        scores: {
          alpha: teamScore[0],
          bravo: teamScore[1],
          playerKills: board.kills.get(myNum) ?? 0,
          leading:
            (myTeam === 1 ? teamScore[0] > teamScore[1] : teamScore[1] > teamScore[0]),
          gap: Math.abs(teamScore[0] - teamScore[1]),
        },
        killFeed: board.feed,
        fps: dt > 0 ? 1 / dt : 0,
      };
      hud.update(hudState);

      if (app !== undefined) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}
