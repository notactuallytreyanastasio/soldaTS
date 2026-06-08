# OpenSoldat PascalScript Modding API Reference

## Overview

This document specifies the complete PascalScript modding API surface exposed to server administrators as the behavioral contract. The implementation spans two execution engines (ScriptCore v1 and ScriptCore3 v2) with different compilation/execution models and event cascading semantics. All claims are grounded in the actual OpenSoldat FreePascal source.

## Architecture: Two Script Engines

### ScriptCore (v1) - Legacy Engine

**Initialization:** server/scriptcore/ScriptCore.pas

- **Detection:** Scripts identified by presence of `Includes.txt` in script folder (ScriptCore.pas:144)
- **Compilation:** Uses bundled uPSComponent/uPSScript (Delphi-era PascalScript fork)
  - Files listed in `Includes.txt` concatenated sequentially (ScriptCore.pas:159–175)
  - Comments prefixed with `//` stripped before concatenation (ScriptCore.pas:161)
  - Compiled to internal representation via `TPSScript.Compile()` (ScriptCore.pas:179)
- **Execution:** Synchronous, in-process via `TPSScript.ExecuteFunction()`
  - Global variables refreshed before each event call via `OnExecute` callback (ScriptCore.pas:210–213)
  - API functions registered once via `OnCompile` callback (ScriptCore.pas:205–208)
- **Disabled Scripts:** Script instances can set `DisableScript` pointer variable to `True` to pause all event delivery to that script (ScriptCore.pas:219–220)
- **Error Recovery:** On exception during event call (ScriptCore.pas:234–275):
  - Error count incremented; errors decay at 1 per second (ScriptCore.pas:246, 286–287)
  - At 10+ errors: configurable crash behavior via `sc_onscriptcrash` cvar:
    - `'shutdown'` → server halts (ScriptCore.pas:249–254)
    - `'recompile'` → script recompiled and relaunched (ScriptCore.pas:256–263)
    - `'disable'` → script unregistered from dispatcher (ScriptCore.pas:265–269)

### ScriptCore3 (v2) - Modern Engine

**Initialization:** server/scriptcore/ScriptCore3.pas

- **Detection:** Scripts identified by presence of `config.ini` with `[Config]` section (ScriptCore3.pas:192)
- **Configuration (config.ini):**
  - `Version`: float, must be ≥ 0.1 (ScriptCore3.pas:194–198)
  - `Name`: string, max 20 chars, required (ScriptCore3.pas:200–210)
  - `MainFile`: string, default `main.pas` (ScriptCore3.pas:211)
  - `Sandboxed`: integer, default 2; checked against global `sc_sandboxed` cvar (ScriptCore3.pas:274)
  - `AllowDLLs`: boolean, default False; checked against global `sc_allowdlls` cvar (ScriptCore3.pas:275)
  - `AllowIniEdit`: boolean, default False (ScriptCore3.pas:276)
  - `Gamemod`: boolean, default False; sets `FGameMod` property (ScriptCore3.pas:236)
  - `Legacy`: boolean, default False; if True, enables hybrid adapter for v1 API compatibility (ScriptCore3.pas:239–242)
  - `Debug`: boolean, default False; enables debug symbols and line info (ScriptCore3.pas:240)
  - `[SearchPaths]` section: additional search paths (relative to script dir) (ScriptCore3.pas:279)
  - `[Defines]` section: preprocessor defines for compilation (ScriptCore3.pas:280)
- **Compilation:** (PascalCompiler.pas)
  - Preprocessor expands `{$include}` directives via OnNeedFile callback (PascalCompiler.pas:97–115)
  - OnUses callback handles module imports; when `SYSTEM` unit requested, all API classes registered (PascalCompiler.pas:117–157)
  - Compiler creates bytecode; optional debug symbols retained if `Debug=True` (ScriptCore3.pas:502–504)
- **Execution:** (PascalExec.pas)
  - Bytecode loaded into TPSExec instance; class importer registers runtime classes (PascalExec.pas:186–199)
  - Script.Execute() runs initialization code, then waits for event calls (ScriptCore3.pas:550)
  - OnException callback intercepts runtime exceptions (ScriptCore3.pas:283–313)
  - Unhandled exceptions trigger HandleException, which:
    - Raises EScriptUnload → unregister script (ScriptCore3.pas:385–387)
    - Raises EScriptRecompile → recompile (optionally forced) and relaunch (ScriptCore3.pas:389–394)
    - Other exceptions → call OnUnhandledException event if set, then unregister (ScriptCore3.pas:420–431)

## Event Dispatch & Cascade Semantics

### Dispatcher Architecture

**Entry Point:** server/scriptcore/ScriptDispatcher.pas

All game events flow through TScriptDispatcher singleton, which iterates registered script instances in reverse order of registration (line 435–436, 450–451, etc.). Each script's corresponding event handler is called sequentially.

### Event Signatures & Cascade Rules

#### State-Modifying Events (return value chains through scripts)

