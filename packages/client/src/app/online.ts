// ONLINE TEAM-vs-TEAM (goal node 450) — the `?online` boot mode: pick the
// bot engine for YOUR side, connect to the game server, get paired against
// another human, fight 3v3 red vs blue (each side = 1 human + 2 bots running
// that side's chosen brain).
//
// THE MODEL (decision node 455, extended by node 465):
//   * The SERVER is authoritative: it runs the same headless Game
//     (humanCount: 2, botCount: 4, combat on) and streams FULL sprite
//     snapshots for ALL SIX sprites at 20 Hz.
//   * YOUR sprite is client-side predicted with @soldat/netcode's
//     PredictionBuffer over a bare sim World: every sim tick records your
//     InputFrame (stepping the local world once for instant response) and
//     sends it to the server; each own-sprite snapshot arrives stamped with
//     the clientTick the server last applied, so the buffer snaps to the
//     authoritative state and replays only the unacknowledged inputs.
//   * EVERY OTHER sprite (the opposing human AND all four bots) is
//     dead-reckoned: every render frame it is pinned to (latest snapshot
//     position + velocity × ticks-since), so the local physics steps in
//     between never accumulate drift.
//   * BULLETS are cosmetic client-side (spawned from each sprite's live fire
//     button with hitMultiply 0 — they render and collide with the map but
//     deal no local damage); hits, health, kills, and respawns are all
//     server truth carried by snapshots, heartbeats, and kill chats.
//   * ENGINE CHOICES ride the wire twice: the hello's v2 `engine` field
//     carries yours up, and the welcome's mapName recipe
//     (`arena=A&seed=S&e1=..&e2=..`) carries both back down, so the banner
//     and kill feed can say 'YOU + WOLF vs STRANGER + HYDRA'.
//
// GAPS that REMAIN (shipped loudly, not silently): ammo/reload state rides
// only the snapshot's ammoCount and jet fuel is mirrored locally (not on the
// wire). The chance wildcard DOES arm online now — bot carriers exist.

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
import { LEARNED_MODELS } from '../ui/menuScreen';
import { engineIds, createEngine } from '../ai';
import { shouldShowControls, showControlsScreen } from '../ui/controlsScreen';
import { START_HEALTH } from '../ui/helpers';
import { applyKill, type KillBoard } from './director';
import { generateArena } from './arena';
import { DEFAULT_TUNING } from './game';
import { VoiceChat } from './voice';

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

/** All sprite slots in an online match: humans 1..2, bots 3..6 (server contract). */
export const ONLINE_SPRITES = [1, 2, 3, 4, 5, 6] as const;

/**
 * Parse the welcome's mapName recipe (`arena=<A>&seed=<S>&e1=<id>&e2=<id>`).
 * e1/e2 are the sanitised per-team engine ids (red/blue); pre-team servers
 * (no e1/e2) read as 'classic' so nothing renders blank.
 */
export function parseMatchRecipe(mapName: string): {
  arenaSeed: number;
  seed: number;
  e1: string;
  e2: string;
} {
  const p = new URLSearchParams(mapName);
  const arenaSeed = parseInt(p.get('arena') ?? '', 10);
  const seed = parseInt(p.get('seed') ?? '', 10);
  const e1 = p.get('e1') ?? '';
  const e2 = p.get('e2') ?? '';
  return {
    arenaSeed: Number.isFinite(arenaSeed) ? arenaSeed : 1,
    seed: Number.isFinite(seed) ? seed : 1,
    e1: e1 !== '' ? e1 : 'classic',
    e2: e2 !== '' ? e2 : 'classic',
  };
}

/**
 * Team of sprite `num` under the server's slot contract: humans 1/2 are red/
 * blue; bots 3..6 alternate red/blue (Game assigns bot slot b team (b%2)+1,
 * and bots start at slot 3).
 */
export function spriteTeam(num: number): number {
  return num <= 2 ? num : ((num - 3) % 2) + 1;
}

/**
 * Kill-feed/banner label for sprite `num`: 'You', 'Stranger', or the engine
 * name (uppercased) driving that bot's team.
 */
