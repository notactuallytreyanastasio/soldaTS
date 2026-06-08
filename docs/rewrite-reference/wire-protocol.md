# OpenSoldat Network Wire Protocol Specification

## Message IDs

All message types are identified by an 8-bit header field (`TMsgHeader.ID`). The following is the complete enumeration:

| ID | Name | Direction |
|---|---|---|
| 0 | MsgID_Custom | N/A |
| 2 | MsgID_HeartBeat | Server→Client |
| 3 | MsgID_ServerSpriteSnapshot | Server→Client |
| 4 | MsgID_ClientSpriteSnapshot | Client→Server |
| 5 | MsgID_BulletSnapshot | Bidirectional |
| 6 | MsgID_ChatMessage | Bidirectional |
| 7 | MsgID_ServerSkeletonSnapshot | Server→Client |
| 8 | MsgID_MapChange | Server→Client |
| 9 | MsgID_ServerThingSnapshot | Server→Client |
| 12 | MsgID_ThingTaken | Server→Client |
| 13 | MsgID_SpriteDeath | Server→Client |
| 15 | MsgID_PlayerInfo | Client→Server |
| 16 | MsgID_PlayersList | Server→Client |
| 17 | MsgID_NewPlayer | Server→Client |
| 18 | MsgID_ServerDisconnect | Server→Client |
| 19 | MsgID_PlayerDisconnect | Server→Client |
| 21 | MsgID_Delta_Movement | Server→Client |
| 25 | MsgID_Delta_Weapons | Server→Client |
| 26 | MsgID_Delta_Helmet | Server→Client |
| 29 | MsgID_Delta_MouseAim | Server→Client |
| 30 | MsgID_Ping | Server→Client |
| 31 | MsgID_Pong | Client→Server |
| 32 | MsgID_FlagInfo | Server→Client |
| 33 | MsgID_ServerThingMustSnapshot | Server→Client |
| 37 | MsgID_IdleAnimation | Server→Client |
| 41 | MsgID_ServerSpriteSnapshot_Major | Server→Client |
| 42 | MsgID_ClientSpriteSnapshot_Mov | Client→Server |
| 43 | MsgID_ClientSpriteSnapshot_Dead | Client→Server |
| 44 | MsgID_UnAccepted | Server→Client |
| 45 | MsgID_VoteOn | Server→Client |
| 46 | MsgID_VoteMap | Client→Server |
| 47 | MsgID_VoteMapReply | Server→Client |
| 48 | MsgID_VoteKick | Client→Server |
| 51 | MsgID_RequestThing | Client→Server |
| 52 | MsgID_ServerVars | Server→Client |
| 54 | MsgID_ServerSyncMsg | Server→Client |
| 55 | MsgID_ClientFreeCam | Bidirectional |
| 56 | MsgID_VoteOff | Server→Client |
| 57 | MsgID_FaeData | Bidirectional (anti-cheat) |
| 58 | MsgID_RequestGame | Client→Server |
| 60 | MsgID_ForcePosition | Server→Client |
| 61 | MsgID_ForceVelocity | Server→Client |
| 62 | MsgID_ForceWeapon | Server→Client |
| 63 | MsgID_ChangeTeam | Client→Server |
| 64 | MsgID_SpecialMessage | Server→Client |
| 65 | MsgID_WeaponActiveMessage | Server→Client |
| 68 | MsgID_JoinServer | Server→Client |
| 70 | MsgID_PlaySound | Server→Client |
| 71 | MsgID_SyncCvars | Server→Client |
| 72 | MsgID_VoiceData | Bidirectional |

## Message Structures

All messages begin with a `TMsgHeader` containing an 8-bit message ID. Sizes are in bytes. Packed records with no padding (FreePascal `packed record`).

### Core Header

```pascal
TMsgHeader = packed record
  ID: Byte;  // 1 byte
end;
```

### Heartbeat Message
**ID:** 2 | **Direction:** Server→Client | **Reliability:** Unreliable  
**Size:** 401 bytes