1. **OnPlayerDamage** (ScriptCore.pas:387–397; ScriptCore3.pas:971–993)
   - ScriptCore signature: `function OnPlayerDamage(Victim, Shooter: Byte; Damage: Single; BulletID: Byte): Single`
   - ScriptCore3 signature: same
   - Semantics: Damage value returned by each script becomes input to next script (chaining multipliers/reductions)
   - ScriptCore chaining: calls `OnPlayerDamage(Victim, Shooter, Damage)` then `OnPlayerDamageEx(Victim, Shooter, Damage, WeaponNum)` on same script; second return value replaces Damage
   - ScriptCore3 chaining: If `Shooter.OnDamage` event assigned, calls it with `[Shooter, Victim, Damage, BulletID]`; return replaces Damage
   - Dispatcher chaining: Each script's returned Damage becomes input to next script (ScriptDispatcher.pas:687–701)

2. **OnBeforeJoinTeam** (ScriptCore3.pas:634–663; ScriptDispatcher.pas:460–482)
   - Signature: `function OnBeforeJoinTeam(Id, Team, OldTeam: Byte): ShortInt`
   - Returns target team ID (or -1 to reject join)
   - Cascade: If any script returns -1, subsequent scripts receive -1; if returned value ≠ -1, that becomes new team for next script (ScriptDispatcher.pas:469–475)

3. **OnVoteMapStart** (ScriptCore3.pas:1042–1060; ScriptDispatcher.pas:735–747)
   - Signature: `function OnVoteMapStart(Id: Byte; Map: string): Boolean`
   - Returns True to veto vote; accumulated via OR logic across scripts (ScriptDispatcher.pas:742–743)

4. **OnVoteKickStart** (ScriptCore3.pas:1062–1082; ScriptDispatcher.pas:750–763)
   - Signature: `function OnVoteKickStart(Id, Victim: Byte; Reason: string): Boolean`
   - Returns True to veto; accumulated via OR logic (ScriptDispatcher.pas:757–758)

5. **OnPlayerCommand** & **OnConsoleCommand** (ScriptCore3.pas:1141–1165, 1169–1192; ScriptDispatcher.pas:808–836)
   - Signature: `function OnPlayerCommand(Id: Byte; Command: string): Boolean`
   - Returns True if command was handled; accumulated via OR logic (ScriptDispatcher.pas:815–816, 831–832)

6. **OnRequestGame** (ScriptCore3.pas:611–632; ScriptDispatcher.pas:443–457)
   - Signature: `function OnRequestGame(Ip, Hw: string; Port: Word; State: Byte; Forwarded: Boolean; Password: string): Integer`
   - Returns modified state code; chained: each script's return becomes next script's input (ScriptDispatcher.pas:450–452)

#### Non-Returning Events (broadcast to all scripts)

Events in this category iterate all scripts; no cascade/ordering constraint visible to scripts except registration order:

- **OnClockTick** (ScriptCore.pas:278–289; ScriptCore3.pas:591–609)
  - Signature: `procedure OnClockTick;` (no params in v1) / `procedure OnClockTick(Ticks: Integer)` (v2 with Game.OnClockTick)
  - Called once per MainTickCounter tick (or every N ticks if script sets AppOnIdleTimer)
  - ScriptCore: Sets ReqPort global before calling OnRequestGame; AppOnIdleTimer timer applied (ScriptCore.pas:282–284, 299)
  - ScriptCore3: If Game.TickThreshold set and MainTickCounter divisible by it, calls Game.OnClockTick (ScriptCore3.pas:598–601)

- **OnJoinTeam** (ScriptCore.pas:308–316; ScriptCore3.pas:665–714)
  - Signature: `procedure OnJoinTeam(Id, Team, OldTeam: Byte; JoinGame: Boolean)`
  - Called after join permission granted; JoinGame=True on first join to game
  - ScriptCore3: Updates internal team rosters; calls OnJoin or Team.OnJoin depending on JoinGame (ScriptCore3.pas:673–706)

- **OnLeaveGame** (ScriptCore.pas:319–323; ScriptCore3.pas:716–741)
  - Signature: `procedure OnLeaveGame(Id: Byte; Kicked: Boolean)`
  - ScriptCore3: Removes player from teams, calls OnLeave events (ScriptCore3.pas:723–740)

- **OnFlagGrab**, **OnFlagScore**, **OnFlagReturn**, **OnFlagDrop** (ScriptCore.pas:363–379; ScriptCore3.pas:836–908)
  - Signatures: `procedure OnFlagGrab(Id, TeamFlag: Byte; GrabbedInBase: Boolean)` (etc.)
  - TeamFlag: flag ID (0=Red, 1=Blue, 2=Yellow)
  - GrabbedInBase: True if grabbed from spawn
  - ScriptCore3: Calls Player.OnFlagGrab/OnFlagScore/OnFlagReturn/OnFlagDrop events (ScriptCore3.pas:843–845, 862–864, 881–883, 898–900)

- **OnKitPickup** (ScriptCore3.pas:910–925)
  - Signature: `procedure OnKitPickup(Id, KitId: Byte)`
  - Calls Player.OnKitPickup event (ScriptCore3.pas:915–917)

- **OnBeforePlayerRespawn** / **OnAfterPlayerRespawn** (ScriptCore3.pas:930–969)
  - BeforeRespawn signature: `function OnBeforePlayerRespawn(Id: Byte): TVector2`
  - Returns new spawn position; chained via SpriteParts.Pos[Id] updates (ScriptDispatcher.pas:664–665)
  - AfterRespawn signature: `procedure OnAfterPlayerRespawn(Id: Byte)`

