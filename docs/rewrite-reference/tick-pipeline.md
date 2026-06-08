# OpenSoldat Simulation Pipeline Reference Specification

## Overview

OpenSoldat runs at a fixed 60 Hz (GOALTICKS) tick rate on both server and client. Real time is accumulated into a fixed-timestep accumulator that drives discrete 60 Hz ticks. Network synchronization occurs on adjusted schedules keyed off `MainTickCounter` with an `Adjust` factor derived from active player count.

**Key timing constants** (shared/Constants.pas):
- `DEFAULT_GOALTICKS = 60` (shared/Constants.pas:27)
- `SECOND = 60` ticks (shared/Constants.pas:84)
- All time values in the codebase are measured in ticks (1 tick = 1/60 second)

**Global timing variables** (shared/Game.pas:31-34):
- `Ticks`: Per-second tick counter
- `TicksPerSecond`: Ticks executed in the last second
- `TickTime`: Total accumulated simulation ticks since start (Integer)
- `TickTimeLast`: Previous tick count
- `GOALTICKS`: Variable (DEFAULT_GOALTICKS or lower during bullet time) (shared/Game.pas:34)

**Per-side tick counter** (shared/network/Net.pas:817):
- `MainTickCounter`: Global accumulating tick counter (both sides, used for network send scheduling; wraps at 2147483640)

---

## (1) Fixed-Timestep Accumulator Mathematics

### Server Side (server/ServerLoop.pas, shared/Game.pas)

**Timing calculation** (shared/Game.pas:181-206, called at AppOnIdle start):

```
procedure Number27Timing;
  TimeInMil := GetTickCount64;  // wall-clock milliseconds
  Timepassed += (TimeInMil - TimeInMilLast);  // accumulate elapsed ms
  TickTime := Trunc(Timepassed / (1000 / GOALTICKS));
```

- `Timepassed`: Accumulator in milliseconds
- `TimeInMil`: System clock (GetTickCount64)
- `dt = 1/GOALTICKS` (default 1/60 = 0.01667 seconds)
- Real milliseconds converted to tick units: `TickTime = floor(Timepassed / (1000/60))`

**In AppOnIdle loop** (server/ServerLoop.pas:23-268):

```
procedure AppOnIdle;
  Number27Timing;  // updates TickTime
  for MainControl := 1 to (TickTime - TickTimeLast) do
    ticks := ticks + 1;
    Inc(MainTickCounter);
    UpdateFrame;  // one 60Hz tick
```

**Tick generation**: The loop at line 41 runs `(TickTime - TickTimeLast)` times, advancing `MainTickCounter` once per iteration. This is the frame-rate-independent loop: faster real time = more ticks per call.

### Client Side (client/ClientGame.pas, client/UpdateFrame.pas)

**Accumulator in GameLoop** (client/ClientGame.pas:216-405):

```
procedure GameLoop;
  CurrentTime := GetCurrentTime;  // SDL_GetPerformanceCounter / Frequency
  FrameTime := CurrentTime - FrameTiming.PrevTime;  // real seconds
  
  if FrameTime > 2 then
    FrameTime := 0;  // safety clamp
  
  dt := 1 / GOALTICKS;  // 1/60
  Accumulator := Accumulator + FrameTime;
  TickTime := TickTime + Trunc(Accumulator / dt);
  
  SimTime := (TickTime - TickTimeLast) * dt;  // real seconds for elapsed time
  Accumulator := Accumulator - SimTime;  // remainder
  FramePercent := Min(1, Max(0, Accumulator / dt));  // [0, 1) interpolation fraction
  
  for MainControl := 1 to (TickTime - TickTimeLast) do
    Inc(MainTickCounter);
    Update_Frame;  // one 60Hz tick
  
  RenderFrame(TimeElapsed, FramePercent, Paused);
```

**Key differences**:
- Uses SDL performance counter (nanosecond precision) instead of millisecond tick count
- Explicitly calculates `FramePercent` for interpolation (lines 247, 402-404)
- Render call passes `FramePercent` to RenderFrame for visual interpolation between tick states

**Interpolation** (client/ClientGame.pas:402-404):
```
if GamePaused then
  RenderFrame(FrameTiming.Elapsed, FramePercent, True)
else
  RenderFrame(FrameTiming.Elapsed - dt * (1 - FramePercent), FramePercent, False);
```

