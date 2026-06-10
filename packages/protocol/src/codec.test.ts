import { describe, it, expect } from "vitest";
import { ChatChannel, HandshakeResult, Posture, PROTOCOL_VERSION } from "./messages";
import type { Buttons, Message } from "./messages";
import { decodeMessage, DecodeError, encodeMessage } from "./codec";

// Fully-populated buttons so the bitfield round-trips every bit.
const allButtons: Buttons = {
  left: true,
  right: false,
  up: true,
  down: false,
  fire: true,
  jetpack: false,
  throwNade: true,
  changeWeapon: false,
  throwWeapon: true,
  reload: false,
  flagThrow: true,
};

const roundTrip = (msg: Message): Message => decodeMessage(encodeMessage(msg));

// One representative (and edge-y) value per Message kind / variant.
const cases: Record<string, Message> = {
  inputFrame: {
    kind: "inputFrame",
    clientTick: -12345,
    buttons: allButtons,
    aim: { x: -32768, y: 32767 },
    posture: Posture.Prone,
    predictedPos: { x: 12.5, y: -64.25 },
    predictedVel: { x: -0.27, y: 3.0 },
  },
  inputFrameNoHints: {
    kind: "inputFrame",
    clientTick: 0,
    buttons: allButtons,
    aim: { x: 0, y: 0 },
    posture: Posture.Standing,
  },
  spriteSnapshotFull: {
    kind: "spriteSnapshot",
    snapshot: {
      kind: "full",
      num: 7,
      serverTick: 987654,
      pos: { x: 100.5, y: 200.25 },
      velocity: { x: -1.5, y: 2.75 },
      aim: { x: 15, y: -22 },
      posture: Posture.Crouching,
      buttons: allButtons,
      cosmetics: { wearHelmet: true, cigar: false },
      health: 87.5,
      vest: 33.25,
      weapon: {
        weaponNum: 4,
        secondaryWeaponNum: 12,
        ammoCount: 30,
        grenadeCount: 3,
      },
    },
  },
  spriteSnapshotDeltaFull: {
    kind: "spriteSnapshot",
    snapshot: {
      kind: "delta",
      num: 9,
      serverTick: 42,
      pos: { x: 1, y: 2 },
      velocity: { x: 3, y: 4 },
      aim: { x: -5, y: 6 },
      posture: Posture.Prone,
      buttons: allButtons,
      health: 50.0,
      weapon: { weaponNum: 2, secondaryWeaponNum: 5 },
      wearHelmet: true,
    },
  },
  spriteSnapshotDeltaEmpty: {
    kind: "spriteSnapshot",
    snapshot: { kind: "delta", num: 1, serverTick: -1 },
  },
  skeletonSnapshot: {
    kind: "skeletonSnapshot",
    num: 3,
    respawnCounter: -250,
    constraints: 255,
    pos: Array.from({ length: 16 }, (_, i) => ({ x: i, y: i * 2 })),
    oldPos: Array.from({ length: 16 }, (_, i) => ({ x: -i, y: -i * 2 })),
  },
  thingSnapshotWithTimeout: {
    kind: "thingSnapshot",
    num: 2,
    owner: 5,
    style: 1,
    holdingSprite: 8,
    pos: Array.from({ length: 4 }, (_, i) => ({ x: i + 0.5, y: i - 0.5 })),
    oldPos: Array.from({ length: 4 }, (_, i) => ({ x: i, y: i })),
    timeout: 1800,
  },
  thingSnapshotNoTimeout: {
    kind: "thingSnapshot",
    num: 2,
    owner: 0,
    style: 0,
    holdingSprite: 0,
    pos: [],
    oldPos: [],
  },
  heartbeat: {
    kind: "heartbeat",
    mapId: 4294967295,
    teamScore: [10, 20, 0, 5],
    players: [
      {
        num: 1,
        active: true,
        team: 2,
        kills: 1234,
        deaths: 56,
        caps: 3,
        ping: 42,
        realPing: 999,
        connectionQuality: 7,
        flags: 1,
      },
      {
        num: 32,
        active: false,
        team: 0,
        kills: 0,
        deaths: 0,
        caps: 0,
        ping: 0,
        realPing: 0,
        connectionQuality: 0,
        flags: 0,
      },
    ],
  },
  chat: {
    kind: "chat",
    senderNum: 255,
    channel: ChatChannel.Radio,
    text: "Need backup! éà テスト 👍",
  },
  handshakeHello: {
    kind: "handshake",
    handshake: {
      kind: "hello",
      protocolVersion: PROTOCOL_VERSION,
      gameVersion: "1.3",
      haveAntiCheat: true,
      hardwareId: "abcdef01234",
      password: "hunter2",
      name: "Major Pain",
      team: 1,
      look: 0b10010110,
      modChecksum: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    },
  },
  handshakeWelcomeOk: {
    kind: "handshake",
    handshake: {
      kind: "welcome",
      result: HandshakeResult.Ok,
      protocolVersion: PROTOCOL_VERSION,
      yourNum: 4,
      mapName: "ctf_Ash",
      serverTick: 100000,
    },
  },
  handshakeWelcomeReject: {
    kind: "handshake",
    handshake: {
      kind: "welcome",
      result: HandshakeResult.WrongVersion,
      protocolVersion: PROTOCOL_VERSION,
      reason: "server runs a newer protocol",
    },
  },
};

