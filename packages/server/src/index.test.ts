// @soldat/server entry-point tests (src/index.ts).
//
// index.ts is all side effects — it builds the HTTP listener, wires upgrades
// into the Lobby, and spawns the per-match interval — so importing it
// in-process would leak a live server into the vitest worker. Instead, the
// suite runs it the way production does (tsx child process, GAME_SERVER_PORT
// env) and talks to it over real localhost sockets, the same pattern
// ws.test.ts uses for its end-to-end case.
//
// Covered: /healthz routing (incl. query strings + method gate), the 404
// fallback, upgrade -> lobby -> match pairing (welcome handshake with slot
// numbers and the arena/seed/e1/e2 mapName recipe), the liveMatches
// start/end log accounting around disconnect, and SIGTERM shutdown.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  decodeMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  HandshakeResult,
  type Message,
} from '@soldat/protocol';

const TSX_BIN = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));

/** Grab a free localhost port from the kernel (probe-listen on 0, close). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcessByStdio<null, Readable, Readable>;
let port: number;
let stdout = '';
let exited: Promise<number | null>;

/** Poll the child's accumulated stdout until `needle` shows up. */
async function waitForLog(needle: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!stdout.includes(needle)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for log '${needle}'; got:\n${stdout}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function get(path: string, method = 'GET'): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return { status: res.status, body: await res.text() };
}

function openWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/arena/ws`);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('ws connect failed')));
  });
}

/** The exact hello the production client sends (engine choice included). */
function helloFrame(engine: string): ArrayBuffer {
  return encodeMessage({
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
      engine,
    },
  });
}

/** Wait for the next decodable message matching `pick` on this socket. */
function nextMessage(ws: WebSocket, pick: (m: Message) => boolean): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), 15000);
    const onMsg = (e: MessageEvent): void => {
      const msg = decodeMessage(e.data as ArrayBuffer);
      if (pick(msg)) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        resolve(msg);
      }
    };
    ws.addEventListener('message', onMsg);
  });
}

beforeAll(async () => {
  port = await freePort();
  child = spawn(TSX_BIN, [ENTRY], {
    env: { ...process.env, GAME_SERVER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stdout += chunk; // keep one transcript; tsx warnings land here too
  });
  exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  await waitForLog(`listening on :${port}`);
}, 30000);

afterAll(async () => {
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
});

describe('game server entry point (real child process)', () => {
  it('GET /healthz returns 200 ok', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok\n');
  });

  it('GET /healthz with a query string still hits the health route', async () => {
    const res = await get('/healthz?probe=1');
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok\n');
  });

  it('GET on any other path returns 404 not found', async () => {
    const res = await get('/');
    expect(res.status).toBe(404);
    expect(res.body).toBe('not found\n');
    expect((await get('/healthzz')).status).toBe(404);
  });

  it('non-GET methods are not health checks (404 even on /healthz)', async () => {
    const res = await get('/healthz', 'POST');
    expect(res.status).toBe(404);
    expect(res.body).toBe('not found\n');
  });

  it(
    'pairs two hello’d sockets into a match: welcomes carry slots + the ' +
      'arena/seed/e1/e2 recipe, and the match start is logged as 1 live',
    async () => {
      const a = await openWs();
      const b = await openWs();

      const welcomeA = nextMessage(a, (m) => m.kind === 'handshake');
      const welcomeB = nextMessage(b, (m) => m.kind === 'handshake');
      a.send(helloFrame('wolf'));
      b.send(helloFrame('hydra'));
      const [wa, wb] = await Promise.all([welcomeA, welcomeB]);

      for (const w of [wa, wb]) {
        expect(w.kind).toBe('handshake');
        if (w.kind !== 'handshake' || w.handshake.kind !== 'welcome') {
          throw new Error('expected a welcome');
        }
        expect(w.handshake.result).toBe(HandshakeResult.Ok);
        expect(w.handshake.protocolVersion).toBe(PROTOCOL_VERSION);
        expect(w.handshake.serverTick).toBe(0);
        // mapName recipe: arena=<A>&seed=<S>&e1=<idA>&e2=<idB>. The seeds are
        // rolled with Math.random in index.ts (production behavior), so only
        // their presence and range are assertable here.
        const params = new URLSearchParams(w.handshake.mapName);
        expect(params.get('e1')).toBe('wolf');
        expect(params.get('e2')).toBe('hydra');
        const arena = Number(params.get('arena'));
        const seed = Number(params.get('seed'));
        expect(arena).toBeGreaterThanOrEqual(1);
        expect(arena).toBeLessThanOrEqual(999);
        expect(seed).toBeGreaterThanOrEqual(1);
        expect(seed).toBeLessThanOrEqual(99999);
      }
      if (wa.kind !== 'handshake' || wa.handshake.kind !== 'welcome') throw new Error('welcome');
      if (wb.kind !== 'handshake' || wb.handshake.kind !== 'welcome') throw new Error('welcome');
      expect(wa.handshake.yourNum).toBe(1); // first hello = red slot
      expect(wb.handshake.yourNum).toBe(2); // second hello = blue slot

      await waitForLog('match start');
      expect(stdout).toMatch(/match start .*— 2 players/);
      expect(stdout).toMatch(/red=wolf blue=hydra/);

      // Disconnect one side with nobody queued: the match ends and the
      // survivor becomes a lone waiting player (clean-restart cycling, no
      // opponent yet — the Arena replaces the old "you win" forfeit).
      const rosterMsg = nextMessage(
        b,
        (m) => m.kind === 'chat' && m.text.startsWith('arena:'),
      );
      a.close();
      const roster = await rosterMsg;
      if (roster.kind !== 'chat') throw new Error('expected an arena roster chat');
      const data = JSON.parse(roster.text.slice('arena:'.length)) as {
        you: { role: string; waiting: boolean };
      };
      expect(data.you.role).toBe('player');
      expect(data.you.waiting).toBe(true);

      await waitForLog('match end');
      expect(stdout).toMatch(/match end — \d+ in queue/);
      b.close();
    },
    30000,
  );

  it('keeps serving /healthz after a match has come and gone', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok\n');
  });

  it('SIGTERM shuts the process down cleanly (exit 0, logged)', async () => {
    child.kill('SIGTERM');
    const code = await exited;
    expect(code).toBe(0);
    await waitForLog('SIGTERM — shutting down');
  }, 15000);
});
