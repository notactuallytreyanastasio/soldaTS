// @soldat/protocol — clean-break, versioned wire schema for the OpenSoldat
// web rewrite.
//
// This is a MODERNIZED schema. It is informed by the legacy wire protocol
// (see docs/rewrite-reference/wire-protocol.md, itself derived from
// shared/network/Net.pas in the reference tree) but it deliberately breaks
// compatibility with the FreePascal `packed record` layout:
//
//   * A single versioned envelope wraps every payload instead of a bare 8-bit
//     `TMsgHeader.ID`.  (legacy: wire-protocol.md "Core Header" / Net.pas).
//   * Counts are length-prefixed (TS arrays) instead of fixed
//     `array[1..MAX_PLAYERS]` / `array[1..MAX_SPRITES]` blocks
//     (legacy MAX_PLAYERS = 32, Net.pas:104).
//   * The scrambled `TGun` / struct-aliasing tricks (wire-protocol.md note 3)
//     are gone; fields are named and explicit.
//   * Logical button sets replace the `Keys16` bitfield
//     (wire-protocol.md "Keys16 Bitmap Layout").
//
// This module is pure data shapes — no physics arithmetic happens here — so
// there is nothing to wrap in the deterministic `f()` scalar. The simulation
// layer is responsible for f32 fidelity when it *consumes* these snapshots.
//
// The protobuf schema in ./schema.proto is the eventual source of truth; this
// TS mirror exists so the rest of the workspace can type-check today without a
// codegen toolchain. Field numbers / names are kept in lockstep with the
// .proto on purpose.

// PORT: a wire Vec2 mirrors @soldat/sim math/vec2.ts:13 `interface Vec2`.
// We do not redefine the Vec2 *helpers* (add/sub/scale/...) — only the plain
// data shape is needed on the wire. Kept structurally identical so a value of
// the sim's Vec2 assigns here without conversion. The protocol package does
// not declare a dependency on @soldat/sim, so we restate the shape rather than
// import it across the package boundary.
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Wire schema version. Bumped on any breaking change to message shapes.
 * Unlike the legacy `Version: array[0..3] of char` game-version string
 * (wire-protocol.md "Request Game"), this versions the *protocol*, not the
 * game build, and rides inside every envelope so peers can reject mismatches
 * during the handshake.
 */
export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Shared enums / small value types
// ---------------------------------------------------------------------------

/**
 * Logical player input buttons. Replaces the legacy `Keys16: Word` bitfield.
 * Names and meaning are taken verbatim from wire-protocol.md
 * "Keys16 Bitmap Layout" (B1..B11), but on our wire these are an explicit set
 * of booleans rather than packed bits, so adding a button is non-breaking.
 */
export interface Buttons {
  left: boolean; // PORT: Keys16 B1 (A / Left arrow)
  right: boolean; // PORT: Keys16 B2 (D / Right arrow)
  up: boolean; // PORT: Keys16 B3 (W / Up arrow)
  down: boolean; // PORT: Keys16 B4 (S / Down arrow)
  fire: boolean; // PORT: Keys16 B5 (Mouse click / Ctrl)
  jetpack: boolean; // PORT: Keys16 B6 (Space)
  throwNade: boolean; // PORT: Keys16 B7 (G)
  changeWeapon: boolean; // PORT: Keys16 B8 (Q)
  throwWeapon: boolean; // PORT: Keys16 B9 (E)
  reload: boolean; // PORT: Keys16 B10 (R)
  flagThrow: boolean; // PORT: Keys16 B11 (F)
}

/**
 * Mouse aim, as pixel offsets from screen centre.
 * PORT: wire-protocol.md "Mouse Aim Encoding" — legacy `MouseAimX, MouseAimY:
 * SmallInt` (signed 16-bit, -32768..32767). We keep the same semantic range
 * but as plain numbers; the codec is responsible for the int16 bound.
 */
export interface MouseAim {
  x: number; // PORT: MouseAimX (SmallInt)
  y: number; // PORT: MouseAimY (SmallInt)
}

/**
 * Chat channel.
 * PORT: shared/network/Net.pas:170-173 MSGTYPE_CMD/PUB/TEAM/RADIO.
 */
export enum ChatChannel {
  Command = 0, // PORT: MSGTYPE_CMD = 0
  Public = 1, // PORT: MSGTYPE_PUB  = 1
  Team = 2, // PORT: MSGTYPE_TEAM = 2
  Radio = 3, // PORT: MSGTYPE_RADIO = 3
}

