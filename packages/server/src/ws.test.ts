// RFC 6455 mini-implementation tests: pure frame math plus one REAL
// end-to-end socket (node:http upgrade + node 22's built-in WebSocket client
// — the same client class the browser exposes).
import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { acceptKey, encodeFrame, parseFrame, upgradeToWs, type WsConnection } from './ws';

describe('acceptKey', () => {
  it('matches the RFC 6455 §1.3 worked example', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

/** Mask a server-style frame so parseFrame accepts it as a client frame. */
function maskFrame(payload: Uint8Array, opcode = 0x2): Buffer {
  const unmasked = encodeFrame(payload, opcode);
  // Rebuild with the mask bit + a fixed mask key.
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const headerLen = unmasked.length - payload.length;
  const head = Buffer.from(unmasked.subarray(0, headerLen));
  head[1] = head[1]! | 0x80;
  const body = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) body[i] = payload[i]! ^ mask[i & 3]!;
  return Buffer.concat([head, mask, body]);
}

describe('frame codec', () => {
  it('round-trips short, 126-boundary, and 64KiB-1 payloads', () => {
    for (const n of [0, 1, 125, 126, 127, 65535]) {
      const payload = new Uint8Array(n).map((_, i) => i & 0xff);
      const framed = maskFrame(payload);
      const parsed = parseFrame(framed);
      expect(parsed).not.toBeNull();
      expect(parsed!.fin).toBe(true);
      expect(parsed!.opcode).toBe(0x2);
      expect(parsed!.consumed).toBe(framed.length);
      expect(Buffer.from(parsed!.payload)).toEqual(Buffer.from(payload));
    }
  });

  it('returns null on a partial frame and rejects unmasked client frames', () => {
    const framed = maskFrame(new Uint8Array([1, 2, 3]));
    expect(parseFrame(framed.subarray(0, framed.length - 1))).toBeNull();
    expect(() => parseFrame(encodeFrame(new Uint8Array([1, 2, 3])))).toThrow(/unmasked/);
  });
});

describe('end-to-end WebSocket (real sockets, builtin client)', () => {
  const server = http.createServer();
  const conns: WsConnection[] = [];
  server.on('upgrade', (req, socket: Socket) => {
    const conn = upgradeToWs(req, socket);
    if (conn === null) return;
    conns.push(conn);
    // Echo server: every binary message bounces straight back.
    conn.onMessage((data) => conn.send(data));
  });

  afterAll(() => {
    for (const c of conns) c.close();
    server.close();
  });

  it('handshakes, echoes binary frames, and closes cleanly', async () => {
    await new Promise<void>((res) => server.listen(0, res));
    const port = (server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.binaryType = 'arraybuffer';

    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res());
      ws.addEventListener('error', () => rej(new Error('connect failed')));
    });

    const sent = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const echoed = await new Promise<Uint8Array>((res) => {
      ws.addEventListener('message', (e) => res(new Uint8Array(e.data as ArrayBuffer)));
      ws.send(sent);
    });
    expect(echoed).toEqual(sent);

    const closed = new Promise<void>((res) => ws.addEventListener('close', () => res()));
    ws.close();
    await closed;
  });
});