---

## (2) Server Tick Operations – Exact Ordered Pipeline

**Per-tick sequence** (server/ServerLoop.pas:23-268):

### Pre-Update Phase
1. **Network receive** (line 34): `UDP.ProcessLoop();` — drain incoming packets
2. **RCON commands** (line 37-38): `AdminServer.ProcessCommands();`
3. **Tick counter** (line 43): `ticks := ticks + 1;`
4. **Main counter** (line 45): `Inc(ServerTickCounter); Inc(MainTickCounter);`
   - MainTickCounter wraps at 2147483640 (line 48-49)

### Script/Platform Hooks
5. **Script clock tick** (line 52): `ScrptDispatcher.OnClockTick();`
6. **Steam callbacks** (line 56): `RunManualCallbacks();`

### Periodic Cleanup (MainTickCounter-based)
7. **Flood IPs reset** (line 59-61): `if MainTickCounter mod 1000 = 0` → clear FloodNum array
8. **Warnings decrement** (line 65-73): `if MainTickCounter mod (MINUTE * 5) = 0` → decrement PingWarnings, FloodWarnings per player
9. **Knife warnings reset** (line 75-79): `if MainTickCounter mod 1000 = 0` → KnifeWarnings := 0
10. **Cvar sync** (line 82-83): `if CvarsNeedSyncing then ServerSyncCvars(0, 0, False);`

### General Game Update
11. **UpdateFrame call** (line 86): See UpdateFrame sub-steps below

### Demo Recording
12. **Demo frame save** (line 90-92): `if DemoRecorder.Active and MapChangeCounter < 0 then DemoRecorder.SaveNextFrame;`

### Network Updates (MainTickCounter-based, only when MapChangeCounter < 0)

#### A. Per-Tick Bundled Broadcast (all players):

**Conditional branch** (line 156 or 178): Based on `net_lan.Value`

##### LAN mode (line 156-176):
- **Sprite snapshot** (line 158-159): `if MainTickCounter mod Round(30 * Adjust) = 0 then ServerSpriteSnapshot(NETW);`
- **Major snapshot** (line 161-163): `if (MainTickCounter mod Round(15 * Adjust) = 0) and (MainTickCounter mod Round(30 * Adjust) <> 0) then ServerSpriteSnapshotMajor(NETW);`
- **Skeleton snapshot** (line 165-166): `if MainTickCounter mod Round(20 * Adjust) = 0 then ServerSkeletonSnapshot(NETW);`
- **Heartbeat** (line 168-169): `if MainTickCounter mod Round(59 * Adjust) = 0 then ServerHeartBeat;`
- **Bot deltas** (line 171-176): `if (MainTickCounter mod Round(4 * Adjust) = 0) and (MainTickCounter mod Round(30 * Adjust) <> 0) and (MainTickCounter mod Round(60 * Adjust) <> 0) then` send deltas for active bots

##### INTERNET mode (line 178-199):
- **Sprite snapshot** (line 180-181): `if MainTickCounter mod Round(net_t1_snapshot.Value * Adjust) = 0`
- **Major snapshot** (line 183-185): `if (MainTickCounter mod Round(net_t1_majorsnapshot.Value * Adjust) = 0) and (MainTickCounter mod Round(net_t1_snapshot.Value * Adjust) <> 0)`
- **Skeleton snapshot** (line 187-188): `if MainTickCounter mod Round(net_t1_deadsnapshot.Value * Adjust) = 0`
- **Heartbeat** (line 190-191): `if MainTickCounter mod Round(net_t1_heartbeat.Value * Adjust) = 0`
- **Bot deltas** (line 193-198): `if (MainTickCounter mod Round(net_t1_delta.Value * Adjust) = 0) and (MainTickCounter mod Round(net_t1_snapshot.Value * Adjust) <> 0) and (MainTickCounter mod Round(net_t1_majorsnapshot.Value * Adjust) <> 0)`

#### B. Per-Player Per-Tick Unicast (HUMAN players only):
For each active HUMAN player (j = 1 to MAX_SPRITES) with Port > 0:

13. **Anti-cheat/FAE** (line 223-243): Every 3 seconds (`MainTickCounter mod (SECOND * 3) = 0`), send FAE challenge if `ac_enable.Value` and no response pending
14. **Cvar sync message** (line 245-246): `if MainTickCounter mod MINUTE = 0 then ServerSyncMsg;`
15. **Ping request** (line 248-263):
    - LAN: `if MainTickCounter mod Round(21 * Adjust) = 0 then ServerPing(j);`
    - INTERNET: `if MainTickCounter mod Round(net_t1_ping.Value * Adjust) = 0 then ServerPing(j);`
16. **Thing snapshot** (line 248-263):
    - LAN: `if MainTickCounter mod Round(12 * Adjust) = 0 then ServerThingSnapshot(j);`
    - INTERNET: `if MainTickCounter mod Round(net_t1_thingsnapshot.Value * Adjust) = 0 then ServerThingSnapshot(j);`

#### C. Adjust Factor Calculation (line 145-153):
```
HeavySendersNum := PlayersNum - SpectatorsNum;
if HeavySendersNum < 5 then
  Adjust := 0.66
else if HeavySendersNum < 9 then
  Adjust := 0.75
else
  Adjust := 1.0;
```
Applied to all network send schedule calculations as `Round(N * Adjust)`.

#### Cvar Default Values (shared/Cvar.pas):
- `net_t1_snapshot = 35` ticks (shared/Cvar.pas)
- `net_t1_majorsnapshot = 19` ticks (shared/Cvar.pas)
- `net_t1_deadsnapshot = 50` ticks (shared/Cvar.pas)
- `net_t1_heartbeat = 135` ticks (shared/Cvar.pas)
- `net_t1_delta = 4` ticks (shared/Cvar.pas)
- `net_t1_ping = 21` ticks (shared/Cvar.pas)
- `net_t1_thingsnapshot = 31` ticks (shared/Cvar.pas)

### UpdateFrame Sub-Steps (server/ServerLoop.pas:270-685)

Called at line 86. This is the core game simulation:

1. **OldSpritePos ring shift** (line 286-290):
   - For each active non-spectator sprite:
   - `for i := MAX_OLDPOS downto 1 do OldSpritePos[j, i] := OldSpritePos[j, i - 1];`
   - `OldSpritePos[j, 0] := Spriteparts.Pos[j];`
   - Maintains ring buffer of MAX_OLDPOS=125 (shared/Constants.pas:223) past positions for lag compensation

2. **Euler physics integration** (line 292-295):
   - For each active non-spectator sprite:
   - `SpriteParts.DoEulerTimeStepFor(j);` — integrate particle system positions

3. **Sprite update** (line 297-299):
   - For each active sprite:
   - `Sprite[j].Update;` — movement, collision, state machines

4. **Bullet update** (line 302-304):
   - For each active bullet:
   - `Bullet[j].Update;` — trajectory, collisions, explosions

5. **Bullet particles** (line 306):
   - `BulletParts.DoEulerTimeStep;` — integrate bullet particle system

6. **Thing update** (line 309-311):
   - For each active thing (flags, weapons, bonuses):
   - `Thing[j].Update;` — physics, collision checks

7. **Bonus spawn** (line 313-359):
   - If not survival/realistic mode and `sv_bonus_frequency.Value > 0`:
   - Per-type frequencies (BERSERKERBONUS_RANDOM=4, FLAMERBONUS_RANDOM=5, etc. from shared/Constants.pas:188-192)
   - Berserker: `if MainTickCounter mod BonusFreq = 0 and Random(4) = 0`
   - Flamer: `if MainTickCounter mod 444 = 0 and Random(5) = 0`
   - Predator: `if MainTickCounter mod BonusFreq = 0 and Random(5) = 0`
   - Vest: `if MainTickCounter mod (BonusFreq div 2) = 0 and Random(4) = 0`
   - Cluster: `if MainTickCounter mod (BonusFreq div 2) = 0 and Random(j) = 0` (j adjusted per game mode)

8. **Bullet time decrement** (line 363-370):
   - `if BulletTimeTimer > -1 then Dec(BulletTimeTimer);`

9. **Game mode-specific scoring** (line 542-583):
   - INF mode: Blue team auto-score every `sv_inf_bluelimit.Value * SECOND` ticks
   - HTF mode: Holding team auto-score every `HTFTime` ticks (sv_htf_pointstime.Value * 60)

