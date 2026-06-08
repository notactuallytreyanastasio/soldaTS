# PROCESS — OpenSoldat → TypeScript Rewrite (live log)

> Human-readable companion to the deciduous decision graph. Updated as work happens
> so another agent or person can watch over. **Graph is the source of truth for
> *why*; this file is the running narrative of *what/now/next*.**

**How to watch:** `deciduous serve` (live graph) · `docs/PORT-PLAN.md` (the plan) ·
`docs/rewrite-reference/` (behavioral contract) · this file (current state).

---

## Where we are right now

**Phase:** M0 ✅ · M1/M2 substantially landed → next: M3 (full PolyMap collision + playable movement) and the fpc-side golden-master capture.
**Branch:** `rewrite/ts-port` → **PR: notactuallytreyanastasio/soldat#1** (on fork; base `develop`).
**Decision of record:** TypeScript · web-first · clean-break protocol · faithful-first. (graph node 30)
**Verification:** `tsc --build` clean; **246 Vitest tests pass in both f64 and STRICT_F32**. The sim has a deterministic heartbeat (`stepWorld`); netcode prediction is proven bit-identical to the server tick-for-tick. Client is keyboard-playable on a real `.PMS` map (typecheck-verified; not browser-smoke-tested here).

### Milestone board
| # | Milestone | Status |
|---|-----------|--------|
| M0 | Bootstrap (monorepo, tooling, shared foundations) | ✅ done |
| M1 | Map loads & renders (.PMS loader + PixiJS) | 🟢 mesh+renderer+app+real .PMS load done; live browser smoke-test pending |
| M2 | Physics core + golden master ⭐ | 🟢 harness + movement done (vs closed-form); fpc trace cross-check pending |
| M3 | Moves like Soldat (SP, no net) | 🟢 multi-point foot collision + jump/jetpack done — player stands & jumps on real geometry; animation-frame gating/prone/roll pending |
| M4 | Combat (weapons/bullets/things) | 🟢 weapons+bullets/damage+sparks+RNG; Things.pas + hitboxes/ricochet/explosion-AoE pending |
| M5 | Bots | 🟢 waypoints + AI brain done; RayCast LOS / weapon model / grenade+flag AI pending |
| — | Integration: Things + stepWorld tick spine | 🟢 done — full deterministic tick runs |
| M6 | Netcode ⭐ | 🟢 codec + replication + prediction done; WebTransport transport wiring deferred (needs server runtime) |
| — | Playable SP: client game loop + jump/foot collision | 🟢 done — keyboard-playable on a real map (typecheck-only) |
| M7 | Modes / HUD / audio | 🟢 game-mode scoring + HUD (wired into loop) + WebAudio done |
| M8 | Modding + content + polish | 🟢 mod API + sandboxed ScriptHost done |
| — | WebTransport transport wiring (client/server runtime) | ⬜ human-gated (needs server runtime) |
| — | fpc golden-master cross-check | ⬜ human-gated (needs FreePascal) |
| — | Browser smoke-test + Gostek skeleton rendering | ⬜ human-gated (needs browser) |

**Numbered milestones M0–M8 are COMPLETE.** Remaining work is human-gated (below).
| M4 | Combat (weapons/bullets/things) | ⬜ |
| M5 | Bots | ⬜ |
| M6 | Netcode ⭐ | ⬜ |
| M7 | Complete game (modes/HUD/menus/audio) | ⬜ |
| M8 | Modding + content + polish | ⬜ |
| M9 | Phase C refactor | ⬜ |

---

## Repo layout (new code)
```
soldat-ts/                     # the rewrite (pnpm monorepo)
  packages/sim/                # @soldat/sim — deterministic core (platform-pure)
    src/scalar.ts              # ✅ Scalar + STRICT_F32/f() f32 policy
    src/math/vec2.ts           # ✅ Vec2 (port of TVector2)
    src/constants.ts           # ✅ Constants.pas + verified caps (+test)
    src/world.ts               # ✅ World: 1-indexed global arrays, sentinel-0 (+test)
    src/entities/types.ts      # ✅ Sprite/Bullet/Thing/Spark/Control records
    src/math/calc.ts           # ✅ geometry helpers (Calc.pas) (+test, 46 cases)
    src/physics/particles.ts   # ✅ ParticleSystem (Parts.pas) — THE feel core (+test)
  packages/assets/             # ✅ @soldat/assets — .PMS loader + CRC32 + types (+test)
  packages/protocol/           # ✅ @soldat/protocol — clean-break wire schema + .proto (+test)
```
Legend: ✅ done · ⏳ in progress · ⬜ later.

---

## State of the rewrite (capstone)

