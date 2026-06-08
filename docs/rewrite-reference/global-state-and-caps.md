# OpenSoldat Global World-State Model: Authoritative Reference Specification

## Overview

This document specifies the global world-state model of OpenSoldat, including hard caps, indexing conventions, and subsystem couplings. All values are sourced from the FreePascal codebase and reflect the current implementation as the behavioral contract for any future rewrite.

---

## 1. Global Arrays and Variables: Complete Declaration

### 1.1 Sprite Array (Players and Spectators)

**Declaration:** `shared/Game.pas:114`
```pascal
Sprite: array[1..MAX_SPRITES] of TSprite;  // player, game handling sprite
```

**Type Definition:** `shared/mechanics/Sprites.pas:107`
- Object containing: Active flag, Position, Velocity, Health, Weapon state, Animation state, Skeleton (ParticleSystem), Control inputs, AI brain data (for bots), Team, Player object reference, etc.

**Capacity:** `shared/mechanics/Sprites.pas:19`
```pascal
MAX_SPRITES = MAX_PLAYERS;  // Defined as 32 in shared/network/Net.pas:104
```

**Indexing:** 1-based, 1..32. Index 0 **not used** (CRITICAL: comment at Game.pas:111-113 warns against changing to 0-based due to client frozen bullets bug).

**Sentinel:** `SpriteNum = 0` in associated TPlayer object means sprite slot is unjoined/available (shared/network/NetworkServerConnection.pas:196, Net.pas:274).

---

### 1.2 Bullet Array

**Declaration:** `shared/Game.pas:115`
```pascal
Bullet: array[1..MAX_BULLETS] of TBullet;  // bullet game handling sprite
```

**Type Definition:** `shared/mechanics/Bullets.pas:9`
- Object containing: Active flag, Position, Velocity, Owner (sprite index), Weapon ID, TimeOut, hit detection state, SpriteCollisions set

**Capacity:** `shared/mechanics/Sprites.pas:20`
```pascal
MAX_BULLETS = 254;
```

**Indexing:** 1-based, 1..254.

**Sentinel:** `Active = False` means slot is unused.

---

### 1.3 Spark Array (Client-Side Only)

**Declaration:** `shared/Game.pas:117`
```pascal
{$IFNDEF SERVER}
Spark: array[1..MAX_SPARKS] of TSpark;  // spark game handling sprite
{$ENDIF}
```

**Type Definition:** `shared/mechanics/Sparks.pas:8`
- Object containing: Active flag, Position, Velocity, Life (remaining ticks), Style, Owner

**Capacity:** `shared/mechanics/Sprites.pas:21`
```pascal
MAX_SPARKS = 558;
```

**Indexing:** 1-based, 1..558.

**Sentinel:** `Active = False` means slot is unused.

---

### 1.4 Thing Array (Pickups, Flags, Stationary Objects)

**Declaration:** `shared/Game.pas:119`
```pascal
Thing: array[1..MAX_THINGS] of TThing;  // thing game handling sprite
```

**Type Definition:** `shared/mechanics/Things.pas:13`
- Object containing: Active flag, Style (object type), Position, Velocity, Owner, HoldingSprite (who picked it up), Skeleton (ParticleSystem), timeout, interest timer

**Capacity:** `shared/mechanics/Sprites.pas:22`
```pascal
MAX_THINGS = 90;
```

**Indexing:** 1-based, 1..90.

**Sentinel:** `Active = False` means slot is unused.

---

### 1.5 Particle System (Physics Skeleton)

**Declaration:** `shared/Game.pas:38-42`
```pascal
SpriteParts, BulletParts, SparkParts,
GostekSkeleton, BoxSkeleton, FlagSkeleton, ParaSkeleton, StatSkeleton,
RifleSkeleton10, RifleSkeleton11, RifleSkeleton18, RifleSkeleton22,
RifleSkeleton28, RifleSkeleton36, RifleSkeleton37, RifleSkeleton39,
RifleSkeleton43, RifleSkeleton50, RifleSkeleton55: ParticleSystem;
```

**Type Definition:** `shared/Parts.pas:41-69`
```pascal
ParticleSystem = object
  Active: array[1..NUM_PARTICLES] of Boolean;
  Pos: array[1..NUM_PARTICLES] of TVector2;
  Velocity: array[1..NUM_PARTICLES] of TVector2;
  OldPos: array[1..NUM_PARTICLES] of TVector2;
  Forces: array[1..NUM_PARTICLES] of TVector2;
  OneOverMass: array[1..NUM_PARTICLES] of Single;
  TimeStep: Single;
  Gravity, VDamping, EDamping: Single;
  ConstraintCount: Integer;
  PartCount: Integer;
  Constraints: array[1..NUM_PARTICLES] of Constraint;
end;
```

