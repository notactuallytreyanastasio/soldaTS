// @soldat/protocol — hand-written binary wire codec.
//
// Compact, versioned (de)serializer for the {@link Message} discriminated union
// in ./messages.ts. No external codegen; everything is a DataView walk in
// little-endian, matching the schema.proto field semantics 1:1.
//
// ---------------------------------------------------------------------------
// Frame layout
// ---------------------------------------------------------------------------
//
//   [uint16 protocolVersion][uint8 kindTag][payload...]
//
// `protocolVersion` is {@link PROTOCOL_VERSION}; decode rejects a mismatch with
// a {@link DecodeError}. `kindTag` selects the payload codec (see KindTag).
// Everything is little-endian. Multi-byte primitives are written via DataView;
// variable-length integers use LEB128 (unsigned) / zigzag-LEB128 (signed).
//
// ---------------------------------------------------------------------------
// Primitive encodings
// ---------------------------------------------------------------------------
//
//   uvarint   LEB128, 7 bits/byte, little-endian groups. Used for counts,
//             unsigned scalars (Byte/Word/LongWord), string byte-lengths.
//   svarint   zigzag(n) then uvarint. Used for signed ticks (LongInt) and
//             MouseAim components (SmallInt). proto3 sint32 == zigzag.
//   f64       8-byte IEEE754 (DataView.setFloat64). Vec2 components — mirrors
//             proto `double Vec2`.
//   f32       4-byte IEEE754. health / vest — mirrors proto `float`.
//   string    uvarint(byteLength) + UTF-8 bytes.
//   Vec2      f64 x, f64 y.
//   Buttons   1 byte bitfield, B1..B11 in bits 0..10 (matches Keys16 order).
//   MouseAim  svarint x, svarint y.
//
// Optional fields (delta snapshots, handshake welcome, thing timeout, input
// hints) are gated by a leading presence bitmask (uvarint) so absent fields
// cost nothing past the mask. The bit assignment per kind is documented inline.
//
// NOTE on fidelity: messages.ts carries `number` for everything. We pick the
// narrowest faithful encoding per the PORT comments / schema.proto type:
//   * Vec2 -> f64 (proto double).  health/vest -> f32 (proto float).
//   * ticks (client/server) -> svarint (proto int32 / Pascal LongInt, signed).
//   * MouseAim -> svarint (proto sint32 / Pascal SmallInt, signed).
//   * Byte/Word/LongWord counts -> uvarint (proto uint32).
// Floats other than Vec2/health/vest are not present in the schema, so no other
// precision compromise is made.

import type {
  Buttons,
  Chat,
  Handshake,
  HandshakeHello,
  HandshakeWelcome,
  Heartbeat,
  InputFrame,
  Message,
  MouseAim,
  ScoreboardEntry,
  SkeletonSnapshot,
  SpriteSnapshot,
  SpriteSnapshotDelta,
  SpriteSnapshotFull,
  ThingSnapshot,
  Vec2,
  Voice,
  WeaponState,
} from "./messages.js";
import {
  ChatChannel,
  HandshakeResult,
  Posture,
  PROTOCOL_VERSION,
} from "./messages.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Reason a {@link decodeMessage} call failed. */
export type DecodeErrorKind =
  | "version-mismatch"
  | "unknown-tag"
  | "truncated"
  | "invalid-enum"
  | "invalid-value";

