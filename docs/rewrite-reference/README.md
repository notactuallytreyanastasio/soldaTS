# OpenSoldat Rewrite Reference

Authoritative, code-grounded specs extracted from the OpenSoldat (FreePascal) source to serve as the **behavioral contract** for a planned total rewrite. Every claim cites `file:line`; constants/field orders are quoted verbatim. These are meant to be trusted in place of re-reading the original code.

Captured in the deciduous decision graph as outcomes of action node 19 (root goal node 1). Architecture-level understanding lives in nodes 2–18.

| Document | What it pins down |
|----------|-------------------|
| [tick-pipeline.md](tick-pipeline.md) | Exact ordered server + client simulation tick, fixed-timestep accumulator math, and the full `MainTickCounter mod N` network send schedule (with the player-count `Adjust` factor) |
| [wire-protocol.md](wire-protocol.md) | Every `TMsg_*` packed record (field order/sizes), MsgID values, snapshot/major/delta/skeleton cadence, `Keys16` input bitmap, client-predicted bullet seed, lag compensation, handshake, and Fae anti-cheat |
| [physics-and-balance-constants.md](physics-and-balance-constants.md) | The feel/balance magic-constant catalog — `GRAV`/`RKV`/`SURFACECOEF`, movement/jump/jetpack, per-thing gravity & damping, bullet penetration/ricochet, and the full `Guns[]` stat tables (normal + realistic) |
| [pms-map-format.md](pms-map-format.md) | Byte-exact `.PMS` on-disk layout, CRC32 validation, the `POLY_TYPE_*` enum, normal-length bounciness encoding, the sector spatial hash, and map `MAX_*` caps |
| [pascalscript-api.md](pascalscript-api.md) | The public modding API: both engines (ScriptCore v1 / ScriptCore3), all dispatched events + signatures + cascade order, the `Script*` object model, and the threading/sandbox model |
| [global-state-and-caps.md](global-state-and-caps.md) | The global world-state arrays, hard caps (`MAX_SPRITES=32` / `BULLETS=300` / `THINGS=256`), 1-indexing + sentinel-0 conventions, and a subsystem × global R/W coupling matrix |

## How to use these for the rewrite

The four load-bearing compatibility contracts (see graph node 5):
1. **Movement feel & determinism** — `physics-and-balance-constants.md` + `tick-pipeline.md`. Port the integrator and constants verbatim; keep fixed 60 Hz.
2. **Net compatibility decision** — `wire-protocol.md`. Reproduce byte-exact, or commit to a versioned flag-day break.
3. **Map library** — `pms-map-format.md`. Load `.PMS` + CRC32 bit-compatibly.
4. **Mod API** — `pascalscript-api.md`. Embed Pascal scripting or provide a shim.

Suggested first deliverable before any rewrite code: a **golden-master determinism test** built from `tick-pipeline.md` + `physics-and-balance-constants.md` (record inputs+seeds, replay, assert bit-identical trajectories).