**Capacity:** `shared/Parts.pas:31`
```pascal
NUM_PARTICLES = 560;
```

**Key Systems:**
- `SpriteParts`: Master particle system for all player skeletons (1-to-1 indexed with Sprite[])
- `BulletParts`: Particles for bullet trails and effects (indexed by weapon skeleton type)
- `SparkParts`: Particles for sparks (indexed by Spark[])
- `GostekSkeleton`: Template skeleton for players, cloned into each Sprite[i].Skeleton
- Other weapon skeletons: Rifle-type weapon visual templates

**Indexing:** Particle positions tracked by `Pos[i]` where `i = 1..NUM_PARTICLES`. For sprites: `SpriteParts.Pos[SpriteIndex]` maps to Sprite[SpriteIndex].

**Sentinel:** `Active[i] = False` means particle slot unused.

---

### 1.6 PolyMap (Static Map Geometry)

**Declaration:** `shared/Game.pas:93`
```pascal
Map: TPolyMap;
```

**Type Definition:** `shared/PolyMap.pas` (Polygon-based collision geometry)
- Contains: Polygons, spawn points, waypoints, polygon types, collision data

**Indexing:** Map polygons indexed 0-based internally (collision queries use polygon indices).

---

### 1.7 Tick Counters

**Declaration:** `shared/Game.pas:31-34`
```pascal
Ticks, TicksPerSecond: Integer;
Frames, FramesPerSecond, TickTime, TickTimelast: Integer;
GOALTICKS: Integer = DEFAULT_GOALTICKS;
```

**Values:** `shared/Constants.pas:27`
```pascal
DEFAULT_GOALTICKS = 60;
```

**Semantics:** Server and client tick at 60 Hz (ticks/second). GOALTICKS can be reduced for bullet-time effects (Game.pas:272: `GOALTICKS div 3 = 20`).

---

### 1.8 Position Interpolation Buffer

**Declaration:** `shared/Game.pas:67`
```pascal
OldSpritePos: array[1..MAX_SPRITES, 0..MAX_OLDPOS] of TVector2;
```

**Capacity:** `shared/Constants.pas:223`
```pascal
MAX_OLDPOS = 125;
```

**Purpose:** Client-side position history for interpolation and lag compensation. Stores up to 126 frames (0..125) of historical sprite positions.

---

### 1.9 Weapon Selection State

**Declaration:** `shared/Game.pas:86`
```pascal
WeaponSel: array[1..MAX_SPRITES, 1..MAIN_WEAPONS] of Byte;
```

**Purpose:** Per-sprite weapon availability (advance mode). Bitmask or count of available weapons.

---

### 1.10 Team and Scoring State

**Declarations:** `shared/Game.pas:88-90`
```pascal
TeamScore: array[0..5] of Integer;      // Score for each team (0=unused, 1..4=teams)
TeamFlag: array[0..4] of Integer;       // Flag thing index for each team (CTF/Infiltration)
TeamAliveNum: array[0..5] of Byte;      // Count of alive players per team (server)
TeamPlayersNum: array[0..4] of Byte;    // Count of active players per team (client)
```

**Indexing:** Team arrays 0-indexed for compatibility (0=unused, 1=TEAM_ALPHA, 2=TEAM_BRAVO, 3=TEAM_CHARLIE, 4=TEAM_DELTA, 5=TEAM_SPECTATOR for TeamAliveNum).

---

### 1.11 Player Sorting

**Declarations:** `shared/Game.pas:103-105`
```pascal
SortedPlayers: array[1..MAX_SPRITES] of TKillSort;
{$IFNDEF SERVER}
SortedTeamScore: array[1..MAX_SPRITES] of TKillSort;
{$ENDIF}
```

**Type:** `shared/Game.pas:22-27`
```pascal
TKillSort = record
  Kills, Deaths: Integer;
  Flags: Byte;
  PlayerNum: Integer;
  Color: LongWord;
end;
```

**Purpose:** Leaderboard sorted by flags, kills, deaths. Updated each frame (Game.pas:729).

---

### 1.12 Voting System State

