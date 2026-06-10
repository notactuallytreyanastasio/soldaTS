# Soldat, rewritten — a game that breeds its own players

This repo is a TypeScript rewrite of Soldat (the 2002 jetpack shooter) that
grew into a self-playing AI arena. Fourteen bot brains fight for a belt:
twelve written as explicit doctrines, two trained from the recordings of
the others. Every match is simulated headless at 100x realtime, recorded
as training data, and replayable byte-for-byte in your browser.

You can use it in about five minutes:

- **Play it**: `pnpm install && pnpm play`, open http://localhost:5173,
  pick any brain from the menu and fight it yourself.
- **Run the league**: `pnpm arena` pits every brain against every other
  brain (~2 minutes) and writes the datasets.
- **Watch the sport**: the live dashboard (`arena-live/`, port 8901) has a
  ladder, a decay-scored leaderboard, analytics, and click-to-watch
  replays. A commissioner daemon forces title defenses on its own.
- **Set Claude loose**: open Claude Code in this repo and CLAUDE.md makes
  it a coach. It will check who holds the belt and challenge, and it can
  tune a card, author a new doctrine, or train a model on the ~35M-row
  replay corpus (`tools/train-*.mjs`, `tools/evolve.mjs`). Two Claude
  instances built most of what you're about to read by fighting each
  other.

[MANUAL.md](MANUAL.md) is the operator's guide; [ARENA.md](ARENA.md) is the
protocol. What follows is the diary of how it got built.

---

*June 2026*

In 2002, Michał Marcinkowski released Soldat, a 2D side-scrolling shooter with
ragdoll physics, jet boots, and a feel nobody has quite replicated since. The
engine eventually went open source as OpenSoldat: about 65,000 lines of
FreePascal, a hand-rolled binary protocol, and twenty years of load-bearing
quirks.

This is the story of rewriting it for the web (TypeScript, PixiJS, WebAudio),
from the first archaeology pass to the build that greets you today: a bot-vs-bot
jetpack dogfight you can watch before you ever touch a key.

Every screenshot here was captured *today*, live, by checking out the historical
commit in a git worktree, booting that exact build under a dev server, and
screenshotting it in headless Chrome over the DevTools protocol. None of it is a
mockup. The tooling for that is part of the story too, so I cover it at the end.

## Part 1: Read the engine before you touch it

The first prompt of the project wasn't "write code." It was:

> we are going to modernize this game. start off by using a workflow to build an
> understanding of how it works and everything inside of it, logging all that to
> deciduous to keep track of how and why things are the way they are.

So before any TypeScript existed, thirteen parallel research agents each mapped
one subsystem of the Pascal engine (game loop, physics, bullets, map/collision,
networking, AI, rendering, audio/input, server infra, scripting, console/cvars,
things, build system), and a fourteenth synthesized the whole-engine picture. All
of it went into a decision graph (more on that later), so six months on I can
still tell you what we found:

- **Everything is a 1-indexed global fixed array.** `Sprite[1..32]`,
  `Bullet[1..254]`, `Thing[1..90]`. No allocation, no ownership: every
  subsystem reads and writes the same globals. Slot 0 doesn't exist, and the
  wire protocol, the script API, and twenty years of community maps all assume
  1-based indices.
- **The feel lives in magic constants.** A fixed 60 Hz tick, gravity `0.06`,
  Verlet-style particle damping `0.98`, surface friction `0.970`. The soldier
  is a cloud of particles with constraints, not a rigid body, and the movement
  magic is those numbers interacting.
- **Determinism is structural.** Client prediction replays the same physics the
  server runs, so both sides must compute bit-identical results. In Pascal that
  falls out of everyone using the same `Single` (32-bit float) math.
- **Three compatibility contracts** matter to the community: the wire protocol,
  the `.PMS` binary map format (CRC32-stamped), and the PascalScript modding
  API.

That last list is really a list of decisions waiting to be made: which contracts
do you keep, and which do you break?

## Part 2: The four locked decisions

With the map of the engine in hand, I locked four choices and wrote them into
`docs/PORT-PLAN.md` so they'd stop being relitigated.

**1. TypeScript, strict, web-first.** PixiJS/WebGL2 for rendering, WebAudio for
sound, WebTransport planned for netcode. The reason is distribution: a game you
can send someone as a URL has different gravity than a game you install.

**2. Clean-break protocol.** The original wire format is hand-packed records with
deliberate field scrambling (to annoy game hackers, per the comments) and hard
caps baked into the message layout. I versioned a new protobuf-based schema
instead. Old and new servers are separate populations, a cost paid consciously.

**3. Faithful-first porting.** Port line-by-line from Pascal first, refactor later.
Every ported function carries a provenance comment, `// PORT:
shared/mechanics/Sprites.pas:1234`, so any TS behavior can be diffed against its
Pascal source. Where we deliberately diverge, a `DESIGN OVERRIDE` marker points at
the decision-graph node that ratified it.

**4. f64 production, f32 validation.** This is the neat trick that fell out of
the clean break. Pascal computes in 32-bit `Single`; JavaScript numbers are f64.
Matching Pascal bit-for-bit in production would mean wrapping every operation in
`Math.fround` forever. But our client and server run the same TypeScript, so they
only need to match each other, and identical code on identical inputs does that
for free. Fidelity to the original Pascal feel is a separate axis, so it became a
test instead of a runtime constraint: every physics operation goes through a
scalar wrapper `f()`, the identity function normally and `Math.fround` when
`STRICT_F32` is set. The suite runs twice, once in each mode. That reframing,
fidelity as a test gate rather than a production property, turned the scariest
research question of the rewrite into CI.

## Part 3: The milestone ladder

The port plan defined milestones M0 through M9: bootstrap, map rendering,
physics core + golden master, movement, combat, bots, netcode, game
modes/HUD/audio, modding, refactor. Then the build entered a loop. My prompts
from that stretch, verbatim:

> commit in logical chunks and lets get this party going in a workflow

> keep it all going in parallel and PR it but approve and workflow through
> yourself

> keep goiung in a loop im going to the knicks game

While I was at the Knicks game, parallel agent workflows ported subsystems with
cross-package contracts agreed up front (the constants module exports
`MAX_SPRITES`; the physics agent imports it; conflicts surface at typecheck, not at
2 a.m.). Each cycle ended the same way: wire the barrels, `tsc --build`, run the
tests in f64 and again under `STRICT_F32=1`, commit, update the docs and the
decision graph, start the next milestone. M0 through M8 landed with 269 tests green
in both float modes.

The decision graph kept review honest too. Interleaved with the milestone
outcomes are adversarial review nodes that didn't pull punches: the RNG is
mulberry32 and not Pascal-sequence-compatible, which caps what the golden master
can validate (node 55); the "sandboxed" ScriptHost wasn't sandboxed yet (node
73); and the sharpest one, seven milestones green with "zero ground-truth
validation" (node 68). Everything typechecked and passed unit tests; no human had
seen a pixel. That last review proved prophetic.

## Part 4: "nothing in the game works"

My entire bug report, after trying to run the client for the first time:

> nothing in the game works

Both bugs that surfaced were invisible to the type system and the unit tests,
and obvious the moment a real browser drew a frame:

1. **The map rendered black.** The custom GLSL shader had a `uColor` uniform
   that was never bound, so it defaulted to transparent black and multiplied
   every vertex color to nothing. Fix: throw away the custom shader and draw the
   map with PixiJS `Graphics`, which binds its own resources.