/** Typed failure thrown by the codec. Never thrown by {@link encodeMessage}. */
export class DecodeError extends Error {
  readonly kind: DecodeErrorKind;
  constructor(kind: DecodeErrorKind, message: string) {
    super(message);
    this.name = "DecodeError";
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Kind tags — stable uint8 discriminants for the Message union.
// ---------------------------------------------------------------------------

const KindTag = {
  inputFrame: 1,
  spriteSnapshot: 2,
  skeletonSnapshot: 3,
  thingSnapshot: 4,
  heartbeat: 5,
  chat: 6,
  handshake: 7,
  voice: 8,
} as const satisfies Record<Message["kind"], number>;

// Sub-tags for the nested snapshot / handshake oneofs.
const SpriteSnapshotTag = { full: 0, delta: 1 } as const;
const HandshakeTag = { hello: 0, welcome: 1 } as const;

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

class Writer {
  private ab: ArrayBuffer;
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initial = 64) {
    this.ab = new ArrayBuffer(initial);
    this.buf = new Uint8Array(this.ab);
    this.view = new DataView(this.ab);
  }

  private ensure(extra: number): void {
    const need = this.pos + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const nextAb = new ArrayBuffer(cap);
    const next = new Uint8Array(nextAb);
    next.set(this.buf);
    this.ab = nextAb;
    this.buf = next;
    this.view = new DataView(nextAb);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos, v & 0xff);
    this.pos += 1;
  }

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, v & 0xffff, true);
    this.pos += 2;
  }

  /** Unsigned LEB128. Accepts values up to 2^53-1 (safe-integer range). */
  uvarint(value: number): void {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      // Encoder is total over valid Message values; this guards programmer error.
      throw new RangeError(`uvarint expects a non-negative integer, got ${value}`);
    }
    let v = value;
    while (v >= 0x80) {
      this.u8((v & 0x7f) | 0x80);
      // Math-based shift to stay correct past 2^31.
      v = Math.floor(v / 128);
    }
    this.u8(v & 0x7f);
  }

  /** Signed varint via zigzag (matches proto sint32). */
  svarint(value: number): void {
    if (!Number.isInteger(value)) {
      throw new RangeError(`svarint expects an integer, got ${value}`);
    }
    // zigzag: (n << 1) ^ (n >> 31) — done in float-safe arithmetic.
    const zz = value >= 0 ? value * 2 : -value * 2 - 1;
    this.uvarint(zz);
  }

  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  string(s: string): void {
    const enc = new TextEncoder().encode(s);
    this.uvarint(enc.length);
    this.bytes(enc);
  }

  finish(): ArrayBuffer {
    return this.ab.slice(0, this.pos);
  }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

class Reader {
  private view: DataView;
  private bytesView: Uint8Array;
  private pos = 0;
  private readonly len: number;

  constructor(buf: ArrayBuffer) {
    this.view = new DataView(buf);
    this.bytesView = new Uint8Array(buf);
    this.len = buf.byteLength;
  }

  private need(n: number): void {
    if (this.pos + n > this.len) {
      throw new DecodeError(
        "truncated",
        `buffer truncated: need ${n} byte(s) at offset ${this.pos}, have ${
          this.len - this.pos
        }`,
      );
    }
  }

  get done(): boolean {
    return this.pos >= this.len;
  }