```pascal
TMsg_HeartBeat = packed record
  Header: TMsgHeader;                    // 1
  MapID: LongWord;                       // 4
  TeamScore: array[1..4] of Word;        // 8
  Active: array[1..MAX_PLAYERS] of Boolean;           // 32
  Kills: array[1..MAX_PLAYERS] of Word;               // 64
  Caps: array[1..MAX_PLAYERS] of Byte;                // 32
  Team: array[1..MAX_PLAYERS] of Byte;                // 32
  Deaths: array[1..MAX_PLAYERS] of Word;              // 64
  Ping: array[1..MAX_PLAYERS] of Byte;                // 32
  RealPing: array[1..MAX_PLAYERS] of Word;            // 64
  ConnectionQuality: array[1..MAX_PLAYERS] of Byte;   // 32
  Flags: array[1..MAX_PLAYERS] of Byte;               // 32
end;
```

### Server Sprite Snapshot (Full)
**ID:** 3 | **Direction:** Server→Client | **Reliability:** Unreliable  
**Size:** 55 bytes

```pascal
TMsg_ServerSpriteSnapshot = packed record
  Header: TMsgHeader;              // 1
  Num: Byte;                       // 1 (sprite number 1-MAX_SPRITES)
  Pos, Velocity: TVector2;         // 16 (TVector2 = 2×Single)
  MouseAimX, MouseAimY: SmallInt;  // 4
  Position: Byte;                  // 1
  Keys16: Word;                    // 2 (encoded controls)
  Look: Byte;                      // 1 (helmet, cigar flags)
  Vest: Single;                    // 4
  Health: Single;                  // 4
  AmmoCount, GrenadeCount: Byte;   // 2
  WeaponNum, SecondaryWeaponNum: Byte;  // 2
  ServerTicks: LongInt;            // 4
end;
```

Sent when: velocity delta > VELDELTA (0.27), health/position/keys/weapons/ammo/vest changes, or 30+ ticks since last full snapshot. Includes full weapon and equipment state.

### Server Sprite Snapshot (Major)
**ID:** 41 | **Direction:** Server→Client | **Reliability:** Unreliable  
**Size:** 31 bytes

```pascal
TMsg_ServerSpriteSnapshot_Major = packed record
  Header: TMsgHeader;              // 1
  Num: Byte;                       // 1
  Pos, Velocity: TVector2;         // 16
  Health: Single;                  // 4
  MouseAimX, MouseAimY: SmallInt;  // 4
  Position: Byte;                  // 1
  Keys16: Word;                    // 2
  ServerTicks: LongInt;            // 4
end;
```

Sent when: velocity delta > VELDELTA, 30+ ticks since movement update, position/health/keys/prone changes. Omits weapon/equipment/helmet state (uses deltas for those).

### Client Sprite Snapshot (Weapon/Equipment)
**ID:** 4 | **Direction:** Client→Server | **Reliability:** Unreliable  
**Size:** 6 bytes

```pascal
TMsg_ClientSpriteSnapshot = packed record
  Header: TMsgHeader;              // 1
  AmmoCount, SecondaryAmmoCount: Byte;   // 2
  WeaponNum, SecondaryWeaponNum: Byte;   // 2
  Position: Byte;                  // 1
end;
```

Sent when: weapon changes, ammo changes, or prone position toggles. Sent only on change.

### Client Sprite Snapshot (Movement)
**ID:** 42 | **Direction:** Client→Server | **Reliability:** Unreliable  
**Size:** 24 bytes

```pascal
TMsg_ClientSpriteSnapshot_Mov = packed record
  Header: TMsgHeader;              // 1
  Pos, Velocity: TVector2;         // 16
  Keys16: Word;                    // 2
  MouseAimX, MouseAimY: SmallInt;  // 4
  // ClientTicks NOT included in network struct
end;
```

Sent when: position delta > POSDELTA (60.0), velocity delta > VELDELTA (0.27), keys change, jetpack enabled, or mouse aim beyond MOUSEAIMDELTA (30) pixels. Firing window: suppressed if weapon has low fire interval (≤5 ticks) and ammo remaining.

### Client Sprite Snapshot (Dead)
**ID:** 43 | **Direction:** Client→Server | **Reliability:** Unreliable  
**Size:** 2 bytes

