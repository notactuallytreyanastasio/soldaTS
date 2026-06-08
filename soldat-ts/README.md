# soldat-ts

A from-scratch **TypeScript / web** rewrite of OpenSoldat (the FreePascal 2D
multiplayer shooter), built faithfully against the original source. See
[`../docs/PORT-PLAN.md`](../docs/PORT-PLAN.md) for the strategy and
[`../docs/rewrite-reference/`](../docs/rewrite-reference/) for the behavioral
contract extracted from the Pascal engine. Live status lives in
[`../PROCESS.md`](../PROCESS.md); the *why* behind decisions is in the deciduous
decision graph (`../docs/graph-data.json`).

**Status:** numbered milestones **M0–M8 complete**. `tsc --build` clean;
**269 Vitest tests pass in both f64 and `STRICT_F32` modes.**

## Decisions (locked)

- **TypeScript**, web-first (PixiJS/WebGL2, WebAudio, WebTransport).
- **Clean-break** versioned protocol — not wire-compatible with legacy servers.
- **Faithful-first**: the simulation is ported ~line-by-line from the Pascal with
  `// PORT: file:line` provenance, then refactored. Feel is preserved by porting
  the Verlet integrator and constants verbatim.
- **Determinism**: the sim is platform-pure (no DOM/Node/`Math.random`). A
  `STRICT_F32` mode routes physics math through `Math.fround` so it reproduces
  Pascal `Single` results — the basis of the golden-master fidelity check.

## Packages

| Package | Role |
|---------|------|
| **`@soldat/sim`** | The deterministic simulation core (platform-pure). Constants, 1-indexed `World`, the `ParticleSystem` integrator (`Parts.pas`), entities (sprite/bullet/thing/spark), PolyMap collision, weapons, bots+waypoints, game modes, the golden-master harness, and `stepWorld` (one 60Hz tick). |
| **`@soldat/protocol`** | Clean-break versioned wire schema (`messages.ts` + `schema.proto`) and a hand-written binary codec. |
| **`@soldat/netcode`** | World↔snapshot replication and client prediction/reconciliation (proven bit-identical to the server tick-for-tick). |
| **`@soldat/assets`** | Read-only `.PMS` map loader + CRC32 (keeps the existing map library working). |
| **`@soldat/client`** | Browser app: PixiJS renderer (map mesh + entities), 60Hz game loop, input, HUD, WebAudio. Keyboard-playable on a real map. |
| **`@soldat/modding`** | Sandboxed mod API replacing PascalScript: the `Script*` object model + event dispatch, with a host that can't be stalled by a crashing mod. |

## What works

- A full **deterministic simulation tick** (`stepWorld`): player physics + jump
  + multi-point foot collision on real polygon geometry, bullets/weapons/damage,
  sparks, things (flags/kits), bots, game-mode scoring.
- A **keyboard-playable browser client** (WASD + mouse) rendering the live world
  on a loaded `.PMS` map, with a HUD and a WebAudio sound engine.
- **Netcode core**: a versioned binary codec and a prediction/reconciliation
  buffer (validated headlessly: client prediction matches the server exactly and
  reconciles after a forced divergence).
- A **golden-master harness** that validates the integrator against closed-form
  trajectories and proves two seeded worlds run bit-identically.

## Build & run

```sh
pnpm install            # or: npx -y pnpm@9 install
pnpm test               # vitest, all packages
STRICT_F32=1 pnpm test  # f32-fidelity mode
pnpm typecheck          # tsc --build
pnpm --filter @soldat/client dev   # Vite dev server (browser)
```

Real `.PMS` maps and assets are **user-supplied** (drop maps in
`packages/client/public/maps/`) per the engine-only distribution decision.

## Known gaps (see PROCESS.md / graph for detail)

- **Feel not yet golden-master-verified against Pascal** — needs a FreePascal
  build to capture a reference trace (`tools/golden-master/` has the
  instrumentation patch ready). The integrator is validated against closed-form
  math + internal determinism only.
- **Client is typecheck-verified, not browser-smoke-tested** in this environment.
- Entity rendering uses placeholder markers (no Gostek skeleton yet).
- WebTransport transport wiring (a `@soldat/server` runtime) is not built —
  the netcode core is transport-agnostic and ready for it.
- Various per-subsystem fidelity items are deferred and logged in the graph
  (animation state machine, ricochet/explosion AoE, INF/HTF tick scoring, etc.).
