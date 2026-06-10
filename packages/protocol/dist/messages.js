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
/**
 * Wire schema version. Bumped on any breaking change to message shapes.
 * Unlike the legacy `Version: array[0..3] of char` game-version string
 * (wire-protocol.md "Request Game"), this versions the *protocol*, not the
 * game build, and rides inside every envelope so peers can reject mismatches
 * during the handshake.
 */
export const PROTOCOL_VERSION = 1;
/**
 * Chat channel.
 * PORT: shared/network/Net.pas:170-173 MSGTYPE_CMD/PUB/TEAM/RADIO.
 */
export var ChatChannel;
(function (ChatChannel) {
    ChatChannel[ChatChannel["Command"] = 0] = "Command";
    ChatChannel[ChatChannel["Public"] = 1] = "Public";
    ChatChannel[ChatChannel["Team"] = 2] = "Team";
    ChatChannel[ChatChannel["Radio"] = 3] = "Radio";
})(ChatChannel || (ChatChannel = {}));
/**
 * Server's verdict on a connection attempt.
 * PORT: wire-protocol.md "Unaccepted Connection" State codes (Net.pas).
 */
export var HandshakeResult;
(function (HandshakeResult) {
    HandshakeResult[HandshakeResult["Ok"] = 1] = "Ok";
    HandshakeResult[HandshakeResult["WrongVersion"] = 2] = "WrongVersion";
    HandshakeResult[HandshakeResult["WrongPassword"] = 3] = "WrongPassword";
    HandshakeResult[HandshakeResult["BannedIp"] = 4] = "BannedIp";
    HandshakeResult[HandshakeResult["ServerFull"] = 5] = "ServerFull";
    HandshakeResult[HandshakeResult["InvalidHandshake"] = 8] = "InvalidHandshake";
    HandshakeResult[HandshakeResult["WrongChecksum"] = 9] = "WrongChecksum";
    HandshakeResult[HandshakeResult["AntiCheatRequired"] = 10] = "AntiCheatRequired";
    HandshakeResult[HandshakeResult["AntiCheatRejected"] = 11] = "AntiCheatRejected";
    HandshakeResult[HandshakeResult["SteamOnly"] = 12] = "SteamOnly";
})(HandshakeResult || (HandshakeResult = {}));
/**
 * Player's prone/standing posture.
 * PORT: legacy `Position: Byte` in the sprite snapshots
 * (wire-protocol.md "Server Sprite Snapshot (Full)").
 */
export var Posture;
(function (Posture) {
    Posture[Posture["Standing"] = 0] = "Standing";
    Posture[Posture["Prone"] = 1] = "Prone";
    Posture[Posture["Crouching"] = 2] = "Crouching";
})(Posture || (Posture = {}));
/** Convenience constructor that always stamps the current PROTOCOL_VERSION. */
export const envelope = (message) => ({
    version: PROTOCOL_VERSION,
    message,
});
//# sourceMappingURL=messages.js.map