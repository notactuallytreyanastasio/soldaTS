// Minimal RFC 6455 WebSocket SERVER — hand-rolled on node:http/node:net.
//
// WHY HAND-ROLLED (decision node 455): the workspace has ZERO runtime npm
// dependencies on the server side (the arena daemons are dependency-free .mjs
// files) and no `ws` package anywhere in the lockfile. The game server needs
// exactly one thing: binary frames in both directions over a single upgraded
// TCP socket, behind Caddy. That is ~200 lines of RFC 6455 — far cheaper than
// adopting and auditing a dependency for it. Clients are browsers and node 22's
// built-in WebSocket; we only implement the SERVER side.
//
// Scope (deliberately small):
//   * handshake: Sec-WebSocket-Accept = base64(sha1(key + GUID))
//   * frames: text(0x1)/binary(0x2) with continuation(0x0) reassembly,
//     close(0x8), ping(0x9)->pong(0xA), client-to-server masking enforced
//   * outbound: unmasked FIN frames (server frames are never masked)
//   * limits: MAX_MESSAGE bytes per reassembled message, else close 1009
//
// No permessage-deflate, no subprotocols, no extensions — the codec's frames
// are tiny (input frames ~25 B, snapshots ~120 B) and Caddy handles TLS.

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Reassembled-message cap. The protocol's biggest message is <1 KiB. */
const MAX_MESSAGE = 64 * 1024;

/**
 * Transport-agnostic socket surface the lobby/match layer consumes — fake
 * implementations drive the unit tests, WsConnection drives production.
 */
export interface GameSocket {
  /** Queue a binary message (one protocol codec frame) to the peer. */
  send(data: ArrayBuffer): void;
  /** Close the connection (best-effort close frame, then teardown). */
  close(code?: number): void;
  /** Single message handler (binary payloads only). */
  onMessage(cb: (data: ArrayBuffer) => void): void;
  /** Single close handler — fires exactly once however the socket dies. */
  onClose(cb: () => void): void;
}

/** Compute the Sec-WebSocket-Accept header value for a client key. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** Frame a payload as a single unmasked FIN frame (server -> client). */
export function encodeFrame(payload: Uint8Array, opcode = 0x2): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** One parsed frame (or null if the buffer doesn't hold a full frame yet). */
interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  /** Total bytes this frame consumed from the front of the buffer. */
  consumed: number;
}

/**
 * Parse one frame off the front of `buf`. Exported for tests. Returns null
 * when incomplete; throws on protocol violations (unmasked client frame,
 * oversized payload) — the caller closes the connection.
 */
export function parseFrame(buf: Buffer): ParsedFrame | null {
  if (buf.length < 2) return null;
  const b0 = buf[0]!;
  const b1 = buf[1]!;
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const big = buf.readBigUInt64BE(off);
    if (big > BigInt(MAX_MESSAGE)) throw new Error('frame too large');
    len = Number(big);
    off += 8;
  }
  if (len > MAX_MESSAGE) throw new Error('frame too large');
  // RFC 6455 §5.1: client->server frames MUST be masked.
  if (!masked) throw new Error('unmasked client frame');
  if (buf.length < off + 4 + len) return null;
  const mask = buf.subarray(off, off + 4);
  off += 4;
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = buf[off + i]! ^ mask[i & 3]!;
  return { fin, opcode, payload, consumed: off + len };
}

/** A live upgraded connection implementing {@link GameSocket}. */
export class WsConnection implements GameSocket {
  private readonly sock: Socket;
  private recv: Buffer = Buffer.alloc(0);
  /** Continuation reassembly state (first frame's opcode + chunks). */
  private fragOpcode = 0;
  private frags: Buffer[] = [];
  private fragBytes = 0;
  private messageCb: ((data: ArrayBuffer) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private closed = false;

  constructor(sock: Socket) {
    this.sock = sock;
    sock.on('data', (chunk: Buffer) => this.onData(chunk));
    const die = (): void => this.teardown();
    sock.on('close', die);
    sock.on('error', die);
    sock.on('end', die);
  }

  onMessage(cb: (data: ArrayBuffer) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  send(data: ArrayBuffer): void {
    if (this.closed) return;
    this.sock.write(encodeFrame(new Uint8Array(data), 0x2));
  }

  close(code = 1000): void {
    if (this.closed) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    try {
      this.sock.write(encodeFrame(body, 0x8));
    } catch {
      /* peer already gone */
    }
    // Give the close frame one tick to flush, then drop the TCP socket.
    this.sock.end();
    this.teardown();
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sock.destroy();
    } catch {
      /* already destroyed */
    }
    this.closeCb?.();
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.recv = this.recv.length === 0 ? chunk : Buffer.concat([this.recv, chunk]);
    try {
      for (;;) {
        const frame = parseFrame(this.recv);
        if (frame === null) return;
        this.recv = this.recv.subarray(frame.consumed);
        this.handleFrame(frame);
        if (this.closed) return;
      }
    } catch {
      // Protocol violation (unmasked / oversized frame): kill the connection.
      this.close(1002);
    }
  }

  private handleFrame(frame: ParsedFrame): void {
    switch (frame.opcode) {
      case 0x0: // continuation
        if (this.frags.length === 0) return; // stray continuation: ignore
        this.fragBytes += frame.payload.length;
        if (this.fragBytes > MAX_MESSAGE) {
          this.close(1009);
          return;
        }
        this.frags.push(frame.payload);
        if (frame.fin) this.deliver(this.fragOpcode, Buffer.concat(this.frags));
        break;
      case 0x1: // text — the protocol is binary-only, but accept + deliver
      case 0x2: // binary
        if (frame.fin) {
          this.deliver(frame.opcode, frame.payload);
        } else {
          this.fragOpcode = frame.opcode;
          this.frags = [frame.payload];
          this.fragBytes = frame.payload.length;
        }
        break;
      case 0x8: // close: echo + teardown
        this.close(1000);
        break;
      case 0x9: // ping -> pong
        this.sock.write(encodeFrame(frame.payload, 0xa));
        break;
      case 0xa: // pong: ignore
        break;
      default:
        this.close(1002);
    }
  }

  private deliver(_opcode: number, payload: Buffer): void {
    this.frags = [];
    this.fragBytes = 0;
    // Copy into a standalone ArrayBuffer (payload may view a shared buffer).
    const ab = new ArrayBuffer(payload.length);
    new Uint8Array(ab).set(payload);
    this.messageCb?.(ab);
  }
}

/**
 * Handle a node:http 'upgrade' event: validate the WebSocket handshake and
 * return a live {@link WsConnection} (or null after rejecting the socket).
 */
export function upgradeToWs(req: IncomingMessage, socket: Socket): WsConnection | null {
  const key = req.headers['sec-websocket-key'];
  const upgrade = (req.headers.upgrade ?? '').toLowerCase();
  if (upgrade !== 'websocket' || typeof key !== 'string' || key.length === 0) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
      '\r\n',
  );
  socket.setNoDelay(true);
  return new WsConnection(socket);
}
