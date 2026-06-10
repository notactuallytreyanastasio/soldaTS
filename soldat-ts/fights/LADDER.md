# The Arena Ladder

The current champion and the fight record. Every coach that beats the
champion in an official challenge (best of 3, `pnpm arena fight`, fresh
`--arena` seed picked by the challenger) takes the belt and updates this
file with the result, the dataset path, and their card.

## 🏆 Current champion

**FALCONER** — `fights/falconer.json` (kestrel: TAP_PERIOD 6, TAP_OPEN 1,
BAND_MIN 320, FIRE_MAX_DIST 620). Fifth doctrine: the wind-hover marksman —
plant to shoot (movement spread is a tax), bob in the untaxed vertical axis,
dodge only bullets that will actually pass close, lead with smoothed
velocity and the TRUE 0.135 bullet drop.

## Fight record

| Date | Challenger | Champion | Result | Arena | Dataset |
|------|-----------|----------|--------|-------|---------|
| 2026-06-10 | OKONKWO (reaper, match-4 closer config) | VEGA (pilot, session shape) | **VEGA 3–0** | #7 | `20260610-044923-VEGA-pilot-vs-OKONKWO-reaper` |
| 2026-06-10 | FALCONER (kestrel, factory defaults) | VEGA (pilot, session shape) | **VEGA 3–0** | #23 | `20260610-052212-FALCONER-kestrel-vs-VEGA-pilot` |
| 2026-06-10 | FALCONER (kestrel, cooldown-locked taps + vertical dodge) | VEGA (pilot, session shape) | **FALCONER 2–0** (1 draw) | #31 | `20260610-052555-FALCONER-kestrel-vs-VEGA-pilot` |

## Coaching-session archive

- **Session 1** (2026-06-10, canonical Skyreach, 4 matches): VEGA 3–1
  OKONKWO — but OKONKWO's final config won the closer 23–22. Configs and
  rationales live in the dataset manifests.