**Declarations:** `shared/Game.pas:122-132`
```pascal
VoteActive: Boolean = False;
VoteType: Byte = 0;
VoteTarget: string = '';
VoteStarter: string = '';
VoteReason: string = '';
VoteTimeRemaining: Integer = -1;
VoteNumVotes: Byte = 0;
VoteMaxVotes: Byte = 0;
VoteHasVoted: array[1..MAX_SPRITES] of Boolean;
VoteCooldown: array[1..MAX_SPRITES] of Integer;
```

**Constants:** `shared/Constants.pas:254-255`
```pascal
DEFAULT_VOTE_TIME = MINUTE * 2;      // 120 ticks
DEFAULT_VOTING_TIME = SECOND * 20;   // 1200 ticks
```

---

## 2. Hard Caps (Constraints That Cannot Be Silently Changed)

### 2.1 Player/Sprite Cap

| Constant | Value | File:Line | Usage |
|----------|-------|-----------|-------|
| `MAX_PLAYERS` | 32 | shared/network/Net.pas:104 | Net protocol, heartbeat arrays, player loops |
| `MAX_SPRITES` | 32 (= MAX_PLAYERS) | shared/mechanics/Sprites.pas:19 | Game state arrays, all subsystems |

**Wire Protocol Impact:** TMsg_HeartBeat (Net.pas:354) contains `Active[1..32]`, `Kills[1..32]`, `Team[1..32]`, etc. Changing this breaks demo replay, network protocol, and all saved game state.

**Script API Impact:** ScriptPlayers.pas enforces `ID must be from 1 to MAX_SPRITES` and `if (ID > MAX_PLAYERS) or (ID = 0)`.

---

### 2.2 Bullet Cap

| Constant | Value | File:Line | Usage |
|----------|-------|-----------|-------|
| `MAX_BULLETS` | 254 | shared/mechanics/Sprites.pas:20 | Bullet array, network bullets snapshot |

**Rationale:** Byte (0-255) stores bullet owner (Bullets.pas:16: `Owner: Byte`). Max 254 allows index 255 as sentinel value.

**Script API Impact:** ScriptMap.pas enforces `if (ID > MAX_BULLETS) or (ID = 0)`.

---

### 2.3 Thing Cap

| Constant | Value | File:Line | Usage |
|----------|-------|-----------|-------|
| `MAX_THINGS` | 90 | shared/mechanics/Sprites.pas:22 | Thing array, pickups, flags, stationary guns |

**Script API Impact:** ScriptMap.pas enforces `if (ID > MAX_THINGS) or (ID = 0)`.

---

### 2.4 Spark Cap

| Constant | Value | File:Line | Usage |
|----------|-------|-----------|-------|
| `MAX_SPARKS` | 558 | shared/mechanics/Sprites.pas:21 | Client-side spark effects |

**Impact:** Client-only (no network constraint), but affects visual fidelity.

---

### 2.5 Particle System Cap

| Constant | Value | File:Line | Usage |
|----------|-------|-----------|-------|
| `NUM_PARTICLES` | 560 | shared/Parts.pas:31 | ParticleSystem.Active[], ParticleSystem.Pos[] |

**Note:** NUM_PARTICLES (560) > MAX_SPARKS (558), allows 2 buffer particles.

---

### 2.6 Weapon Count

| Constant | Value | File:Line | Usage |
|----------|-------|-----------|-------|
| `ORIGINAL_WEAPONS` | (varies) | shared/Weapons.pas | Network ServerVars message weapon arrays |
| `MAIN_WEAPONS` | (varies) | shared/Constants.pas | Limbo menu, weapon selection |
| `PRIMARY_WEAPONS` | (varies) | Weapons.pas | First N weapons |
| `SECONDARY_WEAPONS` | (varies) | Weapons.pas | Secondary/tertiary weapon count |

**Wire Protocol:** TMsg_ServerVars (Net.pas:402-420) contains fixed arrays `Damage[1..ORIGINAL_WEAPONS]`, etc. Changing weapon count breaks network protocol.

---

## 3. 1-Based Indexing Convention

### 3.1 Core World-State Objects

All major game object arrays use **1-based indexing** with **index 0 reserved as sentinel/uninitialized**:

```
Sprite[1..MAX_SPRITES]      : Index 0 invalid (see Game.pas:111-113)
Bullet[1..MAX_BULLETS]      : Index 0 unused
Thing[1..MAX_THINGS]        : Index 0 unused
Spark[1..MAX_SPARKS]        : Index 0 unused
SpriteParts.Pos[1..560]     : Index 0 unused
```

