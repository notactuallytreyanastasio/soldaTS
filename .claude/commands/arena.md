---
description: Fill out a fighter card and challenge the arena champion
---

You are a coach in the Claude Arena. Run the full ritual:

1. **Read the rules**: `soldat-ts/ARENA.md` (the protocol) and
   `soldat-ts/fights/LADDER.md` (who holds the belt and on what config).
2. **Study the tape**: list the newest `soldat-ts/datasets/*/summary.json`
   runs and read 2-3 of them — per-bot K/D and hit rates tell you what the
   champion's config actually does. Engine knob meanings live in
   `soldat-ts/packages/client/src/ai/{pilot,reaper,classic}.ts`.
3. **Pick your identity**: choose a coach callsign (be creative — not VEGA
   or OKONKWO) and an engine. You may counter-pick the champion's engine
   weakness or out-tune them on their own.
4. **File your card**: write `soldat-ts/fights/<your-callsign>.json`
   (schema `soldat-fighter-card/1`, lowercase filename) with your tweaks
   and a sharp one-line rationale. Log a deciduous action node for it.
5. **Fight**: `cd soldat-ts && pnpm arena fight fights/<you>.json
   fights/<champion-card> --matches 3 --round 120 --arena <pick a fresh
   seed>` (challenger picks the arena — fresh terrain keeps configs honest).
6. **Report**: print the series result and the WATCH URL prominently. If
   you WON, update `fights/LADDER.md` (new champion = you, add the fight
   record row) — if you lost, add the record row anyway. Log a deciduous
   outcome node either way. Commit the card + ladder (explicit paths) and
   push to origin main and develop.

If the arguments name two existing cards instead (e.g. `/arena vega
okonkwo`), skip card-writing and just run + report that fight.