- **OnPlayerKill** (ScriptCore.pas:399–412; ScriptCore3.pas:995–1012)
  - Signature: `procedure OnPlayerKill(Killer, Victim, BulletID: Byte)`
  - BulletID: if Killer==Victim (suicide), set to 100; otherwise Bullet[BulletID].OwnerWeapon

- **OnWeaponChange** (ScriptCore.pas:414–421; ScriptCore3.pas:1014–1039)
  - Signature: `procedure OnWeaponChange(Id, Primary, Secondary, PrimaryAmmo, SecondaryAmmo: Byte)`
  - Primary/Secondary: weapon IDs (external, 0-based)
  - ScriptCore3: Creates temp TScriptWeaponChange objects (ScriptCore3.pas:1025–1026) and passes to Player.OnWeaponChange

- **OnBeforeMapChange** / **OnAfterMapChange** (ScriptCore.pas:325–337; ScriptCore3.pas:744–778)
  - Signatures: `procedure OnBeforeMapChange(Map: string)` / `procedure OnAfterMapChange(Map: string)`
  - Map: map file name

- **OnAdminConnect**, **OnAdminDisconnect**, **OnAdminMessage** (ScriptCore.pas:339–361; ScriptCore3.pas:781–833)
  - Signatures: `procedure OnAdminConnect(Ip: string; Port: Word)` (etc.)
  - Called on TCP admin connections

- **OnPlayerSpeak** (ScriptCore.pas:449–453; ScriptCore3.pas:1122–1139)
  - Signature: `procedure OnPlayerSpeak(Id: Byte; Text: string)`
  - ScriptCore3: Calls Player.OnSpeak (ScriptCore3.pas:1130–1131)

### Lock/Thread Safety

All event dispatch wrapped in lock acquisition via TScriptDispatcher.DoLock/DoUnlock (ScriptDispatcher.pas:214–224):
- If calling thread ≠ MainThreadID, acquires script's TCriticalSection lock (Script.pas:114)
- No concurrent event execution within same script; dispatcher serializes via script lock

## Exposed Object Model

### TScriptGame (ScriptGame.pas)

Properties (published via helper functions):
- **GameStyle**: Byte (read/write via sv_gamemode cvar)
- **MaxPlayers**: Byte (read/write; locked if sv_lockedmode=True)
- **NextMap**, **CurrentMap**: string (read-only)
- **NumBots**, **NumPlayers**, **Spectators**: Byte (read-only)
- **ScoreLimit**: Word (read/write via sv_killlimit)
- **ServerIP**, **ServerName**, **ServerPort**, **ServerVersion**, **ServerInfo**: string (read-only)
- **Gravity**: Single (read/write via sv_gravity)
- **Paused**: Boolean (read/write; pause = MapChangeCounter == 999999999)
- **RespawnTime**, **MinRespawnTime**, **MaxRespawnTime**: Longint (read/write)
- **MaxGrenades**, **Bonus**: Byte (read/write)
- **TimeLimit**, **TimeLeft**: Longint (read-only TimeLeft; read/write TimeLimit)
- **FriendlyFire**, **Realistic**, **Survival**, **Advance**, **Balance**: Boolean (read/write)
- **Password**: string (read/write via sv_password)
- **VotePercent**: Byte (read/write)
- **TickThreshold**: Longint (read/write; 0 = disable Game.OnClockTick)
- **TickCount**: Longint (read-only; = MainTickCounter)
- **Teams[0..5]**: TScriptTeam array (read-only; indexed by team ID)
- **ScriptMapsList**, **ScriptBanLists**: read-only collections

Methods:
- **Shutdown()**: Halt server
- **StartVoteKick(ID: Byte; Reason: string)**: Initiate vote
- **StartVoteMap(Name: string)**: Initiate vote
- **StopRecord()**: Stop demo recording
- **Restart()**: Restart game
- **LoadWeap(WeaponMod: string): Boolean**
- **LoadCon(ConfigFile: string): Boolean**
- **LoadList(MapsList: string): Boolean**
- **StartRecord(DemoName: string): Boolean**

Events (as function pointers; if assigned, called during event dispatch):
- **OnClockTick(Ticks: Integer)**
- **OnJoin(Player: TScriptActivePlayer; Team: TScriptTeam)**
- **OnLeave(Player: TScriptActivePlayer; Kicked: Boolean)**
- **OnRequest(Ip, Hw: string; Port: Word; State: Byte; Forwarded: Boolean; Password: string): Integer**
- **OnAdminCommand(Player: TScriptActivePlayer; Command: string): Boolean**
- **OnTCPMessage(Ip: string; Port: Word; Message: string)** (deprecated; use OnAdminCommand)
- **OnTCPCommand(Ip: string; Port: Word; Command: string): Boolean** (deprecated)
- **OnAdminConnect(Ip: string; Port: Word)**
- **OnAdminDisconnect(Ip: string; Port: Word)**

### TScriptTeam (ScriptTeam.pas)

Properties:
- **Score**: Byte (read/write; updates TeamScore[ID])
- **Player[Num: Byte]**: TScriptActivePlayer (read-only; indexed 0..Count-1)
- **Count**: Byte (read-only; number of active players)
- **ID**: Byte (read-only; team number)

Methods:
- **AddPlayer(Player: TScriptActivePlayer)**
- **RemovePlayer(Player: TScriptActivePlayer)**