### 3.2 Sentinel Values and "Not Joined" Convention

**SpriteNum = 0** indicates:
- Player exists (TPlayer object allocated)
- **But sprite is not yet in the game world** (no Sprite[] slot assigned)
- Used during connection handshake before sprite spawning
- See: Net.pas:274, NetworkServerConnection.pas:196, NetworkServerMessages.pas usage

**Active = False** indicates:
- Sprite/Bullet/Thing/Spark slot is unused and available for reuse
- Does **not** indicate a pending join; merely an empty slot

---

## 4. Protocol and Format Constraints

### 4.1 Network Wire Protocol (Unbreakable Constraints)

**TMsg_HeartBeat** (Net.pas:354-367)
- Hardcoded arrays `Active[1..MAX_PLAYERS]`, `Kills[1..MAX_PLAYERS]`, `Team[1..MAX_PLAYERS]`, `Ping[1..MAX_PLAYERS]`
- Sent every heartbeat tick
- MAX_PLAYERS = 32 is baked into every network message

**TMsg_ServerSpriteSnapshot** (Net.pas:372-385)
- `Num: Byte` (0-255) = sprite index (1..32)
- Contains position, velocity, weapon state
- Sent per-sprite per-tick

**TMsg_BulletSnapshot** (Net.pas:455-462)
- `Owner: Byte` = sprite index (1..32, 0=sentinel)
- `WeaponNum: Byte` = weapon ID

**TMsg_ServerVars** (Net.pas:399-420)
- Weapon array `Damage[1..ORIGINAL_WEAPONS]` fixed size
- Sent once per connection

**Demo Format** (Demo.pas:22-33)
- TDemoHeader contains magic 'SOLDEM'
- Version and TicksNum recorded
- Any change to world-state array sizes breaks demo playback

### 4.2 Demo Playback Constraints

**Demo Recorder** (Demo.pas:175-188)
- Uses `Sprite[MAX_SPRITES]` as demo player (index 32)
- Fails if `Sprite[MAX_SPRITES].Active` is true
- Cannot record with >31 human players (Game.pas: line 185 comment)

---

## 5. Script API Constraints (Game Contracts)

### 5.1 Sprite/Player Access

**File:** `server/scriptcore/ScriptPlayers.pas`

```pascal
if (ID > MAX_PLAYERS) or (ID = 0) then
  raise Exception.Create('ID must be from 1 to ' + IntToStr(MAX_SPRITES));
```

- Scripts access players only via 1-based indices 1..32
- Index 0 is **explicitly rejected** at runtime
- Changing MAX_PLAYERS breaks all user scripts

### 5.2 Bullet Access

**File:** `server/scriptcore/ScriptMap.pas`

```pascal
if (ID > MAX_BULLETS) or (ID = 0) then
  raise Exception.Create('ID must be from 1 to ' + IntToStr(MAX_BULLETS));
```

- Scripts access bullets only via 1-based indices 1..254
- Index 0 is **explicitly rejected**

### 5.3 Thing/Object Access

**File:** `server/scriptcore/ScriptMap.pas`

```pascal
if (ID > MAX_THINGS) or (ID = 0) then
  raise Exception.Create('ID must be from 1 to ' + IntToStr(MAX_THINGS));
```

- Scripts access things only via 1-based indices 1..90
- Index 0 is **explicitly rejected**

---

## 6. Cross-Reference Matrix: Subsystem Coupling

### Legend
- **R** = Read-only access
- **W** = Write/modify access
- **R+W** = Read and write access

### 6.1 Sprite[] Subsystem

| Subsystem | Sprite[] | SpriteParts | Bullet[] | Thing[] | Spark[] | Map | Notes |
|-----------|----------|-------------|----------|---------|---------|-----|-------|
| **Sprites (mechanics/Sprites.pas)** | R+W | R+W | R | R+W | W | R | Player update, collision, weapon fire |
| **Bullets (mechanics/Bullets.pas)** | R | R | R+W | R+W | W | R | Collision detection, owner tracking |
| **Things (mechanics/Things.pas)** | R+W | — | — | R+W | W | R | Pickup, flag holds, owner tracking |
| **Sparks (mechanics/Sparks.pas)** | R | — | — | — | R+W | R | Client-side effects, visibility |
| **Control (mechanics/Control.pas)** | R+W | — | — | — | — | R | Input handling, weapon selection |
| **Game (Game.pas)** | R+W | — | R+W | R+W | R+W | R+W | Global state, map changes, voting |
| **NetworkServerGame** | R | R | R | R | — | R | Snapshot transmission, state sync |
| **NetworkServerSprite** | R+W | — | — | — | — | R | Player join/spawn, disconnection |
| **NetworkServerThing** | — | — | — | R+W | — | — | Thing state updates |
| **NetworkClientGame** | R+W | — | R+W | R+W | R+W | R | Client-side simulation, prediction |
| **Demo (shared/Demo.pas)** | R | R | R | R | R | R | Demo recording/playback |
| **Script API** | R | — | R | R | — | R | ScriptPlayers, ScriptMap APIs |

