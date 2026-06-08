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
**Verification:** `tsc --build` clean; **104 Vitest tests pass in both f64 and STRICT_F32**.

### Milestone board
| # | Milestone | Status |
|---|-----------|--------|
| M0 | Bootstrap (monorepo, tooling, shared foundations) | ✅ done |
| M1 | Map loads & renders (.PMS loader + PixiJS) | 🟢 mesh+renderer+app done; live browser smoke-test + real .PMS load pending |
| M2 | Physics core + golden master ⭐ | 🟢 harness + movement done (vs closed-form); fpc trace cross-check pending |
| M3 | Moves like Soldat (SP, no net) | 🟡 needs full PolyMap collision + jump/anim |
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

## Activity log (newest first)

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