```pascal
TMsg_ClientSpriteSnapshot_Dead = packed record
  Header: TMsgHeader;              // 1
  CameraFocus: Byte;               // 1 (spectator camera target sprite)
end;
```

### Sprite Death
**ID:** 13 | **Direction:** Server→Client | **Reliability:** Unreliable  
**Size:** 198 bytes

```pascal
TMsg_SpriteDeath = packed record
  Header: TMsgHeader;              // 1
  Num, Killer, KillBullet, Where: Byte;  // 4
  Constraints: Byte;               // 1 (skeleton constraint flags)
  Pos, OldPos: array[1..16] of TVector2;  // 128 (skeleton at death)
  Health: Single;                  // 4
  OnFire: Byte;                    // 1
  RespawnCounter: SmallInt;        // 2
  ShotDistance, ShotLife: Single;  // 8
  ShotRicochet: Byte;              // 1
end;
```

Skeleton array indices 1-16 sent; client remaps to 1-20 (17-20 derived from 1,2,15,16).

### Server Sprite Delta (Movement)
**ID:** 21 | **Direction:** Server→Client | **Reliability:** Unreliable  
**Size:** 23 bytes

```pascal
TMsg_ServerSpriteDelta_Movement = packed record
  Header: TMsgHeader;              // 1
  Num: Byte;                       // 1
  Pos, Velocity: TVector2;         // 16
  Keys16: Word;                    // 2
  MouseAimX, MouseAimY: SmallInt;  // 4
  ServerTick: LongInt;             // 4
end;
```

Sent only to non-owner clients when: position delta > POSDELTA, velocity delta > VELDELTA, and keys changed. Receiver checks `LastHeartBeatCounter` to drop stale packets.

### Server Sprite Delta (Weapons)
**ID:** 25 | **Direction:** Server→Client | **Reliability:** Unreliable  
**Size:** 4 bytes

```pascal
TMsg_ServerSpriteDelta_Weapons = packed record
  Header: TMsgHeader;              // 1
  Num: Byte;                       // 1
  WeaponNum, SecondaryWeaponNum: Byte;   // 2
end;
```

Sent only to non-owner clients when: weapon changes.

### Server Sprite Delta (Helmet)
**ID:** 26 | **Direction:** Server→Client | **Reliability:** Unreliable  
**Size:** 3 bytes

```pascal
TMsg_ServerSpriteDelta_Helmet = packed record
  Header: TMsgHeader;              // 1
  Num: Byte;                       // 1
  WearHelmet: Byte;                // 1
end;
```

### Server Sprite Delta (Mouse Aim)
**ID:** 29 | **Direction:** Server→Client | **Reliability:** Unreliable  
**Size:** 5 bytes

```pascal
TMsg_ServerSpriteDelta_MouseAim = packed record
  Header: TMsgHeader;              // 1
  Num: Byte;                       // 1
  MouseAimX, MouseAimY: SmallInt;  // 4
end;
```

Sent to all non-owner clients every frame if receiver visible.

### Server Skeleton Snapshot (Dead Sprite)
**ID:** 7 | **Direction:** Server→Client | **Reliability:** Unreliable  
**Size:** 5 bytes

```pascal
TMsg_ServerSkeletonSnapshot = packed record
  Header: TMsgHeader;              // 1
  Num: Byte;                       // 1
  RespawnCounter: SmallInt;        // 2
end;
```

Sent when: sprite transitions to DeadMeat state. Skeleton positions transmitted via SpriteDeath message.

### Bullet Snapshot (Server→Client)
**ID:** 5 | **Direction:** Server→Client | **Reliability:** Unreliable  
**Size:** 24 bytes

```pascal
TMsg_BulletSnapshot = packed record
  Header: TMsgHeader;              // 1
  Owner, WeaponNum: Byte;          // 2
  Pos, Velocity: TVector2;         // 16
  Seed: Word;                      // 2 (RNG seed for spread)
  Forced: Boolean;                 // 1
end;
```

Sent to all clients except owner (unless Forced=True). Forced bullets bypass ammo decrement. Not sent if bullet outside receiver's visibility radius.

**Client-predicted creation:** Clients locally create bullets instantly when they fire; server snapshot confirms/corrects position. Uses Seed to reconstruct exact projectile spread (Eagle 2-pellet, Shotgun 6-pellet).

