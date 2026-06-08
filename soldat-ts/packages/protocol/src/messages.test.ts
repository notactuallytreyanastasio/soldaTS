import { describe, it, expect } from "vitest";
import {
  PROTOCOL_VERSION,
  ChatChannel,
  HandshakeResult,
  Posture,
  envelope,
} from "./messages";
import type {
  Message,
  MessageKind,
  Envelope,
  InputFrame,
  SpriteSnapshot,
  SpriteSnapshotFull,
  SpriteSnapshotDelta,
  SkeletonSnapshot,
  ThingSnapshot,
  Heartbeat,
  Chat,
  Handshake,
  HandshakeHello,
  HandshakeWelcome,
  Buttons,
  Vec2,
} from "./messages";

// Reusable fixtures.
const noButtons: Buttons = {
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
  flagThrow: false,
};
const v = (x: number, y: number): Vec2 => ({ x, y });

describe("PROTOCOL_VERSION", () => {
  it("is the literal 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    // Type-level: PROTOCOL_VERSION is the literal type `1`.
    const _check: 1 = PROTOCOL_VERSION;
    expect(_check).toBe(1);
  });
});

// One constructor per Message variant, each tagged with `kind`.
const inputFrame: Message = {
  kind: "inputFrame",
  clientTick: 42,
  buttons: { ...noButtons, fire: true },
  aim: { x: -10, y: 30 },
  posture: Posture.Standing,
};

const fullSnapshot: SpriteSnapshotFull = {
  kind: "full",
  num: 1,
  serverTick: 100,
  pos: v(320, 240),
  velocity: v(0, 0),
  aim: { x: 0, y: 0 },
  posture: Posture.Prone,
  buttons: noButtons,
  cosmetics: { wearHelmet: true, cigar: false },
  health: 150,
  vest: 0,
  weapon: {
    weaponNum: 4,
    secondaryWeaponNum: 1,
    ammoCount: 30,
    grenadeCount: 2,
  },
};

const deltaSnapshot: SpriteSnapshotDelta = {
  kind: "delta",
  num: 2,
  serverTick: 101,
  pos: v(330, 240),
};

const spriteSnapshotMsg: Message = {
  kind: "spriteSnapshot",
  snapshot: fullSnapshot,
};

const skeletonMsg: Message = {
  kind: "skeletonSnapshot",
  num: 3,
  respawnCounter: -5,
  constraints: 0,
  pos: [v(1, 1), v(2, 2)],
  oldPos: [v(0, 0), v(1, 1)],
};

const thingMsg: Message = {
  kind: "thingSnapshot",
  num: 1,
  owner: 0,
  style: 1,
  holdingSprite: 0,
  pos: [v(10, 10)],
  oldPos: [v(10, 10)],
  timeout: 1800,
};

const heartbeatMsg: Message = {
  kind: "heartbeat",
  mapId: 7,
  teamScore: [0, 0, 0, 0],
  players: [
    {
      num: 1,
      active: true,
      team: 1,
      kills: 3,
      deaths: 1,
      caps: 0,
      ping: 20,
      realPing: 21,
      connectionQuality: 100,
      flags: 0,
    },
  ],
};

const chatMsg: Message = {
  kind: "chat",
  senderNum: 1,
  channel: ChatChannel.Public,
  text: "gg",
};

const helloMsg: Message = {
  kind: "handshake",
  handshake: {
    kind: "hello",
    protocolVersion: PROTOCOL_VERSION,
    gameVersion: "1.3",
    haveAntiCheat: false,
    hardwareId: "0123456789a",
    password: "",
    name: "Major",
    team: 1,
    look: 0,
    modChecksum: "0".repeat(40),
  },
};

const welcomeMsg: Message = {
  kind: "handshake",
  handshake: {
    kind: "welcome",
    result: HandshakeResult.Ok,
    protocolVersion: PROTOCOL_VERSION,
    yourNum: 1,
    mapName: "ctf_Ash",
    serverTick: 100,
  },
};

describe("Message discriminated union narrowing", () => {
  it("narrows each variant by its `kind` tag", () => {
    const seen: MessageKind[] = [];
    const visit = (m: Message): void => {
      switch (m.kind) {
        case "inputFrame": {
          // narrowed to InputFrame — `clientTick` is accessible.
          const f: InputFrame = m;
          expect(typeof f.clientTick).toBe("number");
          break;
        }
        case "spriteSnapshot": {
          // narrowed: `snapshot` is a SpriteSnapshot union.
          const s: SpriteSnapshot = m.snapshot;
          if (s.kind === "full") {
            const full: SpriteSnapshotFull = s;
            expect(full.health).toBeGreaterThan(0);
          } else {
            const d: SpriteSnapshotDelta = s;
            expect(typeof d.num).toBe("number");
          }
          break;
        }
        case "skeletonSnapshot": {
          const s: SkeletonSnapshot = m;
          expect(s.pos.length).toBe(s.oldPos.length);
          break;
        }
        case "thingSnapshot": {
          const t: ThingSnapshot = m;
          expect(t.pos.length).toBeGreaterThan(0);
          break;
        }
        case "heartbeat": {
          const h: Heartbeat = m;
          expect(h.teamScore).toHaveLength(4);
          break;
        }
        case "chat": {
          const c: Chat = m;
          expect(typeof c.text).toBe("string");
          break;
        }
        case "handshake": {
          const hs: Handshake = m.handshake;
          if (hs.kind === "hello") {
            const hello: HandshakeHello = hs;
            expect(hello.gameVersion).toBeTruthy();
          } else {
            const welcome: HandshakeWelcome = hs;
            expect(welcome.result).toBe(HandshakeResult.Ok);
          }
          break;
        }
        default: {
          // Exhaustiveness: if a new `kind` is added without a case,
          // this assignment fails to compile.
          const _exhaustive: never = m;
          throw new Error(`unhandled message: ${String(_exhaustive)}`);
        }
      }
      seen.push(m.kind);
    };

    const all: Message[] = [
      inputFrame,
      spriteSnapshotMsg,
      skeletonMsg,
      thingMsg,
      heartbeatMsg,
      chatMsg,
      helloMsg,
      welcomeMsg,
    ];
    all.forEach(visit);

    // Both hello and welcome are `kind: "handshake"`, so all 8 fixtures are
    // visited but only 7 distinct kinds appear.
    expect(seen).toHaveLength(8);
    expect([...new Set(seen)]).toEqual([
      "inputFrame",
      "spriteSnapshot",
      "skeletonSnapshot",
      "thingSnapshot",
      "heartbeat",
      "chat",
      "handshake",
    ]);
  });

  it("delta snapshots narrow independently of full", () => {
    const s: SpriteSnapshot = deltaSnapshot;
    expect(s.kind).toBe("delta");
    if (s.kind === "delta") {
      // `health` is optional on deltas; absent here.
      expect(s.health).toBeUndefined();
      expect(s.pos).toEqual({ x: 330, y: 240 });
    }
  });
});

describe("envelope()", () => {
  it("stamps the current PROTOCOL_VERSION around a message", () => {
    const e: Envelope = envelope(chatMsg);
    expect(e.version).toBe(PROTOCOL_VERSION);
    expect(e.message).toBe(chatMsg);
    expect(e.message.kind).toBe("chat");
  });
});
