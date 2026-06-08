# Golden-Master Harness (Track E — Pascal side)

This directory documents how the **Pascal reference server** (OpenSoldat) produces a
deterministic per-tick "golden" trace of the particle physics, and how that trace is
replayed through the TypeScript `@soldat/sim` port to prove bit-faithful behaviour.

> **Status / CI note:** Building the Pascal trace requires the Free Pascal Compiler
> (`fpc`). **`fpc` is NOT installed in this environment / CI yet.** Everything here is a
> *documented, ready-to-apply* sketch: the patch in `instrument-serverloop.patch` is a
> unified-diff against the real `server/ServerLoop.pas` (line numbers cited), to be
> refined and compiled the first time we have a working `fpc` toolchain. The trace format
> (`trace-format.md`) and the comparison contract are pinned now so the TS side
> (Tracks A/B/C/D) can be written and tested against fixtures before `fpc` lands.

---

## The shared trace contract

Track A owns the canonical TypeScript types; Track E documents the identical shape that
the Pascal dump MUST emit (see `trace-format.md`):

```ts
interface GoldenTrace { tickRate: number; scenario: string; frames: GoldenFrame[]; }
interface GoldenFrame {
  tick: number;
  particles: { i: number; x: number; y: number; vx: number; vy: number }[];
}
```

- `tickRate` is `GOALTICKS` (default `60`, `shared/Constants.pas:27`).
- `i` is the **1-indexed** particle/sprite index. For sprites,
  `SpriteParts.CreatePart(sPos, sVelocity, 1, i)` is called with `i` = the sprite index
  (`shared/mechanics/Sprites.pas:323`), so particle index == sprite index.
- `x/y` are `SpriteParts.Pos[i]`, `vx/vy` are `SpriteParts.Velocity[i]` — captured
  **after** `DoEulerTimeStepFor(j)` so the dump reflects the integrated state of the tick.
- Only **active** particles appear in `particles[]` (`SpriteParts.Active[i] = True`).

`SpriteParts` is the global `ParticleSystem` declared in `shared/Game.pas:38-42`.
`NUM_PARTICLES = 560` and `MAX_SPRITES = MAX_PLAYERS = 32`
(`shared/Parts.pas:31`, `shared/mechanics/Sprites.pas:19`, `shared/network/Net.pas:104`).

---

## End-to-end flow

```
                         (Pascal reference)                          (TypeScript port)
  scripted scenario  ──► opensoldat-server -dGOLDENMASTER  ──►  golden_<scenario>.json
   + fixed RNG seed                                                       │
   + recorded input                                                       │  same scenario
                                                                          ▼  same seed
                                                            @soldat/sim (STRICT_F32=1)
                                                                          │
                                                                          ▼
                                                              compareTraces(pascal, ts)
                                                                          │
                                                                  pass / per-tick diff
```

### 1. Build the instrumented Pascal server

```bash
# from the OpenSoldat repo root (requires fpc — NOT present in this env yet)
git apply soldat-ts/tools/golden-master/instrument-serverloop.patch
# build the dedicated server with the golden-master define enabled
fpc -dSERVER -dGOLDENMASTER -O- -Sg server/OpenSoldatServer.lpr -oopensoldat-gm-server
```

`-O-` disables optimisation so the integration arithmetic matches the spec'd reference
math; `-Sg` enables `goto`/label support already used by the codebase. The
`{$IFDEF GOLDENMASTER}` blocks added by the patch are inert in normal builds, so the
instrumentation has zero effect on release binaries.

### 2. Run a scripted, deterministic scenario

Determinism requires pinning the two sources of nondeterminism:

1. **RNG seed.** The patch replaces `Randomize;` (`server/Server.pas:1010`) under
   `{$IFDEF GOLDENMASTER}` with `RandSeed := GOLDENMASTER_SEED;` so every run draws the
   same `Random()` sequence (bonus spawns, bot jitter, etc.). Default seed `1337`.
