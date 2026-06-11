#!/usr/bin/env node
// ONLINE TEAM-vs-TEAM smoke test (goal node 450) — drives TWO
// protocol-speaking clients (with DIFFERENT engine choices: wolf vs hydra)
// into the game server and proves the whole 3v3 loop end to end:
//
//   1. both clients pair into one match (welcome, opposite slots 1/2) and the
//      match-start recipe echoes BOTH engine choices (e1/e2 by slot)
//   2. snapshots replicate ALL SIX sprites (2 humans + 4 bots) to both sides
//   3. inputs from client A move A's sprite in the snapshots B receives
//   4. a BOT kill (sprite 3..6 involved) lands in both kill feeds
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

function hello(engine) {
  return {
    kind: 'handshake',
    handshake: {
      kind: 'hello', protocolVersion: PROTOCOL_VERSION, gameVersion: '1',
      haveAntiCheat: false, hardwareId: '', password: '', name: 'smoke',
      team: 0, look: 0, modChecksum: '', engine,
    },
  };
}

class SmokeClient {
  constructor(label, engine) {
    this.label = label;
    this.engine = engine;
    this.welcome = null;
    this.snapshots = new Map(); // sprite num -> latest full snapshot
    this.track = new Map(); // sprite num -> [pos.x samples]
    this.kills = [];
    this.heartbeats = 0;
    this.lastHeartbeat = null;
    this.tick = 0;
    this.ws = new WebSocket(URL_ARG);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('open', () => this.ws.send(encodeMessage(hello(this.engine))));
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

log(`dialing ${URL_ARG} with two clients (A=wolf, B=hydra)…`);
const A = new SmokeClient('A', 'wolf');
const B = new SmokeClient('B', 'hydra');

// 1. PAIRING — both welcomed, opposite slots, identical match recipe, and the
//    recipe ECHOES BOTH ENGINE CHOICES keyed by slot (e1 = slot 1's pick).
await waitFor(() => A.welcome !== null && B.welcome !== null, 'both welcomes');
if (A.myNum === B.myNum) fail(`both clients got slot ${A.myNum}`);
if (![1, 2].includes(A.myNum) || ![1, 2].includes(B.myNum)) fail('bad slot numbers');
if (A.welcome.mapName !== B.welcome.mapName) fail('clients joined different matches');
log(`PAIRED OK: A=sprite ${A.myNum}, B=sprite ${B.myNum}, recipe ${A.welcome.mapName}`);

const recipe = new URLSearchParams(A.welcome.mapName);
const slotEngine = { 1: recipe.get('e1'), 2: recipe.get('e2') };
if (slotEngine[A.myNum] !== A.engine) {
  fail(`recipe says slot ${A.myNum} runs ${slotEngine[A.myNum]}, A chose ${A.engine}`);
}
if (slotEngine[B.myNum] !== B.engine) {
  fail(`recipe says slot ${B.myNum} runs ${slotEngine[B.myNum]}, B chose ${B.engine}`);
}
log(`ENGINE ECHO OK: e1=${recipe.get('e1')} e2=${recipe.get('e2')} (both choices echoed by slot)`);

// 2. 3v3 REPLICATION — both clients must see snapshots of ALL SIX sprites.
const idle = setInterval(() => {
  A.sendInput(noButtons(), { x: 100, y: 0 });
  B.sendInput(noButtons(), { x: -100, y: 0 });
}, 16);
await waitFor(
  () => [1, 2, 3, 4, 5, 6].every((n) => A.snapshots.has(n) && B.snapshots.has(n)),
  'snapshots of all 6 sprites on both clients',
);
clearInterval(idle);
log(`3v3 REPLICATION OK: A sees sprites [${[...A.snapshots.keys()].sort().join(',')}], B sees [${[...B.snapshots.keys()].sort().join(',')}]`);

// 3. CROSS-VISIBILITY — A runs right, B idles; B must see sprite A move +x.
const aNum = A.myNum;
const trackStart = (B.track.get(aNum) ?? []).length;
const runRight = setInterval(() => {
  A.sendInput({ ...noButtons(), right: true }, { x: 100, y: 0 });
  B.sendInput(noButtons(), { x: -100, y: 0 });
}, 16);
await waitFor(() => (B.track.get(aNum)?.length ?? 0) >= trackStart + 30, "B's snapshots of A");
await sleep(1500);
clearInterval(runRight);
const xs = B.track.get(aNum).slice(trackStart);
const dxMoved = xs[xs.length - 1] - xs[0];
if (!(dxMoved > 10)) fail(`A's sprite did not move right in B's view (dx=${dxMoved.toFixed(1)})`);
log(`CROSS-VISIBILITY OK: A moved ${dxMoved.toFixed(1)}px (+x) in B's snapshots over ${xs.length} frames`);
if (A.heartbeats === 0 || B.heartbeats === 0) fail('no heartbeats seen');
const teams = (A.lastHeartbeat?.players ?? []).map((p) => `${p.num}:t${p.team}`).join(' ');
log(`HEARTBEAT OK: teams ${teams}`);

// 4. THE BOT KILL — the four bots brawl on their own; keep the humans pinging
//    inputs and wait until a kill INVOLVING A BOT (sprite 3..6) reaches both
//    feeds. (Human kills may land too — also logged.)
log('waiting for a bot kill to land in both feeds…');
const isBotKill = (text) => {
  const [, killer, victim] = text.split(':');
  return Number(killer) >= 3 || Number(victim) >= 3;
};
const fight = setInterval(() => {
  A.fightTick();
  B.fightTick();
}, 16);
await waitFor(
  () => A.kills.some(isBotKill) && B.kills.some(isBotKill),
  'a bot kill chat on both clients',
  KILL_TIMEOUT_MS,
);
clearInterval(fight);
log(`BOT KILL OK: ${A.kills.find(isBotKill)} (A saw ${A.kills.length} kills, B saw ${B.kills.length})`);
const hb = A.lastHeartbeat;
log(`final heartbeat: teamScore=[${hb.teamScore.join(',')}]`);

A.ws.close();
B.ws.close();
log('SMOKE PASSED: pairing + engine echo + 3v3 replication + cross-visibility + bot kill all verified');
process.exit(0);