### Bullet Snapshot (Client→Server)
**ID:** 5 | **Direction:** Client→Server | **Reliability:** Unreliable  
**Size:** 25 bytes

```pascal
TMsg_ClientBulletSnapshot = packed record
  Header: TMsgHeader;              // 1
  WeaponNum: Byte;                 // 1
  Pos, Velocity: TVector2;         // 16
  Seed: Word;                      // 2
  ClientTicks: LongInt;            // 4
end;
```

Contains client's local tick count (used for lag compensation). Server calculates `PingTicksB = ServerTickCounter - ClientTicks`, clamped to [0, MAX_OLDPOS=125].

**Anti-duplicate:** Server maintains ring buffer of 20 recent bullet seeds (`BULLETCHECKARRAYSIZE`). Duplicate seeds discarded.

**Client spread reconstruction:** For Eagle and Shotgun, client extracts original spread from Seed via `RandSeed := Seed; pellet_offset := (Random * 2 - 1) * BulletSpread`.

### Request Game (Join)
**ID:** 58 | **Direction:** Client→Server | **Reliability:** Reliable  
**Size:** ~76 bytes

```pascal
TMsg_RequestGame = packed record
  Header: TMsgHeader;              // 1
  Version: array[0..3] of char;    // 4 (e.g. "1.3" with null terminator)
  Forwarded: Byte;                 // 1
  HaveAntiCheat: Byte;             // 1 (ACTYPE_NONE=0 or ACTYPE_FAE=1)
  HardwareID: string[11];          // 12 (Pascal string: len byte + 11 chars)
  Password: array[0..24] of char;  // 25
end;
```

Triggers full cvar sync + player list + FAE challenge (if AC required).

### Player Info
**ID:** 15 | **Direction:** Client→Server | **Reliability:** Reliable  
**Size:** 81 bytes

```pascal
TMsg_PlayerInfo = packed record
  Header: TMsgHeader;              // 1
  Name: array[0..23] of char;      // 24 (PLAYERNAME_CHARS)
  Look: Byte;                      // 1 (hair style, head cap, chain bits)
  Team: Byte;                       // 1
  ShirtColor, PantsColor, SkinColor, HairColor, JetColor: LongWord;  // 20
  GameModChecksum: TSHA1Digest;    // 20 (SHA-1 hash)
  CustomModChecksum: TSHA1Digest;  // 20
end;
```

**Look field layout:** `B1`=HairStyle 1, `B2`=HairStyle 2, `B3`=HairStyle 3, `B4`=HairStyle 4, `B5`=Helm, `B6`=Cap, `B7`=Chain 1, `B8`=Chain 2.

After this message, server creates sprite and sends full state to all players.

### Players List (Initial State)
**ID:** 16 | **Direction:** Server→Client | **Reliability:** Reliable  
**Size:** 1,394 bytes (32 players × ~43 bytes + header)

```pascal
TMsg_PlayersList = packed record
  Header: TMsgHeader;              // 1
  ModName: array[0..63] of char;   // 64 (MAPNAME_CHARS)
  ModChecksum: TSHA1Digest;        // 20
  MapName: array[0..63] of char;   // 64
  MapChecksum: TSHA1Digest;        // 20
  Players: Byte;                   // 1
  Name: array[1..32] of array[0..23] of char;     // 768
  ShirtColor, PantsColor, SkinColor, HairColor, JetColor: array[1..32] of LongWord;  // 160
  Team: array[1..32] of Byte;      // 32
  PredDuration: array[1..32] of Byte;  // 32 (predator bonus in seconds)
  Look: array[1..32] of Byte;      // 32
  Pos: array[1..32] of TVector2;   // 256 (32×8)
  Vel: array[1..32] of TVector2;   // 256
  SteamID: array[1..32] of UInt64; // 256
  CurrentTime: Integer;            // 4 (time limit counter)
  ServerTicks: LongInt;            // 4
  AntiCheatRequired: Boolean;      // 1
end;
```

Sent immediately after RequestGame accepted. Contains full roster snapshot. Inactive players have Name="0 " (string with space).