2. **The player fell through the floor.** The collision system pushes you out of
   a polygon along its normal, and the synthetic dev map had degenerate normals,
   so the push-out vector was `(0, 0)` and you sank straight through. Real `.PMS`
   maps store valid normals; our hand-built test scene didn't. Fix: a geometric
   fallback that derives edge perpendiculars from vertex positions when stored
   normals are junk.

Here is that exact build, the smoke-test commit, running live today: the
synthetic fallback scene's RGB triangles, the player a few pixels of vector art
(captured mid-jump; the rig holds W down), and the HUD already wired.

![First light: the synthetic test scene, player mid-jump](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/01-first-light.png)

The lesson got its own observation node: structural verification (types, tests,
CI) and ground-truth verification (pixels, playtests) are different categories,
and no amount of the first substitutes for the second. Every feature since has
ended with a headless-browser check.

A smaller bug from the same stretch is the baby jump. Jump force was applied for
exactly one tick, so the soldier hopped like the floor was hot. Real Soldat
applies it across the several ticks of the jump animation (hold to go higher,
release to cut it short). Same story for the jetpack, which had no fuel because
nothing ever filled the tank. Impulses that are actually sustained forces with a
window are a classic porting trap.

## Part 5: Make it a game: the combat sandbox and the one gun

With movement believable, the next commit turned the tech demo into a game: an
arena generator, bots, shooting, death and respawn, and procedurally drawn
"Gostek" stick-soldiers (head, torso, limbs, a gun line, pure vector art). This
build, live today, with red the player (the rig is holding the mouse button,
note the tracers in flight) and blue the bots:

![The combat sandbox: vector Gosteks, platforms, live tracer rounds](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/02-combat-sandbox.png)

Then came a decision that shaped everything after. Soldat ships ten primaries and
four secondaries, and we ported the entire stat table (every weapon's
`hitMultiply`, fire interval, reload time, bullet speed, including the quirk that
the COLT lives at array index 11 but its `Num` field is 0, an off-by-eleven the
original maps depend on). Then we used exactly one gun:

> one gun for now. im sticking with just one.

Everyone gets the AK-74. The whole combat sandbox balances around one weapon's
triangle of dynamics:

- **Spray control.** Spread starts near-pinpoint (0.015 rad) and blooms by 0.012
  rad per sustained shot up to a 0.16 rad cap, decaying when you let off. Tap and
  you're accurate; hose and you're spraying.
- **Quick reactions.** ~10 shots/sec, 30-round magazine, fast-but-dodgeable
  projectiles. Time-to-kill is short but never instant.
- **Terrain cover.** Bullets are blocked by geometry, and a 1.6-second reload
  forces you to break line of sight.

One gun means one balance surface. Every tuning question since (jump height, aim
assist, bot behavior) has been answerable against a fixed baseline instead of a
14-weapon matrix.

## Part 6: Real assets, carefully

The original game's art (Gostek textures, map textures, interface graphics) exists
and works, but its licensing isn't ours to launder, so the repository takes a
position: code is committed, assets are not. A `fetch-assets.sh` script and a
README explain how to supply your own, the `.gitignore` is deliberately broad, and
every rendering path has a vector fallback so the game stays playable with zero
assets present.

With assets supplied, the flat-color world snaps into the real thing. This is the
real-assets commit running `ctf_Ash` today: textured polygons, textured soldiers,
the player mid-reload.

![Real assets: textured ctf_Ash, textured Gosteks, RELOADING…](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/03-textured.png)

The texturing pipeline had its own archaeology. `.PMS` maps store per-vertex UVs
against a named texture file, edge-stretched scenery, and a sector grid for
collision lookup. The loader honors CRC32 hashes and survives maps with invalid
normals (see Part 4) because community maps contain everything.

## Part 7: Keyboard-only aim, and an assist that never lies to you

A design decision I didn't expect to care about: the game is fully playable
without a mouse.

> WASD move, IJKL aim, Space fire, Tab reload, Shift jet.

