# OpenSoldat → TypeScript/Web: Total Port Plan

**Status:** plan of record. Supersedes nothing yet; no rewrite code written.
**Companion specs:** [`docs/rewrite-reference/`](rewrite-reference/README.md) — the behavioral contract this plan implements.
**Decision graph:** goal node 1 → options → decision → milestone actions.

---

## 0. The four locked decisions

| Axis | Choice | Consequence |
|------|--------|-------------|
| **Language / runtime** | **TypeScript** (strict), Node 22 *or* Bun for tooling | One language for sim + client + server + mods. f64-only numbers — see §2. |
| **Network/data compat** | **Clean break, versioned schema** | New servers/clients form their own population. Old `.demo` files dropped (optional converter later). Frees us from the scrambled `TGun`, `Keys16`, fixed wire caps. |
| **Port strategy** | **Faithful-first, then refactor** | Phase A mirrors the Pascal globals + ports the integrator ~line-by-line to nail *feel*, gated by a golden-master test. Clean architecture comes only after feel is locked. |
| **Distribution** | **Web-first** | Browser is the primary target. Renderer = WebGL2/WebGPU, transport = WebTransport, audio = WebAudio. Native (Tauri/Electron wrapper) is a later, cheap add-on. |

### Verified ground truth (corrected against source — the loose synthesis had two wrong)

| Constant | Value | Source |
|----------|-------|--------|
| `DEFAULT_GOALTICKS` | **60** Hz fixed tick | `shared/Constants.pas:27` |
| `MAX_SPRITES` = `MAX_PLAYERS` | **32** | `shared/network/Net.pas:104`, `Sprites.pas:19` |
| `MAX_BULLETS` | **254** (synthesis wrongly said 300) | `shared/mechanics/Sprites.pas:20` |
| `MAX_SPARKS` | **558** | `shared/mechanics/Sprites.pas:21` |
| `MAX_THINGS` | **90** (synthesis wrongly said 256) | `shared/mechanics/Sprites.pas:22` |
| `NUM_PARTICLES` (per ParticleSystem) | **560** | `shared/Parts.pas:31` |
| `RKV` (Verlet damping) | **0.98** | `shared/Parts.pas:32` |
| `SURFACECOEFX/Y` | **0.970** | `shared/mechanics/Sprites.pas:24-25` |
| `sv_gravity` (CVAR_SYNC) | **0.06** | `shared/Cvar.pas:985` |
| Physics scalar type | Pascal **`Single`** (IEEE-754 f32) | `shared/Parts.pas:38,47-49` |

The last row is the whole ballgame for §2.

---

## 1. Target architecture

### 1.1 Monorepo (pnpm workspaces + Vite + Vitest)

```
soldat-ts/
  packages/
    sim/          # @soldat/sim — the deterministic simulation. NO DOM, NO node APIs.
                  #   Pure TS. Imports nothing platform-specific. Both client & server depend on it.
    protocol/     # @soldat/protocol — versioned wire schema (protobuf-es) + (de)serialization.
    client/       # @soldat/client — browser app: PixiJS renderer, WebAudio, input, WebTransport client,
                  #   prediction/interpolation, HUD/menus.
    server/       # @soldat/server — authoritative dedicated server (Node/Bun/Deno), WebTransport host,
                  #   bans/RCON/lobby, mod host.
    assets/       # @soldat/assets — asset pipeline: convert Soldat gfx/sfx/maps to web formats; .PMS loader.
    mod-api/      # @soldat/mod-api — sandboxed scripting surface (replaces PascalScript). Shared types.
  tools/
    golden-master/  # Pascal instrumentation harness + TS replay comparator (see §2.3).
    pms-tools/      # .PMS inspector/validator CLI.
  apps/
    play/         # Vite app shell that mounts @soldat/client (the actual web game).
```

**Hard rule:** `@soldat/sim` is import-pure and platform-free. If it can't run identically under `node`, `bun`, the browser main thread, and a Web Worker, it's a bug. This is what makes client prediction == server authority trivially true (same code, same f64, both sides).

### 1.2 Concrete stack

