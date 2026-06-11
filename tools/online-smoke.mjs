#!/usr/bin/env node
// ONLINE 1v1 smoke test (goal node 450) — drives TWO protocol-speaking
// clients into the game server and proves the whole loop end to end:
//
//   1. both clients pair into one match (welcome, opposite slots 1/2)
//   2. inputs from client A move A's sprite in the snapshots B receives
//   3. both crude aimbots converge + fire until a kill registers
//
// Works against local AND live deployments:
//   node tools/online-smoke.mjs                      # ws://localhost:8902
//   node tools/online-smoke.mjs wss://bobbby.online/arena/ws
//
// Re-execs under the arena package's tsx (the workspace's extensionless TS
// import chain), same pattern as tools/evaluate.mjs. Requires node >= 22
// (global WebSocket).

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const TSX = join(ROOT, 'packages/arena/node_modules/.bin/tsx');

if (process.env.SMOKE_TSX !== '1') {
  const r = spawnSync(TSX, [SELF, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, SMOKE_TSX: '1' },
  });
  process.exit(r.status ?? 1);
}

const { encodeMessage, decodeMessage, PROTOCOL_VERSION, HandshakeResult, Posture } =
  await import(join(ROOT, 'packages/protocol/src/index.ts'));

const URL_ARG = process.argv[2] ?? 'ws://localhost:8902';
const KILL_TIMEOUT_MS = Number(process.argv[3] ?? 90) * 1000;

const log = (...a) => console.log(new Date().toISOString(), '[smoke]', ...a);
const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};

function noButtons() {
  return {
    left: false, right: false, up: false, down: false, fire: false,
    jetpack: false, throwNade: false, changeWeapon: false, throwWeapon: false,
    reload: false, flagThrow: false,
  };
}

function hello() {
  return {
    kind: 'handshake',
    handshake: {
      kind: 'hello', protocolVersion: PROTOCOL_VERSION, gameVersion: '1',
      haveAntiCheat: false, hardwareId: '', password: '', name: 'smoke',
      team: 0, look: 0, modChecksum: '',
    },
  };
}

class SmokeClient {
  constructor(label) {
    this.label = label;
    this.welcome = null;
    this.snapshots = new Map(); // sprite num -> latest full snapshot
    this.track = new Map(); // sprite num -> [pos.x samples]
    this.kills = [];
    this.heartbeats = 0;
    this.lastHeartbeat = null;
    this.tick = 0;
    this.ws = new WebSocket(URL_ARG);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('open', () => this.ws.send(encodeMessage(hello())));
    this.ws.addEventListener('message', (e) => this.onMessage(e.data));
    this.ws.addEventListener('error', () => fail(`${label}: websocket error (server down?)`));
  }

  onMessage(data) {
    let msg;
    try {
      msg = decodeMessage(data);
    } catch (err) {
      fail(`${this.label}: undecodable frame: ${err.message}`);
      return;
    }
    if (msg.kind === 'handshake' && msg.handshake.kind === 'welcome') {
      if (msg.handshake.result !== HandshakeResult.Ok) {
        fail(`${this.label}: rejected (${msg.handshake.reason})`);
      }
      this.welcome = msg.handshake;
      log(`${this.label}: welcomed as sprite ${msg.handshake.yourNum} (${msg.handshake.mapName})`);
    } else if (msg.kind === 'spriteSnapshot' && msg.snapshot.kind === 'full') {
      this.snapshots.set(msg.snapshot.num, msg.snapshot);
      const t = this.track.get(msg.snapshot.num) ?? [];
      t.push(msg.snapshot.pos.x);
      this.track.set(msg.snapshot.num, t);
    } else if (msg.kind === 'chat' && msg.text.startsWith('kill:')) {
      this.kills.push(msg.text);
      log(`${this.label}: saw ${msg.text}`);
    } else if (msg.kind === 'heartbeat') {
      this.heartbeats += 1;
      this.lastHeartbeat = msg;
    }
  }