Events:
- **OnBeforeJoin(Player: TScriptActivePlayer; Team, OldTeam: TScriptTeam): ShortInt** (return new team or -1 to reject)
- **OnJoin(Player: TScriptActivePlayer; Team: TScriptTeam)**
- **OnLeave(Player: TScriptActivePlayer; Team: TScriptTeam; Kicked: Boolean)**

### TScriptActivePlayer (ScriptPlayer.pas, lines 191+)

Read-only properties (base TScriptPlayer):
- **Sprite**: TSprite (internal; not exported)
- **Team**: Byte
- **Name**: string
- **Alive**: Boolean
- **Health**: Single (read/write)
- **Vest**: Single (read/write)
- **Primary**: TScriptPrimaryPlayerWeapon (read-only; weapon object)
- **Secondary**: TScriptSecondaryPlayerWeapon (read-only)
- **ShirtColor**, **PantsColor**, **SkinColor**, **HairColor**: Longword (read-only)
- **FavouriteWeapon**: string (read/write)
- **ChosenSecondaryWeapon**: Byte (read-only)
- **Friend**: string (read/write)
- **Accuracy**, **ShootDead**, **GrenadeFrequency**, **Camping**, **OnStartUse**: readable/writable stats
- **HairStyle**, **Headgear**, **Chain**: Byte (read-only style IDs)
- **ChatFrequency**, **ChatKill**, **ChatDead**, **ChatLowHealth**, **ChatSeeEnemy**, **ChatWinning**: string (read/write)
- **IsAdmin**: Boolean (read/write)
- **Dummy**: Boolean (read/write)

Methods (active players only):
- **None directly; use Game.* or Map.* methods**

Events (active players, function pointers):
- **OnFlagGrab(Player: TScriptActivePlayer; TFlag: TScriptActiveFlag; Team: Byte; GrabbedInBase: Boolean)**
- **OnFlagReturn(Player: TScriptActivePlayer; Flag: TScriptActiveFlag; Team: Byte)**
- **OnFlagScore(Player: TScriptActivePlayer; Flag: TScriptActiveFlag; Team: Byte)**
- **OnFlagDrop(Player: TScriptActivePlayer; Flag: TScriptActiveFlag; Team: Byte; Thrown: Boolean)**
- **OnKitPickup(Player: TScriptActivePlayer; Kit: TScriptActiveObject)**
- **OnBeforeRespawn(Player: TScriptActivePlayer): TVector2** (returns spawn pos)
- **OnAfterRespawn(Player: TScriptActivePlayer)**
- **OnDamage(Shooter, Victim: TScriptActivePlayer; Damage: Single; BulletID: Byte): Single** (chained damage modifier)
- **OnKill(Killer, Victim: TScriptActivePlayer; WeaponType: Byte)** (WeaponType = bullet owner weapon)
- **OnWeaponChange(Player: TScriptActivePlayer; Primary, Secondary: TScriptPlayerWeapon)**
- **OnVoteMapStart(Player: TScriptActivePlayer; Map: string): Boolean**
- **OnVoteKickStart(Player, Victim: TScriptActivePlayer; Reason: string): Boolean**
- **OnVoteMap(Player: TScriptActivePlayer; Map: string)**
- **OnVoteKick(Player, Victim: TScriptActivePlayer)**
- **OnSpeak(Player: TScriptActivePlayer; Text: string)**
- **OnCommand(Player: TScriptActivePlayer; Command: string): Boolean** (returns True if handled)

### TScriptWeapon & Subclasses (ScriptWeapon.pas)

Base TScriptWeapon (read-only):
- **WType**: Byte (weapon ID)
- **Name**: string
- **BulletStyle**: Byte (projectile type)
- **Ammo**: Byte (read/write; for player weapons, updates internal sprite state)
- **Gun**: TGun (internal gun record)

TScriptPrimaryPlayerWeapon, TScriptSecondaryPlayerWeapon: Sprites[ID].Weapon / SecondaryWeapon access

### TScriptMap (ScriptMap.pas)

Collections (indexed 1-based):
- **Objects[ID: Byte]**: TScriptActiveObject (1..MAX_THINGS; spawned items/flags)
- **Bullets[ID: Byte]**: TScriptActiveBullet (1..MAX_BULLETS; in-flight projectiles)
- **Spawns[ID: Byte]**: TScriptSpawnPoint (1..MAX_SPAWNPOINTS; spawn locations)

Flags (by team index):
- **RedFlag**, **BlueFlag**, **YellowFlag**: TScriptActiveFlag (1-3)

Properties:
- **Name**: string (current map name)

Methods:
- **GetFlag(ID: Integer): TScriptActiveFlag** (get flag by team ID)
- **RayCast(x1, y1, x2, y2: Single; Player, Flag, Bullet, CheckCollider: Boolean; Team: Byte): Boolean**
- **RayCastVector(A, B: TVector2; ...): Boolean**
- **CreateBullet(X, Y, VelX, VelY, HitM: Single; sStyle: Byte; Owner: TScriptActivePlayer): Integer** (returns bullet ID)
- **CreateBulletVector(A, B: TVector2; ...): Integer**
- **AddObject(Obj: TScriptNewObject): TScriptActiveObject** (spawn object)
- **AddSpawnPoint(Spawn: TScriptNewSpawnPoint): TScriptActiveSpawnPoint** (add spawn)
- **NextMap()**: Load next map
- **SetMap(NewMap: string)**: Load specified map