export function spriteLabel(num: number, myNum: number, e1: string, e2: string): string {
  if (num === myNum) return 'You';
  if (num <= 2) return 'Stranger';
  return (spriteTeam(num) === 1 ? e1 : e2).toUpperCase();
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

/**
 * The brain picker (goal node 450, team upgrade): a small overlay listing
 * every registered engine — LEARNED badges included, menuScreen style — that
 * resolves to the chosen id. 'RANDOM' (the default, Enter/Escape) resolves to
 * a concrete random id client-side so the server only ever sees real choices.
 */
function pickEngineOverlay(): Promise<string> {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:1001',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'background:rgba(10,12,16,0.96)',
      'color:#e8e4d8',
      'font-family:ui-monospace,Menlo,monospace',
      'overflow-y:auto',
      'padding:32px 16px',
      'box-sizing:border-box',
      'user-select:none',
    ].join(';');
    const title = document.createElement('div');
    title.textContent = 'PICK YOUR SQUAD';
    title.style.cssText =
      'font-size:22px;font-weight:bold;letter-spacing:0.4em;color:#fff;margin-bottom:4px';
    const sub = document.createElement('div');
    sub.textContent = 'two bots fight at your side — choose the brain they run';
    sub.style.cssText = 'font-size:12px;letter-spacing:0.2em;color:#9aa3b2;margin-bottom:18px';
    el.append(title, sub);

    const column = document.createElement('div');
    column.style.cssText = 'display:flex;flex-direction:column;gap:6px;width:min(680px,94vw)';
    el.appendChild(column);

    const done = (id: string): void => {
      window.removeEventListener('keydown', onKey);
      el.remove();
      resolve(id);
    };
    const randomPick = (): string => {
      const ids = engineIds();
      return ids[Math.floor(Math.random() * ids.length)] ?? 'classic';
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' || e.key === 'Escape') done(randomPick());
    };
    window.addEventListener('keydown', onKey);

    const rowStyle = [
      'display:flex',
      'align-items:baseline',
      'gap:10px',
      'width:100%',
      'text-align:left',
      'background:#141821',
      'color:#e8e4d8',
      'border:1px solid #2a2f3a',
      'border-radius:6px',
      'padding:7px 14px',
      'cursor:pointer',
      'font-family:inherit',
      'font-size:13px',
    ].join(';');

    // RANDOM — the default — leads the list.
    const rnd = document.createElement('button');
    rnd.style.cssText = rowStyle + ';border-color:#3a4154;justify-content:center';
    rnd.textContent = '🎲 RANDOM SQUAD (default — Enter)';
    rnd.addEventListener('click', () => done(randomPick()));
    column.appendChild(rnd);

    for (const id of engineIds()) {
      const engine = createEngine(id);
      const row = document.createElement('button');
      row.style.cssText = rowStyle;
      row.addEventListener('mouseenter', () => (row.style.borderColor = '#ffd75e'));
      row.addEventListener('mouseleave', () => (row.style.borderColor = '#2a2f3a'));
      const name = document.createElement('span');
      const alias = LEARNED_MODELS[id];
      name.textContent =
        alias !== undefined && alias !== id.toUpperCase()
          ? `${id.toUpperCase()} “${alias}”`
          : id.toUpperCase();
      name.style.cssText = 'font-weight:bold;font-size:14px;color:#fff;white-space:nowrap';
      row.appendChild(name);
      if (alias !== undefined) {
        const badge = document.createElement('span');
        badge.textContent = 'LEARNED';
        badge.style.cssText =
          'font-size:9px;font-weight:bold;letter-spacing:0.15em;color:#0a0c10;background:#9be07f;border-radius:3px;padding:1px 6px;white-space:nowrap';
        row.appendChild(badge);
      }
      const blurb = document.createElement('span');
      blurb.textContent = engine.strategy;
      blurb.style.cssText =
        'color:#9aa3b2;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1';
      row.appendChild(blurb);
      row.addEventListener('click', () => done(id));
      column.appendChild(row);
    }
    document.body.appendChild(el);
  });
}