---

### 6.2 Critical Read-Write Couplings

**Sprite Creation/Destruction:**
- `CreateSprite()` (Sprites.pas:240): Allocates Sprite[i], calls `SpriteParts.CreatePart()`, clones `GostekSkeleton`
- Sprite.Kill(): Marks `Active=False`, kills associated particle system
- Write to: Sprite[], SpriteParts.Pos[], SpriteParts.Active[]

**Bullet Lifecycle:**
- `CreateBullet()` (Bullets.pas): Allocates Bullet[i], sets Owner=SpriteIndex
- Bullet.Update(): Reads Bullet[], writes Bullet[], reads Sprite[] (owner collision check)
- Bullet collision: Modifies Sprite[].Health, Thing[].TimeOut, Bullet[].Active

**Thing Pickup:**
- Thing.CheckSpriteCollision(): Returns sprite index if collision detected
- CreateSprite() reads WeaponActive[] to grant weapons via `Thing[]` style
- Sprite can hold Thing[]: `Sprite[].HoldedThing = ThingIndex` (Sprites.pas:117)

**Flag State:**
- `TeamFlag[Team]` stores Thing[] index
- Sprite can hold flag: Sprite[].HoldedThing points to flag Thing
- Script: `Players[i].HoldsFlag()` reads Sprite[].HoldedThing

---

### 6.3 Network Synchronization Coupling

**Server → Client:**
- HeartBeat: Sprite[].Player stats (kills, deaths, team)
- ServerSpriteSnapshot: Sprite[].Pos, Sprite[].Velocity, Sprite[].Health, weapon state
- BulletSnapshot: Bullet[].Pos, Bullet[].Velocity, Bullet[].Owner
- ThingSnapshot: Thing[].Pos, Thing[].Style, Thing[].Owner

**Client → Server:**
- ClientSpriteSnapshot: Local input controls, weapon selection
- ClientBulletSnapshot: Predicted bullet state (for anti-cheat)

**Critical Invariant:** NetworkServerGame must transmit Sprite[] indices 1..32 exactly as-is (no remapping).

---

### 6.4 Subsystem Update Order (Per Tick)

Typical game loop order (inferred from Game.pas, NetworkServerGame.pas):

1. **Control Input:** Sprite[].Control updated from network or local input
2. **Sprite Physics:** Sprite.Update() for each active sprite
   - Reads Control[], writes Sprite[].Position, SpriteParts.Pos[]
3. **Weapon Fire:** Sprite.Fire() creates Bullet[] entries
4. **Bullet Update:** Bullet.Update() for each active bullet
   - Collision checks against Sprite[], Thing[], Map
5. **Thing Update:** Thing.Update() for each active thing
   - Collision checks, timeout decrement
6. **Spark Update:** Spark.Update() for each active spark (client-only)
7. **ParticleSystem Step:** Physics integrator for SpriteParts, BulletParts
8. **Network Sync:** Transmit Sprite[], Bullet[], Thing[] state to clients
9. **Demo Record:** Write frame state to demo file
10. **Script Callbacks:** OnTick, OnPlayerUpdate (if enabled)

---

## 7. Decomposition Complexity Quantification

### 7.1 Global State Coupling (by subsystem)