| Concern | Choice | Why / replaces |
|---------|--------|----------------|
| Language | TypeScript 5.x, `strict`, `noUncheckedIndexedAccess` | — |
| Build/dev | Vite + pnpm + Vitest + tsx | replaces CMake/Lazarus |
| Renderer | **PixiJS v8** (WebGPU w/ WebGL2 fallback) for sprites/skeleton; custom `Mesh` for map polygons | replaces `Gfx.pas`/dglOpenGL |
| Audio | **WebAudio** (`AudioContext`, `PannerNode` for positional) | replaces `Sound.pas`/OpenAL |
| Input | `KeyboardEvent`/`PointerEvent` + Gamepad API, rebindable | replaces `Input.pas`/SDL2 |
| Transport | **WebTransport** (HTTP/3: datagrams = unreliable, streams = reliable); WebRTC DataChannel fallback | replaces GameNetworkingSockets/UDP |
| Wire schema | **protobuf-es** (`@bufbuild/protobuf`), every message carries `protocolVersion` | replaces hand-rolled packed records |
| Server runtime | Node 22 + `@fails-components/webtransport`, **or** Deno (native WebTransport) | replaces `soldatserver` |
| Mod sandbox | Web Worker (client FX) / `isolated-vm` or QuickJS-wasm (server logic) | replaces PascalScript/ScriptCore |
| Map format | `.PMS` **read-only loader** (keep the existing map library) | per `pms-map-format.md` |
| Hash/CRC | `crc-32` npm pkg, matched to Pascal CRC32 for `.PMS` validation | — |
| Persistence | server: SQLite (`better-sqlite3`) for bans/stats; client: IndexedDB for config/demos | replaces flat files |

---

## 2. Determinism strategy — the crux

### 2.1 The problem
Pascal physics uses `Single` (32-bit float). JS `number` is f64. Naïve f64 math will **not** reproduce Pascal trajectories bit-for-bit, and Soldat's collision response is nonlinear (`Velocity := Velocity - Perp` in-place), so small divergences compound chaotically over a few hundred ticks.

### 2.2 The resolution (this is the clever part, and it's only possible *because* we chose clean-break)
We do **not** need bit-identical-to-Pascal math for netcode. Clean break + identical TS on both client and server means **internal determinism is free** — both sides run the same f64 code. We need f32-fidelity only for **two narrow purposes**:
1. **Validating the port is faithful** (does it feel like Soldat?) — handled by the golden-master test.
2. **Guarding against chaotic divergence in long matches** — handled by choosing a stable scalar policy and snapshotting.

So the design:

- **`Scalar = number`** everywhere in `@soldat/sim`, computed in **f64** in production (fast, no `Math.fround` tax).
- A dev/test compile flag **`STRICT_F32`**: when on, a tiny `f32(x) = Math.fround(x)` is threaded through the integrator and collision math via a hygienic codegen/lint rule, so the sim reproduces Pascal `Single` results **exactly**. Used only by the golden-master suite and per-function unit tests.
- **Per-function exact tests**: port `ParticleSystem.DoEulerTimeStep`, `Verlet`, `SatisfyConstraints`, `Sprite.CheckMapCollision`, `Bullet` ballistics — each gets a fixtures-based unit test (inputs dumped from instrumented Pascal → assert f32-exact output). This proves each ported function is correct in isolation.
- **System-level golden master with windowed tolerance** (§2.3): full-sim replay tracks Pascal within ε for the first N ticks before chaos; we assert ε-tracking over a window, not eternal bit-equality.
- **Decision deferred, not dodged:** if production f64 ever produces a *felt* difference, we flip `STRICT_F32` on in production for the sim hot path only. The architecture makes that a one-flag change, not a rewrite.