function showTeamBanner(myTeam: number, myEngine: string, oppEngine: string): void {
  const el = document.createElement('div');
  const opp = myTeam === 1 ? 2 : 1;
  el.innerHTML =
    `<span style="color:${TEAM_CSS[myTeam]};font-weight:bold">YOU + ${myEngine.toUpperCase()}</span>` +
    `<span style="color:#9aa3b2"> vs </span>` +
    `<span style="color:${TEAM_CSS[opp]};font-weight:bold">STRANGER + ${oppEngine.toUpperCase()}</span>`;
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
  // Brain picker FIRST — the hello must carry the choice.
  const myEnginePick = await pickEngineOverlay();

  const overlay = makeOverlay();
  overlay.set('CONNECTING…');

  const ws = new WebSocket(deriveWsUrl(window.location));
  ws.binaryType = 'arraybuffer';

  let booted = false;
  let matchOver = false;
  let voice: VoiceChat | null = null;

  ws.addEventListener('open', () => {
    overlay.set(
      `WAITING FOR AN OPPONENT…<br>` +
        `<span style="font-size:13px;color:#9aa3b2">your squad: ${myEnginePick.toUpperCase()} — ` +
        `first to arrive waits; send a friend to /arena/play/?online</span>`,
    );
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
          engine: myEnginePick,
        },
      }),
    );
  });
  ws.addEventListener('close', () => {
    voice?.dispose();
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
    const { arenaSeed, seed, e1, e2 } = parseMatchRecipe(mapName);
    const myTeam = myNum; // slot 1 = red, slot 2 = blue (server contract)
    const myEngine = myTeam === 1 ? e1 : e2;
    const oppEngine = myTeam === 1 ? e2 : e1;

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

    // Local predicted world: all SIX sprites spawned exactly where the server
    // spawned them (same generateArena recipe, same spawn cycling — humans
    // h=0,1 take spawnFor(h), bots take spawnFor(index); see Game's ctor).
    const world = createWorld();
    initSimWorld(world, { seed });
    world.map = buildPolyMap(map);
    for (const num of ONLINE_SPRITES) {
      const spawnIdx = (num <= 2 ? num - 1 : num) % spawns.length;
      spawnOnlineSprite(world, num, spawns[spawnIdx] ?? { x: 0, y: 0 }, spriteTeam(num));
    }
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
    showTeamBanner(myTeam, myEngine, oppEngine);
    overlay.hide();

    // Voice chat (goal node 522): open mic + mute pill, signaling relayed by
    // the match server. Slot 2 (blue) is the perfect-negotiation polite peer.
    voice = new VoiceChat({
      polite: myNum === 2,
      sendSignal: (data): void => {
        if (!matchOver && ws.readyState === WebSocket.OPEN) {
          ws.send(encodeMessage({ kind: 'voice', data }));
        }
      },
    });
    void voice.start();

    // --- Net state ---------------------------------------------------------
    const nameOf = (i: number): string => spriteLabel(i, myNum, e1, e2);
    const board: KillBoard = { kills: new Map(), feed: [] };
    let teamScore: [number, number] = [0, 0];
    let ownAmmo = 30;
    /** Latest snapshot per REMOTE sprite (opposing human + all four bots). */
    const remoteSnaps = new Map<number, { snap: SpriteSnapshotFull; atTick: number }>();
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
          remoteSnaps.set(snap.num, { snap, atTick: clientTick });
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
      if (msg.kind === 'voice') {
        void voice?.onSignal(msg.data);
        return;
      }
      if (msg.kind === 'chat') {
        const ev = parseServerChat(msg.text);
        if (ev.type === 'kill') {
          applyKill(board, ev.killer, ev.victim, nameOf, myNum, ev.weapon);
        } else if (ev.type === 'end') {
          matchOver = true;
          voice?.dispose();
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
    const nextCosmeticFire: number[] = [0, 0, 0, 0, 0, 0, 0];
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

    /** Pin every REMOTE sprite to (latest snapshot + velocity × elapsed ticks). */
    const deadReckonRemotes = (): void => {
      const parts = world.spriteParts;
      if (parts === null) return;
      for (const [num, { snap, atTick }] of remoteSnaps) {
        const dt = Math.min(clientTick - atTick, EXTRAPOLATE_MAX_TICKS);
        const px = snap.pos.x + snap.velocity.x * dt;
        const py = snap.pos.y + snap.velocity.y * dt;
        parts.posX[num] = px;
        parts.posY[num] = py;
        parts.oldX[num] = px - snap.velocity.x;
        parts.oldY[num] = py - snap.velocity.y;
        parts.velocityX[num] = snap.velocity.x;
        parts.velocityY[num] = snap.velocity.y;
      }
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
          // Cosmetic muzzle output for every remote sprite BEFORE the
          // predicted step moves the world (they fire from their last-known
          // state — fire buttons arrive inside their snapshots).
          const myFrame = controlToInputFrame(clientTick, control);
          for (const num of ONLINE_SPRITES) {
            if (num !== myNum) cosmeticFire(num);
          }
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

      deadReckonRemotes();
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
          `${TEAM_NAMES[myTeam]} YOU + ${myEngine.toUpperCase()} · ` +
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