### New Player Notification
**ID:** 17 | **Direction:** Server→Client | **Reliability:** Reliable  
**Size:** 58 bytes

```pascal
TMsg_NewPlayer = packed record
  Header: TMsgHeader;              // 1
  Num: Byte;                       // 1 (sprite number)
  AdoptSpriteID: Byte;             // 1 (1 if this is local player)
  JoinType: Byte;                  // 1 (JOIN_NORMAL=0 or JOIN_SILENT=1)
  Name: array[0..23] of char;      // 24
  ShirtColor, PantsColor, SkinColor, HairColor, JetColor: LongWord;  // 20
  Team: Byte;                      // 1
  Look: Byte;                      // 1
  Pos: TVector2;                   // 8
  SteamID: UInt64;                 // 8
end;
```

Sent to all players when someone joins. `AdoptSpriteID=1` signals receiver this is their own sprite.

### Unaccepted Connection
**ID:** 44 | **Direction:** Server→Client | **Reliability:** Reliable  
**Size:** Variable

```pascal
TMsg_UnAccepted = packed record
  Header: TMsgHeader;              // 1
  State: Byte;                     // 1 (OK=1, WRONG_VERSION=2, etc.)
  Version: array[0..3] of char;    // 4
  Text: array[0..0] of char;       // Variable (null-terminated reason)
end;
```

Connection immediately closed after send. State codes:
- `OK = 1`
- `WRONG_VERSION = 2`
- `WRONG_PASSWORD = 3`
- `BANNED_IP = 4`
- `SERVER_FULL = 5`
- `INVALID_HANDSHAKE = 8`
- `WRONG_CHECKSUM = 9`
- `ANTICHEAT_REQUIRED = 10`
- `ANTICHEAT_REJECTED = 11`
- `STEAM_ONLY = 12`

### Player Disconnect
**ID:** 19 | **Direction:** Server→Client | **Reliability:** Reliable  
**Size:** 3 bytes

```pascal
TMsg_PlayerDisconnect = packed record
  Header: TMsgHeader;              // 1
  Num: Byte;                       // 1
  Why: Byte;                       // 1 (kick reason code)
end;
```

Kick reason codes: KICK_UNKNOWN=0, KICK_NORESPONSE=1, KICK_CHEAT=8, KICK_VOTED=10, KICK_AC=11, etc.

### Chat Message
**ID:** 6 | **Direction:** Bidirectional | **Reliability:** Reliable  
**Size:** 4 + (2×string length) bytes

```pascal
TMsg_StringMessage = packed record
  Header: TMsgHeader;              // 1
  Num: Byte;                       // 1 (sender sprite, 255=system)
  MsgType: Byte;                   // 1 (MSGTYPE_CMD=0, PUB=1, TEAM=2, RADIO=3)
  Text: array[0..0] of WideChar;   // Variable (null-terminated UTF-16)
end;
```

Message limited to 100 characters (DoS protection). For team/radio messages, filtered by sender's team.

### Ping / Pong
**ID:** 30/31 | **Direction:** Server→Client / Client→Server | **Reliability:** Reliable  
**Size:** 3 bytes each

```pascal
TMsg_Ping = packed record
  Header: TMsgHeader;              // 1
  PingTicks: Byte;                 // 1 (current RTT estimate)
  PingNum: Byte;                   // 1 (sequence 1-8, wraps)
end;

TMsg_Pong = packed record
  Header: TMsgHeader;              // 1
  PingNum: Byte;                   // 1 (echo of PingNum)
end;
```

Server samples 8 outstanding pings. Client latency = `(current_tick - ping_time[PingNum]) * (1000/60) ms`.

### Server Variables
**ID:** 52 | **Direction:** Server→Client | **Reliability:** Reliable  
**Size:** ~2,100 bytes