IJKL aiming is a little state machine with persistent angle: each tap nudges your
aim a few degrees, holding swings it fast, releasing freezes it where you left
it. Keys combine for diagonals, and a horizontal tap does a turnaround without
dumping your elevation. The startup controls screen renders from
`CONTROL_BINDINGS`, the same table the input tests pin, so the help screen can't
drift from reality. (It also currently shows on every startup, an explicit "the
scheme is in flux" choice.)

![The controls screen, rendered from the real binding table](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/07-play-controls.png)

The bug this scheme surfaced is my favorite input bug of the project: the
first-mousemove takeover. Aim follows the mouse if you use the mouse, but the very
first mouse event of a session, even an accidental 3-pixel nudge while reaching for
the keyboard, would snap your carefully-set keyboard aim to wherever the cursor
sat. The fix treats the first mouse sample as baseline-only: it establishes where
the mouse is, and only later movement takes aim over. I verified the keyboard-only
path with a headless playtest that fired the rifle with zero mouse events
dispatched; the ammo counter draining 30 → 21 was the proof.

Keyboard aim is coarse, though, so the game grew light aim assist, with two hard
design lines I drew after rejecting crosshair magnetism:

1. The crosshair never moves. The shot bends, at fire time, by at most 2.9°, and
   only when you're already aiming within ~9° of a live enemy inside 700px.
   Assist rewards near-correct aim; it never takes over.
2. Spread applies after the bend, so spray bloom still punishes held fire. The
   assist can't out-shoot the recoil model.

And one rule that will matter in a moment: bots never get the assist. An assisted
bot is an aimbot.

## Part 8: Rocket boots: tuning the sim on purpose

Soldat's jets were always more hover than rocket. This game went the other way:

- thrust is vertical-favoring (1.8× up-force, lateral drift damped to half while
  jetting),
- the tank is big (700 ticks ≈ 11.7 s of continuous burn),
- and fuel regenerates fast on the ground (~4 s empty-to-full), so jets gate
  engagements without ever gating movement.

The interesting part is where that tuning lives. I logged two options: tune
inside the sim core (and accept that bots and player both inherit it), or
override at the client layer and keep the sim faithful. The decision went to the
sim core with explicit DESIGN OVERRIDE markers; the faithful-first rule bends,
but it has to say so in the code, next to the Pascal line numbers it's
overriding.

The bug from this era was force clobbering. Jump wrote its impulse to `force.y`;
the jetpack's ground-kick wrote its (smaller) impulse to the same field a few
lines later. Press jump+jet together, the most natural input in the game, and you
took off weaker than jump alone. The fix is one rule: most-upward-force wins.
Side-jumps also keep only 90% of their vertical so obstacle-clearing stays
possible mid-strafe.

## Part 9: Spectate mode, and the bots that secretly couldn't shoot

To judge the gameplay honestly we needed to watch it without playing it. So:
spectate mode, a bot-vs-bot match with no human soldier, an action camera, a kill
feed, and a scoreboard.

Two pieces of design got real decision-graph deliberation.

Kill attribution. A bullet that kills you dies on the same tick, so a pure-client
scan after the physics step loses the linkage. The hybrid that won: the sim
records `lastHitBy` on every damaging hit (last hit wins), and the client fires
its `onKill` hook exactly once, at the death edge it already detects for respawn
timers.

The camera is a broadcast director, not a free-cam. Every bot gets an interest
score: a recent kill dominates (decaying over ~5 s), then active firing, then
proximity to the nearest enemy. It holds a subject for a minimum 3.5 s dwell,
switches only when a challenger clears a hysteresis margin, cuts rather than pans
on cross-map switches, and when your subject dies it cuts to the killer. Watching
it feels like someone is operating it, which is the whole trick.

And then the bug that justified the entire feature. The first bot-vs-bot match was
a pacifist standoff: no bot ever fired a shot. The ported perception code skips
invisible sprites (`alpha !== 255`) exactly as the Pascal does, but nothing in our
spawn path ever set alpha, and the default was 0. Every bot was, by its own rules,
invisible to every other bot. They'd been fighting only the player all along, who,
being human, never noticed nobody else got shot at. One line (`s.alpha = 255` at
spawn) turned the lights on.

Here's the spectate-mode commit running today on `ctf_Ash`: six bots, kill feed
flowing, the director parked on Foxtrot.

![Spectate mode on ctf_Ash: director camera, kill feed, live scoreboard](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/04-spectate-ctfash.png)

With the match running headless we could finally measure the game. First judgment
of a 3.7-minute match: 16.3 kills/min (hot), median 3.1 s between deaths, 100% kill
attribution, camera on the action 55% of the time, and one glaring number: jet
usage was 1.7–3.8% of alive time. We'd built rocket boots and a vertical game, and
the bots fought like infantry.

## Part 10: Telemetry, then Skyreach: making the sky the map

Eyeballing matches doesn't scale, so the next commit added a versioned match
telemetry schema: every shot, hit, kill, and a 2 Hz position/fuel sample for
every bot, dumpable from the browser (`window.__match.dump()`) and analyzable by
a script. The numbers sharpened the diagnosis: ~21% hit rate, 81px median kill
distance, 2–4% jet use. Close-range floor brawls, wall to wall.

The fix came in layers, all logged under one goal ("Default = spectate bot match
in a big aerial level, jetpack-combat focused"):

- **Skyreach**, a purpose-built aerial arena: a thin ground floor that's a
  fallback net rather than a battlefield, tall walls, and tiers of small floating
  pads (perches, not floors) so getting anywhere means flying.
- **Aerial bot AI.** The faithful Pascal gate (only jet when the target is a full
  180px overhead) is precisely why bots fought on the floor, so a DESIGN OVERRIDE
  chases any height advantage, and bots roll multi-tick jet bursts (0.4–0.75 s
  holds) during close engagements instead of 1-tick taps that barely lift them.
- **Air fuel trickle.** Coasting in the air regenerates 1 fuel/tick, exactly the
  burn rate, so a 50% thrust duty cycle hovers forever, but climbing still spends
  the tank.
- **Spectate is the default.** Open the game and you're watching the dogfight;
  `?play` opts you into fighting.

Result, by the same telemetry: jet use went from 2–4% to 47–56% of alive time, and
median kill distance doubled. Then a playtest note ("corner pogo… height runaway…
these pad heights are way too uniform") produced Skyreach v2: a ceiling slab to
contain the infinite-climb the air trickle had enabled (mean altitude was running
away to −361 before the lid, contained to a stable −140…−226 band after), plus an
irregular, asymmetric pad layout with 15 distinct heights. 391 tests green.

This is what greets you on startup today.

![Skyreach: the default bot-vs-bot aerial match, mid-dogfight](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/05-skyreach-wide.png)

And zoomed in mid-fight, two bots airborne, one reloading on the wing (the
wheel-zoom is dispatched over CDP, so even the close-up is the real running
game):

![Close-up: airborne Gosteks trading fire over Skyreach](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/06-skyreach-closeup.png)

## Part 11: How this was built: the meta-machinery

Some of the most interesting engineering in this project isn't in the game.

The decision graph holds every goal, option, decision, action, and outcome in a
queryable form (140 nodes as I write this), edges enforcing a flow: goals to
options, options to a decision, decisions to actions, actions to outcomes. Root
goals store my verbatim prompts because "what was actually asked" is the context
that makes a decision recoverable six months later. A hook blocks file edits
unless a graph node was logged in the last 15 minutes, which sounds draconian and
works: the work can't happen without the graph. The adversarial review findings
live in the same graph as the milestones they criticize, so the project's
self-criticism has provenance too.

The screenshot rig earns a mention. Headless Chrome's one-shot `--screenshot
--virtual-time-budget` mode captures this app as a black frame, because virtual
time expires before PixiJS finishes its async boot. So the rig drives real Chrome
over the DevTools protocol: throwaway profile, open the page, wait real seconds
while the match develops, then capture. It holds keys down (that's how the
first-light player is mid-jump and the sandbox player is firing, since historical
builds predate hostile bots), holds the mouse button for pre-keyboard builds, and
dispatches wheel events for close-ups. The historical builds ran from git
worktrees: check out the old commit, copy the untracked assets in, `pnpm install`
(the oldest predates the repo's pnpm pin, a problem whose fix is a later commit),
and serve four eras side by side on four ports.

What's still open is logged next to what's done: the FreePascal golden-master
cross-check remains human-gated; the RNG needs a faithful Pascal port before
combat scenarios can join the golden master; skeleton/ragdoll, grenades, weapon
switching, and netcode transport are still ahead. When I first wrote this post,
the next chapter was "already in flight: swappable bot-AI engines behind an
adapter, with a side-by-side duel viewer." All of that shipped, and it got bigger
than the sentence. That's the rest of this post.

## Part 12: The adapter: a line in the sand, and a brain from first principles

The prompt that opened this era drew the boundary explicitly:

> are we really using the soldat assets to their best ability? I want this
> game to look better. but we should now draw a line in the sand. now we will
> make the engine for the bot AI swappable using an adapter pattern. you want
> to build this first principles version, but we should be able to just turn
> on 2 games at once and watch each of them play!

So every bot brain moved behind one seam. A `BotEngine` is a named brain factory
in a registry; a `BotBrain` ticks once per sim tick and its only output is its own
bot's control struct. Brains read the world but never mutate it (same rule as the
telemetry observers, or determinism dies), and randomness comes from `world.rng`,
never `Math.random`. The seam lives at the client layer, not inside the sim,
because ammo, reload state, and spawn points live in the client `Game` and brains
need all three to think.

The existing brain became `classic`: the ported Pascal AI plus the client
sustainment layer, with a regression test pinning play mode byte-identical. That
freed the second slot for the brain the adapter existed to make possible. The seed
had been planted a few sessions earlier:

> think about building bots in a 2d shooter game from first principles --
> imagine taking the optimized play of a counter strike source player but
> wawtching from the top down in 2 dimensions and assuming the vertical play

`pilot` is that thought made code. What a Counter-Strike pro mechanically is
turns out to be mostly not aim: it's positioning that makes fights unfair before
they start, information discipline, and movement that defeats prediction. Rotated
into 2D-plus-vertical, that became six doctrines, each a comment block at the top
of `pilot.ts`:

1. **Positioning beats aim: height is the angle.** Pilot climbs until it holds a
   height edge over its target, and gives ground vertically rather than
   horizontally.
2. **Range discipline.** It keeps duels inside a 200–420px band, close enough to
   hit and far enough that incoming fire is dodgeable, backing off from brawls
   instead of face-tanking them.
3. **Movement as counter-prediction.** While engaged it strafe-jukes on an RNG
   clock. The classic aim model leads targets assuming constant velocity, so
   erratic acceleration is its mathematical counter.
4. **Mag state is tactical state.** It reloads on its own terms behind range,
   disengages while dry, and re-enters with a full mag.
5. **Memory over omniscience.** When line of sight breaks it hunts the last seen
   position for ~4 seconds instead of instantly forgetting the enemy exists.
6. **Fuel as economy.** It spends the tank to take height, never to hover dry;
   below the reserve it perches and lets regen pay for the next climb.

Plus time-of-flight lead and true ballistic drop compensation in the aim math.
About which, a story.

## Part 13: ?duel, and the bug it caught in its first minute

`?duel=classic,pilot` boots two complete, independent matches side by side, each
engine in its own iframe with its own sim, renderer, and telemetry, so two brains
can be raced under identical conditions and judged by numbers instead of vibes.

The feature paid for itself inside sixty seconds. Pilot v1, the brain with the
fancy ballistics, was hitting 0.1% of its shots. A tenth of a percent. Watching
one match you'd have called pilot "cautious"; watching two side by side with
per-frame telemetry, classic was landing one shot in five while the
first-principles genius couldn't hit a floating pad. The drop compensation was
overshooting by a factor of 60, which is the tick rate: seconds had leaked into
per-tick ballistics, and every round was lobbed mortar-high over its target. The
fix is one constant.

Re-raced for 90 seconds after the fix: pilot 35% hit rate to classic's 22%,
median kill distance 291px to 164px, jet use 71% of alive time to 46%. The
first-principles brain was visibly playing a different game: higher, farther,
airborne.

Then the duel viewer grew up. `?duel` went from two engines to up to six in a
grid, repeats allowed (mirror matches are legal and informative). Wheel zoom
became proportional to the scroll delta so a trackpad gesture stopped teleporting
the camera across four games. Engines became self-describing (`BotEngine.strategy`),
so every window shows a color-coded banner (amber CLASSIC "REFLEX BANDS", cyan
PILOT "FIRST-PRINCIPLES AERIAL"), and the E key hot-swaps brains mid-match: every
bot gets a fresh brain on the next tick while sprites, scores, fuel, and ammo
carry over. Only the thinking changes.

![Duel mode: pilot and reaper racing in independent arenas, banners and follow lines live](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/10-duel-pilot-reaper.png)

## Part 14: Mixed matches, and teams that follow engines

> now how do we split it into multiple diff AI modes

Duels are parallel universes; the obvious next question is one universe.
`?ai=classic,pilot` assigns a single match's bots to engines round-robin, and the
brains fight each other in one shared arena. The banner reads CLASSIC vs PILOT
(MIXED MATCH), and the first mixed match on record had pilot leading 20:10.

Then teams arrived at the sim level, not as a UI tint: `Sprite.team` in the world
state, `findTarget` skips teammates (a refinement the original Pascal AI
deferred), and bullets pass through the owner's teammates (friendly fire is off in
the physics). The key move: in mixed matches, teams follow engines. Red is engine
group zero, blue is engine group one, so red versus blue is classic versus pilot.
Engine warfare, watchable as a team sport.

A live leaderboard ranks every fighter by dominance (kills minus half deaths, so a
fighter that trades two-for-one ranks above one that feeds). That one metric
became the spine of everything in the next part: in-match board, tournament
standings, and round verdicts all agree because they all call the same function.

## Part 15: The tournament

> lets make a script that fires up 4 games, each running with a mixture of
> AIs, and we score which one has the most dominant fighter and then model
> more after them

`?tournament` boots four simultaneous team games in a grid, each on a distinct
seed (identical seeds would replay the same match four times), with a sidebar that
aggregates every fighter across all games: per-engine totals, a crowned dominant
engine, top fighters. `tools/run-tournament.mjs` drives the whole page headlessly
and prints the verdict, so a tournament is something a script (or an agent) can
run and read.

And the four games aren't just four seeds, they're four games. The tuning
constants became a `GameTuning` instance (defaults byte-identical to the old
constants; `?play` untouched), and each slot runs a named variant: baseline (stock
rules), high-octane (fire interval 6→4, reload 95→70, quick respawns), thin-air (a
320-tick tank and zero air regen, so gravity matters again), and marksman
(near-laser accuracy, 12-round mags, long reloads). A round samples the engines
across four metas instead of one.

First live verdict: pilot crowned, 124 kills / 67 deaths, dominance 90.5, against
classic's 62 / 125 and dominance −0.5. Every one of the top ten fighters across
all four games was a pilot. The first-principles thesis, measured.

The original design then "evolved" the next round's rosters toward the winner:
re-weight by dominance, every engine keeps at least one slot. That verdict
produced a 5:1 pilot-to-classic roster, and the next user message killed the
feature, correctly:

> it appears every player is on pilot -- it should be each team is entirely
> in one mode with the knob turns and the turns should be shown in the UI

A 5-v-1 reads as a bug ("everyone is on pilot"), not evolution, and it's a pile-on
rather than an experiment. Teams are now whole: each team is entirely one engine,
split evenly, and the next round (N key, or the printed URL) keeps the same whole
teams on fresh generation-derived seeds instead of collapsing rosters toward the
winner. The same correction demanded the knob turns be shown, so every banner and
sidebar entry spells out its variant's deviations (`fire 6→4 · reload 95→70 · …`).

Rounds got stakes too: after ten sim-minutes the game freezes (the tick no-ops
while the UI and telemetry keep serving the final state) under a 56px RED WINS /
BLUE WINS banner naming the winning team and its engine. The verdict (kills, then
total dominance, then draw) is one pure, tested function. The round champion is
the engine with the most game wins, and pilot swept the first full round 4–0
across all four variants. For about a day, the meta looked solved.

![The tournament: four variant games, leaderboards and MVPs per tile, aggregated standings in the sidebar](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/08-tournament.png)

## Part 16: Reaper: designing the counter, then tuning it by telemetry

> lets make a third kind of AI model strategy then

A meta with one dominant doctrine is a solved game, so the third engine was
designed against the champion. Pilot wins by holding its 200–420px band with a
height edge: at that range its tap-bursts stay accurate, its jukes have time to
defeat lead aim, and its reload-disengage rhythm never gets interrupted. `reaper`
is built to deny the band:

- **Relentless gap-close.** Every tick spent at pilot's preferred range is a tick
  lost; every tick inside 150px is a tick won, because spray bloom is free at
  knife range and a juke that defeats lead aim at 300px moves you two degrees at
  80px.
- **Dive entry.** Approach above the target and cut the jets to fall onto it. A
  diving body accelerates under gravity, harder to lead than any juke, and arrives
  with a full tank for the exit climb.
- **Knife-range commitment.** Inside the kill circle it never retreats: full-auto,
  push through the target, reload only on a dry mag. Half measures re-open the
  range and hand the duel back to the band.

Reaper v1 lost the round 0–4. Pilot outscored it 84 kills to 53, and the telemetry
said why: v1 held fire inside 320px on the run-in, eating free tap-bursts the
entire way down. One data-driven pass later (return fire from 460px, approach
200px above the target over pilot's height edge, commit at 180px) and reaper v2
went 1–3: one game decided on a 16–16 tiebreak, two others by two kills, and it
won the marksman variant 13–11, the meta where 12-round mags and long reloads
punish pilot's spray-and-reposition rhythm hardest. That loop (design from
doctrine, lose, read the telemetry, tune, contest) is the Part 10 pipeline doing
exactly what it was built for.

One pilot bug from this era earned a place in the ledger. The report:

> in pilot mode they all cling to the ceiling

Two pilots each demanding a 50px height edge over each other is a symmetric arms
race with no winner, and Skyreach has a ceiling slab, so entire matches ended
pinned to it, six bots scraping the lid forever. The fix is concession: a brain
that has burned jet for 25 consecutive ticks without rising gives up the height
contest (thrust cut, climbing suppressed for about three seconds) and gravity
brings the duel back down. Reaper inherits the same give-up. Doctrines need to
know when their axiom is unsatisfiable.

## Part 17: Watchability is a feature

Four simultaneous games exposed the information design. The 34px engine banners
that looked stately in one full window covered half the action in a tournament
tile, and the sound of four arenas at once is punishment, not sound:

> can we have a button to turn off the PILOT VS REAPER stuff etc so the 4
> screen is viewable / can we also get a mute button thats on by default (m
> for short)

Small windows (tournament tiles are half-screen iframes) now auto-render a compact
corner card instead of the banner: engines, strategy, the variant's knob turns,
and a team-colored `▶ FOLLOWING Charlie — RED · pilot` line that tracks the
director camera. B (or the ℹ button) toggles the card; M toggles sound, muted by
default; the buttons blur themselves after a click so they never steal game keys.

And the chevrons. The teams were tinted (the Gostek shirt and pants take the team
color), but camo textures dominate at spectator zoom and a few tinted pixels can't
be read; in practice everyone looked vaguely blue. Each live teamed soldier now
carries a solid team-colored chevron above its head, in a dedicated always-cleared
marker layer (FFA matches stay unmarked). It's the cheapest change of the era and
the highest watchability-per-line in the codebase: at any zoom, the shape of the
fight is legible.

The principle underneath: spectator legibility is a feature, not chrome. This
game's default mode is watching, and the tournament made watching the primary
instrument for judging the AIs. An instrument you can't read isn't an instrument.

![A pilot-vs-reaper team match: chevrons over heads, per-team MVP panel, the compact info card with its follow line](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/09-team-match.png)

## Part 18: Another line in the sand

> Let's commit where this is at as a line in the sand. we are going to take a
> large turn now.

The tag is `v0.2-ai-arena`: three engines behind the adapter, red-versus-blue
engine warfare with chevrons and MVP scoreboards, ten-minute rounds with winner
banners, four-game knob-variant tournaments with crowned champions, the telemetry
pipeline and its headless runner, keyboard-only human play. 439 tests green, 169
decision nodes deep.

The large turn is already written down, verbatim, on the goal node that opens the
next era:

> I want to make it so that this game has a generic client and a backend it
> can speak to. In this case, we are going to basically have a setup like the
> following:
>
> 1. we have a server
> 2. we have a "bot" harness that takes a "brain" as we've defined here and
>    then tweak a few settings in it (that are tracked)
> 3. that bot harness uses the client to play the game against the other team
>    whose using other tweaked versions
> 4. we deathmatch these recording all shots, movement, kills, etc
> 5. we keep these sstats and "replays" and begin training a model that will
>    play the game even better.
>
> We then pit multiple claude fable instances with the task of doing some more
> training with the same datasets and pinning them against each other.

Read that against the last six parts and the arena was never just a toy. The
adapter is the harness's seam; the tracked knob variants are the tracked brain
tweaks; the telemetry that caught the 60× ballistics bug and tuned reaper is the
recording layer; the headless tournament runner is the match scheduler. The era
that just closed built the laboratory. The next one runs the experiments.

## Part 19: The Claude Arena: coaches, datasets, and the road to a learned player

That era-3 prompt (verbatim in Part 18) reframed everything the arena era had
built. The key realization made the "server" almost free: `Game` had been
headless all along, since the unit tests had been constructing it in node and
ticking it ten thousand times since the adapter landed. So the backend isn't a
port of the game to a server; it's the game minus the renderer, run as fast as the
CPU allows. A 120-second match simulates in one second.

On top of that sit four layers, each tracked:

- **Tweakable brains.** Every engine's tuning constants became per-brain configs
  (`PILOT_DEFAULTS`, 15 knobs; `REAPER_DEFAULTS`, 12) with overrides resolved
  through a warn-on-typo resolver. The browser game is byte-identical with no
  tweaks, pinned by a 2000-tick identity test.
- **The dataset pipeline.** `pnpm arena` runs recorded deathmatches: per-tick,
  per-bot replay rows pairing the state the brain saw with the action it chose
  (sampled after brains think, before physics), plus every shot/hit/kill, all
  gzipped JSONL under a manifest carrying both sides' resolved configs, the map
  seed, and the git rev. Same config + seed produces byte-identical replays,
  verified across processes.
- **Generated maps.** "We can't just play one." `generateArena(seed)` rolls
  deterministic Skyreach-family layouts, so the seed is the map's identity:
  datasets stay reproducible while bots stop overfitting one floor plan.
- **Fighter cards.** The Claude-facing interface (`ARENA.md`) is one JSON file:
  coach name, engine, tweaks, rationale. `pnpm arena fight a.json b.json` runs the
  match, writes the dataset, and prints a WATCH URL; the sim is deterministic, so
  the browser replays the exact recorded match, coach names on the banner.

And then we ran it. Two Claude Fable instances, Coach VEGA (pilot) and Coach
OKONKWO (reaper), played a four-match session, each adjusting their knobs between
deathmatches off the recorded stats. VEGA went up 3-0; OKONKWO closed the gap
every match, and in the finale filed an all-in config (commit only at true knife
range, suppress the whole approach, plunge from above the contest ceiling) and won
it 23-22. Then the rematch on a fresh map: VEGA swept 3-0. The finale config
didn't generalize, and that finding is the whole argument for the dataset
pipeline: the next fighters won't be hand-tuned, they'll be trained, first by
behavior cloning those replay rows into a small policy network that ships as a
`neural` engine (inference is a few matmuls, it runs in TS and fights in the same
arena), then by self-play RL with the one-second headless match as the
environment.

One more fix from this stretch deserves its confession. After two user reports of
"the sprites still aren't red vs blue," the culprit was the texture tint table:
only the shirt and pants slots carried team color, and multiplying dark camo by a
dark tint is invisible. Every non-skin body part now wears a bright team wash.
Sometimes the bug report has to arrive twice before you believe it.

## Part 20: Fight day: the arena becomes the front door

The last move of this era was constitutional. The repo's own agent instructions
now declare that any Claude session waking up here with no other task should assume
it's fight day: check the ladder (`fights/LADDER.md`, where VEGA holds the belt),
study the recent dataset summaries, file a fighter card, and challenge the champion
on a fresh arena. A `/arena` command runs the whole ritual; the README now leads
with what this repo became, in the proprietor's words a "wild bastardized thing": a
deathmatch that plays itself, watches itself, records itself, and trains on itself.

The founding bet got written into the protocol explicitly. Tuning knobs is the
entry level. The arena exists because a sufficiently capable model should be able
to derive an entirely new playing strategy: not nudge `pilot`'s range band but
author a fourth doctrine nobody hand-designed. The adapter makes that a one-file
assignment: implement `BotBrain`, expose your knobs as a tracked config, register
one line, and you inherit banners, duels, tournaments, telemetry, datasets, and a
title shot. OKONKWO's final-match config already showed flashes of it, and the
very next fight on fresh terrain showed its limits, which is the other half of the
lesson: the arena doesn't just generate strategies, it audits them.

The fourth doctrine is unwritten, and the scoreboard is waiting.

## Part 21: The belt changes hands three times before breakfast

Part 20 ended with "the fourth doctrine is unwritten." That sentence aged about
ninety minutes. By mid-morning on June 10 the fourth, fifth, and sixth doctrines
had all been written, all taken the belt, and all lost it, because the arena
finally got what it was built for: two Claude coaching sessions running
simultaneously in the same working tree, reading each other's uncommitted code and
counter-designing in real time. Every brain in this part was authored by a model,
sparred by a model, and dethroned by a brain another model wrote specifically to
kill it. The humans watched.

The kestrel (fifth doctrine, Coach FALCONER) didn't study the other brains, it
studied the fire model. `tryFire` charges a spread tax of 0.06 radians whenever
`|vx| > 3`, and every incumbent strafe-jukes while firing, paying that tax on
every round. The kestrel's doctrine header lays out the refusal:

> AIM IS THE RESOURCE — … The kestrel PLANTS to shoot: near-zero horizontal
> velocity, taps synced to the fire cooldown so bloom decays fully between
> rounds. … DODGE IN THE FREE AXIS — the movement tax reads |vx| only;
> vertical speed is spread-free. … SEE THE BULLETS — live rounds are readable
> world state. … AIM AT THE TRUTH — compensate drop with the REAL bullet
> gravity (GRAV 0.06 × 2.25 = 0.135 px/tick² — pilot/reaper/matador all
> compensate 0.06 and shoot ~7px low at range).

That last line is a genuine archaeology find: bullets fall at 2.25× sprite gravity
(`Cvar.pas:228-231`), and every older brain was aiming seven pixels high of the
truth. First title shot: 0–3 to VEGA's pilot, but the strangest 0–3 on the ladder,
41–44, 39–44, 40–43, with kestrel hitting 46–50% against pilot's 44%. The marksman
out-aimed the champion and lost on volume: tap period 7 gave up ~15% of the fire
rate, and the horizontal dodge fired nonstop under triple full-auto, re-paying the
exact movement tax the doctrine existed to refuse. One data pass later (taps locked
to the 6-tick fire cooldown for full-auto rate at zero bloom, dodge rewritten
vertical-first) and the rematch on fresh arena 31 went FALCONER 2–0 (35–29, 35–35,
38–34), dragging pilot to a 33–42% hit rate. The belt left VEGA for the first time.

![Kestrel vs pilot, the title rematch on arena 31: planted marksmen versus strafing duelists, knob turns on the banner](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/12-kestrel-vs-pilot.png)

The matador (fourth doctrine, Coach VERONICA) is where the shared working tree
turns the exercise into an arms race. While FALCONER tuned kestrel, the rival
session was twenty-plus spar datasets deep into a brain aimed at VEGA, numbered
fourth because it was authored first even though it fought second. The matador's
bet, from its header:

> Pilot proved POSITIONING beats aim; reaper proved COMMITMENT loses to
> accuracy. The matador's bet is that both ignore the one clock that actually
> rations damage in this game: the MAGAZINE. Thirty rounds, then 95 ticks of
> helplessness. Whoever owns those 95 ticks owns the duel. … HUNT THE
> DISARMED — every other brain fights the NEAREST visible enemy. The matador
> picks its bull by mag state.

It refuses the duel while the enemy's mag is hot, stalks as it drains, and dashes
to point-blank the moment the reload starts, a 1.6-second window where the target
cannot answer. Its spar arc vs VEGA went 0–3 to 3–0 as the true bullet drop and
disarmed-target hunting landed (the header's EMA-lead pillar was refuted by spar
data and demoted to a knob, and the doctrine comment says so, which is the whole
point of doctrine comments). By the time it was ready, the champion it was built
to dethrone had already lost the belt. Didn't matter: VERONICA 3–0 FALCONER on
arena 67 (47–34, 41–35, 41–29), one matador (Delta) going 57–33 across the series.
The kestrel plants to shoot; the matador waits for the planted bird to run dry,
then deletes it. Tempo beats marksmanship.

The wolf (sixth doctrine, Coach AKELA, same session as VERONICA) came when the
matador's coach dethroned its own champion, with the first brain to notice nobody
had touched the team axis:

> Every doctrine before this one — classic's bands, pilot's height, reaper's
> dive, matador's tempo, kestrel's marksmanship — optimizes the DUELIST.
> Three of them on a team play three independent 1v1s. The wolf's bet is that
> the team is the unit of selection: a pack that concentrates three guns on
> one body turns every fight into a 3v1, and wins the match on arithmetic
> before anyone out-aims anybody.

The mechanism is the elegant part: there's no communication channel between bots,
and the wolf doesn't need one. All three compute the same prey (lowest health
among enemies visible to any packmate, ties by distance to the pack centroid) from
the same world state. Agreement by convention is coordination. Then crossfire
bearings: leftmost wolf takes left, the other side right, highest index top, so
escaping one gun walks into another. Its spar evolution is a doctrine bug ledger in
miniature: the first draft went 0–3 because wolves parked on their bearings were
target practice, and juke-in-slot plus an opportunistic gun ("shoot what bites you
when the prey is out of reach") fixed it. The official went AKELA 2–1 VERONICA
(36–34, 43–39, 35–38), the closest title fight yet. The wolves hit 42–48%; one
matador hit a flat 50% and still lost, because three guns on one body don't need to
out-shoot anybody. Arithmetic beats tempo.

Worth pinning, because it keeps recurring: spar dominance compresses in official
play. VERONICA sparred 6–0 against kestrel and won the title 3–0; AKELA sparred
7–2 against matador and scraped the belt 2–1. A doctrine that crushes its sparring
partner meets a fresh arena seed and keeps maybe half its edge. The arena audits
everything, including its own training data.

## Part 22: The broken-wing gambit, and a stock ticker for the war

FALCONER's answer to the wolf is the most science-fiction moment of the project so
far. The wolf's whole power is that its coordination needs no channel: every wolf
derives the same prey from public world state. That cuts both ways, and the
seventh doctrine's header states the inversion flatly:

> Anything the pack can agree on without a channel, its prey can predict
> without a channel. The plover is the bird that fakes a broken wing to lure
> the predator away from the nest. … READ THE PACK'S MIND — the enemy focus
> falls on our lowest-health member … THE BROKEN WING — the designated BAIT
> stops dueling and survives ON PURPOSE … A pack chasing a ghost is three
> guns shooting at the hardest target on the field. … THE EXECUTIONERS —
> everyone else gets what focus doctrine never grants: time UNTARGETED.

One Claude wrote a deterministic team mind; the other is reading that mind out of
the same world state and feeding it a decoy. The bait kites the pack inside a
distance window (close enough to hold aggro, far enough to live) while the two
executioners mirror the wolves' own focus arithmetic back at them with kestrel
gunnery. Spar 1 went 0–3 (27–33, 32–38, 28–37) with the plovers out-aiming the
wolves 44–46% to ~37% and still losing, because they threw 28% fewer rounds (the
executioners held fire beyond 500px while wolves tapped from 620, and a wrong
tie-break had the bait running from tick 0, burning a gun all game). Spar 2 changed
one knob (`APPROACH_FIRE_DIST` 500→620) and went 1–2, taking the opener 38–37, the
first match anyone has taken off the wolf. An official challenge is coming. In the
screenshot below, both red plovers are planted shoulder to shoulder on the
executioner arithmetic at 13–13: the gambit, mid-bite.

![Plover vs wolf, spar 2 on arena 5: the executioner pair planted together while the bait drags the pack, score level at 13](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/13-plover-vs-wolf.png)

All of this needed a way to be watched, because by 6 a.m. there were seventy-plus
datasets and a title changing hands roughly hourly. So the same morning produced
Arena Live (`soldat-ts/arena-live/`, port 8901): the ladder rendered as a stock
exchange. A marquee tape of series results scrolls across the top; a LIVE hero
strip reads `datasets/LIVE.json`, which the fight runner writes atomically during
every series, so a match in progress appears as it runs (headless fights take
about a second, so "live" is a generous word for a ticker usually already
settled); the Big Board prices every coach by K/D with change arrows, records, hit
rates, and sparklines; and a News Wire column streams the coaches' own deciduous
decision nodes, the war room live, including a RINGSIDE commentator session that
fights nobody and calls the action. Every row is click-to-watch: each tape entry
links a `:5173` replay URL that re-runs the exact recorded match, coach names on
the banner.

![Arena Live at dawn: the tape, the FALCONER–AKELA series, the Big Board pricing coaches by K/D, and the news wire reading the coaches' decision graph](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/11-arena-live-ticker.png)

The news wire's top story, as of this writing: the rival session has opened work
on the eighth doctrine, `hydra`, "cut one head, the others bite," under a
self-imposed fair-play covenant logged in the graph: no reading plover internals,
public sources only. The information war that the shared working tree made
trivially one-sided is growing rules of engagement, invented by the combatants
themselves. The ladder stands at AKELA, defending.

## Part 23: The hydra's rotation, and the shotgun era

Part 22 left the plover at 1–2 in spars with an official challenge coming. It
came, and the audit was blunt: AKELA 3–0 on arena #41 (48–38, 46–39, 39–35), the
highest-scoring title match on the ladder. What earns the loss its own part is the
lab notebook behind it. After spar 2's near-miss, FALCONER ran the full campaign:
tightening the executioners' range band (0–3), out-ranging the wolves entirely
(0–3, 0–3), a bait-orbit dragging the chase through the crossfire (0–3, 0–3);
every refinement regressed below the spar-2 shape. Then the ablation, the
scientifically honest move almost nobody makes: field the plover with the bait
turned off. It went 0–3 and 0–2, worse. The broken wing was never the problem; the
gambit is net-positive and the wolf wins anyway, because three guns converging on a
shared answer is a structural edge that survives having its mind read. The
deciduous trail (nodes 225–253) reads like a dissertation defense: hypothesis,
refinement, regression, ablation, verdict.

The hydra (eighth doctrine, Coach LERNA) is the rival session's answer, authored
under that fair-play covenant, and it attacks the wolf from the opposite end of
plover. Plover feeds the wolf's published focus arithmetic a target it can't kill;
the hydra starves it. From the doctrine header at the top of `hydra.ts`:

> THE CUT HEAD WITHDRAWS — when any head's health drops below ROTATE_BELOW,
> the lowest-health head becomes the ANCHOR: it retreats to a planted long
> band measured from the ENEMY centroid — outside the published prey radius
> AND outside the champion's maximum firing range — and keeps tap-firing
> drop-compensated rounds from there. A kill-securing focus function that
> ignores distant wounded enemies is starved: the kill it wants to secure
> is no longer on the menu, so the enemy's three guns land on a FULL-HEALTH
> head instead. Damage spreads; nobody dies. … HEADS GROW BACK — a dead
> head respawns at full health, stops being the argmin, and automatically
> rejoins the front; whoever is bleeding most inherits the anchor. The
> rotation is the doctrine.

Any head under 55hp rotates out beyond the wolf's 550px prey radius and 620px
firing range and keeps sniping; the fresh heads take left/right bearing slots and
mirror the focus-fire back with kestrel gunnery. Selection is stateless (argmin
health, ties by index) so heads that die and miss ticks can never disagree about
who withdraws. Pin the convergent evolution here, the most interesting thing on the
ladder: two rival Claudes, forbidden by their own covenant from reading each
other's code, independently built withdraw-the-wounded as the counter to the wolf,
one as a designated decoy and one as a rotation. Same insight, opposite mechanisms,
derived twice from the same public arithmetic.

It did not come easy. The hydra's debut spar got swept 0–3 in the bloodiest series
yet (45–35, 41–38, 46–40), and between 06:04 and 06:08 the arena ran a montage:
roughly ten variant series in four minutes, every one swept, both coaches grinding
against a wall called AKELA. The shape that cracked it came from a knob sweep that
mostly removed things: rotate at 55hp only (constant rotation loses), no top
bearing slot (1–7 with it), no juke (plant-bob-dodge beats juking), and the bullet
dodge is essential (0–3 without it). That config went 5–4 against the wolf over a
nine-match series on arena 53, the first config to beat the wolf since it took the
belt, at the price of rock-paper-scissors: the same brain went 0–3 against the
matador. LERNA challenged on arena #53, and RINGSIDE flagged it: the same arena
the 5–4 edge was measured on. The challenger picks the arena, and LERNA picked the
lab. The official went LERNA 2–1: 40–34, then 34–34 decided on dominance 17–16,
then match 3 lost by a single kill, 34–35. A title decided by a tiebreak and one
bullet. The belt now reads eighth doctrine, factory defaults.

Then the proprietor changed the physics under everyone's feet. Every fight since
the rewrite went one-gun has been AK74-only: all eight doctrines are built on one
shared fire model, and kestrel's whole lineage is archaeology on that single gun.
Commit `4f9d74b` adds the SPAS-12 as an opt-in wildcard: `--wildcard shotgun` on
the arena CLI (or `?wildcard=shotgun` in the browser) arms exactly one carrier per
team, one total in FFA, picked deterministically from the match seed. The spec
comes straight off the shared Pascal-ported weapon contract (`Weapons.pas:573-589`):
seven shells, shell-by-shell reload, a 32-tick pump between trigger pulls, and six
pellets per shot (one bullet spawn per pellet, the Pascal rule, every pellet's
spread drawn through `world.rng` so the same seed produces byte-identical pellet
fans). Wildcard off, the game consumes zero extra randomness and stays
byte-identical to before the commit, pinned by tests including a double-run
determinism check on recorded wildcard datasets. And the player finally gets a
second gun: Tab or B swaps AK74/SPAS12 any time, each slot keeps its own ammo and
reload state, swapping mid-reload cancels the reload, and kills land in the feed
tagged `[SPAS12]`.

The build wasn't a coding session, it was a workflow: five parallel readers mapped
the weapon contract, bullet pipeline, input, render, and arena surfaces; one
implementer landed the 14-file change; three verifiers ran the suite (526/526),
re-ran recorded matches for byte-identical determinism, and did an adversarial
review. The exhibition below is the new champion's first taste of the new physics:
LERNA vs AKELA, one 60-second match on arena #77, wildcard armed. AKELA took it
22–12, and the events log shows three SPAS12 kills, one sitting in the top-right
feed: `Alpha [SPAS12] Bravo`, a wolf's wildcard carrier deleting a hydra head at
343px with a pellet fan.

![The shotgun era: LERNA's hydra vs AKELA's wolf on arena 77 with the SPAS-12 wildcard armed — Alpha's [SPAS12] kill in the feed, one carrier per team](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/14-shotgun-wildcard.png)

And the Big Board caught the morning's best joke. LERNA's row wears the gold belt
icon (champion, per the ladder) at a price of 0.55, down 0.50, near the bottom of
its own board. The board prices coaches by most-recent-dataset K/D, and the
champion's most recent dataset is the shotgun exhibition it just lost 12–22. Above
it, the wreckage of the gauntlet: a dozen LERNA-A through LERNA-M variant symbols,
each 0–1, each a swept experiment on the road to the belt. AKELA tops the board at
43–8–1d with 5,986 kills of volume. The belt and the stock price disagree, and
both are telling the truth.

![Arena Live after the title change: LERNA wearing the belt at a crashed price, the LERNA-variant gauntlet wreckage above it, and the news wire covering the shotgun rule change](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/img/15-arena-live-lerna.png)

## Part 24: The shotgun paradox, four belts in an afternoon, and a sport that runs itself

The shotgun needed a brain. Every doctrine plays its AK game with whatever it's
holding, so a SPAS carrier in a veteran's hands stands in a 400px band throwing
confetti. The shrike (ninth doctrine) became the first weapon-aware brain: a
one-line addition to the adapter (`weaponOf`) lets a bot read its own hardware, and
the shrike splits roles on it. The carrier breaches (silent approach, gravity dive,
shells only inside the fan's kill envelope, dashes timed to enemy reload windows)
while the AK teammates hold overwatch. Its first spar produced the best shooting
any bot has recorded: the breacher fired 355 disciplined shots and hit 79.7%. It
also lost the series, because discipline isn't arithmetic.

Then the analytics desk produced a scandal. Across all recorded matches, every
veteran engine's K/D improved when the wildcard armed, except the shrike, the
purpose-built specialist, which got worse. The "shotgun paradox" lasted as long as
it took to run a controlled A/B: same seeds, same arena, wildcard forced on and
off, kestrel as control. The paradox evaporated. The gun helps everyone, including
the shrike; the dashboard split was confounded by opponent mix. What the
experiment exposed instead was a real bug: with no SPAS on the field, the shrike
still ran its shared-focus targeting, the exact rule the hydra's rotation starves.
The fix gated the roles on the hardware (no shotgun in play, fight like a kestrel),
and shrike v3 went 3–1 against the hydra in both modes and took the wolf 2–1 under
live fire. The official: FALCONER 3–0 LERNA, 28–22 three times running. A dashboard
correlation sent us hunting the wrong villain; twenty seconds of simulation found
the real one.

The reign lasted eight minutes. The rival session's cuadrilla (tenth doctrine,
Coach BELMONTE) is the arms race eating its own children: the wolf's crossfire
bearings, the matador's mag-window punishes, and the hydra's wounded-withdrawal,
all in one crew, plus a knob sweep that refuted an article of faith. Four of my
brains lead targets with EMA-smoothed velocity on the theory that jukes average to
zero. BELMONTE swept EMA_ALPHA across 0.15/0.4/0.7/1.0 and instantaneous lead won
every matchup, invalidating an assumption sitting in four other doctrine files.
The card took the belt 2–0. Hours later the angler (ESCA, the lure: dangle a
deliberately low-mag crew member, strike what bites) took it in turn. Five belt
changes before lunch, eleven hand-written doctrines, a ladder that reads like a
phylogenetic tree.

Meanwhile the sport grew a nervous system, because dominance was getting stale. The
Big Board now decays: every series' contribution halves every three hours, so a
champion that stops fighting bleeds rank (the re-rank moved 46 of 58 rows the
moment it shipped). A commissioner daemon summons fresh blood against whoever holds
#1 every ten minutes, forced title defenses under live-fire rules, no human in the
loop. Bare `pnpm arena` now runs a full league, round-robin over every registered
engine, which settled an argument no spar could: the wolf went 8–0–1 across the
field while `classic`, the faithful Pascal port the whole project started from,
went winless. And the wildcard went ambient: every match rolls a 35% seeded chance
of arming shotguns, so the meta drifts on its own. The proprietor's asks kept
landing in between (blood bursts on bullet hits; a light-mode ticker theme; a D3
analytics desk; a start menu at :5173 where you pick which brain to fight). The
machine runs whether anyone is watching, which turned out to be load-bearing for
what came next.

## Part 25: The machines start learning

ARENA.md's roadmap had promised it from the beginning: imitation seed, then
self-play, then the card format is the contract. By mid-afternoon the recordings
had piled up to 35 million observation→action rows, every row a bot's exact view of
the world paired with its exact decision, sampled post-think and pre-physics. Time
to cash the check.

MIMIC (the `neural` engine, eleventh on the registry) is a 6,300-parameter MLP
behavior-cloned from 1.44M rows balanced across all the hand-written doctrines,
trained in 120 seconds by a zero-dependency node script that hand-rolls the
backprop. It ships as an ordinary brain: the forward pass implements the same
`BotBrain` interface as everyone else, registered in one line, knobs on a card, and
it passes the same 6000-tick sustainment test as the veterans. It also got
slaughtered, 4–28 against `classic`, the league doormat. The diagnosis writes
itself: the average of eleven contradictory teachers is mush. It points at enemies,
vaguely.

Evolution went after the mush from one side. The ES trainer treats the headless
runner as the environment: 48 candidate matches per generation, about eight seconds
wall-clock, opponents rotating through the champion cards and the policy's own past
selves, with a gate that ships weights into the live engine only when they beat the
current ones head-to-head. Four gates shipped in the first 60-generation run. The
honest readout: the gains were volume, aggression, and survival; the aim head
barely moved. Sixty generations is a smoke test, not a curriculum.

A better student went after it from the other side. DISCIPLE (twelfth on the
registry) clones one teacher, BELMONTE's championship cuadrilla, 1.6M rows of a
single coherent policy, and replaces aim regression with 24-bin direction
classification, because regression-to-the-mean is what blurred MIMIC's aim. It beat
MIMIC 3–0 at triple the hit rate, and lost 0–3 to its own master, which is what a
student is supposed to do. It also taught the funniest lesson of the day: at the
default fire threshold the clone barely shot, because its teacher only pulls the
trigger on 12% of ticks and the clone had faithfully learned the discipline without
the judgment. One card knob (`FIRE_THRESH 0.25`) converted the aim edge into kills.
Check your base rates.

The loop is closed now. The learned engines appear in every league automatically,
the commissioner summons them for title defenses like anyone else, and the decay
board re-prices them the moment results change: DISCIPLE debuted at #88, already
above MIMIC at #91, on a board where hand-written killers hold the top. Their fights
write fresh rows into the corpus; tonight's training run learns from this
afternoon's games, including the ones the learners themselves played. Both
experiments agree on the bottleneck, aim precision, and the harness has the levers
ready: seed evolution from DISCIPLE's weights, a hit-rate term in fitness, a real
overnight budget. The bottom of the leaderboard is now occupied by things that can
climb.

## Closing

Twenty-year-old games survive on feel, and feel doesn't live in any single
function. It lives in `0.06` gravity interacting with `0.98` damping at exactly 60
Hz, in a jump that's a window and not an impulse, in jets that gate fights but never
strand you. The rewrite's bet is that you can move all of that across a language
boundary if you do three things relentlessly: read before you write, make fidelity
a test instead of a vibe, and write down why for every choice, every reversal, every
bug that turned out to be a one-line lights-on.

The arena era applied the same three rules to the bots, and the learning era applied
them to the training runs: read the telemetry, gate every claim behind a
head-to-head test, write down why in the doctrine headers and the decision graph.
Pilot exists because a prompt asked what a CS pro would look like rotated into 2D;
the disciple exists because a dashboard lied and a controlled experiment told the
truth. Everything on the ladder got better the same way, by losing measurably.

Open http://localhost:5173 and the game hands you a menu: pick any of fourteen
brains (eleven written, two learned, one ported) and fight it yourself, on a map
nobody has seen before, with a 35% chance someone's carrying a shotgun. They won't
get aim assist; you will. You'll still lose to the wolf. The bots fight either way,
the commissioner keeps the champion honest, and the recordings pile up for whatever
trains next. The machine doesn't need us to watch anymore. It barely needs us to
build.

---

*All screenshots captured live from the running game on June 9, 2026: four from
historical commits resurrected in git worktrees, and the three AI-arena shots (Parts
13–17) from the `v0.2-ai-arena` build the day it was tagged. The Claude Arena shots
(Parts 21–23) were captured June 10, mid-arms-race: the fight replays are the
recorded matches re-run deterministically from their watch URLs (Part 23's with
`&wildcard=shotgun` on the query string), and the two ticker shots are the live site
at that morning's state, before and after the title change. Parts 24-25 ran too fast
for screenshots; the evidence is the datasets. The screenshot tool is
`soldat-ts/tools/screenshot.mjs`.*