/**
 * Server's verdict on a connection attempt.
 * PORT: wire-protocol.md "Unaccepted Connection" State codes (Net.pas).
 */
export enum HandshakeResult {
  Ok = 1, // PORT: OK = 1
  WrongVersion = 2, // PORT: WRONG_VERSION = 2
  WrongPassword = 3, // PORT: WRONG_PASSWORD = 3
  BannedIp = 4, // PORT: BANNED_IP = 4
  ServerFull = 5, // PORT: SERVER_FULL = 5
  InvalidHandshake = 8, // PORT: INVALID_HANDSHAKE = 8
  WrongChecksum = 9, // PORT: WRONG_CHECKSUM = 9
  AntiCheatRequired = 10, // PORT: ANTICHEAT_REQUIRED = 10
  AntiCheatRejected = 11, // PORT: ANTICHEAT_REJECTED = 11
  SteamOnly = 12, // PORT: STEAM_ONLY = 12
}

/**
 * Player's prone/standing posture.
 * PORT: legacy `Position: Byte` in the sprite snapshots
 * (wire-protocol.md "Server Sprite Snapshot (Full)").
 */
export enum Posture {
  Standing = 0,
  Prone = 1,
  Crouching = 2,
}

/** Equipment / weapon block shared by full sprite snapshots. */
export interface WeaponState {
  weaponNum: number; // PORT: WeaponNum: Byte
  secondaryWeaponNum: number; // PORT: SecondaryWeaponNum: Byte
  ammoCount: number; // PORT: AmmoCount: Byte
  grenadeCount: number; // PORT: GrenadeCount: Byte
}

