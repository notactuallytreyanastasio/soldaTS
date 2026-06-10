# Arena training datasets

## 1. What this is

Observation→action datasets recorded from **headless bot-vs-bot deathmatches**
run by `@soldat/arena` (`packages/arena`). Each run pits two AI engines
(`pilot`, `reaper`, `classic`) against each other on the Skyreach arena, with
optionally **tweaked brain configs** on either side, and records everything a
model needs to learn to play: per-tick state + the control each brain chose,
plus shot/hit/kill events and aggregate telemetry.

Generate datasets from `soldat-ts/`:

```bash
# 8 matches, stock brains, 120 s rounds
pnpm arena --teams "pilot vs reaper" --matches 8 --round 120 --variant baseline

# Tweaked brains (knob names = the engine's config keys, see manifest.teams)
pnpm arena --teams pilot vs reaper --tweak-a RANGE_MAX=500 --tweak-b KILL_RANGE=220

# Sweep ONE knob across values — one run directory per value, same seed series
pnpm arena --teams pilot vs reaper --sweep a:RANGE_MAX=380,420,460 --matches 4

pnpm arena --help
```

**Determinism guarantee:** the sim is deterministic per seed and the recorder
introduces no wall-clock or ambient randomness. The same config + seed
produces **byte-identical** replay rows, events, and telemetry (only
`manifest.createdAt`/`gitRev` vary). Match `k` of a run uses `seed + k`, so a
run is fully reproducible from its manifest.

## 2. Directory layout

One directory per CLI invocation (per sweep value when sweeping):

```
datasets/
  20260610-153000-pilot-vs-reaper[-KNOB-value]/
    manifest.json              # full provenance (schema soldat-arena-replay/1)
    summary.json               # cross-match standings (soldat-arena-summary/1)
    match-1.replay.jsonl.gz    # per-tick observation→action rows (gzipped JSONL)
    match-1.telemetry.json     # aggregate telemetry (soldat-match-telemetry/1)
    match-1.events.jsonl       # shot/hit/kill event stream
    match-2.*                  # ... one triple per match
```

## 3. manifest.json (`soldat-arena-replay/1`)

| field | meaning |
|---|---|
| `schema` | `soldat-arena-replay/1` — the dataset format id |
| `runId` | directory name: `YYYYMMDD-HHMMSS-<a>-vs-<b>[-<suffix>]` (UTC) |
| `createdAt` | ISO 8601 UTC timestamp (the only wall-clock value in the run) |
| `gitRev` | `git rev-parse HEAD` of the code that produced the run (`unknown` if git failed) |
| `map` | always `Skyreach` (the hand-built aerial arena, `packages/client/src/app/arena.ts`) |
| `botCount` | total bots, split evenly red/blue (6 = 3v3) |
| `roundTicks` | round length in sim ticks (60 ticks = 1 s) |
| `maxTicks` | hard safety cap on the tick loop (`roundTicks + 600`) |
| `variant` | gameplay variant: `name` + the **resolved full `GameTuning`** the match ran (fire interval, mag size, reload, spread, jet fuel/regen, respawn) |
| `teams[]` | per team (1 = red, 2 = blue): `engine`, `requestedTweaks` (what the caller asked for, `{}` if none), and **`resolvedTweaks` — the EXACT, complete brain config the team's brains ran with** (defaults + applied tweaks). This is the provenance record for "tweaked versions" of a brain. |
| `matches[]` | per match: `n` (1-based), `seed`, and the relative `files` (replay/telemetry/events) |
| `cli` | the verbatim CLI arg string that produced the run (`null` when driven programmatically) |

Knob names in `resolvedTweaks` are the engine's config keys —
`PILOT_DEFAULTS` / `REAPER_DEFAULTS` / `CLASSIC_DEFAULTS` in
`packages/client/src/ai/{pilot,reaper,classic}.ts` are the authoritative
defaults with per-knob comments.

## 4. Replay rows — `match-N.replay.jsonl.gz`

Gunzip → JSONL: **one JSON row per sim tick per LIVE bot**. This is the
training stream. Example row:

```json
{"tick":482,"bot":3,"team":2,"engine":"reaper","x":-512.4,"y":118.75,"vx":1.82,"vy":-0.4,
 "fuel":611,"hp":97.4,"ammo":14,"reloading":false,"onGround":false,
 "control":{"left":false,"right":true,"up":false,"down":false,"fire":true,
            "jetpack":true,"reload":false,"aimX":233,"aimY":-41}}
```

### Units and conventions

- Ticks are the 60 Hz sim clock (`tick` 60 = 1 second in).
- Positions are **px** in world space; **y points DOWN** (smaller y = higher up).
- Velocities are **px/tick**; positions/velocities rounded to 2 decimals.
- `fuel` is jet ticks remaining; `hp` is health (150 = full, 1 decimal).
- `control.aimX`/`aimY` are the aim point as a **relative offset from the
  bot** (px, y down) — exactly what brains write into the sprite control.