Events:
- **OnBeforeMapChange(Next: string)**
- **OnAfterMapChange(Next: string)**

### TScriptActiveBullet (ScriptBullet.pas)

Read-only properties:
- **Active**: Boolean
- **ID**: Byte
- **Style**: Byte (projectile type)
- **X**, **Y**, **VelX**, **VelY**: Single

Methods:
- **GetOwnerWeaponId(): Integer** (internal weapon type)

### TScriptActiveObject / TScriptActiveFlag (ScriptObject.pas)

Base TScriptObject (read-only):
- **Style**: Byte (item type)
- **X**, **Y**: Single (position in world coordinates)

TScriptActiveObject:
- **Active**: Boolean
- **ID**: Byte
- **Kill()**: Remove object

TScriptActiveFlag (subclass):
- **InBase**: Boolean (flag at spawn location)

### TScriptPlayers (ScriptPlayers.pas)

Collection (indexed 1..MAX_SPRITES):
- **Player[ID: Byte]**: TScriptActivePlayer
- **Active**: TFPGList<TScriptActivePlayer> (dynamically maintained list of joined players)

Methods:
- **Add(Player: TScriptNewPlayer; JoinType: TJoinType): TScriptActivePlayer** (spawn new bot)
- **GetByName(Name: string): TScriptActivePlayer**
- **GetByIP(IP: string): TScriptActivePlayer**
- **WriteConsole(Text: string; Color: Longint)** (broadcast to all)
- **BigText(Layer: Byte; Text: string; Delay: Integer; Color: Longint; Scale: Single; X, Y: Integer)** (screen overlay)
- **WorldText(Layer: Byte; Text: string; Delay: Integer; Color: Longint; Scale, X, Y: Single)** (in-world text)
- **Tell(Text: string)** (broadcast message)

### TScriptMapsList, TScriptBanLists (ScriptMapsList.pas, ScriptBanLists.pas)

Read-only collections of maps and IP bans; primarily for iteration.

### TScriptMath (ScriptMath.pas)

Mathematical functions:
- **Sin, Cos, Tan, Cotan, ArcSin, ArcCos, ArcTan, ArcCotan, ArcTan2**
- **Pow, LogN, Ln, Exp**
- **Min, Max, Abs, Sign**
- **Round, RoundTo, DegToRad, RadToDeg, DegNormalize**
- **InRange, EnsureRange, Random, Sincos**
- **IsNaN**
- **E, Pi**: constants

### TScriptFileAPI (ScriptFileAPI.pas)

File operations (sandboxed to UserDirectory by default):
- **File**: TScriptFile methods
  - **CheckAccess(FilePath: string): Boolean**
  - **CreateFileStream()**: TMyMemoryStream
  - **CreateFileStreamFromFile(Path: string)**: TMyMemoryStream
  - **CreateStringList()**: TMyStringList
  - **CreateStringListFromFile(Path: string)**: TMyStringList
  - **CreateINI(Path: string)**: TMyIniFile
  - **Exists(Path: string): Boolean**
  - **Copy(Source, Destination: string): Boolean**
  - **Move(Source, Destination: string): Boolean**
  - **Delete(Path: string): Boolean**

### TScriptGlobal (ScriptGlobal.pas)

Global settings:
- **Global.ScriptDateSeparator**: Char (read/write DefaultFormatSettings.DateSeparator)
- **Global.ShortDateFormat**: string (read/write DefaultFormatSettings.ShortDateFormat)

### TScriptUnit (ScriptUnit.pas)

Script lifecycle events (ScriptCore3 only):
- **ScriptUnit.OnException(ExError: TPSError; Message: string; UnitName: string; FunctionName: string; Col, Row: Cardinal)**: Called when exception during execution
- **ScriptUnit.OnUnhandledException(Error: TPSError; Message: string; UnitName: string; FunctionName: string; Row, Col: Cardinal): Boolean** (return True to suppress unload)

### TScriptDateUtils (ScriptDateUtils.pas)

Date/time utilities exposed to scripts.

## Global State & Variable Access

### ScriptCore (v1) Global Variables

Registered once via RegisterFunctions (ScriptCoreInterface.pas:1140–1393); refreshed before each event via SetVariables:

**Read-only globals:**
- CoreVersion, ScriptName: string
- SafeMode: Byte (0/1)
- MaxPlayers, NumPlayers, NumBots: Byte
- CurrentMap, NextMap: string
- TimeLimit, TimeLeft, ScoreLimit: Integer
- GameStyle: Byte
- Version, ServerVersion, ServerName, ServerIP: string
- ServerPort: Integer
- DeathmatchPlayers, AlphaPlayers, BravoPlayers, CharliePlayers, DeltaPlayers, Spectators: Byte
- AlphaScore, BravoScore, CharlieScore, DeltaScore: Byte
- Paused: Boolean
- Password: string
- ReqPort: Word (set before OnRequestGame calls)

**Pointer variables (modifiable):**
- DisableScript: Boolean (set to True to disable all events to this script)
- AppOnIdleTimer: LongWord (timer divisor for OnIdle calls; default 60 frames)

### ScriptCore3 Global Variables