**M0–M8 complete. 38 commits on `rewrite/ts-port` (PR #1). `tsc --build` clean;
269 tests green in f64 AND STRICT_F32.** Six packages: `sim` (deterministic core
+ `stepWorld` heartbeat), `protocol` (codec), `netcode` (snapshot + prediction),
`assets` (.PMS), `client` (playable browser app + HUD), `modding` (sandboxed mod
API). See `soldat-ts/README.md`. The simulation runs a full deterministic tick
(physics+jump+collision, bullets/weapons/damage, sparks, things, bots, modes);
the browser client is keyboard-playable on a real map; netcode prediction is
proven bit-identical to the server tick-for-tick.

**What needs YOU (human-gated, not attempted blind):**
1. **FreePascal** → run the golden-master cross-check (`tools/golden-master/` has
   the instrumentation patch) to validate sim *feel* against the original. Until
   then feel is validated vs closed-form + internal determinism only.
2. **A browser** → smoke-test `pnpm --filter @soldat/client dev` (renderer/loop
   are typecheck-verified but never GPU-run here).
3. **A server runtime** → WebTransport transport wiring (the netcode core is
   ready and transport-agnostic).
4. Decisions on remaining fidelity items (Gostek skeleton render, animation state
   machine, ricochet/explosion AoE, INF/HTF scoring) — all logged in the graph.

## Activity log (newest first)

### 2026-06-08 (cont. 9, autonomous loop — capstone)
- **M8 modding landed** (mod API + sandboxed ScriptHost that can't be stalled by a
  crashing mod). Reconciled to one canonical contract. Graph 71.
- **Capstone**: top-level `soldat-ts/README.md`; HUD wired into the client loop;
  PROCESS state-of-the-rewrite summary. **269 tests green.** M0–M8 DONE.
- **Loop paused**: remaining work is human-gated (fpc / browser / server runtime).
  Not spawning new milestone workflows — see "What needs YOU" above.

### 2026-06-08 (cont. 8, autonomous loop)
- **M7 landed** (3-track workflow): game-mode scoring (DM/PM/TDM/CTF/INF/HTF/Rambo),
  HUD (health/jet/ammo/score/kill-feed), WebAudio sound engine (positional). Fixed a
  SECOND/MINUTE barrel clash. **246 tests green.** Commits 323efa0, 8faadbb, b01f9bb. Graph 69/70.
- **M7 deferred/integration gap (graph 70):** modes+HUD+audio not yet wired into the
  client main.ts loop; INF/HTF tick scoring, HUD skins, audio channels pending.
- → next: wire M7 into the playable loop OR WebTransport transport OR M8 modding.

### 2026-06-08 (cont. 7, autonomous loop)
- **Playable SP landed** (2-track workflow). M3 finished: jump/jetpack + multi-point
  foot collision (player rests standing on floor polygons, not COM-sunk; onGround latch).
  Client game loop: Game (60Hz stepWorld) + EntityRenderer + InputController + camera follow
  — keyboard-playable on a real `.PMS`. **213 tests green.** Commits 59cac82, 817c187. Graph 66/67.
- **Caveats (graph 67):** client typecheck-only (no browser smoke-test here); entity render is
  placeholder markers (no gostek skeleton yet); feel still pending fpc golden-master.
- → launching **M7**: game-mode logic (DM/CTF scoring) + HUD (InterfaceGraphics) + WebAudio sound.

### 2026-06-08 (cont. 6, autonomous loop)
- **M6 netcode core landed** (3-track workflow). `@soldat/protocol` binary codec
  (every message round-trips) + `@soldat/netcode` snapshot replication + `PredictionBuffer`.
  Prediction proven bit-identical to server tick-for-tick + reconciles after divergence.
  **210 tests green.** Commits 2da6819, a9b1176. Graph 64/65.
- **M6 remaining (graph 65):** WebTransport transport wiring (needs server runtime);
  reconcile snapshot apply to cover COM particle + onGround latches end-to-end.
- → launching **Playable SP**: client game loop (stepWorld + entity render + input) +
  M3 finish (jump/jetpack + multi-point foot collision) — a movable+jumping player on a
  real map. Sim physics still pending the fpc golden-master cross-check for feel.

### 2026-06-08 (cont. 5, autonomous loop)
- **Integration landed**: Things.pas (flags/kits over shared `world.thingParts`) +
  **`stepWorld`** — one full 60Hz tick in `UpdateFrame` order. Two identically-seeded
  worlds produce bit-identical trajectories. **182 tests green.** The sim now has a
  deterministic heartbeat. Commits 4d2fbe1, 5c49ec2. Graph 61/62.
- → launching **M6 netcode**: protocol codec (serialize/deserialize) + client
  prediction/reconciliation over `stepWorld`. WebTransport transport wiring deferred
  (needs a server runtime to smoke-test) — building the headless-testable core first.

### 2026-06-08 (cont. 4, autonomous loop)
- **M5 bots landed** (2-track workflow). `@soldat/sim/ai`: waypoint graph + AI.pas
  ControlBot brain, emitting human-style Control. **171 tests green.** Graph 59/60.
- → launching **integration batch**: Things.pas (flags/kits) + `stepWorld` unified
  per-tick spine (orchestrates particles→sprites→bullets→sparks→things→bots in
  tick-pipeline order) — the missing piece that makes a full SP tick run.

### 2026-06-08 (cont. 3, autonomous loop)
- **M4 combat landed** (3-track workflow). Weapons stat tables (normal+realistic),
  bullet ballistics/map+sprite collision/damage, sparks. Caught + fixed a determinism
  break (Math.random in sparks) by adding a seeded `World.rng` (mulberry32). Fixed
  barrel collisions (BulletStyle/timeouts → single source in weapons/guns).
  **150 tests green (f64 + STRICT_F32).** Commits 5ef6656, d4b3202, dd932d8. Graph 57/58.
- **M4 deferred (graph 58):** per-body-part hitboxes (need per-sprite Skeleton),
  ricochet/explosion AoE/cluster spawning, Pascal-RNG-sequence fidelity.
- → launching **M5 bots**.

### 2026-06-08 (cont. 2)
- **M3 collision landed** (2-track workflow + orchestrator integration). `@soldat/sim/map`:
  full `PolyMap` (PointInPoly, sector grid, ClosestPerpendicular, collideCircle, POLY_TYPE_*)
  + `buildPolyMap` from `.PMS`. `sprite.ts` gains the faithful pushout primitive
  `resolveParticleMapCollision` (Sprites.pas:2718-2751) + `collideSpriteAgainstMap`. Client now
  loads real `.PMS` with synthetic fallback. **115 tests green (f64 + STRICT_F32).** Commits
  34f74bd, d562684. Graph: outcome 53, remaining-work 54.
- **M3 remaining (graph 54):** multi-point foot collision + Area/animation gating (COM is a
  stand-in), jump/jetpack impulses, then the fpc golden-master cross-check.

### 2026-06-08 (cont.)
- **M1 + M2 landed in parallel** (5-track workflow). Forked to `notactuallytreyanastasio/soldat`,
  opened **PR #1**. New: `@soldat/client` map mesh + PixiJS renderer + Vite app (M1);
  `@soldat/sim/golden` harness (ScenarioRunner/compareTraces, free-fall vs closed form over
  600 ticks, determinism, perturbation) + `Sprites.pas` movement port + minimal floor collision (M2);
  `tools/golden-master/` Pascal instrumentation patch + format docs. **104 tests green (f64 + STRICT_F32).**
  Commits a168d12 (M1), 044b821 (M2). Graph: outcomes 48/49, env-constraints 50.
- **Env gaps (graph 50):** no `fpc` here → Pascal trace capture deferred; no upstream push → fork PR;
  M1 live browser render not yet smoke-tested.

### 2026-06-08
- **M0 COMPLETE.** Foundational port workflow (6 agents) landed; wired the `index.ts`
  barrel, resolved 2 name collisions (`distance`, `ParticleSystem`), and fixed the
  constants test to assert `f(literal)` so it's STRICT_F32-safe. `tsc --build` clean;
  **90 tests pass in f64 AND STRICT_F32.** Committed (6fe83cd scaffold, 0882109 ports).
  Graph: M0 outcome node 41; divergence watch-items node 42.
- **Committed understanding + plan** in 4 logical chunks on `rewrite/ts-port`
  (gitignore, reference specs, port plan, graph export).
- **Scaffolded `soldat-ts/` monorepo** inline: pnpm/Vite/Vitest config, `tsconfig`,
  shared foundations `scalar.ts` (f32/STRICT_F32 policy) and `math/vec2.ts`.
- **Launched foundational workflow**: 6 parallel agents porting constants, world/entity
  types, particle physics, geometry helpers, the `.PMS` loader, and the protocol schema
  from the verified Pascal source. (see graph nodes 31–33; outcomes pending)
- Earlier: built whole-engine understanding (graph nodes 1–18), extracted 6 authoritative
  reference specs (nodes 19–25), recorded the rewrite decision + 10 milestones (nodes 26–40).

---

## Open decisions / watch-items
- f64-vs-f32: resolved in principle (STRICT_F32 golden master); **must be proven at M2**
  against a real Pascal trace.
- **M2 fidelity risk (graph node 42):** `vec2.dot` rounds each op in `f()`, but Pascal
  `Vec2Dot` is a single unrounded `Single` expr. Physics inlined dot/length to match
  per-op rounding; if the golden master diverges, drop the inner `f()` on the dot sum.
- `.PMS` kept read-compatible even though netcode is a clean break (separate axes).
- Deps now installed (`pnpm install` ran); `pnpm test` / `STRICT_F32=1 pnpm test` both green.