10. **Rambo bow respawn** (line 586-609):
    - `if sv_gamemode.Value = GAMESTYLE_RAMBO and MainTickCounter mod SECOND = 0` and no bow on map or held

11. **Flag duplicate cleanup** (line 611-678):
    - CTF/INF: Destroy extra alpha/bravo flags every 2 seconds
    - POINTMATCH/HTF: Destroy extra pointmatch flags every 2 seconds

12. **Demo auto-record** (line 680-684):
    - `if demo_autorecord.Value and not DemoRecorder.Active and Map.Name <> ''`

---

## (3) Client Tick Operations – Exact Ordered Pipeline

**Per-tick sequence** (client/ClientGame.pas:258-382, calls Update_Frame):

### Tick Increment
1. **Tick counters** (line 263-267):
   - `Inc(Ticks);`
   - `Inc(ClientTickCount);`
   - `Inc(MainTickCounter);` (synchronized with server)

### Game State Update
2. **Menu timer decrement** (line 269-270): `if MenuTimer > -1 then Dec(MenuTimer);`
3. **Steam callbacks** (line 273): `SteamAPI_RunCallbacks();`
4. **General update** (line 277): `Update_Frame;` (see sub-steps below)

### Demo/Playback
5. **Demo position save** (line 279-280):
   - `if DemoRecorder.Active and (MainTickCounter mod demo_rate.Value = 0) then DemoRecorder.SavePosition;`
6. **Demo frame save/load** (line 282-289):
   - `if (MapChangeCounter < 0) and (not EscMenu.Active) then`
   - `if DemoRecorder.Active then DemoRecorder.SaveNextFrame;`
   - `if DemoPlayer.Active then DemoPlayer.ProcessDemo;`

### Network
7. **Radio cooldown** (line 291-294):
   - `if (MainTickCounter mod SECOND = 0) and (RadioCooldown > 0) and (sv_radio.Value) then Dec(RadioCooldown);`

8. **Packet adjust factor** (line 296-309):
   - Identical to server (lines 301-306 set Adjust based on HeavySendersNum)

9. **Local sprite input and network send** (line 311-379):
   - Only if `MySprite > 0` and not demo playback:
   - **Connection monitoring** (line 314-340): Track NoHeartbeatTime, timeout at DISCONNECTION_TIME (line 328)
   - **ClientStopMovingCounter** (line 342): `Dec(ClientStopMovingCounter);`

#### Local Sprite Snapshot Send (MySprite only, when alive):

**INTERNET mode** (line 344-360):
- **Snapshot** (line 350-352): `if (MainTickCounter mod Round(7 * Adjust) = 1) and (MainTickCounter mod Round(5 * Adjust) <> 0) then ClientSpriteSnapshot;`
- **Movement snapshot** (line 353-355): `if (MainTickCounter mod Round(5 * Adjust) = 0) or ForceClientSpriteSnapshotMov then ClientSpriteSnapshotMov;`
- **Dead snapshot** (line 358-359): `if MainTickCounter mod Round(30 * Adjust) = 0 then ClientSpriteSnapshotDead;`

**LAN mode** (line 362-376):
- **Snapshot** (line 366-367): `if MainTickCounter mod Round(4 * Adjust) = 0 then ClientSpriteSnapshot;`
- **Movement snapshot** (line 369-371): `if (MainTickCounter mod Round(3 * Adjust) = 0) or ForceClientSpriteSnapshotMov then ClientSpriteSnapshotMov;`
- **Dead snapshot** (line 374-375): `if MainTickCounter mod Round(15 * Adjust) = 0 then ClientSpriteSnapshotDead;`

### Update_Frame Sub-Steps (client/UpdateFrame.pas:31-400)

Called at tick loop line 277:

1. **FAE anti-cheat** (line 40-42): `FaeOnTick();` if enabled
2. **Camera/mouse previous state** (line 44-47): Store for interpolation
3. **Sprite particle integration** (line 54-58):
   - For each active non-spectator sprite (only if `ClientStopMovingCounter > 0`):
   - `SpriteParts.DoEulerTimeStepFor(j);`

4. **Sprite update** (line 60-62):
   - For each active sprite:
   - `Sprite[j].Update;` — local prediction, including input-driven movement