Set via API class RuntimeRegisterVariables. Access via direct variable name or via TScriptGame, TScriptMap, etc.

## Sandboxing & Security Limits

### ScriptCore (v1)

- **SafeMode flag** (ScriptDispatcher.SafeMode):
  - Disables DLL plugin loading if True (ScriptCore.pas:124–128)
  - Disables shell_exec() if True (ScriptCoreInterface.pas:1066–1071)
  - Disables GetURL() if True (commented but pattern shown at ScriptCoreInterface.pas:124–135)
- **File access:** Path traversal (`..`) stripped from file paths (ScriptCoreInterface.pas:120, 224, 447, 1046)

### ScriptCore3 (v2)

- **Sandbox levels** (config.ini Sandboxed field):
  - Checked against global `sc_sandboxed` cvar; script rejected if script sandbox level < global level (ScriptCore3.pas:221–226)
- **DLL support:**
  - Controlled by config.ini AllowDLLs, checked against global `sc_allowdlls` cvar (ScriptCore3.pas:228–234)
  - If enabled, TPascalExec.AddDllSupport() called to register DLL interface (PascalExec.pas not shown but referenced ScriptCore3.pas:523)
- **File access:** TScriptFileAPI enforces path checks via CheckAccess() (ScriptFileAPI.pas:84)
- **AllowIniEdit** flag (config.ini): Controls INI file modification capabilities (ScriptCore3.pas:276, 326)

## Compilation & Bytecode Details

### Preprocessor & Includes

Both engines support `{$include 'file.pas'}` directives processed by TPSPreProcessor (PascalCompiler.pas:97–115):
- Search paths added via Compiler.AddSearchPath() (ScriptCore3.pas:480)
- OnNeedFile callback finds and inlines file contents (PascalCompiler.pas:103–114)

### Function Signatures & Type System

All function/procedure signatures exposed via Compiler.AddFunction() / AddClass() / RegisterProperty() (and runtime equivalents). Type system:
- Primitive types: Byte, Word, Integer, Longint, Single, Double, Extended, String, Boolean, Char
- Records: TVector2, TGun, TSprite (not all exported to script scope)
- Classes: TScriptGame, TScriptTeam, TScriptActivePlayer, TScriptWeapon, etc.
- Arrays: array of Variant, array of String (static arrays via {$include})
- Function pointers: procedure / function types assigned to event fields

### Bytecode Format

Internal format stored as string; created by TPSPascalCompiler.Compile() and loaded by TPSExec.LoadBytecode(). No public spec; opaque to scripts.

## Error Handling & Recovery

### ScriptCore (v1) Exception Handling

Try-except wrapper around ExecuteFunction (ScriptCore.pas:230–275):
- Catches Exception; checks PascalScript.ExecErrorCode for error details (ScriptCore.pas:237–238)
- Logs error to console (ScriptCore.pas:238–245)
- Increments error count; decays 1 per second (ScriptCore.pas:246, 286–287)
- At 10+ errors: Applies crash behavior (shutdown/recompile/disable)
- Lock released after exception handling (ScriptCore.pas:274)

### ScriptCore3 (v2) Exception Handling

OnException callback (TPascalExec.OnException) intercepts execution-time exceptions (PascalExec.pas:146–154):
- Calls TScriptCore3.OnException (ScriptCore3.pas:283–313)
- If OnException event assigned on ScriptUnit, calls it with error details (ScriptCore3.pas:299–307)
- Unrecognized exception types → HandleException (ScriptCore3.pas:376–433)
  - EScriptUnload → unregister script (line 385–387)
  - EScriptRecompile → recompile/relaunch (line 389–394)
  - Other → call OnUnhandledException event if set; if event returns True, suppress unload (line 410–411, 421–422); otherwise unload (line 431)

## API Registration & Runtime Integration

### ICompilerAPI Interface

Each API module (TScriptGame, TScriptMap, etc.) implements ICompilerAPI.CompilerRegister() to add compile-time classes, properties, functions to TPSPascalCompiler. Called via OnUses callback when SYSTEM module imported (PascalCompiler.pas:132–137).

### IRuntimeAPI Interface

Each API module implements IRuntimeAPI:
- **RuntimeRegisterApi(Exec)**: Register runtime classes, class methods, function pointers
- **RuntimeRegisterVariables(Exec)**: Register global variables, initialize pointers to game state
- **BeforeExecute(Exec)**: Called before script.Execute() (ScriptCore3.pas:not shown but defined)
- **AfterExecute(Exec)**: Called after script.Execute() (ScriptCore3.pas:not shown but defined)

Called during TPascalExec.LoadBytecode() (PascalExec.pas:195–199).

### API Loading Order (ScriptCore3)

FApi list order significant; position 9 must be TScriptPlayersAPI (ScriptCore3.pas:360–363, comment at line 360–362). List:
1. TScriptDateUtilsAPI
2. TScriptWeaponAPI
3. TScriptObjectAPI
4. TScriptBulletAPI
5. TScriptPlayerAPI
6. TScriptTeamAPI
7. TScriptSpawnPointAPI
8. TScriptFileAPI
9. TScriptMapAPI
10. TScriptPlayersAPI ← must be position 9 for GameRegisterVariables
11. TScriptMapsListAPI
12. TScriptBanListsAPI
13. TScriptGameAPI
14. TScriptUnitAPI
15. TScriptGlobalAPI
16. TScriptMathAPI
17. TCoreFunctionsAPI
18. (optional) TScriptFFITestsAPI