  u8(): number {
    this.need(1);
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  uvarint(): number {
    let result = 0;
    let shift = 1; // multiplier (128^k), float-safe past 2^31
    for (let i = 0; i < 8; i++) {
      const byte = this.u8();
      result += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return result;
      shift *= 128;
    }
    throw new DecodeError("invalid-value", "uvarint too long (>8 bytes)");
  }

  svarint(): number {
    const zz = this.uvarint();
    // inverse zigzag
    return zz % 2 === 0 ? zz / 2 : -(zz + 1) / 2;
  }

  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  string(): string {
    const n = this.uvarint();
    this.need(n);
    const slice = this.bytesView.subarray(this.pos, this.pos + n);
    this.pos += n;
    return new TextDecoder().decode(slice);
  }

  /** Asserts the whole buffer was consumed; trailing bytes mean corruption. */
  expectEnd(): void {
    if (!this.done) {
      throw new DecodeError(
        "invalid-value",
        `trailing ${this.len - this.pos} byte(s) after payload`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Shared value (de)serializers
// ---------------------------------------------------------------------------

function writeVec2(w: Writer, v: Vec2): void {
  w.f64(v.x);
  w.f64(v.y);
}

function readVec2(r: Reader): Vec2 {
  const x = r.f64();
  const y = r.f64();
  return { x, y };
}

// Buttons bitfield. Bit i (0-based) maps to B(i+1) in Keys16 order.
const BUTTON_BITS = [
  "left",
  "right",
  "up",
  "down",
  "fire",
  "jetpack",
  "throwNade",
  "changeWeapon",
  "throwWeapon",
  "reload",
  "flagThrow",
] as const satisfies readonly (keyof Buttons)[];

function writeButtons(w: Writer, b: Buttons): void {
  let bits = 0;
  for (let i = 0; i < BUTTON_BITS.length; i++) {
    const key = BUTTON_BITS[i]!;
    if (b[key]) bits |= 1 << i;
  }
  w.u16(bits);
}

function readButtons(r: Reader): Buttons {
  const bits = r.u16();
  // Construct explicitly so the object shape is exact (no spread of unknowns).
  return {
    left: (bits & (1 << 0)) !== 0,
    right: (bits & (1 << 1)) !== 0,
    up: (bits & (1 << 2)) !== 0,
    down: (bits & (1 << 3)) !== 0,
    fire: (bits & (1 << 4)) !== 0,
    jetpack: (bits & (1 << 5)) !== 0,
    throwNade: (bits & (1 << 6)) !== 0,
    changeWeapon: (bits & (1 << 7)) !== 0,
    throwWeapon: (bits & (1 << 8)) !== 0,
    reload: (bits & (1 << 9)) !== 0,
    flagThrow: (bits & (1 << 10)) !== 0,
  };
}

function writeMouseAim(w: Writer, a: MouseAim): void {
  w.svarint(a.x);
  w.svarint(a.y);
}

function readMouseAim(r: Reader): MouseAim {
  const x = r.svarint();
  const y = r.svarint();
  return { x, y };
}

function writePosture(w: Writer, p: Posture): void {
  w.u8(p);
}

function readPosture(r: Reader): Posture {
  const v = r.u8();
  if (v !== Posture.Standing && v !== Posture.Prone && v !== Posture.Crouching) {
    throw new DecodeError("invalid-enum", `invalid Posture value ${v}`);
  }
  return v;
}

function readChatChannel(r: Reader): ChatChannel {
  const v = r.u8();
  if (
    v !== ChatChannel.Command &&
    v !== ChatChannel.Public &&
    v !== ChatChannel.Team &&
    v !== ChatChannel.Radio
  ) {
    throw new DecodeError("invalid-enum", `invalid ChatChannel value ${v}`);
  }
  return v;
}

const HANDSHAKE_RESULTS: readonly HandshakeResult[] = [
  HandshakeResult.Ok,
  HandshakeResult.WrongVersion,
  HandshakeResult.WrongPassword,
  HandshakeResult.BannedIp,
  HandshakeResult.ServerFull,
  HandshakeResult.InvalidHandshake,
  HandshakeResult.WrongChecksum,
  HandshakeResult.AntiCheatRequired,
  HandshakeResult.AntiCheatRejected,
  HandshakeResult.SteamOnly,
];

function readHandshakeResult(r: Reader): HandshakeResult {
  const v = r.uvarint();
  if (!HANDSHAKE_RESULTS.includes(v as HandshakeResult)) {
    throw new DecodeError("invalid-enum", `invalid HandshakeResult value ${v}`);
  }
  return v as HandshakeResult;
}

function writeWeaponState(w: Writer, ws: WeaponState): void {
  w.uvarint(ws.weaponNum);
  w.uvarint(ws.secondaryWeaponNum);
  w.uvarint(ws.ammoCount);
  w.uvarint(ws.grenadeCount);
}

function readWeaponState(r: Reader): WeaponState {
  const weaponNum = r.uvarint();
  const secondaryWeaponNum = r.uvarint();
  const ammoCount = r.uvarint();
  const grenadeCount = r.uvarint();
  return { weaponNum, secondaryWeaponNum, ammoCount, grenadeCount };
}

// Generic length-prefixed Vec2 array (skeleton / thing physics rings).
function writeVec2Array(w: Writer, arr: readonly Vec2[]): void {
  w.uvarint(arr.length);
  for (const v of arr) writeVec2(w, v);
}

function readVec2Array(r: Reader): Vec2[] {
  const n = r.uvarint();
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) out.push(readVec2(r));
  return out;
}

// ---------------------------------------------------------------------------
// Per-kind payload codecs
// ---------------------------------------------------------------------------

// --- InputFrame ---
// Layout: svarint clientTick, Buttons, MouseAim, u8 posture, u8 presence,
//         [Vec2 predictedPos]?, [Vec2 predictedVel]?
// presence bits: 0x1 predictedPos, 0x2 predictedVel.
function writeInputFrame(w: Writer, f: InputFrame): void {
  w.svarint(f.clientTick);
  writeButtons(w, f.buttons);
  writeMouseAim(w, f.aim);
  writePosture(w, f.posture);
  let mask = 0;
  if (f.predictedPos !== undefined) mask |= 0x1;
  if (f.predictedVel !== undefined) mask |= 0x2;
  w.u8(mask);
  if (f.predictedPos !== undefined) writeVec2(w, f.predictedPos);
  if (f.predictedVel !== undefined) writeVec2(w, f.predictedVel);
}

function readInputFrame(r: Reader): InputFrame {
  const clientTick = r.svarint();
  const buttons = readButtons(r);
  const aim = readMouseAim(r);
  const posture = readPosture(r);
  const mask = r.u8();
  const base: InputFrame = { clientTick, buttons, aim, posture };
  if (mask & 0x1) base.predictedPos = readVec2(r);
  if (mask & 0x2) base.predictedVel = readVec2(r);
  return base;
}

// --- SpriteSnapshot (full | delta) ---
function writeSpriteSnapshotFull(w: Writer, s: SpriteSnapshotFull): void {
  w.uvarint(s.num);
  w.svarint(s.serverTick);
  writeVec2(w, s.pos);
  writeVec2(w, s.velocity);
  writeMouseAim(w, s.aim);
  writePosture(w, s.posture);
  writeButtons(w, s.buttons);
  // Cosmetics: 1 byte bitfield (bit0 wearHelmet, bit1 cigar).
  w.u8((s.cosmetics.wearHelmet ? 0x1 : 0) | (s.cosmetics.cigar ? 0x2 : 0));
  w.f32(s.health);
  w.f32(s.vest);
  writeWeaponState(w, s.weapon);
}

function readSpriteSnapshotFull(r: Reader): SpriteSnapshotFull {
  const num = r.uvarint();
  const serverTick = r.svarint();
  const pos = readVec2(r);
  const velocity = readVec2(r);
  const aim = readMouseAim(r);
  const posture = readPosture(r);
  const buttons = readButtons(r);
  const cosBits = r.u8();
  const cosmetics = {
    wearHelmet: (cosBits & 0x1) !== 0,
    cigar: (cosBits & 0x2) !== 0,
  };
  const health = r.f32();
  const vest = r.f32();
  const weapon = readWeaponState(r);
  return {
    kind: "full",
    num,
    serverTick,
    pos,
    velocity,
    aim,
    posture,
    buttons,
    cosmetics,
    health,
    vest,
    weapon,
  };
}

// Delta presence bitmask (uvarint):
//   0x001 pos, 0x002 velocity, 0x004 aim, 0x008 posture, 0x010 buttons,
//   0x020 health, 0x040 weapon (weaponNum+secondaryWeaponNum), 0x080 wearHelmet.
function writeSpriteSnapshotDelta(w: Writer, s: SpriteSnapshotDelta): void {
  w.uvarint(s.num);
  w.svarint(s.serverTick);
  let mask = 0;
  if (s.pos !== undefined) mask |= 0x001;
  if (s.velocity !== undefined) mask |= 0x002;
  if (s.aim !== undefined) mask |= 0x004;
  if (s.posture !== undefined) mask |= 0x008;
  if (s.buttons !== undefined) mask |= 0x010;
  if (s.health !== undefined) mask |= 0x020;
  if (s.weapon !== undefined) mask |= 0x040;
  if (s.wearHelmet !== undefined) mask |= 0x080;
  w.uvarint(mask);
  if (s.pos !== undefined) writeVec2(w, s.pos);
  if (s.velocity !== undefined) writeVec2(w, s.velocity);
  if (s.aim !== undefined) writeMouseAim(w, s.aim);
  if (s.posture !== undefined) writePosture(w, s.posture);
  if (s.buttons !== undefined) writeButtons(w, s.buttons);
  if (s.health !== undefined) w.f32(s.health);
  if (s.weapon !== undefined) {
    w.uvarint(s.weapon.weaponNum);
    w.uvarint(s.weapon.secondaryWeaponNum);
  }
  if (s.wearHelmet !== undefined) w.u8(s.wearHelmet ? 1 : 0);
}

function readSpriteSnapshotDelta(r: Reader): SpriteSnapshotDelta {
  const num = r.uvarint();
  const serverTick = r.svarint();
  const mask = r.uvarint();
  const out: SpriteSnapshotDelta = { kind: "delta", num, serverTick };
  if (mask & 0x001) out.pos = readVec2(r);
  if (mask & 0x002) out.velocity = readVec2(r);
  if (mask & 0x004) out.aim = readMouseAim(r);
  if (mask & 0x008) out.posture = readPosture(r);
  if (mask & 0x010) out.buttons = readButtons(r);
  if (mask & 0x020) out.health = r.f32();
  if (mask & 0x040) {
    const weaponNum = r.uvarint();
    const secondaryWeaponNum = r.uvarint();
    out.weapon = { weaponNum, secondaryWeaponNum };
  }
  if (mask & 0x080) out.wearHelmet = r.u8() !== 0;
  return out;
}

function writeSpriteSnapshot(w: Writer, snap: SpriteSnapshot): void {
  if (snap.kind === "full") {
    w.u8(SpriteSnapshotTag.full);
    writeSpriteSnapshotFull(w, snap);
  } else {
    w.u8(SpriteSnapshotTag.delta);
    writeSpriteSnapshotDelta(w, snap);
  }
}

function readSpriteSnapshot(r: Reader): SpriteSnapshot {
  const tag = r.u8();
  if (tag === SpriteSnapshotTag.full) return readSpriteSnapshotFull(r);
  if (tag === SpriteSnapshotTag.delta) return readSpriteSnapshotDelta(r);
  throw new DecodeError("unknown-tag", `unknown SpriteSnapshot tag ${tag}`);
}

// --- SkeletonSnapshot ---
function writeSkeletonSnapshot(w: Writer, s: SkeletonSnapshot): void {
  w.uvarint(s.num);
  w.svarint(s.respawnCounter);
  w.uvarint(s.constraints);
  writeVec2Array(w, s.pos);
  writeVec2Array(w, s.oldPos);
}

function readSkeletonSnapshot(r: Reader): SkeletonSnapshot {
  const num = r.uvarint();
  const respawnCounter = r.svarint();
  const constraints = r.uvarint();
  const pos = readVec2Array(r);
  const oldPos = readVec2Array(r);
  return { num, respawnCounter, constraints, pos, oldPos };
}

// --- ThingSnapshot ---
// Layout: uvarint num/owner/style/holdingSprite, Vec2[] pos, Vec2[] oldPos,
//         u8 hasTimeout, [svarint timeout]?
function writeThingSnapshot(w: Writer, s: ThingSnapshot): void {
  w.uvarint(s.num);
  w.uvarint(s.owner);
  w.uvarint(s.style);
  w.uvarint(s.holdingSprite);
  writeVec2Array(w, s.pos);
  writeVec2Array(w, s.oldPos);
  if (s.timeout !== undefined) {
    w.u8(1);
    w.svarint(s.timeout);
  } else {
    w.u8(0);
  }
}

function readThingSnapshot(r: Reader): ThingSnapshot {
  const num = r.uvarint();
  const owner = r.uvarint();
  const style = r.uvarint();
  const holdingSprite = r.uvarint();
  const pos = readVec2Array(r);
  const oldPos = readVec2Array(r);
  const hasTimeout = r.u8();
  const out: ThingSnapshot = { num, owner, style, holdingSprite, pos, oldPos };
  if (hasTimeout) out.timeout = r.svarint();
  return out;
}

// --- Heartbeat ---
function writeScoreboardEntry(w: Writer, e: ScoreboardEntry): void {
  w.uvarint(e.num);
  w.u8(e.active ? 1 : 0);
  w.uvarint(e.team);
  w.uvarint(e.kills);
  w.uvarint(e.deaths);
  w.uvarint(e.caps);
  w.uvarint(e.ping);
  w.uvarint(e.realPing);
  w.uvarint(e.connectionQuality);
  w.uvarint(e.flags);
}

function readScoreboardEntry(r: Reader): ScoreboardEntry {
  const num = r.uvarint();
  const active = r.u8() !== 0;
  const team = r.uvarint();
  const kills = r.uvarint();
  const deaths = r.uvarint();
  const caps = r.uvarint();
  const ping = r.uvarint();
  const realPing = r.uvarint();
  const connectionQuality = r.uvarint();
  const flags = r.uvarint();
  return {
    num,
    active,
    team,
    kills,
    deaths,
    caps,
    ping,
    realPing,
    connectionQuality,
    flags,
  };
}

function writeHeartbeat(w: Writer, h: Heartbeat): void {
  w.uvarint(h.mapId);
  w.uvarint(h.teamScore.length);
  for (const s of h.teamScore) w.uvarint(s);
  w.uvarint(h.players.length);
  for (const p of h.players) writeScoreboardEntry(w, p);
}

function readHeartbeat(r: Reader): Heartbeat {
  const mapId = r.uvarint();
  const scoreCount = r.uvarint();
  const teamScore: number[] = [];
  for (let i = 0; i < scoreCount; i++) teamScore.push(r.uvarint());
  const playerCount = r.uvarint();
  const players: ScoreboardEntry[] = [];
  for (let i = 0; i < playerCount; i++) players.push(readScoreboardEntry(r));
  return { mapId, teamScore, players };
}

// --- Chat ---
function writeChat(w: Writer, c: Chat): void {
  w.uvarint(c.senderNum);
  w.u8(c.channel);
  w.string(c.text);
}

function readChat(r: Reader): Chat {
  const senderNum = r.uvarint();
  const channel = readChatChannel(r);
  const text = r.string();
  return { senderNum, channel, text };
}

// --- Voice (WebRTC signaling relay) ---
function writeVoice(w: Writer, v: Voice): void {
  w.uvarint(v.peer);
  w.string(v.data);
}

function readVoice(r: Reader): Voice {
  const peer = r.uvarint();
  return { peer, data: r.string() };
}

// --- Handshake (hello | welcome) ---
function writeHandshakeHello(w: Writer, h: HandshakeHello): void {
  w.uvarint(h.protocolVersion);
  w.string(h.gameVersion);
  w.u8(h.haveAntiCheat ? 1 : 0);
  w.string(h.hardwareId);
  w.string(h.password);
  w.string(h.name);
  w.uvarint(h.team);
  w.uvarint(h.look);
  w.string(h.modChecksum);
  w.string(h.engine); // v2: requested team bot engine ('' = server default)
}

function readHandshakeHello(r: Reader): HandshakeHello {
  const protocolVersion = r.uvarint();
  const gameVersion = r.string();
  const haveAntiCheat = r.u8() !== 0;
  const hardwareId = r.string();
  const password = r.string();
  const name = r.string();
  const team = r.uvarint();
  const look = r.uvarint();
  const modChecksum = r.string();
  // v2 field. A v1 hello ends here — read '' so the message still decodes and
  // the lobby can reject the stale client with a clean WrongVersion welcome.
  const engine = r.done ? "" : r.string();
  return {
    kind: "hello",
    protocolVersion,
    gameVersion,
    haveAntiCheat,
    hardwareId,
    password,
    name,
    team,
    look,
    modChecksum,
    engine,
  };
}

// Welcome presence bitmask (u8):
//   0x1 yourNum, 0x2 mapName, 0x4 serverTick, 0x8 reason, 0x10 spectator, 0x20 yourId.
function writeHandshakeWelcome(w: Writer, h: HandshakeWelcome): void {
  w.uvarint(h.result);
  w.uvarint(h.protocolVersion);
  let mask = 0;
  if (h.yourNum !== undefined) mask |= 0x1;
  if (h.mapName !== undefined) mask |= 0x2;
  if (h.serverTick !== undefined) mask |= 0x4;
  if (h.reason !== undefined) mask |= 0x8;
  if (h.spectator) mask |= 0x10;
  if (h.yourId !== undefined) mask |= 0x20;
  w.u8(mask);
  if (h.yourNum !== undefined) w.uvarint(h.yourNum);
  if (h.mapName !== undefined) w.string(h.mapName);
  if (h.serverTick !== undefined) w.svarint(h.serverTick);
  if (h.reason !== undefined) w.string(h.reason);
  if (h.yourId !== undefined) w.uvarint(h.yourId);
}

function readHandshakeWelcome(r: Reader): HandshakeWelcome {
  const result = readHandshakeResult(r);
  const protocolVersion = r.uvarint();
  const mask = r.u8();
  const out: HandshakeWelcome = { kind: "welcome", result, protocolVersion };
  if (mask & 0x1) out.yourNum = r.uvarint();
  if (mask & 0x2) out.mapName = r.string();
  if (mask & 0x4) out.serverTick = r.svarint();
  if (mask & 0x8) out.reason = r.string();
  if (mask & 0x10) out.spectator = true;
  if (mask & 0x20) out.yourId = r.uvarint();
  return out;
}

function writeHandshake(w: Writer, h: Handshake): void {
  if (h.kind === "hello") {
    w.u8(HandshakeTag.hello);
    writeHandshakeHello(w, h);
  } else {
    w.u8(HandshakeTag.welcome);
    writeHandshakeWelcome(w, h);
  }
}

function readHandshake(r: Reader): Handshake {
  const tag = r.u8();
  if (tag === HandshakeTag.hello) return readHandshakeHello(r);
  if (tag === HandshakeTag.welcome) return readHandshakeWelcome(r);
  throw new DecodeError("unknown-tag", `unknown Handshake tag ${tag}`);
}

// ---------------------------------------------------------------------------
// Top-level frame
// ---------------------------------------------------------------------------

/**
 * Serialize a {@link Message} into a framed ArrayBuffer.
 * Frame: [uint16 PROTOCOL_VERSION][uint8 kindTag][payload]. Total over every
 * valid Message; never throws {@link DecodeError}.
 */
export function encodeMessage(msg: Message): ArrayBuffer {
  const w = new Writer();
  w.u16(PROTOCOL_VERSION);

  switch (msg.kind) {
    case "inputFrame":
      w.u8(KindTag.inputFrame);
      writeInputFrame(w, msg);
      break;
    case "spriteSnapshot":
      w.u8(KindTag.spriteSnapshot);
      writeSpriteSnapshot(w, msg.snapshot);
      break;
    case "skeletonSnapshot":
      w.u8(KindTag.skeletonSnapshot);
      writeSkeletonSnapshot(w, msg);
      break;
    case "thingSnapshot":
      w.u8(KindTag.thingSnapshot);
      writeThingSnapshot(w, msg);
      break;
    case "heartbeat":
      w.u8(KindTag.heartbeat);
      writeHeartbeat(w, msg);
      break;
    case "chat":
      w.u8(KindTag.chat);
      writeChat(w, msg);
      break;
    case "voice":
      w.u8(KindTag.voice);
      writeVoice(w, msg);
      break;
    case "handshake":
      w.u8(KindTag.handshake);
      writeHandshake(w, msg.handshake);
      break;
  }

  return w.finish();
}

/**
 * Deserialize a framed ArrayBuffer back into a {@link Message}.
 * Throws {@link DecodeError} on version mismatch, unknown tag, truncation,
 * invalid enum, or trailing bytes.
 */
export function decodeMessage(buf: ArrayBuffer): Message {
  const r = new Reader(buf);

  const version = r.u16();
  if (version !== PROTOCOL_VERSION) {
    throw new DecodeError(
      "version-mismatch",
      `protocol version mismatch: got ${version}, expected ${PROTOCOL_VERSION}`,
    );
  }

  const tag = r.u8();
  let msg: Message;
  switch (tag) {
    case KindTag.inputFrame:
      msg = { kind: "inputFrame", ...readInputFrame(r) };
      break;
    case KindTag.spriteSnapshot:
      msg = { kind: "spriteSnapshot", snapshot: readSpriteSnapshot(r) };
      break;
    case KindTag.skeletonSnapshot:
      msg = { kind: "skeletonSnapshot", ...readSkeletonSnapshot(r) };
      break;
    case KindTag.thingSnapshot:
      msg = { kind: "thingSnapshot", ...readThingSnapshot(r) };
      break;
    case KindTag.heartbeat:
      msg = { kind: "heartbeat", ...readHeartbeat(r) };
      break;
    case KindTag.chat:
      msg = { kind: "chat", ...readChat(r) };
      break;
    case KindTag.voice:
      msg = { kind: "voice", ...readVoice(r) };
      break;
    case KindTag.handshake:
      msg = { kind: "handshake", handshake: readHandshake(r) };
      break;
    default:
      throw new DecodeError("unknown-tag", `unknown message kind tag ${tag}`);
  }

  r.expectEnd();
  return msg;
}
