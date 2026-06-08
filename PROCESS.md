# PROCESS — OpenSoldat → TypeScript Rewrite (live log)

> Human-readable companion to the deciduous decision graph. Updated as work happens
> so another agent or person can watch over. **Graph is the source of truth for
> *why*; this file is the running narrative of *what/now/next*.**

**How to watch:** `deciduous serve` (live graph) · `docs/PORT-PLAN.md` (the plan) ·
`docs/rewrite-reference/` (behavioral contract) · this file (current state).

---

## Where we are right now

**Phase:** M0 (bootstrap) → starting M1/M2 foundations.
**Branch:** `rewrite/ts-port`.
**Decision of record:** TypeScript · web-first · clean-break protocol · faithful-first. (graph node 30)

### Milestone board
| # | Milestone | Status |
|---|-----------|--------|
| M0 | Bootstrap (monorepo, tooling, shared foundations) | 🟡 in progress |
| M1 | Map loads & renders (.PMS loader + PixiJS) | ⬜ not started |
| M2 | Physics core + golden master ⭐ | ⬜ not started |
| M3 | Moves like Soldat (SP, no net) | ⬜ |
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
    src/constants.ts           # ⏳ port of Constants.pas + verified caps
    src/world.ts               # ⏳ World: 1-indexed global arrays, sentinel-0
    src/entities/types.ts      # ⏳ Sprite/Bullet/Thing/Spark/Control records
    src/math/calc.ts           # ⏳ geometry helpers (Calc.pas/Vector.pas)
    src/physics/particles.ts   # ⏳ ParticleSystem (Parts.pas) — THE feel core
  packages/assets/             # @soldat/assets — .PMS loader + tools
  packages/protocol/           # @soldat/protocol — clean-break wire schema
```
Legend: ✅ done · ⏳ being built in current workflow · ⬜ later.

---

## Activity log (newest first)

### 2026-06-08
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
- f64-vs-f32: resolved in principle (STRICT_F32 golden master); **must be proven at M2.**
- `.PMS` kept read-compatible even though netcode is a clean break (separate axes).
- Nothing in `soldat-ts/` is dependency-installed yet (`pnpm install` needs network).