```pascal
TMsg_ServerVars = packed record
  Header: TMsgHeader;              // 1
  Damage: array[1..ORIGINAL_WEAPONS] of Single;            // 256
  Ammo: array[1..ORIGINAL_WEAPONS] of Byte;                // 64
  ReloadTime: array[1..ORIGINAL_WEAPONS] of Word;          // 128
  Speed: array[1..ORIGINAL_WEAPONS] of Single;             // 256
  BulletStyle: array[1..ORIGINAL_WEAPONS] of Byte;         // 64
  StartUpTime: array[1..ORIGINAL_WEAPONS] of Word;         // 128
  Bink: array[1..ORIGINAL_WEAPONS] of SmallInt;            // 128
  FireInterval: array[1..ORIGINAL_WEAPONS] of Word;        // 128
  MovementAcc: array[1..ORIGINAL_WEAPONS] of Single;       // 256
  BulletSpread: array[1..ORIGINAL_WEAPONS] of Single;      // 256
  Recoil: array[1..ORIGINAL_WEAPONS] of Word;              // 128
  Push: array[1..ORIGINAL_WEAPONS] of Single;              // 256
  InheritedVelocity: array[1..ORIGINAL_WEAPONS] of Single; // 256
  ModifierHead: array[1..ORIGINAL_WEAPONS] of Single;      // 256
  ModifierChest: array[1..ORIGINAL_WEAPONS] of Single;     // 256
  ModifierLegs: array[1..ORIGINAL_WEAPONS] of Single;      // 256
  NoCollision: array[1..ORIGINAL_WEAPONS] of Byte;         // 64
  WeaponActive: array[1..MAIN_WEAPONS] of Byte;            // 11
end;
```

ORIGINAL_WEAPONS=64, MAIN_WEAPONS=11. Sent on join and when cvars change.

### Sync Cvars
**ID:** 71 | **Direction:** Server→Client | **Reliability:** Reliable  
**Size:** Variable

```pascal
TMsg_ServerSyncCvars = packed record
  Header: TMsgHeader;              // 1
  ItemCount: Byte;                 // 1
  Data: array[0..0] of Byte;       // Variable (bit-packed cvar updates)
end;
```

Bitstream-encoded cvar values (int32/single/boolean/string). Each item: cvar_index (u8) + value. Sent on join (full sync) and when cvars change (partial).

### Force Commands
**ID:** 60/61/62 | **Direction:** Server→Client | **Reliability:** Reliable

```pascal
TMsg_ForcePosition = packed record
  Header: TMsgHeader;              // 1
  Pos: TVector2;                   // 8
  PlayerID: Byte;                  // 1
end;  // 10 bytes

TMsg_ForceVelocity = packed record
  Header: TMsgHeader;              // 1
  Vel: TVector2;                   // 8
  PlayerID: Byte;                  // 1
end;  // 10 bytes

TMsg_ForceWeapon = packed record
  Header: TMsgHeader;              // 1
  WeaponNum, SecondaryWeaponNum: Byte;  // 2
  AmmoCount, SecAmmoCount: Byte;   // 2
end;  // 6 bytes
```

Used for server-side position/velocity/weapon correction/synchronization. Triggers client-side update without re-predicting.

### Thing Snapshot (Flag/Bonus)
**ID:** 9 | **Direction:** Server→Client | **Reliability:** Unreliable  
**Size:** 97 bytes

```pascal
TMsg_ServerThingSnapshot = packed record
  Header: TMsgHeader;              // 1
  Num, Owner, Style, HoldingSprite: Byte;  // 4
  Pos, OldPos: array[1..4] of TVector2;    // 64 (physics history ring)
end;
```

Position history for physics. Sent when thing moves.

### Thing Must Snapshot (Guaranteed)
**ID:** 33 | **Direction:** Server→Client | **Reliability:** Reliable  
**Size:** 101 bytes

```pascal
TMsg_ServerThingMustSnapshot = packed record
  Header: TMsgHeader;              // 1
  Num, Owner, Style, HoldingSprite: Byte;  // 4
  Pos, OldPos: array[1..4] of TVector2;    // 64
  Timeout: LongInt;                // 4
end;
```

Used on player join to transmit all active things. Timeout is despawn countdown.

### Thing Taken
**ID:** 12 | **Direction:** Server→Client | **Reliability:** Unreliable  
**Size:** 5 bytes

```pascal
TMsg_ServerThingTaken = packed record
  Header: TMsgHeader;              // 1
  Num, Who: Byte;                  // 2 (thing ID, taker sprite)
  Style, AmmoCount: Byte;          // 2
end;
```