2. **Input.** Drive the sim from a fixed input script rather than live network/bots so
   the per-tick forces are identical run to run. Two supported drivers:
   - *Replay/demo*: load a recorded `.sdm` demo (`shared/Demo.pas`) that re-injects the
     same control inputs each tick. This is the preferred, fully-faithful path.
   - *Scripted bot*: a deterministic bot waypoint scenario (no `Random`-driven aim).

A scenario is identified by a string (written verbatim into `GoldenTrace.scenario`) and
a fixed tick budget. Suggested seed scenarios:

| scenario id        | description                                   | ticks |
|--------------------|-----------------------------------------------|-------|
| `freefall-1`       | single sprite, gravity only, no input         | 240   |
| `jump-arc`         | single sprite, one jump impulse then fall     | 240   |
| `two-bodies`       | two sprites, asymmetric initial velocities    | 240   |

```bash
./opensoldat-gm-server \
  -fs_basepath . \
  +sv_gravity 0.06 \
  +gm_scenario freefall-1 \
  +gm_maxticks 240 \
  +gm_tracefile golden_freefall-1.json
```

(`gm_scenario`, `gm_maxticks`, `gm_tracefile` are the cvars the patch wires up; see the
patch header for their declarations.) The server writes the trace and exits once
`MainTickCounter` reaches `gm_maxticks`.

### 3. Replay the SAME scenario through `@soldat/sim`

The TS side (Track A's runner) seeds an identical `ParticleSystem`, sets the same
gravity/damping, drives the same scripted input, and runs `gm_maxticks` ticks under
`STRICT_F32=1` (forcing `Math.fround` 32-bit single arithmetic to mirror Pascal's
`Single`). It emits a `GoldenTrace` of the same shape.

```bash
STRICT_F32=1 npx vitest run packages/sim/test/golden-master.test.ts
```

### 4. Compare

`compareTraces(pascalTrace, tsTrace)` (Track A owns the implementation) asserts:

- identical `tickRate` and `scenario`;
- identical frame count and identical `tick` values per frame;
- identical active-particle index set per frame;
- per particle, exact bitwise equality of `x/y/vx/vy` after fround.

On mismatch it reports the first diverging `(tick, i, field, pascal, ts)` so we can bisect
which integration step drifts.

---

## Why "after DoEulerTimeStepFor"

The server tick pipeline (`docs/rewrite-reference/tick-pipeline.md`, §2 UpdateFrame) runs,
in order: OldSpritePos ring shift → `DoEulerTimeStepFor(j)` (integration) → `Sprite.Update`
(movement/collision). For the *physics* golden master we snapshot immediately **after**
the Euler integration loop (`server/ServerLoop.pas:292-295`) and **before** `Sprite.Update`
(`:297-299`), so the trace isolates `ParticleSystem.Euler` (`shared/Parts.pas:106-124`)
without the higher-level state machine mixed in. A later milestone can add a second
snapshot after `Sprite.Update` for the full-fidelity comparison.

---

## Files

| file                          | purpose                                                     |
|-------------------------------|-------------------------------------------------------------|
| `README.md`                   | this document — end-to-end harness overview                 |
| `trace-format.md`             | exact `GoldenTrace` JSON the Pascal dump must emit          |
| `instrument-serverloop.patch` | unified-diff sketch adding the `{$IFDEF GOLDENMASTER}` dump |

## TODO (when `fpc` is available)

- Compile the patch, fix any unit/`uses` adjustments the real build surfaces.
- Confirm cvar registration site for `gm_scenario`/`gm_maxticks`/`gm_tracefile`
  (the patch sketches them inline; they likely belong in `shared/Cvar.pas`).
- Decide JSON writer: the patch uses a hand-rolled `WriteLn` to avoid pulling fpjson into
  the server build; swap to `fpjson`/`jsonparser` if already linked.
- Wire the scripted-input driver (demo replay vs. deterministic bot) into the scenario id.
- Generate the three seed-scenario fixtures and commit them for the TS test.
