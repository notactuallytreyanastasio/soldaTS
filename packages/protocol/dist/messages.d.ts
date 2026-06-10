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
export declare const PROTOCOL_VERSION: 1;
/**
 * Logical player input buttons. Replaces the legacy `Keys16: Word` bitfield.
 * Names and meaning are taken verbatim from wire-protocol.md
 * "Keys16 Bitmap Layout" (B1..B11), but on our wire these are an explicit set
 * of booleans rather than packed bits, so adding a button is non-breaking.
 */
export interface Buttons {
    left: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
    fire: boolean;
    jetpack: boolean;
    throwNade: boolean;
    changeWeapon: boolean;
    throwWeapon: boolean;
    reload: boolean;
    flagThrow: boolean;
}
/**
 * Mouse aim, as pixel offsets from screen centre.
 * PORT: wire-protocol.md "Mouse Aim Encoding" — legacy `MouseAimX, MouseAimY:
 * SmallInt` (signed 16-bit, -32768..32767). We keep the same semantic range
 * but as plain numbers; the codec is responsible for the int16 bound.
 */
export interface MouseAim {
    x: number;
    y: number;
}
/**
 * Chat channel.
 * PORT: shared/network/Net.pas:170-173 MSGTYPE_CMD/PUB/TEAM/RADIO.
 */
export declare enum ChatChannel {
    Command = 0,// PORT: MSGTYPE_CMD = 0
    Public = 1,// PORT: MSGTYPE_PUB  = 1
    Team = 2,// PORT: MSGTYPE_TEAM = 2
    Radio = 3
}
/**
 * Server's verdict on a connection attempt.
 * PORT: wire-protocol.md "Unaccepted Connection" State codes (Net.pas).
 */
export declare enum HandshakeResult {
    Ok = 1,// PORT: OK = 1
    WrongVersion = 2,// PORT: WRONG_VERSION = 2
    WrongPassword = 3,// PORT: WRONG_PASSWORD = 3
    BannedIp = 4,// PORT: BANNED_IP = 4
    ServerFull = 5,// PORT: SERVER_FULL = 5
    InvalidHandshake = 8,// PORT: INVALID_HANDSHAKE = 8
    WrongChecksum = 9,// PORT: WRONG_CHECKSUM = 9
    AntiCheatRequired = 10,// PORT: ANTICHEAT_REQUIRED = 10
    AntiCheatRejected = 11,// PORT: ANTICHEAT_REJECTED = 11
    SteamOnly = 12
}
/**
 * Player's prone/standing posture.
 * PORT: legacy `Position: Byte` in the sprite snapshots
 * (wire-protocol.md "Server Sprite Snapshot (Full)").
 */
export declare enum Posture {
    Standing = 0,
    Prone = 1,
    Crouching = 2
}
/** Equipment / weapon block shared by full sprite snapshots. */
export interface WeaponState {
    weaponNum: number;
    secondaryWeaponNum: number;
    ammoCount: number;
    grenadeCount: number;
}
/** Cosmetic / equipment flags previously packed into the `Look: Byte`. */
export interface Cosmetics {
    wearHelmet: boolean;
    cigar: boolean;
}
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
    clientTick: number;
    buttons: Buttons;
    aim: MouseAim;
    posture: Posture;
    /**
     * Optional self-reported predicted state. PORT: Pos, Velocity: TVector2 in
     * ClientSpriteSnapshot_Mov — the server treats these as a hint and reconciles.
     */
    predictedPos?: Vec2;
    predictedVel?: Vec2;
}
/**
 * Server → Client FULL sprite snapshot.
 * PORT: TMsg_ServerSpriteSnapshot (wire-protocol.md ID=3, "Full"). Sent on
 * demand or every 30 ticks; carries the complete authoritative state including
 * weapons/equipment/health/vest.
 */
export interface SpriteSnapshotFull {
    kind: "full";
    num: number;
    serverTick: number;
    pos: Vec2;
    velocity: Vec2;
    aim: MouseAim;
    posture: Posture;
    buttons: Buttons;
    cosmetics: Cosmetics;
    health: number;
    vest: number;
    weapon: WeaponState;
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
    num: number;
    serverTick: number;
    pos?: Vec2;
    velocity?: Vec2;
    aim?: MouseAim;
    posture?: Posture;
    buttons?: Buttons;
    health?: number;
    weapon?: Pick<WeaponState, "weaponNum" | "secondaryWeaponNum">;
    wearHelmet?: boolean;
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
    num: number;
    respawnCounter: number;
    constraints: number;
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
    num: number;
    owner: number;
    style: number;
    holdingSprite: number;
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
    active: boolean;
    team: number;
    kills: number;
    deaths: number;
    caps: number;
    ping: number;
    realPing: number;
    connectionQuality: number;
    flags: number;
}
/**
 * Server → Client scoreboard / world tick.
 * PORT: TMsg_HeartBeat (wire-protocol.md ID=2). The legacy message was a fixed
 * 401-byte block of `array[1..MAX_PLAYERS]` columns; we transpose it into a
 * length-prefixed list of rows so it scales past 32 players.
 */
export interface Heartbeat {
    mapId: number;
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
    channel: ChatChannel;
    text: string;
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
    result: HandshakeResult;
    protocolVersion: number;
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
/**
 * Every payload type, tagged by `kind`. This is the modern replacement for the
 * legacy 8-bit `TMsgHeader.ID` switch (wire-protocol.md "Message IDs"). The
 * `kind` strings are stable identifiers; the .proto assigns them field numbers.
 */
export type Message = ({
    kind: "inputFrame";
} & InputFrame) | ({
    kind: "spriteSnapshot";
} & {
    snapshot: SpriteSnapshot;
}) | ({
    kind: "skeletonSnapshot";
} & SkeletonSnapshot) | ({
    kind: "thingSnapshot";
} & ThingSnapshot) | ({
    kind: "heartbeat";
} & Heartbeat) | ({
    kind: "chat";
} & Chat) | ({
    kind: "handshake";
} & {
    handshake: Handshake;
});
/** The discriminant literal of {@link Message}. */
export type MessageKind = Message["kind"];
/**
 * The framed unit actually put on the wire: a version stamp plus exactly one
 * {@link Message}. Mismatched `version` is rejected during the handshake.
 */
export interface Envelope {
    version: number;
    message: Message;
}
/** Convenience constructor that always stamps the current PROTOCOL_VERSION. */
export declare const envelope: (message: Message) => Envelope;
//# sourceMappingURL=messages.d.ts.map