5. **Bullet update** (line 65-72):
   - For each active bullet:
   - `Bullet[j].Update;`
   - `if Bullet[j].PingAdd > 0 then Dec(Bullet[j].PingAdd, 4);` (ping compensation decay)

6. **Bullet particles** (line 74): `BulletParts.DoEulerTimeStep;`

7. **Spark update** (line 76-82):
   - For each active spark:
   - `Spark[j].Update;` and track SparksCount

8. **Thing update** (line 85-87):
   - For each active thing:
   - `Thing[j].Update;`

9. **Screenshot countdown** (line 89-92):
   - `if MainTickCounter mod SECOND = 0 and ScreenCounter <> 255 then ScreenCounter := $FF and (ScreenCounter - 1);`

10. **Spectate target timeout** (line 95-100):
    - `if MainTickCounter mod (SECOND * 5) = 0 and CameraFollowSprite > 0 and Sprite[CameraFollowSprite].DeadMeat and (sv_realisticmode.Value or sv_survivalmode.Value) then CameraFollowSprite := GetCameraTarget();`

11. **Weather effects** (line 103-108):
    - `if r_weathereffects.Value then` apply rain/sandstorm/snow particle spawning

12. **Cursor detection** (line 129-154):
    - For each visible non-spectator sprite (not self, not predator):
    - Calculate distance to cursor; if < CURSORSPRITE_DISTANCE (15), set CursorText and friendly status

13. **Bullet time decrement** (line 157-164): Identical to server
14. **Game mode scoring** (line 189-194): Client-side timeout checks for stats save
15. **SinusCounter update** (line 196): `SinusCounter := SinusCounter + ILUMINATESPEED;`
16. **Grenade effect timer** (line 198-199): `if GrenadeEffectTimer > -1 then Dec(GrenadeEffectTimer);`

### Rendering Phase (GameLoop, line 384-405)

After all ticks processed:

13. **Render safety check** (line 385-386): Clamp PrevRenderTime if it exceeds CurrentTime
14. **Frame render** (line 388-405):
    - `if ShouldRenderFrames and ((CurrentTime - PrevRenderTime) >= MinDeltaTime) then`
    - `RenderFrame(TimeElapsed, FramePercent, Paused);`
    - Updates FPS counter every 30 frames

### Post-GameLoop
15. **Map change** (line 411-415): If MapChanged flag set, reset frame timing

---

## (4) Differences Between Client and Server Drivers

| Aspect | Server | Client |
|--------|--------|--------|
| **Timing source** | GetTickCount64 (OS milliseconds) | SDL_GetPerformanceCounter (nanosecond precision) |
| **Accumulator unit** | Milliseconds, converted to ticks | Real seconds directly |
| **Frame percent calc** | Not computed; no interpolation | Explicitly calculated (line 247) |
| **Rendering** | No render phase | Separate render phase with FramePercent |
| **Demo recording** | SaveNextFrame per tick when active | SavePosition sampled; SaveNextFrame when active |
| **Physics prediction** | Authoritative; no local prediction | Local prediction with Sprite.Update (input-driven) |
| **Network model** | Broadcast with per-player unicasts | Unicast snapshots only (Movement, Position, Dead) |
| **Sprite snapshots sent** | Server sends periodic sprites to all clients | Client sends own sprite snapshots to server |
| **Adjust factor** | HeavySendersNum = PlayersNum - SpectatorsNum | Same calculation |
| **LAN snapshot rate** | 30 ticks (Sprite), 15 (Major), 20 (Skeleton), 59 (Heartbeat), 4 (Delta) | 4 ticks (Snapshot), 3 (Movement), 15-30 (Dead) |
| **INTERNET snapshot rate** | net_t1_snapshot=35, net_t1_majorsnapshot=19, net_t1_deadsnapshot=50, net_t1_heartbeat=135, net_t1_delta=4 | 7 ticks (Snapshot), 5 (Movement), 30 (Dead) |
| **Update_Frame contents** | OldSpritePos shift, physics, bonuses, flags, rambo bow | OldSpritePos NOT shifted (client-side only); camera/cursor logic |

**Key client-side prediction detail** (client/UpdateFrame.pas:54-62):
- Client runs Sprite.Update locally on all sprites (not just MySprite)
- Server state corrections arrive via network packets
- ClientStopMovingCounter gates local particle integration (line 57)

---