  get myNum() {
    return this.welcome?.yourNum ?? 0;
  }

  sendInput(buttons, aim) {
    this.tick += 1;
    this.ws.send(
      encodeMessage({
        kind: 'inputFrame', clientTick: this.tick,
        buttons, aim, posture: Posture.Standing,
      }),
    );
  }

  /** Crude homing aimbot: steer + aim + fire at the opponent's last snapshot. */
  fightTick() {
    const me = this.snapshots.get(this.myNum);
    const opp = this.snapshots.get(this.myNum === 1 ? 2 : 1);
    const b = noButtons();
    let aim = { x: this.myNum === 1 ? 100 : -100, y: 0 };
    if (me !== null && me !== undefined && opp !== undefined) {
      const dx = opp.pos.x - me.pos.x;
      const dy = opp.pos.y - me.pos.y;
      aim = { x: Math.max(-2000, Math.min(2000, Math.round(dx))), y: Math.max(-2000, Math.min(2000, Math.round(dy))) };
      if (Math.abs(dx) > 80) {
        b.left = dx < 0;
        b.right = dx > 0;
      }
      b.jetpack = dy < -40; // opponent above: burn
      b.fire = true;
    }
    this.sendInput(b, aim);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, what, timeoutMs = 15000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) fail(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

log(`dialing ${URL_ARG} with two clients…`);
const A = new SmokeClient('A');
const B = new SmokeClient('B');

// 1. PAIRING — both welcomed, opposite slots, identical match recipe.
await waitFor(() => A.welcome !== null && B.welcome !== null, 'both welcomes');
if (A.myNum === B.myNum) fail(`both clients got slot ${A.myNum}`);
if (![1, 2].includes(A.myNum) || ![1, 2].includes(B.myNum)) fail('bad slot numbers');
if (A.welcome.mapName !== B.welcome.mapName) fail('clients joined different matches');
log(`PAIRED OK: A=sprite ${A.myNum}, B=sprite ${B.myNum}, recipe ${A.welcome.mapName}`);

// 2. CROSS-VISIBILITY — A runs right, B idles; B must see sprite A move +x.
const aNum = A.myNum;
const runRight = setInterval(() => {
  A.sendInput({ ...noButtons(), right: true }, { x: 100, y: 0 });
  B.sendInput(noButtons(), { x: -100, y: 0 });
}, 16);
await waitFor(() => (B.track.get(aNum)?.length ?? 0) >= 30, "B's snapshots of A");
await sleep(1500);
clearInterval(runRight);
const xs = B.track.get(aNum);
const dxMoved = xs[xs.length - 1] - xs[0];
if (!(dxMoved > 10)) fail(`A's sprite did not move right in B's view (dx=${dxMoved.toFixed(1)})`);
log(`CROSS-VISIBILITY OK: A moved ${dxMoved.toFixed(1)}px (+x) in B's snapshots over ${xs.length} frames`);
if (A.heartbeats === 0 || B.heartbeats === 0) fail('no heartbeats seen');
const teams = (A.lastHeartbeat?.players ?? []).map((p) => `${p.num}:t${p.team}`).join(' ');
log(`HEARTBEAT OK: teams ${teams}`);

// 3. THE KILL — both aimbots converge and fire until somebody dies.
log('fighting until a kill registers…');
const fight = setInterval(() => {
  A.fightTick();
  B.fightTick();
}, 16);
await waitFor(
  () => A.kills.length > 0 && B.kills.length > 0,
  'a kill chat on both clients',
  KILL_TIMEOUT_MS,
);
clearInterval(fight);
log(`KILL OK: ${A.kills[0]}`);
const hb = A.lastHeartbeat;
log(`final heartbeat: teamScore=[${hb.teamScore.join(',')}]`);

A.ws.close();
B.ws.close();
log('SMOKE PASSED: pairing + cross-visibility + kill all verified');
process.exit(0);
