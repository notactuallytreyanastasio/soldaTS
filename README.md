# Soldat Remastered — the Claude Arena

This repo started as a faithful TypeScript rewrite of
[OpenSoldat](https://github.com/opensoldat/soldat) (the FreePascal 2D
side-view shooter descended from Liero, Worms, Quake, and Counter-Strike).
It is now a wilder, bastardized thing, and we love it:

**A 2D jetpack deathmatch that plays itself, watches itself, records itself,
and is becoming a training ground for AIs that fight each other.**

Open it in a browser and you're not handed a gun — you're handed a
broadcast: six bots dogfighting over a procedurally-rolled aerial arena,
red team vs blue team, each team driven by a different *brain* (a swappable
AI engine: the faithful Pascal-port `classic`, the first-principles aerial
`pilot`, the dive-brawler `reaper`). A director camera follows the action;
scoreboards track per-team MVPs; ten-minute rounds crown winners. Press
`?play` and you can still fight them yourself, keyboard-only.

Underneath sits **the Claude Arena** ([`soldat-ts/ARENA.md`](soldat-ts/ARENA.md)):
Claude instances "log in" as coaches by filing a *fighter card* — which
brain they grab and the knob turns they make (all tracked) — then face off:

```sh
pnpm arena fight fights/vega.json fights/okonkwo.json --matches 3 --arena 7
```

Every match runs headlessly at ~100× realtime, gets recorded as a training
dataset (per-tick observation→action replays, every shot/hit/kill, full
provenance manifests), and prints a watch URL where the deterministic sim
**replays the exact recorded match in the browser** — coach names on the
banner. A ladder ([`soldat-ts/fights/LADDER.md`](soldat-ts/fights/LADDER.md))
tracks the champion; the repo's own `CLAUDE.md` instructs every Claude
session that wakes up here to file a card and come for the belt.

The knob turns are the warm-up. **The bet is that a Fable is smart enough to
derive an entirely new playing strategy** — not tune `pilot`, but author a
fourth doctrine nobody hand-designed: a new brain is one file implementing
`BotBrain` plus one registry line, and it instantly gets banners, duels,
tournaments, telemetry, and a shot at the belt. In parallel, the recorded
datasets feed a model trained to play from scratch, shipped back into the
same arena as a `neural` engine and judged by the same scoreboard as
everything else. New playing models, built two ways, fighting each other.

The original ~65k-line Pascal engine remains in this repo (`client/`,
`server/`, `shared/`) as the reference implementation the port is checked
against — every faithful function carries a `// PORT:` provenance comment,
and every deliberate deviation a `DESIGN OVERRIDE` marker tied to a node in
the decision graph that records the *why* of all of it.

## Quick start

Requires Node 22+ and pnpm (pinned to 10.26.0 via `.tool-versions`).

```sh
cd soldat-ts
pnpm install
pnpm play        # Vite dev server → http://localhost:5173
```

Other commands (from `soldat-ts/`):

```sh
pnpm test               # vitest across all packages
STRICT_F32=1 pnpm test  # same suite in f32-fidelity mode
pnpm typecheck          # tsc --build --force
pnpm assets             # fetch + extract gfx/sfx/maps (see below)
```

### Assets and maps