## (5) Demo Record/Playback Hook Points

### Server (server/ServerLoop.pas:90-91, 680-684)

- **Frame save** (line 90-91): `if DemoRecorder.Active and MapChangeCounter < 0 then DemoRecorder.SaveNextFrame;` — saves game state after UpdateFrame
- **Auto-record start** (line 680-684): `if demo_autorecord.Value and not DemoRecorder.Active and Map.Name <> '' then DemoRecorder.StartRecord(...)`
- Hook point: After all tick updates, before network sends complete

### Client (client/ClientGame.pas:279-289, shared/UpdateFrame.pas:51-52, 394-399)

- **Position sample** (line 279-280): `if DemoRecorder.Active and (MainTickCounter mod demo_rate.Value = 0) then DemoRecorder.SavePosition;`
- **Frame save** (line 285-286): `if DemoRecorder.Active then DemoRecorder.SaveNextFrame;`
- **Frame load** (line 287-288): `if DemoPlayer.Active then DemoPlayer.ProcessDemo;` — advances demo playback
- **Demo pause check** (UpdateFrame line 51-52): `if DemoPlayer.Active and EscMenu.Active then Exit;` — halts client Update_Frame
- **Auto-record start** (UpdateFrame line 394-399): Same as server
- Hook point: Demo recording within game tick loop; playback processes incoming demo events before tick update

**Demo integration**: Demos record/playback at MainTickCounter granularity. Server demos capture authoritative state; client demos capture local view (includes local prediction). Playback injects demo frames into the network message stream (shared/Demo.pas).

---

## Network Send Summary Table

### Server → All Clients (Broadcast)

| Message Type | LAN Interval | INTERNET Interval | Default INTERNET Value |
|--------------|---|---|---|
| Sprite Snapshot (full) | 30 | net_t1_snapshot | 35 ticks |
| Sprite Snapshot Major | 15 (when not 30) | net_t1_majorsnapshot (when not snapshot) | 19 ticks |
| Skeleton Snapshot | 20 | net_t1_deadsnapshot | 50 ticks |
| Heartbeat | 59 | net_t1_heartbeat | 135 ticks |
| Bot Delta | 4 (when not 30, 60) | net_t1_delta (when not snapshot, major) | 4 ticks |

### Server → Each HUMAN Player (Unicast)

| Message Type | LAN Interval | INTERNET Interval | Default INTERNET Value |
|---|---|---|---|
| Ping Request | 21 | net_t1_ping | 21 ticks |
| Thing Snapshot | 12 | net_t1_thingsnapshot | 31 ticks |
| FAE Challenge | - | SECOND * 3 | 180 ticks |
| Cvar Sync | MINUTE | MINUTE | 3600 ticks |

### Client → Server (Unicast, MySprite only)

| Message Type | LAN Interval | INTERNET Interval |
|---|---|---|
| Sprite Snapshot | 4 | 7 (when not 5) |
| Sprite Snapshot Mov | 3 | 5 (or forced) |
| Sprite Snapshot Dead | 15 | 30 |

All intervals are adjusted by `Adjust` factor: 0.66 (0-4 active), 0.75 (5-8 active), 1.0 (9+ active).

---

## Reimplementation Checklist

### Server Loop