### Field reference

| field | meaning |
|---|---|
| `tick` | sim tick the brain made this decision on |
| `bot` | sprite index — a **stable identity across respawns** (same seat all match) |
| `team` | 1 red, 2 blue |
| `engine` | engine id driving this bot (`team`↔`engine` is constant per match) |
| `x`,`y`,`vx`,`vy` | the bot's kinematic state |
| `fuel`,`hp`,`ammo`,`reloading`,`onGround` | the rest of the observable self-state |
| `control` | **the action the brain chose this tick** (booleans + aim offset) |

### Sampling seam — why this is an observation→action dataset

Rows are sampled via `Game.onBrainsTicked`: **after** every living brain wrote
its control for the tick, **before** firing and physics run. So for each row:

- `{row minus control}` is the observation the brain acted on;
- `control` is the action it chose given that observation;
- the **next row for the same bot** is the resulting next state (s, a, s').

Dead bots emit no rows — a `tick` gap for a bot means it was dead/respawning
(respawn delay is `variant.tuning.respawnTicks`, default 180 ticks ≈ 3 s).
Every live bot emits exactly one row per tick, so rows-per-tick ≤ `botCount`.

To see what a bot could observe about *enemies*, join rows across bots on
`tick` — every live bot's state is in the same tick's row group. (Brains have
line-of-sight-gated perception; the replay records ground truth, not the
brain's filtered view.)

## 5. Events — `match-N.events.jsonl.gz`

One JSON object per line, three shapes (all ticks on the same 60 Hz clock):

```json
{"tick":480,"type":"shot","bot":3}
{"tick":491,"type":"hit","attacker":3,"victim":4,"damage":34.6}
{"tick":702,"type":"kill","killer":3,"victim":4,"killerPos":{"x":-500,"y":110},
 "victimPos":{"x":-318,"y":141},"dist":185}
```

- `shot`: a bullet left `bot`'s gun.
- `hit`: a damaging bullet landed (`damage` 1 decimal; self-hits excluded).
- `kill`: a death. `killer` 0 = **unattributed** (no enemy credited —
  `killerPos`/`dist` are `null`). Positions are rounded px at the kill tick.

Use these as reward signal: shots vs hits = accuracy cost, kills/deaths =
the score the round verdict is computed from.

## 6. Telemetry — `match-N.telemetry.json` (`soldat-match-telemetry/1`)

The aggregate per-match dump produced by `MatchRecorder` —
`packages/client/src/app/telemetry.ts` is the authoritative schema. Highlights:
`meta` (engines, per-bot assignment, variant), 2 Hz position `samples`,
`shotsBy`/`hitsBy`/`damageBy`, `kills`, the round verdict, and `derived`
per-sprite stats (hit rate, air-time %, jet use, kill-distance percentiles,
death clusters). The samples are 2 Hz **aggregates**; the replay JSONL is the
60 Hz ground truth.

## 7. summary.json (`soldat-arena-summary/1`)

Cross-match standings for the run:

- `matches[]`: per match — seed, ticks, `winnerTeam` (0 draw / 1 red / 2 blue),
  `winnerEngine`, team kill totals and dominance.
- `standings.red`/`.blue`: engine, wins, kills, deaths, dominance summed
  across matches. **Dominance = kills − 0.5·deaths.** A round's verdict is
  kills, tie → dominance, tie → draw. `standings.winner` is the engine with
  more match wins (kills tiebreak; `''` on a dead tie).
- `bots[]`: per-seat totals across matches (kills desc), with
  `hitRate = hits/shots`.

## 8. Training notes

- **Suggested framing:** behavior cloning / next-control prediction — given a
  bot's row (and optionally the same-tick rows of other bots as context),
  predict `control`. The booleans are 7 binary heads; `aimX`/`aimY` is a
  regression (or discretized angle + magnitude) target.
- **Pick your teacher:** filter rows by `engine`, or by the winning team via
  `summary.json`, to clone only the stronger policy. The per-tick event
  stream gives dense reward if you'd rather go RL.
- **Tweak provenance:** `manifest.teams[].resolvedTweaks` is the full config
  the brains ran with — sweeps (`--sweep`) hold the seed series constant so
  differences between run dirs isolate the knob.
- **Mirror-match limitation (v1):** the same engine id can't play both sides
  (the Game groups teams by engine id). Pitting two tweaked *pilots* against
  each other needs engine aliasing — planned for the next slice.
- **Schema versioning:** any breaking change to row/manifest/summary shapes
  bumps the `/1` suffix. Trainers should assert on the `schema` fields and
  refuse versions they don't know.
