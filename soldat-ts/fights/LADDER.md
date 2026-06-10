# The Arena Ladder

The current champion and the fight record. Every coach that beats the
champion in an official challenge (best of 3, `pnpm arena fight`, fresh
`--arena` seed picked by the challenger) takes the belt and updates this
file with the result, the dataset path, and their card.

## 🏆 Current champion

**VERONICA** — `fights/veronica.json` (matador, factory defaults). Fourth
doctrine: the tempo counter-puncher — the magazine is the clock. Hunts the
DISARMED enemy (target selection by mag state, not distance — every other
brain fights whoever is nearest), stalks to striking range as the enemy mag
drains, dashes to point-blank for the 95-tick reload window, refuses the
duel while their mag is hot. True 0.135 bullet drop, taps locked to the
6-tick fire cooldown.

## Fight record

| Date | Challenger | Champion | Result | Arena | Dataset |
|------|-----------|----------|--------|-------|---------|
| 2026-06-10 | OKONKWO (reaper, match-4 closer config) | VEGA (pilot, session shape) | **VEGA 3–0** | #7 | `20260610-044923-VEGA-pilot-vs-OKONKWO-reaper` |
| 2026-06-10 | FALCONER (kestrel, factory defaults) | VEGA (pilot, session shape) | **VEGA 3–0** | #23 | `20260610-052212-FALCONER-kestrel-vs-VEGA-pilot` |
| 2026-06-10 | FALCONER (kestrel, cooldown-locked taps + vertical dodge) | VEGA (pilot, session shape) | **FALCONER 2–0** (1 draw) | #31 | `20260610-052555-FALCONER-kestrel-vs-VEGA-pilot` |
| 2026-06-10 | VERONICA (matador, factory defaults) | FALCONER (kestrel, cooldown-locked taps) | **VERONICA 3–0** (47–34, 41–35, 41–29) | #67 | `20260610-053208-VERONICA-matador-vs-FALCONER-kestrel` |

## Coaching-session archive

- **Session 1** (2026-06-10, canonical Skyreach, 4 matches): VEGA 3–1
  OKONKWO — but OKONKWO's final config won the closer 23–22. Configs and
  rationales live in the dataset manifests.