### 2.3 Golden-master harness (`tools/golden-master/`)
1. **Instrument the original Pascal** (a throwaway `{$IFDEF GOLDENMASTER}` build): in `server/ServerLoop.UpdateFrame`, after each sub-step, dump per-tick state — every sprite's particle positions/velocities, bullets, things — plus the exact input stream and RNG seed, to a binary trace.
2. **Drive a scripted scenario**: bot-only or replayed-input match on a fixed map (e.g. `ctf_Ash`), ~600 ticks (10 s).
3. **Replay in TS**: feed the same inputs+seed into `@soldat/sim` with `STRICT_F32` on.
4. **Compare**: assert per-tick particle positions match within ε (start ε=0 for f32-exact functions; widen only where documented float-order differences exist). Report first-divergence tick + subsystem.
5. **CI gate**: golden-master must pass before any milestone that touches physics is "done."

This harness is **milestone M2's primary deliverable** and the single most important de-risking artifact in the whole project.

---

## 3. Faithful-port discipline (Phase A data model)

Mirror the Pascal globals so porting is mechanical and reviewable against the source:

- **1-indexed, sentinel-0 preserved.** `sprites: Sprite[]` has length `MAX_SPRITES+1`; index 0 is the "none/not-joined" sentinel exactly as Pascal uses `SpriteNum=0`. We keep this through Phase A so cross-references (`Bullet.Owner`, `Thing.HoldingSprite`) port verbatim. It gets abstracted away in Phase C.
- **Struct-of-Arrays for hot state.** `ParticleSystem` uses `Float32Array` for `posX/posY/oldX/oldY/forceX/forceY` (length `NUM_PARTICLES+1`) — this *also* gives us the f32 storage boundary for free.
- **One module per Pascal unit** in `@soldat/sim`, same function names, ported top-to-bottom, with `// PORT: shared/mechanics/Sprites.pas:1234` provenance comments so a reviewer can diff against the original.
- **`World` object** holds the former globals (`sprites`, `bullets`, `things`, `sparks`, `map`, `spriteParts`, `bulletParts`, tick counters). Passed explicitly instead of being module globals — the *only* concession to cleanliness in Phase A, and it's what lets the server hold N independent worlds and the golden master replay deterministically.

---

## 4. Subsystem port map (Pascal → TS → spec → milestone)

| Pascal source | `@soldat/sim` (or pkg) module | Reference spec | Milestone |
|---------------|-------------------------------|----------------|-----------|
| `shared/Constants.pas` | `sim/constants.ts` | global-state-and-caps | M0 |
| `shared/Parts.pas` (ParticleSystem) | `sim/physics/particles.ts` | physics-constants, tick-pipeline | **M2** |
| `shared/Vector.pas`, `Calc.pas` | `sim/math/vec2.ts`, `sim/math/calc.ts` | physics-constants | M2 |
| `shared/mechanics/Sprites.pas` | `sim/entities/sprite.ts` | physics-constants, tick-pipeline | **M2/M3** |
| `shared/mechanics/Control.pas` | `sim/entities/control.ts` | physics-constants | M3 |
| `shared/Anims.pas` + `.inc` | `sim/anim/animations.ts` | — | M3 |
| `shared/mechanics/Bullets.pas` | `sim/entities/bullet.ts` | physics-constants, wire-protocol | M4 |
| `shared/Weapons.pas` | `sim/weapons/guns.ts` (+ data tables) | physics-constants | M4 |
| `shared/mechanics/Sparks.pas` | `sim/entities/spark.ts` | — | M4 |
| `shared/mechanics/Things.pas` | `sim/entities/thing.ts` | global-state-and-caps | M4 |
| `shared/PolyMap.pas`, `MapFile.pas` | `assets/pms-loader.ts`, `sim/map/polymap.ts` | pms-map-format | **M1** |
| `shared/Waypoints.pas` | `sim/ai/waypoints.ts` | pms-map-format | M5 |
| `shared/AI.pas` | `sim/ai/bot.ts` | — | M5 |
| `shared/Cvar.pas`, `Command.pas`, `Console.pas` | `sim/config/cvars.ts`, `client/console.ts` | tick-pipeline (CVAR_SYNC) | M3/M6 |
| `shared/Game.pas` globals | `sim/world.ts` (`World`) | global-state-and-caps | M0/M2 |
| `shared/network/*` | `protocol/*` + `server/net`, `client/net` | wire-protocol | **M6** |
| `shared/Demo.pas` | `sim/demo.ts` (record `World` deltas) | tick-pipeline | M6 |
| `client/Gfx.pas`, `GameRendering.pas` | `client/render/*` | — | M1/M3 |
| `client/MapGraphics.pas` | `client/render/map.ts` | pms-map-format | M1 |
| `client/GostekGraphics.pas` + `.inc` | `client/render/gostek.ts` | — | M3 |
| `client/InterfaceGraphics.pas` | `client/ui/hud.ts` | — | M7 |
| `client/Input.pas` | `client/input.ts` | wire-protocol (input msg) | M3 |
| `client/Sound.pas` | `client/audio.ts` | — | M7 |
| `client/GameMenus.pas` | `client/ui/menus.ts` | — | M7 |
| `server/Server.pas`, `ServerLoop.pas` | `server/loop.ts` | tick-pipeline | M6 |
| `server/Rcon.pas`, `BanSystem.pas`, `LobbyClient.pas` | `server/admin/*` | — | M7 |
| `server/scriptcore/*` | `mod-api/*` + `server/mods/*` | pascalscript-api | M8 |
| `CMakeLists.txt`, `*.lpi` | pnpm/Vite config | — | M0 |

