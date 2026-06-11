# Getting started — run the arena and build a training dataset

This is the shortest path to a live setup: a fleet of headless matches
running continuously to grow the replay corpus, plus the dashboards and
browser client to watch them. For the full story see [`MANUAL.md`](MANUAL.md)
(operator's guide), [`ARENA.md`](ARENA.md) (protocol), and
[`README.md`](README.md) (the build diary).

Determinism is the load-bearing wall: same seed + same config = the same
match, byte for byte. A "watch URL" does not stream video; it re-runs the
exact recorded simulation in your browser at 60 Hz. Headless, that same
sim runs ~120–240x realtime (a 2-minute match in ~1 s), which is what
makes running hundreds of matches cheap.

## 0. Prerequisites

Node and pnpm, both pinned in `.tool-versions` (asdf-friendly). pnpm is
pinned to `10.26.0` via the `packageManager` field and is delivered through
corepack. If `pnpm` is not on your PATH:

```sh
corepack enable          # installs the pnpm shim into your node bin
asdf reshim nodejs       # only if node is managed by asdf
pnpm --version           # expect 10.26.0
```

## 1. Install

```sh
pnpm install
```

(pnpm may warn that it ignored esbuild build scripts. That is fine; vite
loads its esbuild binary from a platform package, not the postinstall.)

Optional sanity check that the sim works and writes a dataset:

```sh
pnpm arena fight fights/belmonte.json fights/akela.json --matches 3 --arena 7
```

It prints the series result, the dataset path under `datasets/`, and a
WATCH URL.

## 2. Start everything

Five long-lived processes. The three game daemons are zero-dependency
node; start them detached so they outlive your shell. All commands run
from the repo root unless noted.

### Watch live (2 daemons)

```sh
# The dashboards: THE FLOOR (/) and THE DESK (/desk.html) on :8901
cd arena-live && nohup node watch.mjs > watcher.log 2>&1 & disown
cd ..

# The browser game client on :5173 — needed to open any WATCH URL / replay
nohup pnpm play > arena-live/play.log 2>&1 & disown
```

### Generate training data (3 daemons)

These run forever, each producing recorded matches into `datasets/`. The
watcher, the decay board, and the trainers pick them up with no further
wiring.

```sh
cd arena-live
# Diversity: 3 parallel workers, random card pairings across the whole
# matchup matrix. Pauses below 12 GB free disk.
nohup node sparring.mjs    > sparring.log    2>&1 & disown
# Volume floor: one round-robin pairing every 30 s (~120 matches/hr).
nohup node league.mjs      > league.log      2>&1 & disown
# Drama: every 10 min forces a title defense by the least-recently-fought
# card against the current board #1.
nohup node commissioner.mjs > commissioner.log 2>&1 & disown
cd ..
```

You do not need all three. `sparring.mjs` alone gives the widest coverage;
add `league.mjs` for a guaranteed steady floor and `commissioner.mjs` for
championship pressure. Running all three on a multi-core box is fine.

## 3. Watch it

| URL | What you get |
|-----|--------------|
| http://localhost:8901/ | THE FLOOR: scrolling result tape, LIVE hero, decay-scored Big Board, analytics desk, infinite fight feed. Everything is click-to-watch. |
| http://localhost:8901/desk.html | THE DESK: auto-written lead story, the learned bots' climb chart, rivalry cards, tonight's card. |
| http://localhost:5173/ | The game client. Opens in spectate mode by default. Click any WATCH URL on the floor and it replays that exact match here. |
| http://localhost:5173/?play | Play it yourself against 3 bots. |

The floor rebuilds when new datasets land, so matches appear as the
daemons produce them.

## 4. Check health

```sh
# Are all five up?
pgrep -fl "watch.mjs|sparring.mjs|league.mjs|commissioner.mjs|vite"

# Is the corpus growing? (run twice, watch the number climb)
ls -d datasets/*/ | wc -l

# Endpoints alive?
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8901/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/

# Tail any daemon
tail -f arena-live/sparring.log
```

## 5. What gets written

Every fight writes a directory under `datasets/<runId>/`:

- `manifest.json` — both fighter cards, resolved configs, variant, per-match
  seeds and resolved wildcard, git rev, CLI line
- `summary.json` — per-match winners/kills/dominance, per-bot K/D/shots/hit %
- `match-N.events.jsonl.gz` — every shot/hit/kill with ticks
- `match-N.replay.jsonl.gz` — the training data: one row per live bot per
  tick, pairing the observed state with the control the brain chose
- `datasets/LIVE.json` — the in-progress feed the watcher's hero reads

Schema and training notes: [`datasets/README.md`](datasets/README.md) and
[`MANUAL.md`](MANUAL.md) §5. Replays are the corpus, so nothing here is
pruned automatically; watch disk if you leave the daemons running for days
(`league.mjs` logs `datasets/` size each cycle; `sparring.mjs` pauses below
12 GB free).

## 6. Train on it

Once the corpus is large enough, the trainers are zero-npm-dependency node
(see [`MANUAL.md`](MANUAL.md) §5):

```sh
node tools/train-imitation.mjs   # behavior-clone all engines
node tools/train-disciple.mjs    # single-teacher clone of the champion
node tools/evolve.mjs --generations 60 --pop 24 --matches 2 --jobs 8
```

## 7. Stop everything

```sh
pkill -f "node watch.mjs"
pkill -f "node sparring.mjs"
pkill -f "node league.mjs"
pkill -f "node commissioner.mjs"
pkill -f vite                     # the :5173 client
```