/** Cosmetic / equipment flags previously packed into the `Look: Byte`. */
export interface Cosmetics {
  wearHelmet: boolean; // PORT: Look field B5 "Helm"
  cigar: boolean; // PORT: Look field — cigar flag
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/**
 * Client → Server input for a single logical tick.
 * PORT: replaces TMsg_ClientSpriteSnapshot_Mov (wire-protocol.md ID=42) plus
 * the weapon/posture half of TMsg_ClientSpriteSnapshot (ID=4). We carry an
 * explicit `clientTick` (legacy left ClientTicks out of the Mov struct and
 * shoved it into the bullet message — see wire-protocol.md note on ID=42 and
 * "Bullet Snapshot (Client→Server)"). Used for lag compensation:
 * `PingTicksB = ServerTick - clientTick`, clamped to [0, MAX_OLDPOS=125]
 * (wire-protocol.md "Lag Compensation").
 */
export interface InputFrame {
  clientTick: number; // PORT: ClientTicks: LongInt (moved into the input frame)
  buttons: Buttons; // PORT: Keys16: Word
  aim: MouseAim; // PORT: MouseAimX/Y: SmallInt
  posture: Posture; // PORT: Position: Byte
  /**
   * Optional self-reported predicted state. PORT: Pos, Velocity: TVector2 in
   * ClientSpriteSnapshot_Mov — the server treats these as a hint and reconciles.
   */
  predictedPos?: Vec2; // PORT: Pos: TVector2
  predictedVel?: Vec2; // PORT: Velocity: TVector2
}

/**
 * Server → Client FULL sprite snapshot.
 * PORT: TMsg_ServerSpriteSnapshot (wire-protocol.md ID=3, "Full"). Sent on
 * demand or every 30 ticks; carries the complete authoritative state including
 * weapons/equipment/health/vest.
 */
export interface SpriteSnapshotFull {
  kind: "full";
  num: number; // PORT: Num: Byte (sprite 1..MAX_SPRITES, 1-indexed)
  serverTick: number; // PORT: ServerTicks: LongInt
  pos: Vec2; // PORT: Pos: TVector2
  velocity: Vec2; // PORT: Velocity: TVector2
  aim: MouseAim; // PORT: MouseAimX/Y: SmallInt
  posture: Posture; // PORT: Position: Byte
  buttons: Buttons; // PORT: Keys16: Word
  cosmetics: Cosmetics; // PORT: Look: Byte
  health: number; // PORT: Health: Single
  vest: number; // PORT: Vest: Single
  weapon: WeaponState; // PORT: WeaponNum/SecondaryWeaponNum/AmmoCount/GrenadeCount
}

/**
 * Server → Client DELTA sprite snapshot (incremental).
 * PORT: a fusion of the legacy ID=41 "Major" snapshot and the per-field
 * deltas ID=21 (Movement), ID=25 (Weapons), ID=26 (Helmet), ID=29 (MouseAim)
 * — see wire-protocol.md "Snapshot / Delta Model". Every field except `num`
 * and `serverTick` is optional: present only when it changed.
 */
export interface SpriteSnapshotDelta {
  kind: "delta";
  num: number; // PORT: Num: Byte
  serverTick: number; // PORT: ServerTick: LongInt
  pos?: Vec2; // PORT: Pos: TVector2 (ID=21 / ID=41)
  velocity?: Vec2; // PORT: Velocity: TVector2 (ID=21 / ID=41)
  aim?: MouseAim; // PORT: MouseAimX/Y (ID=29 / ID=41)
  posture?: Posture; // PORT: Position: Byte (ID=41)
  buttons?: Buttons; // PORT: Keys16: Word (ID=21 / ID=41)
  health?: number; // PORT: Health: Single (ID=41)
  weapon?: Pick<WeaponState, "weaponNum" | "secondaryWeaponNum">; // PORT: ID=25
  wearHelmet?: boolean; // PORT: WearHelmet: Byte (ID=26)
}

/** Discriminated union over the two snapshot tiers. */
export type SpriteSnapshot = SpriteSnapshotFull | SpriteSnapshotDelta;

/**
 * Server → Client skeleton state for a dead sprite's ragdoll.
 * PORT: TMsg_ServerSkeletonSnapshot (wire-protocol.md ID=7) merged with the
 * skeleton-position payload from TMsg_SpriteDeath (ID=13): `Pos, OldPos:
 * array[1..16] of TVector2`. Legacy sends indices 1..16 and the client derives
 * 17..20 from {1,2,15,16}; we keep the 1-indexed 16-point set and let the
 * client perform the same derivation. Counts are length-prefixed instead of
 * a fixed `array[1..16]`.
 */
export interface SkeletonSnapshot {
  num: number; // PORT: Num: Byte
  respawnCounter: number; // PORT: RespawnCounter: SmallInt
  constraints: number; // PORT: Constraints: Byte (skeleton constraint flags)
  /** PORT: Pos: array[1..16] of TVector2 — wire indices 1..16 (1-indexed). */
  pos: Vec2[];
  /** PORT: OldPos: array[1..16] of TVector2. */
  oldPos: Vec2[];
}

/**
 * Server → Client thing (flag / kit / bonus) snapshot.
 * PORT: TMsg_ServerThingSnapshot (wire-protocol.md ID=9) and its reliable
 * sibling TMsg_ServerThingMustSnapshot (ID=33, adds `Timeout`). The legacy
 * 4-entry physics history ring (`Pos, OldPos: array[1..4] of TVector2`) is
 * kept but length-prefixed.
 */
export interface ThingSnapshot {
  num: number; // PORT: Num: Byte
  owner: number; // PORT: Owner: Byte
  style: number; // PORT: Style: Byte
  holdingSprite: number; // PORT: HoldingSprite: Byte
  /** PORT: Pos: array[1..4] of TVector2 — physics history ring (1-indexed). */
  pos: Vec2[];
  /** PORT: OldPos: array[1..4] of TVector2. */
  oldPos: Vec2[];
  /** PORT: Timeout: LongInt — only on the reliable "must" variant (ID=33). */
  timeout?: number;
}

/** Per-player scoreboard row inside a Heartbeat. */
export interface ScoreboardEntry {
  /**
   * Sprite / player slot, 1-indexed. PORT: legacy used the array index into
   * `array[1..MAX_PLAYERS]` (MAX_PLAYERS = 32, Net.pas:104); here it is an
   * explicit field so the list can be sparse.
   */
  num: number;
  active: boolean; // PORT: Active: Boolean
  team: number; // PORT: Team: Byte
  kills: number; // PORT: Kills: Word
  deaths: number; // PORT: Deaths: Word
  caps: number; // PORT: Caps: Byte
  ping: number; // PORT: Ping: Byte
  realPing: number; // PORT: RealPing: Word
  connectionQuality: number; // PORT: ConnectionQuality: Byte
  flags: number; // PORT: Flags: Byte
}

/**
 * Server → Client scoreboard / world tick.
 * PORT: TMsg_HeartBeat (wire-protocol.md ID=2). The legacy message was a fixed
 * 401-byte block of `array[1..MAX_PLAYERS]` columns; we transpose it into a
 * length-prefixed list of rows so it scales past 32 players.
 */
export interface Heartbeat {
  mapId: number; // PORT: MapID: LongWord
  /** PORT: TeamScore: array[1..4] of Word — 4 team scores, 1-indexed. */
  teamScore: number[];
  /** PORT: the transposed array[1..MAX_PLAYERS] columns, now one row each. */
  players: ScoreboardEntry[];
}

/**
 * Bidirectional chat message.
 * PORT: TMsg_StringMessage (wire-protocol.md ID=6). `Text: array[0..0] of
 * WideChar` (null-terminated UTF-16) becomes a plain JS string; the legacy
 * 100-char DoS cap is enforced by the codec, not the type.
 */
export interface Chat {
  /** PORT: Num: Byte — sender sprite, 255 = system/server message. */
  senderNum: number;
  channel: ChatChannel; // PORT: MsgType: Byte
  text: string; // PORT: Text: array[0..0] of WideChar (UTF-16 LE)
}

/**
 * Client → Server connection request (first reliable message after connect).
 * PORT: TMsg_RequestGame (wire-protocol.md ID=58) combined with the identity
 * fields the client later sent in TMsg_PlayerInfo (ID=15). Naming it "Hello"
 * to match the modern handshake vocabulary.
 */
export interface HandshakeHello {
  kind: "hello";
  /** PORT: this protocol's PROTOCOL_VERSION, echoed for an explicit reject. */
  protocolVersion: number;
  /** PORT: Version: array[0..3] of char — game build string, e.g. "1.3". */
  gameVersion: string;
  /** PORT: HaveAntiCheat: Byte (ACTYPE_NONE=0 / ACTYPE_FAE=1) -> boolean. */
  haveAntiCheat: boolean;
  /** PORT: HardwareID: string[11]. */
  hardwareId: string;
  /** PORT: Password: array[0..24] of char (empty string if none). */
  password: string;
  /** PORT: Name: array[0..23] of char (PLAYERNAME_CHARS) from PlayerInfo. */
  name: string;
  /** PORT: Team: Byte from PlayerInfo. */
  team: number;
  /** PORT: Look: Byte from PlayerInfo (hair/cap/chain bits). */
  look: number;
  /** PORT: GameModChecksum: TSHA1Digest — 20 raw bytes as hex. */
  modChecksum: string;
}

/**
 * Server → Client connection verdict + initial world.
 * PORT: TMsg_UnAccepted (wire-protocol.md ID=44) for rejects, and on accept the
 * roster carried by TMsg_PlayersList (ID=16) / per-join TMsg_NewPlayer (ID=17).
 */
export interface HandshakeWelcome {
  kind: "welcome";
  result: HandshakeResult; // PORT: State: Byte
  protocolVersion: number; // PORT: server's PROTOCOL_VERSION
  /**
   * The slot the server assigned this client (its own sprite num).
   * PORT: NewPlayer.Num with AdoptSpriteID=1 (wire-protocol.md ID=17).
   * Present only when `result === Ok`.
   */
  yourNum?: number;
  /** PORT: MapName: array[0..63] of char. Present only on Ok. */
  mapName?: string;
  /** PORT: ServerTicks: LongInt — authoritative tick at accept time. */
  serverTick?: number;
  /** PORT: Text: array[0..0] of char — human-readable reject reason. */
  reason?: string;
}

/** Discriminated union over the two handshake phases. */
export type Handshake = HandshakeHello | HandshakeWelcome;

// ---------------------------------------------------------------------------
// Versioned envelope + top-level discriminated union
// ---------------------------------------------------------------------------

/**
 * Every payload type, tagged by `kind`. This is the modern replacement for the
 * legacy 8-bit `TMsgHeader.ID` switch (wire-protocol.md "Message IDs"). The
 * `kind` strings are stable identifiers; the .proto assigns them field numbers.
 */
export type Message =
  | ({ kind: "inputFrame" } & InputFrame)
  | ({ kind: "spriteSnapshot" } & { snapshot: SpriteSnapshot })
  | ({ kind: "skeletonSnapshot" } & SkeletonSnapshot)
  | ({ kind: "thingSnapshot" } & ThingSnapshot)
  | ({ kind: "heartbeat" } & Heartbeat)
  | ({ kind: "chat" } & Chat)
  | ({ kind: "handshake" } & { handshake: Handshake });

/** The discriminant literal of {@link Message}. */
export type MessageKind = Message["kind"];

/**
 * The framed unit actually put on the wire: a version stamp plus exactly one
 * {@link Message}. Mismatched `version` is rejected during the handshake.
 */
export interface Envelope {
  version: number; // PORT: PROTOCOL_VERSION
  message: Message;
}

/** Convenience constructor that always stamps the current PROTOCOL_VERSION. */
export const envelope = (message: Message): Envelope => ({
  version: PROTOCOL_VERSION,
  message,
});