---

## 5. Milestones (acceptance-gated)

Each milestone ends with a **demo** and **acceptance criteria**. Nothing is "done" until its criteria pass in CI.

### M0 — Bootstrap (foundation)
Monorepo, pnpm workspaces, Vite app shell, Vitest, CI (typecheck + test + lint), `@soldat/sim` skeleton with `World`, constants ported from `Constants.pas`, `Scalar`/`STRICT_F32` infra.
**Accept:** `pnpm test` green; empty app boots in browser; CI passes.

### M1 — Map loads and renders
`.PMS` loader (byte-exact per `pms-map-format.md`, CRC32 validated), `PolyMap` in-memory model, PixiJS render of map polygons + scenery + parallax background, free-fly camera.
**Accept:** load a stock `.PMS`, render it pixel-recognizably vs the original; CRC32 matches Pascal for 5 sample maps; `pms-tools` validates the whole stock map library.

### M2 — Physics core + golden master ⭐ (the feel milestone)
Port `Parts.pas` ParticleSystem (Verlet/Euler/constraints) and the movement-critical paths of `Sprites.pas` (gravity, friction, `CheckMapCollision`, collision response). Build the golden-master harness (§2.3). Headless — no rendering.
**Accept:** per-function f32-exact unit tests pass; golden master tracks instrumented Pascal within ε for ≥600 ticks on 3 maps; first-divergence report generated.

### M3 — It moves like Soldat (single-player, no net)
Port `Control.pas` (input→forces, jump/jetpack/crouch/prone/roll), `Anims.pas`, Gostek skeleton render (`GostekGraphics`), browser input mapping, render interpolation at `FramePercent`.
**Accept:** a human can run/jump/jetpack around a map and **it feels like Soldat** (side-by-side video check); render interpolation smooth at high FPS with 60 Hz sim.

### M4 — Combat (weapons, bullets, things)
Port `Bullets.pas` (ballistics, ricochet, penetration, collision vs map/sprite/thing, damage), `Weapons.pas` tables (normal+realistic), `Sparks.pas`, `Things.pas` (flags, kits, stationary guns). Local-only.
**Accept:** all 20+ weapons fire with correct stats; bullets collide & damage; CTF flag grab/capture works locally; thin-geometry tunnelling behaves as the original (documented quirk preserved or consciously fixed).

### M5 — Bots (single-player vs AI)
Port `AI.pas` + `Waypoints.pas` (load waypoints from `.PMS`). Bots drive the same `Control` path as humans.
**Accept:** a playable bot match (DM + CTF) on stock maps with believable bot movement/aim; waypoint format read-compatible.

