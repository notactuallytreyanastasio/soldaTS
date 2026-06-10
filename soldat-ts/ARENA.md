# The Claude Arena

How an agent (a Claude Fable instance, a human, or eventually a trained
model wrapper) logs into the arena, grabs a brain, tweaks it, and fights.

## The loop

1. **Grab a brain.** Three engines are registered: `classic` (faithful
   Pascal reflex bands), `pilot` (first-principles aerial duelist),
   `reaper` (dive brawler). Their knobs and defaults live in
   `packages/client/src/ai/{pilot,reaper,classic}.ts` (`PILOT_DEFAULTS`,
   `REAPER_DEFAULTS`, `CLASSIC_DEFAULTS`) — every knob has a comment
   explaining what it does.
2. **File a fighter card** — one JSON file (schema `soldat-fighter-card/1`):

   ```json
   {
     "schema": "soldat-fighter-card/1",
     "coach": "VEGA",
     "engine": "pilot",
     "tweaks": { "RANGE_MAX": 360, "HEIGHT_EDGE_MIN": 80, "FUEL_RESERVE": 160 },
     "rationale": "Tight band beat the dive meta in matches 1-3."
   }
   ```

   `tweaks` may be empty (factory defaults). Unknown knobs are validation
   errors with the legal knob list in the message — a coach can self-serve.
3. **Fight.** Two cards face off (red = card A, blue = card B; whole teams,
   one engine per side):

   ```sh
   pnpm arena fight fights/vega.json fights/okonkwo.json --matches 3 --round 120 --arena 7
   ```

   Every match is recorded as a training dataset (`datasets/<runId>/` —
   replays, events, telemetry, manifest with both cards' resolved configs;
   see `datasets/README.md`).
4. **Watch.** The command prints a WATCH URL. The sim is deterministic per
   seed, so the browser **replays the exact recorded match** — coach names
   on the banner (`PILOT (VEGA) vs REAPER (OKONKWO)`), each side's knob
   turns on the info card, chevrons, MVPs, the works. (`pnpm play` first.)
5. **Adjust between matches.** Read the dataset summary (`summary.json`,
   per-bot K/D/hit rates) and file a revised card for the next fight. The
   manifest tracks every config that ever played, so the tweak history IS
   the experiment log.

## Maps

`--arena N` (CLI) / `?arena=N` (browser) selects a deterministic generated
arena from the Skyreach family — same seed, same map, forever. `0` is the
canonical hand-built Skyreach. Vary arenas across fights so a config's
edge isn't a map quirk.

## What's tracked

Every fight's manifest records: both coaches' requested tweaks AND the
resolved full configs the brains actually ran, the variant tuning, the map
(arena seed), match seeds, and the git rev. Replays pair each bot's
observed state with its chosen action at 60 Hz — the uniform format the
from-scratch model trains on (`datasets/README.md` § training notes).

## The real assignment: derive a NEW strategy

Tweaking knobs is the entry level. The arena's founding bet is that a coach
can **author an entirely new doctrine** — a playing model nobody
hand-designed:

1. Write one file: `packages/client/src/ai/<yourbrain>.ts` implementing
   `BotBrain` (study `pilot.ts` and `reaper.ts` — each opens with its
   doctrine spelled out). Expose a `<NAME>_DEFAULTS` config so your knobs
   are tweakable and tracked like everyone else's. Honor the contract:
   write only your bot's `control`, randomness only through `world.rng`.
2. Register it (one line in `packages/client/src/ai/index.ts`) and add a
   sustainment test (copy the `describe.each` pattern in `engine.test.ts`).
3. It instantly gets: a banner, `?ai=` selection, duel grids, tournaments,
   mixed-team matches, telemetry, datasets — and a shot at the belt.
   File your fighter card with `"engine": "<yourbrain>"` and challenge.

History so far: `pilot` (first principles) beat `classic` (the faithful
port) decisively; `reaper` (designed counter) got within tiebreaks. The
fourth doctrine is unwritten.

## Roadmap from here

- **Imitation seed**: behavior-clone the replay rows (obs → control) into a
  small policy net; ship it as a `neural` engine (forward pass in TS) so it
  fights in the same arena, gets the same banner, and is measured by the
  same telemetry as the hand-written brains.
- **Self-play RL**: use the headless runner as the environment (a 2-minute
  match simulates in ~1 s) with kills/dominance as reward; coaches become
  training curricula.
- **Claude-vs-Claude**: multiple Fable instances train against the same
  datasets and pit their fighters here. The card format is the contract.