### FAE Anti-Cheat Challenge/Response
**ID:** 57 | **Direction:** Bidirectional | **Reliability:** Reliable

```pascal
TMsg_FaeChallenge = packed record
  Header: TMsgHeader;              // 1
  InOrder: Byte;                   // 1
  Challenge: TFaeChallenge;        // ~200 (packed attestation struct)
end;

TMsg_FaeResponse = packed record
  Header: TMsgHeader;              // 1
  Response: TFaeResponseBox;       // ~500 (packed attestation response)
end;
```

Challenge sent during handshake (MsgID_RequestGame→PlayerInfo). Response validated with remote attestation. If validation fails or response indicates cheat, player kicked with ANTICHEAT_REJECTED.

## Client Input Model

### Keys16 Bitmap Layout

Word (16-bit) encoding sprite controls sent to server:

```
Bit  Name           Control
B1   Left           A/Left arrow
B2   Right          D/Right arrow
B3   Up             W/Up arrow
B4   Down           S/Down arrow
B5   Fire           Mouse click / Ctrl
B6   Jetpack        Space
B7   ThrowNade      G
B8   ChangeWeapon   Q (also set if BodyAnimation.ID == Change.ID)
B9   ThrowWeapon    E (also set if BodyAnimation.ID == ThrowWeapon.ID)
B10  Reload         R
B11  FlagThrow      F
```

**Mouse Aim Encoding:** SmallInt (signed 16-bit) `MouseAimX`, `MouseAimY`. Represents pixel offsets from center screen (-32768 to 32767). Sent in ClientSpriteSnapshot_Mov. Delta-compressed: if weapon has low fire interval and round(mx/my) matches old value ±MOUSEAIMDELTA (30), not sent.

## Snapshot / Delta Model

**Three-tier state transmission:**

1. **Full Snapshot (ServerSpriteSnapshot, ID=3):** Sent on demand or every 30 ticks. Includes: Pos, Vel, Health, Vest, Equipment, Keys, MouseAim, Helmet, Cigar, Weapon/Ammo, Position.

2. **Major Snapshot (ServerSpriteSnapshot_Major, ID=41):** Sent when velocity/position/health/prone changes. Omits equipment—equipment changes via separate delta (ID=25). **No weapon/ammo data.**

3. **Deltas (IDs 21, 25, 26, 29):** Incremental updates for movement, weapons, helmet, and mouse aim. Each delta includes just the changed field(s).

**Server send cadence:**
- **Full snapshot:** When velocity delta > VELDELTA (0.27), or 30+ ticks since last snapshot, or health/position/weapons/ammo/vest changed.
- **Major snapshot:** When velocity delta > VELDELTA, or 30+ ticks since movement update, or position/health/prone changed.
- **Movement delta:** Visible receivers, only if position delta > POSDELTA (60.0) OR velocity delta > VELDELTA.
- **Weapon delta:** Only when weapon changes.
- **Helmet delta:** Only when helmet state changes.
- **Mouse aim delta:** Every frame to visible non-owner clients.

**Client send cadence:**
- **Weapon snapshot (ID=4):** Only when weapon/ammo/prone changes.
- **Movement snapshot (ID=42):** When position delta > POSDELTA OR velocity delta > VELDELTA OR keys change OR jetpack enabled OR mouse aim delta > MOUSEAIMDELTA. Suppressed if weapon fire interval ≤5 ticks and ammo > 0 (to reduce spam during sustained fire).
- **Dead snapshot (ID=43):** When dead, if camera target changes.

## Lag Compensation

**Ping-based lookback ring:**

`PingTicksB = ServerTickCounter - ClientTicks` (clamped to [0, MAX_OLDPOS=125])

Client sends `ClientTicks` in bullet snapshot; server calculates how many frames back the client's state was. Used to create bullets at server-side historical sprite position to simulate client-side prediction.

**OldSpritePos ring:** Server stores sprite snapshots for 125 frames of history. When processing bullets, server can rewind to `sprite.Pos[MainTickCounter - PingTicksB]` to collision-check against historical position.

**Replay simulation on client:** Client receives bullet snapshot with Seed. For multi-pellet weapons (Eagle 2, Shotgun 6), client re-executes RNG from Seed to get exact pellet offsets, then fast-forwards bullet `PingAdd` frames (combined ping of sender + receiver) to match server's current time.