### M6 — Netcode ⭐ (the multiplayer milestone)
Design the clean-break protocol (`protocol/` proto schemas: input, full/major/delta sprite snapshots, skeleton, thing, heartbeat, chat, handshake — modeled on `wire-protocol.md` but versioned). WebTransport client+server. Authoritative server loop (`tick-pipeline.md` order), client prediction + reconciliation for the local sprite, interpolation for remotes, CVAR_SYNC. Dedicated server binary. Demo record/replay of `World`.
**Accept:** 2+ browsers on one dedicated server play a smooth match over real internet; predicted local movement reconciles without visible rubber-banding at 100 ms RTT; protocol carries a version handshake.

### M7 — A complete game (modes, HUD, menus, audio)
Game-mode logic (DM/PM/TDM/CTF/INF/HTF/Rambo), `InterfaceGraphics`→HUD, scoreboard, `GameMenus`→UI, server browser/lobby, `Sound.pas`→WebAudio (positional), RCON/bans/admin.
**Accept:** full match lifecycle (join→play→map change→scoreboard) across all modes; positional audio; in-browser server browser lists and joins servers.

### M8 — Modding + content pipeline + polish
`mod-api` sandboxed scripting mirroring the `pascalscript-api.md` object model & event names (`OnPlayerDamage`, `OnJoin`, `OnFlagGrab`, …) in TS; server-side mod host (`isolated-vm`); asset import pipeline; weather/FX; perf pass; optional Tauri native wrapper.
**Accept:** a sample community-style mod runs (e.g. a gun-game / zombie mod) using the new API; asset pipeline imports a stock install; stable 60 Hz under load.

### M9 (Phase C) — Refactor toward clean architecture
With feel + net + modes proven and golden-master-protected, incrementally retire the 1-indexed global mirror: extract entity collections, decouple `Sprite↔Bullet↔Thing` cross-refs, optionally introduce a lightweight ECS — **each step gated by the golden master and gameplay regression tests.**
**Accept:** global sentinel-0 mirror removed from at least the Things subsystem (the §node-5 pilot) with zero golden-master regression.

---

## 6. Networking design (clean-break)

- **Transport:** WebTransport. Datagrams for snapshots/deltas (unreliable, latest-wins). Reliable bidirectional streams for handshake, cvar sync, chat, heartbeat/scoreboard, map transfer.
- **Schema:** protobuf-es. Every packet: `{ protocolVersion, tick, payload }`. Snapshot family mirrors Soldat's full/major/delta/skeleton structure (it's a good design) but as evolvable messages, *not* memory layout. No scrambled structs, no `MAX_*` baked into the wire — counts are length-prefixed.
- **Authority:** server-authoritative, exactly `tick-pipeline.md`'s order. Client sends input (clean `InputFrame`, not the legacy `Keys16` bitmap — though we keep the same logical buttons). Client predicts only its own sprite; remotes are interpolated between the last two authoritative snapshots.
- **Reconciliation:** ring buffer of unacknowledged inputs; on snapshot, rewind local sprite to server state and re-simulate buffered inputs. (Modernization win the clean break buys us — the original has looser correction.)
- **Lag comp:** server keeps an `OldSpritePos` history ring (port the concept from `wire-protocol.md`) for hit validation; rewind to the shooter's `PingTicks` for bullet checks.
- **Anti-cheat:** server-side bullet replay/validation (speed/distance/ammo/timing) instead of Fae's challenge-response — easier and stronger in an authoritative model where the client is never trusted.

## 7. Rendering design

- **Layers (back→front):** background gradient → parallax scenery → back map polygons → things → sprites/Gostek → bullets/sparks/particles → front map polygons → front scenery → weather → HUD. (Matches `GameRendering` order.)
- **Interpolation:** render reads `prevWorld` + `currWorld`, lerps positions by `FramePercent`. Sim and render fully decoupled (sim fixed 60 Hz, render at display rate).
- **Gostek:** the layered skeleton character — bone transforms drive PixiJS sprite children; port the `GostekGraphics.inc` part/texture index tables to a data file.
- **Map polygons:** vertex-colored, textured `Mesh` (triangle soup from `.PMS`), uploaded once per map.