1. Initialize `Timepassed`, `TimeInMil`, system timing
2. **AppOnIdle loop:**
   - Call Number27Timing (measure wall-clock, update TickTime)
   - UDP.ProcessLoop (receive packets)
   - RCON.ProcessCommands
   - **Per TickTime increment (frame-rate-independent loop):**
     - `Inc(MainTickCounter)` (with wrap check at 2147483640)
     - `Inc(ServerTickCounter)`
     - OnClockTick callback
     - Periodic maintenance (1000 ticks: flush flood; 5min: decay warnings; etc.)
     - CvarsNeedSyncing sync
     - **UpdateFrame:**
       - OldSpritePos ring shift (MAX_OLDPOS=125)
       - DoEulerTimeStepFor all non-spectators (particle integration)
       - Sprite[j].Update all
       - Bullet[j].Update all
       - BulletParts.DoEulerTimeStep
       - Thing[j].Update all
       - Bonus spawn (per-type, per-mode)
       - Bullet time decrement
       - INF/HTF scoring checks
       - Rambo bow respawn (GAMESTYLE_RAMBO)
       - Flag duplicate cleanup (CTF/INF/POINTMATCH/HTF)
       - Demo auto-record
     - Post-UpdateFrame: Demo SaveNextFrame (if active)
     - **Network sends (MainTickCounter-based):**
       - Calculate Adjust (0.66/0.75/1.0 based on PlayersNum - SpectatorsNum)
       - **Broadcast (all players):**
         - Sprite snapshot: `MainTickCounter mod Round(30 * Adjust) = 0` (LAN) or `net_t1_snapshot` (INET)
         - Major snapshot: on even 15-ticks (LAN) or 19-ticks (INET), skipping snapshot ticks
         - Skeleton: 20 (LAN) or 50 (INET)
         - Heartbeat: 59 (LAN) or 135 (INET)
         - Bot deltas: 4 (LAN, when not snapshot/60), 4 (INET, when not snapshot/major)
       - **Per HUMAN player unicast:**
         - Ping: 21 (LAN) or net_t1_ping (INET)
         - Thing snapshot: 12 (LAN) or net_t1_thingsnapshot (INET)
         - FAE challenge: every 3 seconds (if ac_enable)
         - Cvar sync: every MINUTE

### Client Loop

1. Initialize SDL performance counter, Accumulator, FramePercent
2. **GameLoop iteration:**
   - Read wall-clock time
   - Calculate FrameTime, clamp to 2 seconds max
   - `dt = 1 / GOALTICKS`
   - Accumulator += FrameTime
   - TickTime += floor(Accumulator / dt)
   - SimTime = (TickTime - TickTimeLast) * dt
   - Accumulator -= SimTime
   - **FramePercent = clamp(Accumulator / dt, 0, 1)** ← Interpolation fraction
   - FAE auth fetch from background thread
   - **Per TickTime increment:**
     - `Inc(MainTickCounter)`
     - `Inc(ClientTickCount)`
     - MenuTimer decrement
     - SteamAPI_RunCallbacks
     - **Update_Frame:**
       - FaeOnTick
       - Store CameraPrev, MousePrev
       - **(MapChangeCounter < 0 only):**
         - SpriteParts.DoEulerTimeStepFor (non-spectators, if ClientStopMovingCounter > 0)
         - Sprite[j].Update all
         - Bullet[j].Update all, PingAdd decay
         - BulletParts.DoEulerTimeStep
         - Spark[j].Update all
         - Thing[j].Update all
         - Screenshot counter (every SECOND)
         - Spectate timeout (every 5 seconds)
         - Weather effects
       - Cursor/player text detection
       - Bullet time decrement
       - Game mode scoring timeouts
       - SinusCounter increment
       - GrenadeEffectTimer decrement
     - Demo position sample (MainTickCounter mod demo_rate)
     - Demo frame save/load (if active/playing)
     - Radio cooldown (every SECOND)
     - Calculate Adjust factor (identical to server)
     - **Local sprite network send (if MySprite > 0, not demo playback):**
       - NoHeartbeatTime tracking
       - Timeout detection (DISCONNECTION_TIME)
       - ClientStopMovingCounter decrement
       - **INTERNET mode:**
         - Snapshot: `MainTickCounter mod Round(7 * Adjust) = 1` AND `MainTickCounter mod Round(5 * Adjust) <> 0`
         - Movement: `MainTickCounter mod Round(5 * Adjust) = 0` OR ForceClientSpriteSnapshotMov
         - Dead: `MainTickCounter mod Round(30 * Adjust) = 0`
       - **LAN mode:**
         - Snapshot: `MainTickCounter mod Round(4 * Adjust) = 0`
         - Movement: `MainTickCounter mod Round(3 * Adjust) = 0` OR ForceClientSpriteSnapshotMov
         - Dead: `MainTickCounter mod Round(15 * Adjust) = 0`
   - **Render phase (outside tick loop, timing-based):**
     - Check if MinDeltaTime elapsed since last render
     - **RenderFrame(TimeElapsed, FramePercent, GamePaused)** ← Interpolate visuals with FramePercent
     - Update FPS counter (every 30 frames)
   - Sleep if r_sleeptime > 0
   - **If MapChanged:** ResetFrameTiming

---

**Document version**: Based on OpenSoldat source at commit/branch as of this extraction.