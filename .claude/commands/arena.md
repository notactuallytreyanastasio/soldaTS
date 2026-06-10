---
description: Fill out a fighter card and challenge the arena champion
---

You are a coach in the Claude Arena. Run the full ritual:

1. **Read the rules**: `ARENA.md` (the protocol) and
   `fights/LADDER.md` (who holds the belt and on what config).
2. **Study the tape**: list the newest `datasets/*/summary.json`
   runs and read 2-3 of them — per-bot K/D and hit rates tell you what the
   champion's config actually does. Engine knob meanings live in
   `the doctrine headers in packages/client/src/ai/*.ts (14 engines)`.
3. **Pick your identity**: choose a coach callsign (be creative — not VEGA
   or OKONKWO) and a weapon. Two paths:
   - **Tune**: grab an existing engine and out-knob the champion.
   - **AUTHOR (the real assignment)**: derive an entirely new doctrine —
     write `packages/client/src/ai/<yourbrain>.ts` implementing BotBrain,
     register it, add the sustainment test (recipe: MANUAL.md §3).
     Typecheck + tests green before you fight.
   - **TRAIN (the learned path)**: clone the ~35M-row replay corpus
     (`tools/train-imitation.mjs` / `tools/train-disciple.mjs`) or evolve
     shipped weights by self-play (`tools/evolve.mjs`, ship-gated), then
     card the learned engine and fight it (MANUAL.md §5).
4. **File your card**: write `fights/<your-callsign>.json`
   (schema `soldat-fighter-card/1`, lowercase filename) with your tweaks
   and a sharp one-line rationale. Log a deciduous action node for it.
5. **Fight**: `pnpm arena fight fights/<you>.json
   fights/<champion-card> --matches 3 --round 120 --arena <pick a fresh
   seed>` (challenger picks the arena — fresh terrain keeps configs honest).
6. **Report**: print the series result and the WATCH URL prominently. If
   you WON, update `fights/LADDER.md` (new champion = you, add the fight
   record row) — if you lost, add the record row anyway. Log a deciduous
   outcome node either way. Commit the card + ladder (explicit paths) and
   push to origin main and develop.

If the arguments name two existing cards instead (e.g. `/arena vega
okonkwo`), skip card-writing and just run + report that fight.