## Legacy ScriptCore API Functions (ScriptCoreInterface.pas)

ScriptCore (v1) exposed these functions; some ported to ScriptCore3 via adapters:

**Player Stats:**
- `GetPlayerStat(Id: Byte; Stat: string): Variant` (stat name case-insensitive; e.g., 'KILLS', 'HEALTH', 'X', 'Y', 'VELX', 'VELY', 'ALIVE', 'PING', 'IP', 'HWID', 'PORT', 'NAME', 'TEAM', 'AMMO', 'SECAMMO', 'JETS', 'GRENADES', 'FLAGGER', 'TIME', 'GROUND', 'HUMAN', 'VEST', 'DIRECTION', 'FLAGS', 'MUTE') (ScriptCoreInterface.pas:788–859)

**Object Stats:**
- `GetObjectStat(Id: Byte; Stat: string): Variant` (stat: 'STYLE', 'ACTIVE', 'X', 'Y', 'INBASE') (ScriptCoreInterface.pas:894–914)

**Spawn Stats:**
- `GetSpawnStat(Id: Byte; Stat: string): Variant` (stat: 'ACTIVE', 'STYLE', 'X', 'Y') (ScriptCoreInterface.pas:916–931)
- `SetSpawnStat(Id: Byte; Stat: string; Value: Variant)` (ScriptCoreInterface.pas:933–946)

**Damage & Health:**
- `DoDamage(Id: Byte; Damage: Integer)` (applies damage to player)
- `DoDamageBy(Id, Shooter: Byte; Damage: Integer)` (applies damage with shooter attribution) (ScriptCoreInterface.pas:948–962)

**Game Control:**
- `Command(Cmd: string): Variant` (execute console command)
- `Shutdown()` / `Restart()`
- `KickPlayer(Num: Byte)` (kick without ban)
- `BanPlayer(Num: Byte; Time: Integer)` (Time in hours; 0 = permanent) (ScriptCoreInterface.pas:726–740)
- `BanPlayerReason(Num: Byte; Time: Integer; Reason: string)` (ScriptCoreInterface.pas:734–740)
- `StartVoteKick(Target: Byte; Reason: string)` (ScriptCoreInterface.pas:1002–1006)
- `StartVoteMap(Mapname, Reason: string)` (ScriptCoreInterface.pas:1008–1012)

**Weapons & Bullets:**
- `ForceWeapon(PlayerId, Primary, Secondary, Ammo: Byte)` (force weapon swap)
- `ForceWeaponEx(PlayerId, Primary, Secondary, PrimaryAmmo, SecondaryAmmo: Byte)` (ScriptCoreInterface.pas:511–514)
- `CreateBullet(X, Y, VelX, VelY, HitM: Single; BulletStyle, Owner: Byte): Integer` (ScriptCoreInterface.pas:545–571)
- `WeaponNameByNum(Num: Integer): string` (ScriptCoreInterface.pas:501–504)

**Geometry & Physics:**
- `RayCast(X1, Y1, X2, Y2: Single; var Distance: Single; MaxDist: Single): Boolean` (ScriptCoreInterface.pas:471–481)
- `RayCastEx(...; Player, Flag, Bullet, Collider: Boolean; Team: Byte): Boolean` (ScriptCoreInterface.pas:483–494)
- `Distance(A, B, C, D: Single): Single` (Euclidean)
- `GetPlayerXY(Id: Byte; var X, Y: Single)` (ScriptCoreInterface.pas:964–968)
- `GetFlagsXY(var BlueFlagX, BlueFlagY, RedFlagX, RedFlagY: Single)` (ScriptCoreInterface.pas:970–992)
- `GetFlagsSpawnXY(...)` (spawn locations) (ScriptCoreInterface.pas:994–1000)
- `MovePlayer(Id: Byte; X, Y: Single)`

**Text & Display:**
- `DrawText(Id: Byte; Text: string; Delay: Integer; Colour: Longint; Scale: Single; X, Y: Integer)` (HUD text to player)
- `DrawTextEx(Id, Num: Byte; ...)` (layer-based variant) (ScriptCoreInterface.pas:188–209)
- `SayToPlayer(Id: Byte; Text: string)` (chat message)
- `BotChat(Id: Byte; Text: string)` (bot broadcasts chat + console) (ScriptCoreInterface.pas:752–762)
- `WriteConsole(Id: Byte; Text: string; Color: Longint)` (internal function)

**Scoring & Stats:**
- `SetScore(Id: Byte; Score: Integer)` (set player kill count)
- `SetTeamScore(Team: Byte; Score: Integer)` (ScriptCoreInterface.pas:522–528)

**Bonuses:**
- `GiveBonus(Id, BonusType: Byte)` (BonusType: 1=Predator, 2=Berserker, 3=Vest, 4=Grenades, 5=Clusters, 6=FlameGod) (ScriptCoreInterface.pas:629–686)