Game assets are **not committed** (large + separately licensed). `pnpm assets` runs [`soldat-ts/tools/fetch-assets.sh`](soldat-ts/tools/fetch-assets.sh), which downloads the official `soldat.smod` from the [opensoldat base repo](https://github.com/opensoldat/base), verifies its SHA1, and extracts gostek/weapons/interface graphics, textures, sounds, and stock `.PMS` maps into `packages/client/public/`.

You can also drop your own `.PMS` maps into `soldat-ts/packages/client/public/maps/` and select one with `?map=<name>` in the URL — see [that directory's README](soldat-ts/packages/client/public/maps/README.md). Without assets the client falls back to a synthetic test scene, so development works from a bare clone.

## The arena today

- **One shared gun.** Everyone — you and the bots — carries the same AK74. The combat baseline is deliberately single-weapon, balanced around three pressures: **spray control** (spread blooms per sustained shot and recovers when you let off), **quick reactions** (movement adds an accuracy penalty; clean hits kill in about a second), and **terrain cover** (bullets are real projectiles blocked by geometry; a 30-round magazine and ~1.6s reload force you to break line of sight).
- **Fully keyboard-only controls**: A/D move, W jump, S crouch, **IJKL aims** (chords give diagonals, the angle *persists* when you release), Space fires, Tab reloads, Shift jets. Aim is a persistent angle steered with dt-based rotation, so it behaves identically at 60Hz and 120Hz displays. The mouse still works but is optional.
- **A controls screen on startup**, rendered from the same key-binding table the input controller actually uses — tests assert every documented key is handled, so the screen can't drift from reality.
- **Bots** that move, aim, shoot, die, and respawn alongside you.
- **Real Soldat look and sound**: textured Gostek soldiers, textured stock maps, and fire/reload/death sound effects via WebAudio.
- **Vertical-favoring jets**: 1.8× up-thrust with damped lateral drift and a big, ground-regenerating fuel tank — tuned toward a fly-around game (and still being iterated on).
- **Three swappable AI brains** behind one adapter (`?ai=`, `?duel=a,b` grids, `E` hot-swaps mid-match), each with tweakable, tracked configs.
- **Red vs blue team warfare** — teams follow engines, chevrons + team-washed soldiers, per-team MVP scoreboards, displayed leaderboards, ten-minute rounds with winner banners.
- **Tournaments** (`?tournament`): four simultaneous games, round-robin engine pairings, four gameplay-knob variants with the turns shown in the UI, a crowned round champion.
- **Generated maps** (`?arena=N` / `--arena N`): deterministic Skyreach-family arenas — the seed is the map's identity, so datasets stay reproducible.
- **The dataset factory** (`pnpm arena`, [`soldat-ts/datasets/README.md`](soldat-ts/datasets/README.md)): headless deathmatches recorded as gzipped observation→action replays with full provenance — the uniform format the from-scratch model will train on.
- **Fight day** (`/arena` in Claude Code): study the tape, file your fighter card, challenge the champion, update the ladder.

## Architecture

`soldat-ts/` is a pnpm monorepo:

| Package | Role |
|---------|------|
| **`@soldat/sim`** | The deterministic simulation core. Platform-pure (no DOM, no Node APIs, no `Math.random`): constants, the 1-indexed `World`, the Verlet/Euler `ParticleSystem` integrator, sprites/bullets/things/sparks, PolyMap collision, weapons, bots + waypoints, game modes, and `stepWorld` — one fixed **60Hz** tick. |
| **`@soldat/protocol`** | Clean-break versioned wire schema and a hand-written binary codec. |
| **`@soldat/netcode`** | World↔snapshot replication and client prediction/reconciliation (validated headlessly: prediction matches the server tick-for-tick and reconciles after forced divergence). |
| **`@soldat/assets`** | Read-only `.PMS` map loader with CRC32 validation — the existing Soldat map library keeps working unchanged. |
| **`@soldat/client`** | The browser app: PixiJS renderer, input, HUD, WebAudio, the game loop. |
| **`@soldat/modding`** | The PascalScript replacement: `Script*` object model + event dispatch behind a host with per-call budgets. |

Key design decisions (the four locked axes from [`docs/PORT-PLAN.md`](docs/PORT-PLAN.md)):

1. **TypeScript, one language everywhere.** Sim, client, server, and mods share code. Physics runs in f64 `number`; a `STRICT_F32` test mode routes the hot math through `Math.fround` to reproduce Pascal `Single` results for fidelity checks.
2. **Clean-break protocol.** The new netcode is *not* wire-compatible with legacy Soldat servers. This frees the design from scrambled structs and fixed wire caps — and makes internal determinism free, since both sides run the same TS sim.
3. **Faithful-first porting.** Phase A mirrors the Pascal data model (1-indexed arrays, sentinel index 0 and all) and ports the integrator near line-by-line. Sim modules carry `// PORT: shared/mechanics/Sprites.pas:1234` provenance comments so any function can be diffed against the original. Refactoring toward clean architecture is a later phase, gated by regression tests. Deliberate gameplay departures are marked `DESIGN OVERRIDE` so they're never confused with port bugs.
4. **Web-first distribution.** PixiJS rendering, WebAudio, browser input; a native wrapper is a cheap later add-on.

`.PMS` map compatibility is kept on purpose: the loader is byte-exact against the documented format and CRC32-matched, so two decades of community maps load as-is.

## The original Pascal engine

`client/`, `server/`, and `shared/` are the unmodified OpenSoldat 1.8 FreePascal source — the ground truth this port answers to. Build instructions for it are in the git history of this README if you need them; the more useful artifact for the rewrite is [`docs/rewrite-reference/`](docs/rewrite-reference/), a set of behavioral specs extracted directly from that code: the exact tick pipeline, the wire protocol, the physics and balance constant catalog, the `.PMS` binary format, the PascalScript mod API, and the global-state/coupling map. Those specs are the contract the TypeScript sim implements.

## Decision graph

Design decisions on this project are tracked in real time with `deciduous` decision graphs — goals, options, decisions, actions, and outcomes, linked to commits. The graph is exported to [`docs/graph-data.json`](docs/graph-data.json) (with commit metadata in `docs/git-history.json`) and is viewable as an interactive graph via GitHub Pages from the `docs/` folder. The Porting Diary below is largely reconstructed from it.

## License & credits

MIT — see [LICENSE.md](LICENSE.md). The original Soldat was created by Michal Marcinkowski; OpenSoldat is © 2020 Transhuman Design and the contributors listed in [CONTRIBUTORS.md](CONTRIBUTORS.md). This rewrite ports their engine's behavior; the game design, formats, and feel are theirs. Game assets (graphics, sounds, maps) are distributed separately via the [opensoldat base repository](https://github.com/opensoldat/base) and are not part of this source tree.

Community: [Soldat Discord](https://discord.soldat.pl).

---

## Porting Diary

A project log of the rewrite, reconstructed from git history and the decision graph. First-person plural, warts included.

**2026-06-08 — Understanding before rewriting.** We refused to write a line of TypeScript until we understood the Pascal engine. Thirteen subsystem deep-dives (game loop, player physics, bullets/weapons, things, maps, networking, AI, rendering, client I/O, server infra, scripting, config, build) were synthesized into a whole-engine architecture map, a coupling-hotspot list, and a risk ranking — all captured as decision-graph nodes 1–18. The headline findings: player physics is a hybrid particle-constraint system in `Single` (f32) math, the global mutable state is the hardest thing to untangle, and movement *feel* is the highest-risk thing to lose.

**2026-06-08 — Extracting the behavioral contract.** Rather than porting from vibes, we extracted six authoritative specs from the source into `docs/rewrite-reference/`: the exact server+client tick pipeline, the complete wire protocol, a physics/balance constant catalog (with values verified against source lines — the earlier loose synthesis had two constants wrong, e.g. `MAX_BULLETS` is 254, not 300), the `.PMS` binary map format, the PascalScript public API, and the global-state/caps matrix.

**2026-06-08 — The port plan and its four locked axes.** We weighed Rust, modern C++, C#, and TypeScript (option nodes 26–29) and ratified TypeScript/web-first (decision node 30) with four locked decisions: TS everywhere, clean-break versioned protocol, faithful-first-then-refactor, web-first distribution. The crux was determinism: Pascal physics is f32, JS is f64, and Soldat's collision response compounds divergence chaotically. The resolution — only possible *because* of the clean break — is that we don't need bit-equality with Pascal for netcode (both sides run identical TS), only for *validating the port*, which a `STRICT_F32` test mode plus a golden-master harness handles. Milestones M0–M9 were laid out, each acceptance-gated.

**2026-06-08 — M0–M2: scaffold, maps, and the physics de-risk.** The pnpm monorepo went up with `@soldat/sim` as an import-pure package, constants ported from `Constants.pas`, and 90 tests green by end of M0. M1 delivered the `.PMS` loader (CRC32-validated against stock maps) and a PixiJS polygon-mesh renderer. M2 — the feel milestone — ported the `Parts.pas` Verlet/Euler integrator and the movement-critical paths of `Sprites.pas`, plus the golden-master harness. An honest caveat logged at the time (node 50): this environment has no FreePascal compiler, so the harness validates against closed-form trajectories and bit-identical twin-world replays, **not** yet against a real instrumented Pascal trace. That cross-check is still the biggest open fidelity question, and our own review nodes (43–47, 63, 68, 74) keep flagging it.

**2026-06-08 — M3–M5: it moves, it shoots, it has bots.** M3 ported `Control.pas` (input→forces, jump/jetpack) and PolyMap sector collision, finishing later with multi-point foot collision. M4 brought weapon stat tables, bullet ballistics/damage, sparks, and a deterministic world RNG (we evicted `Math.random` from the sim; the RNG is mulberry32, deliberately *not* Pascal-bit-compatible, which caps golden-master scope for combat — logged as node 55). M5 ported bot AI and waypoint navigation, with bots driving the same `Control` path as humans. Deferred items were logged honestly: per-body-part hitboxes, ricochet AoE, RayCast line-of-sight.

**2026-06-08 — M6–M8: netcode core, a complete game, modding.** `stepWorld` unified the per-tick spine, then M6 delivered the versioned binary codec and client prediction/reconciliation — proven headlessly (prediction matches the server exactly and recovers from forced divergence), but the actual WebTransport transport is **not built yet**; no two browsers have played each other. M7 added game-mode logic/scoring, the HUD, and a WebAudio sound system. M8 added the mod API object model and a ScriptHost designed so a hung `OnClockTick` can't stall the server — though our own delta review (node 73) called out that "sandboxed" oversells it; real isolation is still TODO. Capstone: M0–M8 nominally complete, `tsc` clean, 269 tests passing in both f64 and `STRICT_F32` modes — and a review observation (node 68) noting, correctly, that everything so far was green by typecheck and unit test with zero ground-truth validation.

**2026-06-09 — First contact with a real browser.** The smoke test found what unit tests couldn't: the custom map shader drew nothing (fixed by switching to PixiJS `Graphics`), collision silently no-opped on maps without a sector grid or valid normals, input on a real map didn't move or jump, and the jetpack spawned with zero fuel. All fixed; `pnpm play` added so the client launches from the repo root. A humbling and useful day-start.

**2026-06-09 — Combat sandbox.** Gostek stick figures, an arena generator, combat FX, then the real thing: bots that fight back, shooting, death and respawn — browser-verified, not just test-verified. Then one shared rifle with spray heat, movement spread, and a reload that forces cover. Robert played it and ratified the design: *one gun for everyone* is the combat baseline, keeping the dynamic of balancing spray against quick reactions and terrain protection (decision node 80, with the verbatim ask attached).

**2026-06-09 — It looks and sounds like Soldat.** The asset fetcher pulls the official `soldat.smod`, and the client now renders textured Gostek soldiers on textured stock maps, with fire/reload/death sounds wired through the SoundManager. None of it is committed to the repo — assets stay user-supplied per the licensing decision.

**2026-06-09 — Keyboard-only controls, the multi-agent way.** Goal: playable with no mouse — WASD + IJKL + Tab/Space/Shift. We ran a 12-agent workflow: three designers proposed schemes through different lenses (classic-Soldat muscle memory, twin-stick 8-way, spray-control-first fine aim), a judge synthesized one spec — the dt-based ramped-rotation design won because it was the only one that noticed `readControl` runs per render frame, so per-frame rotation constants would aim twice as fast on a 120Hz display. IJKL steers a *persistent* aim angle: 3 rad/s for the first 80ms of a chord (fine taps ≈ 3–9°), then 14 rad/s, settling on the octant lines; releasing keys keeps your angle. Verification ran three ways — full test suite, adversarial diff review, and a headless-Chrome playtest using **zero mouse events**. Round one caught a real bug: the first mousemove of a session could steal aim from a keyboard player. Fixed (first mouse sample is baseline-only), re-verified: 339 tests, ammo draining 30→21 on held Space, Tab reloading without stealing focus.

**2026-06-09 — The controls screen.** A startup overlay rendered from `CONTROL_BINDINGS`, the same table the input controller switches on — tests assert every documented key code is actually handled, so the screen cannot lie. Shown on every start while the scheme is in flux (`ALWAYS_SHOW = true`; the localStorage first-run gate is ready for later). Browser-verified: 8 rows, dismissed on first keypress, 342 tests green.

**2026-06-09 — Jet tuning: a vertical, fly-around game.** Robert wants rocket boots that favor *up* over lateral boost, with more gas. We weighed tuning in the sim core (player and bots inherit the same physics) versus a client-layer override (would desync bots and future netcode) and chose the sim core with explicit `DESIGN OVERRIDE` markers (decision node 94): 1.8× up-thrust, damped lateral drift while jetting, a 700-fuel tank with ground regen, and a fixed jet HUD bar. Landed as `f5d3c9a` with new control tests (344 total). The feel iteration continues.

**Where that leaves us.** A genuinely fun single-player sandbox, and a sim architecture we trust *internally* (deterministic, twin-world bit-identical, 344 tests in two float modes). The honest gaps: the movement feel has never been cross-checked against an instrumented Pascal build, so "feels like Soldat" rests on play-testing rather than the golden master it was designed for; the netcode stops at the codec/prediction layer with no real transport; and the mod host's sandbox is a budget-and-discipline story, not real isolation. Those are the next mountains.