describe("codec round-trip — every Message kind", () => {
  for (const [name, msg] of Object.entries(cases)) {
    it(`round-trips ${name}`, () => {
      const decoded = roundTrip(msg);
      expect(decoded).toEqual(msg);
    });
  }
});

describe("frame structure", () => {
  it("stamps PROTOCOL_VERSION in the first uint16 LE", () => {
    const buf = encodeMessage(cases.chat!);
    const view = new DataView(buf);
    expect(view.getUint16(0, true)).toBe(PROTOCOL_VERSION);
  });

  it("does not carry undefined optional fields", () => {
    const decoded = roundTrip(cases.inputFrameNoHints!);
    expect("predictedPos" in decoded).toBe(false);
    expect("predictedVel" in decoded).toBe(false);
  });
});

describe("decode rejections", () => {
  it("rejects a version mismatch", () => {
    const buf = encodeMessage(cases.chat!);
    const view = new DataView(buf);
    view.setUint16(0, PROTOCOL_VERSION + 1, true);
    expect(() => decodeMessage(buf)).toThrowError(DecodeError);
    try {
      decodeMessage(buf);
    } catch (e) {
      expect(e).toBeInstanceOf(DecodeError);
      expect((e as DecodeError).kind).toBe("version-mismatch");
    }
  });

  it("rejects an unknown kind tag", () => {
    const buf = encodeMessage(cases.chat!);
    const view = new DataView(buf);
    view.setUint8(2, 250); // overwrite the kind tag
    try {
      decodeMessage(buf);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DecodeError);
      expect((e as DecodeError).kind).toBe("unknown-tag");
    }
  });

  it("rejects a truncated buffer", () => {
    const buf = encodeMessage(cases.skeletonSnapshot!);
    const truncated = buf.slice(0, buf.byteLength - 4);
    try {
      decodeMessage(truncated);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DecodeError);
      expect((e as DecodeError).kind).toBe("truncated");
    }
  });

  it("rejects trailing garbage after a valid payload", () => {
    const buf = encodeMessage(cases.chat!);
    const padded = new Uint8Array(buf.byteLength + 2);
    padded.set(new Uint8Array(buf));
    expect(() => decodeMessage(padded.buffer)).toThrowError(DecodeError);
  });

  it("rejects an invalid enum value", () => {
    const buf = encodeMessage(cases.chat!);
    const bytes = new Uint8Array(buf);
    // chat payload: [u16 ver][u8 tag][uvarint senderNum=255][u8 channel]...
    // senderNum 255 encodes as two bytes (0xFF 0x01); channel byte follows.
    bytes[5] = 99; // corrupt channel
    try {
      decodeMessage(bytes.buffer);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DecodeError);
      expect((e as DecodeError).kind).toBe("invalid-enum");
    }
  });
});