**File I/O:**
- `ReadFile(Filename: string): string` (ScriptCoreInterface.pas:1083–1086)
- `WriteFile(Filename, Data: string): Boolean` (ScriptCoreInterface.pas:1039–1057)
- `WriteLnFile(Filename, Data: string): Boolean` (append) (ScriptCoreInterface.pas:AppendFile)
- `FileExists(Path: string): Boolean` (ScriptCoreInterface.pas:116–122)
- `ReadINI(Filename, Section, Value, Default: string): string` (ScriptCoreInterface.pas:1128–1138)

**String Utils:**
- `StrReplace(Source, Find, ReplaceWith: string): string`
- `StrPos(Text, Substr: string): Integer` (1-based position)
- `ContainsString(Text, Substr: string): Boolean`
- `GetStringIndex(Text: string; Array: array of string): Integer` (-1 if not found)
- `GetPiece(Source, Delimiter: string; Piece: Integer): string` (split on delimiter)

**Cryptography & Encoding:**
- `MD5String(Text: string): string`

**Math:**
- `Random(Min, Max: Integer): Integer` (ScriptCoreInterface.pas:694–697)
- `Sqrt, Sin, Cos, ArcTan, Exp, Ln, LogN, ...` (Math module)
- `RoundTo(Value: Extended; Digits: Integer): Extended` (ScriptCoreInterface.pas:1024–1037)

**System Info:**
- `GetSystem(): string` ('windows', 'linux', 'osx', 'unknown') (ScriptCoreInterface.pas:771–786)
- `GetTickCount(): Cardinal` (= MainTickCounter) (ScriptCoreInterface.pas:535–539)
- `IDToIP(Id: Byte): string` (player's IP or '255.255.255.255' for server) (ScriptCoreInterface.pas:716–719)
- `IDToHW(Id: Byte): string` (hardware ID) (ScriptCoreInterface.pas:721–724)
- `IDToName(Id: Byte): string` (player name)
- `NameToID(Name: string): Byte` (player ID by name)
- `NameToHW(Name: string): string` (hardware ID by name)

**Other:**
- `RegExpMatch(Regex, Source: string): Boolean` (ScriptCoreInterface.pas:699–702)
- `RegExpReplace(Regex, Source, ReplaceWith: string; UseSubstitution: Boolean): string` (ScriptCoreInterface.pas:704–709)
- `Iif(Condition: Boolean; TrueVal, FalseVal: Variant): Variant` (ternary)
- `Sleep(Milliseconds: Cardinal)` (pause execution; CAUTION: blocks event loop) (ScriptCoreInterface.pas:764–769)
- `RGB(R, G, B: Byte): Longint` (color value) (ScriptCoreInterface.pas:300–303)

## Reserved Constants & Enums

### Team IDs
0 = Deathmatch, 1 = Alpha, 2 = Bravo, 3 = Charlie, 4 = Delta, 5 = Spectator

### Weapon/Bullet Style IDs
(Maps defined in Weapons.pas; exposed via WeaponNameByNum and weapon.BulletStyle property)

### Object Styles
1 = Red Flag, 2 = Blue Flag, 3 = Yellow Flag, 4..27 = various pickups/weapons

### Game Styles (sv_gamemode)
0 = DeathMatch, 1 = Team DeathMatch, 2 = Capture The Flag, 3 = Deathmatch Team Score, 4 = Survival (mode-dependent)

## Compilation & Loading Sequence

### ScriptCore (v1)

1. **Discovery:** FindScripts() scans `/scripts/` folders; CheckFunction identifies Includes.txt
2. **Prepare:** ScriptCore.Prepare() reads Includes.txt, concatenates files, calls TPSScript.Compile()
3. **Launch:** Calls ActivateServer() user procedure if present
4. **Runtime:** Events trigger CallFunc(), which acquires lock, calls ExecuteFunction(), releases lock

### ScriptCore3 (v2)

1. **Discovery:** FindScripts() scans `/scripts/` folders; CheckFunction reads config.ini
2. **Prepare:** ScriptCore3.Prepare() calls Compile(), then creates TPascalExec, loads bytecode
   - Compile(): TPascalCompiler preprocesses main file, compiles to bytecode (PascalCompiler.pas:465–507)
   - All API classes' CompilerRegister() called during SYSTEM unit import (PascalCompiler.pas:132–137)
3. **Launch:** Calls Execute() (runs initialization code), then callsActivateServer() if legacy mode
4. **Runtime:** Events call CallFunc() or CallEvent(), acquiring lock, invoking function/event pointer

## Constants & Limits

- **MAX_PLAYERS:** 32 (max concurrent human players) (ScriptPlayers.pas:107)
- **MAX_SPRITES:** 32 (including bots, set to > 32 in some configs but scripts see 32)
- **MAX_THINGS:** 255 (map objects/flags) (ScriptMap.pas:99)
- **MAX_BULLETS:** 255 (in-flight projectiles) (ScriptMap.pas:102)
- **MAX_SPAWNPOINTS:** 256 (map spawnpoints) (ScriptMap.pas:103)
- **Script name length:** Max 20 characters (ScriptCore3.pas:206)
- **Weapon count:** ~30 (exposed as byte IDs 0..29)
- **Team count:** 6 (0..5 for team IDs)

---

**Document Version:** 2.0 (ScriptCore & ScriptCore3 combined spec)  
**Last Updated:** Based on source snapshot from /soldat_remastered/soldat/server/scriptcore/  
**Authoritative References:** All citations point to (relative_path:line_number) in actual FreePascal source files.