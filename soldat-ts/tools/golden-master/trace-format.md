# Golden-Master Trace Format

The exact JSON the Pascal `{$IFDEF GOLDENMASTER}` dump emits, and that `@soldat/sim`
re-emits for comparison. This mirrors Track A's canonical TypeScript types **byte for
byte in shape** — Track A owns the type, Track E pins the wire format the Pascal side
must produce.

## TypeScript types (canonical — Track A)

```ts
interface GoldenTrace {
  tickRate: number;   // GOALTICKS, default 60
  scenario: string;   // verbatim scenario id, e.g. "freefall-1"
  frames: GoldenFrame[];
}

interface GoldenFrame {
  tick: number;       // value of MainTickCounter at capture time
  particles: GoldenParticle[];
}

interface GoldenParticle {
  i: number;          // 1-indexed particle/sprite index
  x: number;          // SpriteParts.Pos[i].X
  y: number;          // SpriteParts.Pos[i].Y
  vx: number;         // SpriteParts.Velocity[i].X
  vy: number;         // SpriteParts.Velocity[i].Y
}
```

## On-disk JSON shape

A single top-level object. Whitespace is insignificant; the comparator parses then
compares structurally, so the Pascal writer may emit compact or pretty JSON.

```json
{
  "tickRate": 60,
  "scenario": "freefall-1",
  "frames": [
    {
      "tick": 1,
      "particles": [
        { "i": 1, "x": 320.0, "y": 200.06000000238419, "vx": 0.0, "vy": 0.06000000238419 }
      ]
    },
    {
      "tick": 2,
      "particles": [
        { "i": 1, "x": 320.0, "y": 200.18000000715256, "vx": 0.0, "vy": 0.11999000459909 }
      ]
    }
  ]
}
```

## Field-by-field contract

### `tickRate` (number, integer)
- Source: global `GOALTICKS` (`shared/Game.pas:34`), default `DEFAULT_GOALTICKS = 60`
  (`shared/Constants.pas:27`).
- Emit the value live at capture time. For golden runs bullet-time is disabled, so this
  is constant `60` across all frames.

### `scenario` (string)
- The verbatim scenario id passed via the `gm_scenario` cvar. Copied unmodified into the
  trace and asserted equal by `compareTraces`.

### `frames` (array)
- One entry per simulated tick, in ascending `tick` order, contiguous, no gaps.
- Length equals `gm_maxticks`.
- A frame is appended once per `UpdateFrame` call, **after** the
  `SpriteParts.DoEulerTimeStepFor(j)` loop (`server/ServerLoop.pas:292-295`) and before
  `Sprite[j].Update` (`:297-299`).

### `frames[].tick` (number, integer)
- Value of `MainTickCounter` for this tick (`shared/network/Net.pas:817`, incremented in
  `AppOnIdle` at `server/ServerLoop.pas:47`). 1-based on a fresh run.

### `frames[].particles` (array)
- One entry per **active** particle for which `SpriteParts.Active[i] = True`
  (`shared/Parts.pas:42`). Inactive slots are omitted (NOT emitted as null/zero).
- Emitted in ascending `i` order (`for i := 1 to NUM_PARTICLES`), so index sets are
  trivially comparable. `NUM_PARTICLES = 560` (`shared/Parts.pas:31`); for sprite-only
  scenarios only `i` in `1..MAX_SPRITES` (=32) are active.

### `frames[].particles[].i` (number, integer, 1-indexed)
- The particle slot index. For sprites this equals the sprite index because
  `SpriteParts.CreatePart(sPos, sVelocity, 1, i)` is called with the sprite index `i`
  (`shared/mechanics/Sprites.pas:323`). **Do not 0-index** — faithfulness requires the
  Pascal 1-based convention end to end.

### `x`, `y`, `vx`, `vy` (number, IEEE-754)
- `x = SpriteParts.Pos[i].X`, `y = SpriteParts.Pos[i].Y`
  (`Pos: array[1..NUM_PARTICLES] of TVector2`, `shared/Parts.pas:43`).
- `vx = SpriteParts.Velocity[i].X`, `vy = SpriteParts.Velocity[i].Y`
  (`shared/Parts.pas:44`).
- The underlying Pascal type is `Single` (32-bit). The TS side runs with `STRICT_F32=1`
  / `Math.fround` so its values are also 32-bit singles. **Comparison is exact (bitwise
  on the fround'd value), not epsilon-based** — the whole point of the golden master is
  to catch any 32-bit divergence.

## Precision / serialization rules

- The Pascal writer MUST emit enough decimal digits to round-trip a `Single` exactly.
  Use a 17-significant-digit float-to-string (e.g. `FloatToStr` with a
  `TFormatSettings` using `'.'` decimal separator, or `Format('%.17g', [v])`). A lossy
  format would make exact comparison impossible.
- Decimal separator MUST be `'.'` regardless of locale (set an explicit
  `TFormatSettings`). Never emit `,`.
- Non-finite values (`NaN`, `Inf`) are a bug in a golden run; if they ever occur, emit
  them as JSON strings `"NaN"` / `"Infinity"` / `"-Infinity"` so the comparator can flag
  the tick rather than producing invalid JSON. (Standard JSON has no NaN literal.)
- No trailing commas; standard JSON only.

## Determinism prerequisites (so two runs match)

- RNG: `RandSeed := GOLDENMASTER_SEED` instead of `Randomize` (patched at
  `server/Server.pas:1010`).
- Input: fixed demo replay or scripted deterministic bot (no `Random`-driven aim).
- Physics params pinned: `SpriteParts.Gravity` (set from the gravity cvar at
  `shared/Cvar.pas:229`), `TimeStep`, `EDamping`, `VDamping` must be identical on both
  sides. The TS `ParticleSystem` constructor must take the same values.
