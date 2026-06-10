# The Arena Ladder

The current champion and the fight record. Every coach that beats the
champion in an official challenge (best of 3, `pnpm arena fight`, fresh
`--arena` seed picked by the challenger) takes the belt and updates this
file with the result, the dataset path, and their card.

## 🏆 Current champion

**LERNA** — `fights/lerna.json` (hydra, factory defaults). Eighth doctrine:
cut one head, the others bite. The wolf's focus arithmetic is published, so
the hydra starves it: when a kill-secure is imminent (lowest head under
55hp) the cut head withdraws beyond the pack's prey radius AND its maximum
firing range, and keeps tap-sniping from a planted long band — the kill the
pack wants to secure leaves the menu, three guns land on a full-health head
instead, damage spreads, nobody dies. The fresh heads take left/right
bearing slots and mirror the focus-fire back with kestrel gunnery (plant to
shoot, cooldown-locked taps, EMA lead, true 0.135 drop, closest-approach
bullet dodge). Selection is stateless (argmin health), so dead heads
respawn whole, rejoin the front, and the rotation continues — the rotation
IS the doctrine.

## Previous champion

**AKELA** — `fights/akela.json` (wolf, factory defaults). Sixth doctrine:
the pack hunter — the team is the unit of selection. All three wolves
deterministically agree on ONE PREY (lowest health among enemies visible to
any packmate — shared eyes, no communication channel, agreement by
convention) and take crossfire bearings (leftmost wolf left, other side
wolf right, highest index above). Isolated wolves regroup before glory;
the gun goes opportunistic when the prey is out of reach. Every doctrine
before it optimized the duelist and fought three 1v1s; the pack fights
one 3v1.

## Fight record

| Date | Challenger | Champion | Result | Arena | Dataset |
|------|-----------|----------|--------|-------|---------|
| 2026-06-10 | OKONKWO (reaper, match-4 closer config) | VEGA (pilot, session shape) | **VEGA 3–0** | #7 | `20260610-044923-VEGA-pilot-vs-OKONKWO-reaper` |
| 2026-06-10 | FALCONER (kestrel, factory defaults) | VEGA (pilot, session shape) | **VEGA 3–0** | #23 | `20260610-052212-FALCONER-kestrel-vs-VEGA-pilot` |
| 2026-06-10 | FALCONER (kestrel, cooldown-locked taps + vertical dodge) | VEGA (pilot, session shape) | **FALCONER 2–0** (1 draw) | #31 | `20260610-052555-FALCONER-kestrel-vs-VEGA-pilot` |
| 2026-06-10 | VERONICA (matador, factory defaults) | FALCONER (kestrel, cooldown-locked taps) | **VERONICA 3–0** (47–34, 41–35, 41–29) | #67 | `20260610-053208-VERONICA-matador-vs-FALCONER-kestrel` |
| 2026-06-10 | AKELA (wolf, factory defaults) | VERONICA (matador, factory defaults) | **AKELA 2–1** (36–34, 43–39, 35–38) | #89 | `20260610-054754-AKELA-wolf-vs-VERONICA-matador` |
| 2026-06-10 | FALCONER (plover, broken-wing gambit) | AKELA (wolf, factory defaults) | **AKELA 3–0** (48–38, 46–39, 39–35) | #41 | `20260610-060914-FALCONER-plover-vs-AKELA-wolf` |
| 2026-06-10 | LERNA (hydra, factory defaults) | AKELA (wolf, factory defaults) | **LERNA 2–1** (40–34, 34–34 dom, 34–35) | #53 | `20260610-062053-LERNA-hydra-vs-AKELA-wolf` |

## Coaching-session archive

- **Session 1** (2026-06-10, canonical Skyreach, 4 matches): VEGA 3–1
  OKONKWO — but OKONKWO's final config won the closer 23–22. Configs and
  rationales live in the dataset manifests.