## 8. Modding (PascalScript replacement)
- Keep the **event names and object model** from `pascalscript-api.md` (`Game`, `Map`, `Players[]`, `Bullets[]`, `Weapons`) so mod authors port mentally 1:1, but the language becomes sandboxed **TypeScript/JS**.
- **Server logic mods:** run in `isolated-vm`/QuickJS with a frozen API and a per-tick CPU budget (a hung `OnClockTick` can't stall the server — the original's worst failure mode, fixed by design).
- **Client FX mods:** Web Worker, no access to net/authority.
- Preserve event **dispatch order and damage-cascade semantics** documented in the spec (scripts depend on them).

## 9. Asset & map pipeline
- `.PMS` maps: **read-only loader**, keep the existing library working (CRC32-validated). New map format optional, later.
- Graphics/sounds: `@soldat/assets` build step converts a stock OpenSoldat install (PNG/`.bmp`→texture atlases via the existing `BinPack` bin-packer logic; sounds→`.ogg`/WebAudio buffers). Licensing note: ship the *engine*, point users at their own asset install for v1.

## 10. Testing strategy
1. **Per-function f32-exact unit tests** (the integrator, collision, ballistics) — Vitest + Pascal-dumped fixtures.
2. **Golden-master system test** (§2.3) — CI gate for any physics-touching change.
3. **Protocol round-trip tests** — encode/decode every message; version-skew tests.
4. **Headless sim soak** — run `@soldat/sim` for 100k ticks with bots, assert no NaN/Inf, stable energy, no divergence between two independently-stepped `World`s fed identical input (proves internal determinism).
5. **Gameplay regression** — scripted scenarios (grab flag, kill, respawn) assert outcomes.
6. **Manual feel review** — side-by-side video vs original at M3/M4 (no automated substitute for "feels right").

## 11. Risk register

| Risk | Severity | Mitigation |
|------|----------|------------|
| f64≠f32 breaks feel | High | `STRICT_F32` mode + per-function exact tests + golden master; flip f32 on in prod hot path if needed (one flag) |
| GC pauses jitter the 60 Hz sim | Med | SoA `Float32Array` world (near-zero per-tick allocation); object pools for bullets/sparks; sim never allocates in the hot loop |
| WebTransport browser/server maturity | Med | WebRTC DataChannel fallback; pick Deno/Node lib with HTTP/3 support; abstract transport behind `@soldat/protocol` |
| Gostek skeleton fidelity is fiddly | Med | Port `GostekGraphics.inc` tables verbatim to data; visual diff at M3 |
| Scope (this is a whole game) | High | Acceptance-gated milestones; M1–M5 are single-player and independently shippable as a tech demo |
| Asset licensing | Med | Engine-only distribution; user supplies assets for v1 |
| Mod ecosystem won't port | Med | Keep API names/semantics identical; provide a porting guide; it's a known clean-break cost |

## 12. First two weeks (concrete task list)

1. `pnpm` monorepo scaffold; `@soldat/sim`, `@soldat/protocol`, `apps/play` skeletons; Vite + Vitest + CI. *(M0)*
2. Port `Constants.pas` → `sim/constants.ts` (verified caps from §0). *(M0)*
3. `Scalar`/`STRICT_F32` infra + `vec2.ts` (port `Vector.pas`/`Calc.pas`) with f32-exact tests. *(M0/M2)*
4. `.PMS` loader in `@soldat/assets` + `pms-tools` CLI; validate CRC32 against 5 stock maps. *(M1)*
5. PixiJS map-polygon `Mesh` render; load+draw one stock map with a free camera. *(M1)*
6. Stand up `tools/golden-master/`: add the `{$IFDEF GOLDENMASTER}` trace dump to a local Pascal build; capture a 600-tick bot trace on one map. *(M2)*
7. Port `ParticleSystem.DoEulerTimeStep` + `Verlet` + `SatisfyConstraints`; make the per-function f32-exact tests pass. *(M2)*
8. Begin `Sprites.pas` movement port; get golden master tracking for the first 100 ticks of the captured trace. *(M2)*

When M2's golden master holds for 600 ticks, the riskiest unknown in the entire project is retired — everything after is "a lot of careful work," not "a research question."
