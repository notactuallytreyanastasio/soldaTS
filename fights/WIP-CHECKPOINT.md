# WIP checkpoint — 2026-06-14

A safe snapshot of the working tree so history can be browsed without losing
in-flight work. Tree is **green** (`mojojojo.test.ts` 14 ✓, `tweaks.test.ts`
21 ✓). Branch: `main`. Previous tip: `b909574`.

## What this session was doing — the MOJOJOJO brain (5th learned student)

`mojojojo` was already registered (`packages/client/src/ai/index.ts`) in an
earlier commit. This session **iterated on its shipped weights and senses**:

- **Stage-2 weights shipped.** `mojojojoWeights.ts` now carries the **gen-150
  ES mean** (200-gen antithetic ES from the imitation seed, fitness
  `killDiff + 0.25·domDiff + 30·teamHitRate`). gen-150 was chosen because it
  passed a 3–0 gate vs the imitation seed AND is the only gate-passing mean
  that still sustains the factory `FIRE_THRESH` probe — gen-190/200 means
  zeroed kills everywhere (ES pushed the trigger off a cliff the gate can't see).
- **`FIRE_THRESH` re-probed per stage:** stage-1 sustained at 0.35; the shipped
  stage-2 mean sustains only at **0.30** over seeds {7,21,99,3,42} × 6000 ticks.
- **New sense wired end-to-end — spray heat.** `BotEngineContext.sprayHeatOf?(i)`
  added (`engine.ts`), implemented in `game.ts` (`sprayHeatOf` reads the
  per-slot `sprayHeat` field, exposed to brains as replay schema-v2 / v3-sense).
- **`evolve.mjs`** supports `--engine mojojojo --hit-fit 30`.
- **Fighter card** `fights/mojojojo.json` filed (`FIRE_THRESH: 0.01` tweak;
  full two-stage rationale in the card).

## Untracked artifacts captured here

- `tools/checkpoints/gen1610..gen1670.json`, `tools/checkpoints-mojojojo/` — ES run output.
- `arena-live/public/`, `arena-live/site/brain.html` — spectator/desk additions.
- `fights/SEASONS.md` — commissioner's season record book (auto-appended).

## Bulk churn (not code — generated)

`arena-live/*.log`, `*.jsonl`, `*-state.json`, `arena-live/site/*`,
`docs/graph-data.json`, `docs/git-history.json`, and the `tools/*-ledger.jsonl`
files are autopilot/commissioner/evolve output that accumulated since `b909574`.

## Open frontier (unchanged from MANUAL.md §5)

Aim precision is the learned bots' bottleneck. mojojojo's stage-2 goal was
closing buttstein's ~14-point team-hit-rate hole; the trigger is the fragile
part — ES tends to push it off the sustaining cliff past gen-150.
