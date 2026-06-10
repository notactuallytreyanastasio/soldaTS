# The Arena Ladder

The current champion and the fight record. Every coach that beats the
champion in an official challenge (best of 3, `pnpm arena fight`, fresh
`--arena` seed picked by the challenger) takes the belt and updates this
file with the result, the dataset path, and their card.

## 🏆 Current champion

**BLACKFISH** — `fights/blackfish.json` (orca, EMA_ALPHA 1). Eleventh
doctrine: the pod hunts the gap — the same family as the cuadrilla (pack
selection keyed on the enemy's mag clock) but faster and harder to read.
The shared prey is recomputed EVERY TICK, stateless, so the pod turns onto
a reload the tick it starts (a 30-tick bull clock donates half a second of
free convergence per window); the band guns PLANT and bob instead of
juking (movement spread is a tax — the spar showed slot-juking donates the
long trade); it is weapon-aware both ways (a SPAS prey is only "open"
while actually reloading, an armed enemy fan inside 360px outranks the
shared prey, an orca the wildcard arms dives reload windows with pellet
ballistics); the health fallback never chases a withdrawn reserve; and
reloads only happen when safe from EVERY gun, not just the prey's. Took
the belt 3–0 with the champion's own sweep finding (EMA_ALPHA 1) turned
against it — its crew-wide passes outran a smoothed lead.

## Previous champions

**BELMONTE** — `fights/belmonte.json` (cuadrilla, EMA_ALPHA 1). Tenth
doctrine: the bullfighter's crew — a matador never works alone. One bull
picked by MAG STATE (a disarmed enemy beats a merely wounded one; in a
3v3 someone is always reloading), crossfire bearings while its mag is hot,
and the WHOLE crew passes to point-blank the moment it reloads: 150hp
inside a 95-tick window dies faster than any health-threshold rotation can
rescue it. The wounded torero withdraws to the long reserve (the hydra's
own starvation defense, mirrored back) and BULL_RADIUS refuses to chase
withdrawn anchors — fight the fronts 3v2. EMA_ALPHA swept 0.15/0.4/0.7/1
across the field: instantaneous lead won every matchup. Spar record en
route to the belt: 9–0 LERNA, 8–1 AKELA (two arenas), 7–1 VERONICA, 8–1
BLACKFISH, 9–0 FALCONER.

**FALCONER** — `fights/falconer-shrike.json` (shrike v3, factory defaults).
Ninth doctrine, the first weapon-aware brain, rebuilt on a controlled A/B
that dissolved the "shotgun paradox": no SPAS on the field → pure kestrel
dueling (no shared focus for the hydra's rotation to starve); when the
wildcard arms a carrier it becomes the BREACHER (silent high approach,
gravity dive, shells only inside the fan's kill envelope) while teammates
keep dueling. Took the belt 3–0 under live-fire chance-wildcard rules.

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
| 2026-06-10 | FALCONER (shrike v3, hardware-gated roles) | LERNA (hydra, factory defaults) | **FALCONER 3–0** (28–22 ×3) | #73 | `20260610-142049-FALCONER-shrike-vs-LERNA-hydra` |
| 2026-06-10 | BELMONTE (cuadrilla, EMA_ALPHA 1) | FALCONER (shrike v3, factory defaults) | **BELMONTE 2–0** (34–27, 33–26, 36–36 draw) | #137 | `20260610-142850-BELMONTE-cuadrilla-vs-FALCONER-shrike` |
| 2026-06-10 | BLACKFISH (orca, EMA_ALPHA 1) | BELMONTE (cuadrilla, EMA_ALPHA 1) | **BLACKFISH 3–0** (43–35, 37–30, 41–36) | #211 | `20260610-143821-BLACKFISH-orca-vs-BELMONTE-cuadrilla` |

## Coaching-session archive

- **Session 1** (2026-06-10, canonical Skyreach, 4 matches): VEGA 3–1
  OKONKWO — but OKONKWO's final config won the closer 23–22. Configs and
  rationales live in the dataset manifests.