## GameNetworkingSockets Reliability Channels

**All messages use a single implicit channel (k_nSteamNetworkingSend_Unreliable or k_nSteamNetworkingSend_Reliable).**

- **Unreliable:** Sprite snapshots, deltas, bullets, heartbeat, pings.
- **Reliable:** Connection setup (RequestGame, PlayerInfo, PlayersList), disconnects, chat, weapon/cvar changes, forced commands.

GNS handles packet retransmission, reordering, and ACKs internally. No application-level acks.

## Connection Handshake Sequence

1. **Client initiates TCP-like connection** via `ConnectByIPAddress()` with IP_AllowWithoutAuth=1.
2. **Server accepts** on listening socket, transitions to Connected state, creates TPlayer object.
3. **Client sends MsgID_RequestGame (ID=58)** with version, HWID, password, AC capability.
4. **Server validates:** version, password, IP ban, hardware ban, HWID checksum.
5. **If AC required (ac_enable cvar):** Server sends **MsgID_FaeData challenge (ID=57)** (reliable). Client calls `FaeAuthSync()` to generate response. Client sends **MsgID_FaeData response (ID=57)** (reliable). Server validates with `FaeCheck()`.
6. **If accepted:** Server sends **MsgID_SyncCvars** (full sync, reliable) → **MsgID_PlayersList (ID=16)** (reliable, full roster).
7. **Client receives PlayersList,** sends **MsgID_PlayerInfo (ID=15)** (reliable) with name, colors, look, team, mod checksums.
8. **Server creates sprite,** sends **MsgID_NewPlayer (ID=17)** (reliable) to all. Client now active in game.
9. **Ongoing:** Heartbeat, snapshots, deltas, bullets via unreliable channel. Pings every ~1 second (reliable).

## Snapshot Trigger Thresholds

| Parameter | Value | Use |
|---|---|---|
| POSDELTA | 60.0 | Position delta threshold for movement send |
| VELDELTA | 0.27 | Velocity delta threshold for movement send |
| MOUSEAIMDELTA | 30 | Mouse aim delta in pixels (SmallInt) |
| FIREINTERVAL_NET | 5 | Weapon fire interval threshold for mouse aim suppression |
| MAX_OLDPOS | 125 | Bullet lag-compensation lookback frames |
| BULLETCHECKARRAYSIZE | 20 | Ring buffer size for duplicate bullet detection |

## Wire Format Critical Notes

1. **Packed records:** All TMsg_* structures are `packed record` with no padding. Field order is byte-significant for the wire layout.

2. **TVector2 encoding:** Two 32-bit IEEE floats (8 bytes total), little-endian on x86.

3. **Weapon scrambling:** The `TGun` structure used in bullets contains embedded fields (BulletStyle, Speed, Damage, etc.) in a specific order that must match struct memory layout. Client reconstructs weapon parameters from wire BulletStyle field.

4. **Spread reconstruction:** Bullet Seed encodes exact RNG state. To reconstruct Eagle/Shotgun pellet positions, set `RandSeed := BulletSnap.Seed` then call `Random()` for each pellet in identical order.

5. **String encoding:** Pascal strings (array[0..N] of char) are null-terminated on wire. WideChar strings (chat) are UTF-16 LE.

6. **Checksum:** TSHA1Digest is 20 raw bytes (160-bit hash). For mod/map validation, client computes SHA-1 and compares byte-for-byte.

7. **Color format:** LongWord with alpha overlay: `$FFBBGGRR` (ARGB, little-endian as UInt32). Spectators have ShirtColor forced to `$FFFFFF` (white).

8. **Endianness:** All multi-byte fields are little-endian (Intel x86/x64 native). Network byte order is host byte order.

9. **Look field encoding:** Helmet/hair/cigar/cap/chain state compressed into single byte with bit flags B1–B8 for styling options.

10. **Connection lifecycle:** Player object allocated on connect, lifetime = connection lifetime. Sprite allocated on PlayerInfo, deallocated on disconnect. Player.SpriteNum=0 indicates pre-game handshake phase.