| Subsystem | Globals Read | Globals Written | External Dependencies | Complexity |
|-----------|--------------|-----------------|----------------------|------------|
| Sprites.pas Update | 9 (Sprite, SpriteParts, Bullet, Thing, Map, Control, Game vars) | 4 (Sprite, SpriteParts, Bullet) | Physics, weapons, pathfinding | **Very High** |
| Bullets.pas Update | 8 (Bullet, Sprite, Thing, Map, SpriteParts, Game.Ticks) | 3 (Bullet, Sprite, Thing) | Collision, effects | **High** |
| Things.pas Update | 6 (Thing, Sprite, Map, Bullet) | 2 (Thing, Sprite) | Collision, ownership | **Medium-High** |
| Sparks.pas Update | 4 (Spark, SpriteParts, Map, Game vars) | 1 (Spark) | Rendering, collision | **Medium** |
| Control.pas | 2 (Sprite, Game.Map) | 1 (Sprite.Control) | Input, weapon state | **Low-Medium** |
| NetworkServerGame.pas | 7 (Sprite, Bullet, Thing, Map, Game.TeamScore, Game.Ticks) | 1 (Network output) | Serialization | **Medium** |
| NetworkServerSprite.pas | 3 (Sprite, Game.PlayersNum, Map) | 2 (Sprite, Network output) | Connection mgmt | **Medium** |
| Demo.pas | 8 (read-only: Sprite, Bullet, Thing, Map, Game vars) | 1 (File I/O) | Recording infrastructure | **Low-Medium** |

### 7.2 Rewrite Risk Assessment

**Minimum Viable Rewrite:** Separate simulation from networking
- Core simulation loop: Sprite[], Bullet[], Thing[] physics and collision
- Network layer: Serialization/deserialization of above
- **Risk:** Heartbeat and packet indices must match exactly (32 players, 254 bullets, 90 things)

**Safe Refactoring:** Encapsulate per-object lifecycle
- Replace flat array loops with object pools or entity-component patterns
- **Constraint:** 1-based indexing and index → object mapping must remain transparent to network/script layers
- **Hidden Complexity:** Demo format ties to array layout (Sprite[MAX_SPRITES] as demo player)

**Unsafe Changes:** 
- Increasing MAX_SPRITES beyond 32 (breaks network protocol)
- Changing bullet indexing from 1-based (breaks demo playback)
- Changing particle system from array-based (breaks skeleton animation)

---

## 8. Specific Value References (Exact Constants)

### 8.1 Hardcoded in Protocol Messages

| Field | Type | Max Value | Source | Impact |
|-------|------|-----------|--------|--------|
| `TMsg_HeartBeat.Active[1..32]` | Boolean array | 32 slots | Net.pas:358 | Network protocol frozen |
| `TMsg_HeartBeat.Kills[1..32]` | Word array | 65535 per player | Net.pas:359 | Max kills before overflow |
| `TMsg_ServerSpriteSnapshot.Num` | Byte | 255 | Net.pas:374 | Sprite index must fit in Byte |
| `TMsg_BulletSnapshot.Owner` | Byte | 255 | Net.pas:458 | Sprite index must fit in Byte |
| `TMsg_ServerVars.Damage[1..ORIGINAL_WEAPONS]` | Single array | ORIGINAL_WEAPONS slots | Net.pas:402 | Weapon count frozen |

### 8.2 Tick and Time Constants

| Constant | Value | Source | Meaning |
|----------|-------|--------|---------|
| `DEFAULT_GOALTICKS` | 60 | Constants.pas:27 | Game runs at 60 Hz |
| `SECOND` | 60 | Constants.pas:84 | 60 ticks = 1 second |
| `DEFAULT_VOTE_TIME` | 7200 | Constants.pas:254 (MINUTE * 2 * 60) | Vote cooldown in ticks |
| `DEFAULT_VOTING_TIME` | 1200 | Constants.pas:255 (SECOND * 20) | Vote window in ticks |
| `GOALTICKS div 3` | 20 | Game.pas:272 | Bullet-time slow-mo tick rate |

---

## 9. Conclusion: The Behavioral Contract

**For any rewrite, these are non-negotiable:**

1. **Array Indices:** Sprite[1..32], Bullet[1..254], Thing[1..90], Spark[1..558] (1-based, no 0-indexing)
2. **Sentinels:** Index 0 forbidden in public APIs; `SpriteNum=0` means "no sprite"; `Active=False` means "unused slot"
3. **Network Wire:** 32-player heartbeats, 254-bullet snapshots, weapon arrays frozen at current count
4. **Demo Format:** Sprite[MAX_SPRITES=32] reserved for demo player; all indices must remain stable across load/save
5. **Script API:** PlayerID range 1..32, BulletID range 1..254, ObjectID range 1..90 (0 rejected at runtime)
6. **ParticleSystem:** 560-particle fixed arrays indexed 1..560 for skeleton animation
7. **Tick Rate:** 60 ticks/second (GOALTICKS) is the simulation heartbeat; derivable to 20 for bullet-time

**Any deviation requires coordinated changes across: Network protocol, Demo format, Wire message definitions, Script API validation, and potentially client/server negotiation.**