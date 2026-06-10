# Rewriting Soldat in TypeScript: a build diary

*June 2026*

In 2002, Michał Marcinkowski released Soldat — a 2D side-scrolling shooter with
ragdoll physics, jet boots, and a feel that nobody has quite replicated since.
The engine eventually went open source as OpenSoldat: about 65,000 lines of
FreePascal, a hand-rolled binary protocol, and twenty years of accumulated
load-bearing quirks.

This is the story of rewriting it for the web — TypeScript, PixiJS, WebAudio —
from the first archaeology pass to the build that greets you today: a bot-vs-bot
jetpack dogfight you can watch before you ever touch a key.

A note on the screenshots: every image in this post was captured *today*, live,
by checking out the historical commit in a git worktree, booting that exact
build under a dev server, and screenshotting it in headless Chrome over the
DevTools protocol. Nothing here is a mockup or a memory. The tooling for that is
part of the story too, so it's covered at the end.

## Part 1: Read the engine before you touch it

The first prompt of the project wasn't "write code." It was:

> we are going to modernize this game. start off by using a workflow to build an
> understanding of how it works and everything inside of it, logging all that to
> deciduous to keep track of how and why things are the way they are.

So before any TypeScript existed, thirteen parallel research agents each mapped
one subsystem of the Pascal engine — game loop, player physics, bullets,
map/collision, networking, AI, rendering, audio/input, server infra, scripting,
console/cvars, things/objects, build system — and a fourteenth synthesized the
whole-engine picture. All of it went into a decision graph (more on that later),
which means six months on I can still tell you exactly what we found:

- **Everything is a 1-indexed global fixed array.** `Sprite[1..32]`,
  `Bullet[1..254]`, `Thing[1..90]`. No allocation, no ownership — every
  subsystem reads and writes the same globals. Slot 0 doesn't exist; the wire
  protocol, the script API, and twenty years of community maps all assume
  1-based indices.
- **The feel lives in magic constants.** A fixed 60 Hz tick, gravity `0.06`,
  Verlet-style particle damping `0.98`, surface friction `0.970`. The soldier
  isn't a rigid body; it's a cloud of particles with constraints, and the
  movement "magic" is just these numbers interacting.
- **Determinism is structural.** Client prediction replays the same physics the
  server runs, so both sides must compute bit-identical results. In Pascal this
  falls out of everyone using the same `Single` (32-bit float) math.
- **Three compatibility contracts** matter to the community: the wire protocol,
  the `.PMS` binary map format (CRC32-stamped), and the PascalScript modding
  API.

That last list is really a list of decisions waiting to be made: which contracts
do you keep, and which do you break?

## Part 2: The four locked decisions

With the map of the engine in hand, we locked four choices and wrote them into
`docs/PORT-PLAN.md` so they'd stop being relitigated:

**1. TypeScript, strict, web-first.** PixiJS/WebGL2 for rendering, WebAudio for
sound, WebTransport planned for netcode. The reason is distribution: a game you
can send someone as a URL has a different gravity than a game you install.

**2. Clean-break protocol.** The original wire format is hand-packed records
with deliberate field scrambling (to annoy game hackers, per the comments) and
hard caps baked into the message layout. We versioned a new protobuf-based
schema instead. Old and new servers are separate populations — a real cost,
paid consciously.

**3. Faithful-first porting.** Port line-by-line from Pascal first; refactor
later. Every ported function carries a provenance comment — `// PORT:
shared/mechanics/Sprites.pas:1234` — so any TS behavior can be diffed against
its Pascal source. Where we *deliberately* diverge, the code says so loudly
with a `DESIGN OVERRIDE` marker and a pointer to the decision-graph node that
ratified it. Faithfulness is the default; deviation is documented.

**4. f64 production, f32 validation.** Here's the neat trick that fell out of
the clean break. Pascal computes in 32-bit `Single`; JavaScript numbers are
f64. Matching Pascal bit-for-bit in production would mean wrapping every
operation in `Math.fround` forever. But because *both* our client and our
server run the same TypeScript, they only need to match **each other** — and
identical code on identical inputs does that for free. Fidelity to the
*original Pascal feel* is a separate axis, so it became a *test* instead of a
runtime constraint: every physics operation goes through a scalar wrapper
`f()`, which is the identity function normally and `Math.fround` when the
`STRICT_F32` flag is set. The test suite runs twice, once in each mode, and a
golden-master harness replays scenarios against closed-form expectations.

That re-framing — "fidelity is a test gate, not a production property" — turned
the scariest research question of the rewrite into CI.

## Part 3: The milestone ladder

The port plan defined milestones M0 through M9: bootstrap, map rendering,
physics core + golden master, movement, combat, bots, netcode, game
modes/HUD/audio, modding, refactor. Then the build entered what I can only
describe as a loop. My prompts from that stretch, verbatim from the transcript:

> commit in logical chunks and lets get this party going in a workflow

> keep it all going in parallel and PR it but approve and workflow through
> yourself

> keep goiung in a loop im going to the knicks game

While I was at the Knicks game, parallel agent workflows ported subsystems with
explicit cross-package contracts agreed upfront (the constants module exports
`MAX_SPRITES`; the physics agent imports it; conflicts surface at typecheck,
not at 2 a.m.). Each cycle ended the same way: wire the barrels, `tsc --build`,
run the tests in f64, run them again under `STRICT_F32=1`, commit a logical
chunk, update the process docs and the decision graph, start the next
milestone. M0 through M8 landed with 269 tests green in both float modes.

The decision graph kept the review process honest, too. Interleaved with the
milestone outcomes are adversarial review nodes that didn't pull punches:
the RNG is mulberry32 and *not* Pascal-sequence-compatible, which caps what the
golden master can validate (node 55); the "sandboxed" ScriptHost wasn't
actually sandboxed yet (node 73); and the sharpest one — seven milestones
green, "zero ground-truth validation" (node 68). All typecheck and unit tests;
no human had seen a pixel.

That last review proved prophetic.

## Part 4: "nothing in the game works"

My entire bug report, after trying to run the client for the first time:

> nothing in the game works

Both bugs that surfaced were invisible to the type system and the unit tests,
and obvious the moment a real browser drew a frame:

1. **The map rendered black.** The custom GLSL shader had a `uColor` uniform
   that was never bound, so it defaulted to transparent black and multiplied
   every vertex color to nothing. Fix: throw away the custom shader and draw
   the map with PixiJS `Graphics`, which binds its own resources.
2. **The player fell through the floor.** The collision system pushes you out
   of a polygon along its normal — and the synthetic dev map had degenerate
   normals, so the push-out vector was `(0, 0)` and you sank straight through.
   Real `.PMS` maps store valid normals; our hand-built test scene didn't. Fix:
   a geometric fallback that derives edge perpendiculars from vertex positions
   when stored normals are junk.

Here is that exact build — the smoke-test commit, running live today. The
synthetic fallback scene's RGB triangles, the player a few pixels of vector art
(captured mid-jump; the screenshot rig holds W down), and the HUD already
wired:

![First light: the synthetic test scene, player mid-jump](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/docs/blog/img/01-first-light.png)

The lesson got its own observation node: structural verification (types, tests,
CI) and ground-truth verification (pixels, playtests) are different categories,
and no amount of the first substitutes for the second. Every feature since has
ended with a headless-browser check.

A smaller bug from the same stretch deserves its tidbit status: **the baby
jump**. Jump force was applied for exactly one tick, so the soldier hopped like
the floor was hot. Real Soldat applies jump force across the several ticks of
the jump animation — hold to go higher, release to cut it short. Same story for
the jetpack, which had no fuel because nothing ever filled the tank. Impulses
that are actually *sustained forces with a window* are a classic porting trap.

## Part 5: Make it a game — the combat sandbox and the one gun

With movement believable, the next commit turned the tech demo into a game: an
arena generator, bots, shooting, death and respawn, and procedurally drawn
"Gostek" stick-soldiers (head, torso, limbs, a gun line — pure vector art).
This build, live today; red is the player (the rig is holding the mouse button
— note the tracers in flight), blue are bots:

![The combat sandbox: vector Gosteks, platforms, live tracer rounds](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/docs/blog/img/02-combat-sandbox.png)

Then came a decision that shaped everything after. Soldat ships ten primaries
and four secondaries; we ported the entire stat table (every weapon's
`hitMultiply`, fire interval, reload time, bullet speed — including the
delightful quirk that the COLT lives at array index 11 but its `Num` field is
0, an off-by-eleven the original maps depend on). And then we used exactly one
gun:

> one gun for now. im sticking with just one.

Everyone gets the AK-74. The whole combat sandbox balances around one weapon's
triangle of dynamics:

- **Spray control** — spread starts near-pinpoint (0.015 rad) and blooms by
  0.012 rad per sustained shot up to a 0.16 rad cap, decaying when you let off.
  Tap and you're accurate; hose and you're spraying.
- **Quick reactions** — ~10 shots/sec, 30-round magazine, fast-but-dodgeable
  projectiles. Time-to-kill is short but never instant.
- **Terrain cover** — bullets are blocked by geometry, and a 1.6-second reload
  forces you to break line of sight.

One gun means one balance surface. Every tuning question since — jump height,
aim assist, bot behavior — has been answerable against a fixed baseline instead
of a 14-weapon matrix.

## Part 6: Real assets, carefully

The original game's art — Gostek body-part textures, map textures, interface
graphics — exists and works, but its licensing isn't ours to launder, so the
repository takes a position: *code is committed, assets are not*. A
`fetch-assets.sh` script and a README explain how to supply your own; the
`.gitignore` is deliberately broad; and every rendering path has a vector
fallback so the game stays playable with zero assets present.

With assets supplied, the flat-color world snaps into the real thing. This is
the real-assets commit running `ctf_Ash` today — textured polygons, textured
soldiers, the player mid-reload:

![Real assets: textured ctf_Ash, textured Gosteks, RELOADING…](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/docs/blog/img/03-textured.png)

The texturing pipeline had its own archaeology: `.PMS` maps store per-vertex
UVs against a named texture file, edge-stretched scenery, and a sector grid for
collision lookup. The loader honors CRC32 hashes and survives maps with invalid
normals (see Part 4) because community maps contain *everything*.

## Part 7: Keyboard-only aim, and an assist that never lies to you

Here's a design decision I didn't expect to care about: the game is fully
playable without a mouse.

> WASD move, IJKL aim, Space fire, Tab reload, Shift jet.

IJKL aiming is a little state machine with *persistent angle*: each tap nudges
your aim a few degrees, holding swings it fast, releasing freezes it where you
left it. Keys combine for diagonals; a horizontal tap does a turnaround without
dumping your elevation. The startup controls screen renders from
`CONTROL_BINDINGS` — the same table the input tests pin — so the help screen
cannot drift from reality. (It also currently shows on *every* startup, an
explicit "the scheme is in flux" choice.)

![The controls screen, rendered from the real binding table](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/docs/blog/img/07-play-controls.png)

The bug this scheme surfaced is my favorite input bug of the project: **the
first-mousemove takeover**. Aim follows the mouse if you use the mouse — but
the *very first* mouse event of a session, even an accidental 3-pixel nudge
while reaching for the keyboard, would snap your carefully-set keyboard aim to
wherever the cursor happened to sit. The fix treats the first mouse sample as
baseline-only: it establishes where the mouse *is*, and only subsequent
*movement* takes aim over. Verified the keyboard-only path works with a
headless playtest that fired the rifle with zero mouse events ever dispatched —
the ammo counter draining 30 → 21 was the proof.

Keyboard aim is coarse, though, so the game grew **light aim assist** — with
two hard design lines drawn after considering and rejecting crosshair
magnetism:

1. The crosshair never moves. The *shot* bends, at fire time, by at most 2.9°,
   and only when you're already aiming within ~9° of a live enemy inside 700px.
   Assist rewards near-correct aim; it never takes over.
2. Spread applies *after* the bend, so spray bloom still punishes held fire.
   The assist can't out-shoot the recoil model.

And one rule that will matter in a moment: **bots never get the assist**. An
assisted bot is just an aimbot.

## Part 8: Rocket boots — tuning the sim, on purpose

Soldat's jets were always more hover than rocket. This game went the other way:

- thrust is vertical-favoring (1.8× up-force, lateral drift damped to half
  while jetting),
- the tank is big — 700 ticks ≈ 11.7 s of continuous burn,
- and fuel regenerates fast on the ground (~4 s empty-to-full), so jets gate
  *engagements* without ever gating *movement*.

The interesting part is *where* that tuning lives. Two options were logged: 
tune inside the sim core (and accept that bots and player both inherit it), or
override at the client layer and keep the sim faithful. The decision went to
the sim core *with explicit DESIGN OVERRIDE markers* — the faithful-first rule
bends, but it has to say so in the code, next to the Pascal line numbers it's
overriding.

The bug from this era: **force clobbering**. Jump wrote its impulse to
`force.y`; the jetpack's ground-kick wrote *its* (smaller) impulse to the same
field a few lines later. Press jump+jet together — the most natural input in
the game — and you took off *weaker* than jump alone. The fix is one rule:
most-upward-force wins. Side-jumps also kept only 90% of their vertical so
obstacle-clearing stayed possible mid-strafe.

## Part 9: Spectate mode, and the bots that secretly couldn't shoot

To judge the gameplay honestly we needed to *watch* it without playing it. So:
spectate mode — a bot-vs-bot match with no human soldier, an action camera, a
kill feed, and a scoreboard.

Two pieces of design got real decision-graph deliberation:

**Kill attribution.** A bullet that kills you *dies on the same tick*, so a
pure-client scan after the physics step loses the linkage. The hybrid that won:
the sim records `lastHitBy` on every damaging hit (last hit wins), and the
client fires its `onKill` hook exactly once, at the death edge it already
detects for respawn timers.

**The camera is a broadcast director, not a free-cam.** Every bot gets an
interest score — a recent kill dominates (decaying over ~5 s), then active
firing, then proximity to the nearest enemy. The camera holds a subject for a
minimum 3.5 s dwell, switches only when a challenger clears a hysteresis
margin, cuts (rather than pans) on cross-map switches, and when your subject
dies it cuts to the killer. Watching it feels like someone is *operating* it,
which is the whole trick.

And then the bug that justified the entire feature. The first bot-vs-bot match
was a pacifist standoff: **no bot ever fired a single shot.** The ported
perception code faithfully skips invisible sprites — `alpha !== 255` — exactly
as the Pascal does. But nothing in our spawn path ever *set* alpha, and the
default was 0. Every bot was, by its own rules, invisible to every other bot.
They had been fighting only the player all along, who — being human — never
noticed that nobody else got shot at. One line (`s.alpha = 255` at spawn)
turned the lights on.

Here's the spectate-mode commit running today on `ctf_Ash`, six bots, kill feed
flowing, the director parked on Foxtrot:

![Spectate mode on ctf_Ash: director camera, kill feed, live scoreboard](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/docs/blog/img/04-spectate-ctfash.png)

With the match running headless we could finally *measure* the game. First
judgment of a 3.7-minute match: 16.3 kills/min (hot), median 3.1 s between
deaths, 100% kill attribution, camera on the action 55% of the time — and one
glaring number: jet usage was **1.7–3.8% of alive time**. We'd built rocket
boots and a vertical game, and the bots fought like infantry.

## Part 10: Telemetry, then Skyreach — making the sky the map

Eyeballing matches doesn't scale, so the next commit added a versioned match
telemetry schema: every shot, hit, kill, and a 2 Hz position/fuel sample for
every bot, dumpable from the browser (`window.__match.dump()`) and analyzable
by a script. The numbers sharpened the diagnosis: ~21% hit rate, 81px median
kill distance, 2–4% jet use. Close-range floor brawls, wall to wall.

The fix came in layers, all logged under one goal ("Default = spectate bot
match in a big aerial level, jetpack-combat focused"):

- **Skyreach**, a purpose-built aerial arena: a thin ground floor that's a
  fallback net rather than a battlefield, tall walls, and tiers of small
  floating pads — perches, not floors — so getting anywhere means flying.
- **Aerial bot AI**: the faithful Pascal gate (only jet when the target is a
  full 180px overhead) is precisely why bots fought on the floor, so a DESIGN
  OVERRIDE chases *any* height advantage, and bots roll multi-tick jet
  *bursts* (0.4–0.75 s holds) during close engagements instead of 1-tick taps
  that barely lift them.
- **Air fuel trickle**: coasting in the air regenerates 1 fuel/tick — exactly
  the burn rate — so a 50% thrust duty cycle hovers forever, but climbing
  still spends the tank.
- **Spectate is the default.** Open the game and you're watching the dogfight;
  `?play` opts you into fighting.

Result, by the same telemetry: jet use went from 2–4% to **47–56%** of alive
time, median kill distance doubled. Then a playtest note — "corner pogo…
height runaway… these pad heights are way too uniform" — produced Skyreach v2:
a ceiling slab to contain the infinite-climb the air trickle had enabled (mean
altitude was running away to −361 before the lid; contained to a stable
−140…−226 band after), and an irregular, asymmetric pad layout with 15
distinct heights. 391 tests green.

This is what greets you on startup today:

![Skyreach: the default bot-vs-bot aerial match, mid-dogfight](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/docs/blog/img/05-skyreach-wide.png)

And zoomed in mid-fight — two bots airborne, one reloading on the wing
(the wheel-zoom is dispatched over CDP, so even the close-up is the real
running game):

![Close-up: airborne Gosteks trading fire over Skyreach](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/docs/blog/img/06-skyreach-closeup.png)

## Part 11: How this was actually built — the meta-machinery

Some of the most interesting engineering in this project isn't in the game.

**The decision graph.** Every goal, option, decision, action, and outcome lives
in a queryable graph (140 nodes as I write this), with edges enforcing a flow:
goals lead to options, options to a decision, decisions to actions, actions to
outcomes. Root goals store my *verbatim* prompts — not summaries — because
"what was actually asked" is the context that makes a decision recoverable six
months later. A pre-commit-style hook even blocks file edits unless a graph
node was logged in the last 15 minutes, which sounds draconian and works: the
graph can't drift from the work, because the work can't happen without the
graph.

**Reviews as first-class nodes.** The adversarial review findings — the RNG
fidelity cap, the unsandboxed sandbox, the verification-depth warning — sit in
the same graph as the milestones they criticize, linked to them. The project's
self-criticism has provenance.

**The screenshot rig that illustrated this post.** Headless Chrome's one-shot
`--screenshot --virtual-time-budget` mode captures this app as a black frame —
virtual time expires before PixiJS finishes its async boot. So the rig drives
real Chrome over the DevTools protocol instead: launch with a throwaway
profile, open the page, wait *real* seconds while the match actually develops,
then capture. It can hold keys down (that's how the first-light player is
mid-jump and the sandbox player is firing — historical builds predate hostile
bots, so the player provides the action), hold the mouse button for
pre-keyboard-era builds, and dispatch wheel events for zoomed close-ups. The
historical builds themselves ran from git worktrees: check out the old commit,
copy the untracked assets in, `pnpm install` (the oldest one predates the
repo's pnpm version pin — a problem whose fix is itself a later commit), and
serve four eras of the game side by side on four ports.

**Honest ledger, same graph.** What's still open is logged next to what's done:
the FreePascal golden-master cross-check (the final feel-fidelity gate) remains
human-gated; the RNG will need a faithful Pascal port before combat scenarios
can join the golden master; the skeleton/ragdoll, grenades, weapon switching,
and netcode transport are still ahead. When I first wrote this post, the next
chapter was "already in flight: swappable bot-AI engines behind an adapter,
with a side-by-side duel viewer to watch two brains fight it out." All of that
shipped — and it got considerably bigger than the sentence. That's the rest of
this post.

## Part 12: The adapter — a line in the sand, and a brain from first principles

The prompt that opened this era drew the boundary explicitly:

> are we really using the soldat assets to their best ability? I want this
> game to look better. but we should now draw a line in the sand. now we will
> make the engine for the bot AI swappable using an adapter pattern. you want
> to build this first principles version, but we should be able to just turn
> on 2 games at once and watch each of them play!

So every bot brain moved behind one seam. A `BotEngine` is a named brain
factory in a registry; a `BotBrain` ticks once per sim tick and its *only
output* is its own bot's control struct. Brains read the world freely but
never mutate it — same rule as the telemetry observers, or determinism dies —
and randomness must come from `world.rng`, never `Math.random`. Where the seam
lives was its own logged decision: at the *client* layer, not inside the sim,
because ammo, reload state, and spawn points live in the client `Game` and
brains need all three to think.

The existing brain became `classic` — a pure extraction of the ported Pascal
AI plus the client sustainment layer, with a regression test pinning play mode
byte-identical. Which freed the second slot for the brain the adapter existed
to make possible. The seed had been planted a few sessions earlier:

> think about building bots in a 2d shooter game from first principles --
> imagine taking the optimized play of a counter strike source player but
> wawtching from the top down in 2 dimensions and assuming the vertical play

`pilot` is that thought made code. What a Counter-Strike pro mechanically *is*
turns out to be mostly not aim — it's positioning that makes fights unfair
before they start, information discipline, and movement that defeats
prediction. Rotated into 2D-plus-vertical, that became six doctrines, each one
a comment block at the top of `pilot.ts`:

1. **Positioning beats aim — height is the angle.** Pilot climbs until it
   holds a height edge over its target, and gives ground vertically rather
   than horizontally.
2. **Range discipline.** It keeps duels inside a 200–420px band — close
   enough to hit, far enough that incoming fire is dodgeable — backing off
   from brawls instead of face-tanking them.
3. **Movement as counter-prediction.** While engaged it strafe-jukes on an
   RNG clock. The classic aim model leads targets assuming constant velocity,
   so erratic acceleration is literally its mathematical counter.
4. **Mag state is tactical state.** It reloads on its own terms behind range,
   disengages while dry, and re-enters with a full mag.
5. **Memory over omniscience.** When line of sight breaks it hunts the last
   seen position for ~4 seconds instead of instantly forgetting the enemy
   exists.
6. **Fuel as economy.** It spends the tank to take height, never to hover
   dry; below the reserve it perches and lets regen pay for the next climb.

Plus time-of-flight lead and true ballistic drop compensation in the aim math.
About which — a story.

## Part 13: ?duel, and the bug it caught in its first minute

`?duel=classic,pilot` boots two complete, independent matches side by side —
each engine in its own iframe with its own sim, renderer, and telemetry — so
two brains can be raced under identical conditions and judged by numbers
instead of vibes.

The feature paid for itself inside sixty seconds. Pilot v1 — the brain with
the fancy ballistics — was hitting **0.1%** of its shots. Not 10%. A tenth of
a percent. Watching one match you'd have called pilot "cautious"; watching two
matches side by side with per-frame telemetry, classic was landing one shot in
five while the first-principles genius couldn't hit a floating pad. The drop
compensation was overshooting by a factor of **60** — and if that number
sounds familiar, it's the tick rate; seconds had leaked into per-tick
ballistics, and every round was being lobbed mortar-high over its target. The
fix is one constant; the code comment at the crime scene still notes that the
duel paid for itself in its first minute.

Re-raced for 90 seconds after the fix: pilot **35%** hit rate to classic's
22%, median kill distance **291px** to 164px, jet use **71%** of alive time to
46%. The first-principles brain wasn't just winning — it was visibly playing a
different game: higher, farther, airborne.

Then the duel viewer grew up. `?duel` generalized from exactly two engines to
up to six in a grid, repeats allowed — mirror matches are legal and
informative. Wheel zoom became proportional to the actual scroll delta so a
trackpad gesture stopped teleporting the camera across four games. Engines
became self-describing (`BotEngine.strategy`), so every window shows a big
color-coded banner — amber CLASSIC "REFLEX BANDS", cyan PILOT
"FIRST-PRINCIPLES AERIAL" — and the E key hot-swaps brains mid-match: every
bot gets a fresh brain from the new engine on the next tick while sprites,
scores, fuel, and ammo carry over. Only the thinking changes.

![Duel mode: pilot and reaper racing in independent arenas, banners and follow lines live](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/docs/blog/img/10-duel-pilot-reaper.png)

## Part 14: Mixed matches, and teams that follow engines

> now how do we split it into multiple diff AI modes

Duels are parallel universes; the obvious next question is one universe.
`?ai=classic,pilot` assigns a single match's bots to engines round-robin, and
the brains fight *each other* in one shared arena. The scoreboard becomes
engine versus engine, the banner reads CLASSIC vs PILOT — MIXED MATCH, and the
first mixed match on record had pilot leading 20:10.

Then teams arrived, and they arrived at the sim level, not as a UI tint:
`Sprite.team` in the world state, `findTarget` skips teammates (a refinement
the original Pascal AI deferred), and bullets pass through the owner's
teammates — friendly fire is off in the *physics*. The key move: in mixed
matches, **teams follow engines**. Red is engine group zero, blue is engine
group one, so red versus blue *is* classic versus pilot. Engine warfare,
watchable as a team sport.

A live leaderboard panel ranks every fighter by **dominance** — kills minus
half deaths, so a fighter that trades two-for-one ranks above one that feeds —
with team dots and engine tags. That one metric became the spine of everything
in the next part: the in-match board, the tournament standings, and the round
verdicts all agree because they all call the same function.

## Part 15: The tournament

> lets make a script that fires up 4 games, each running with a mixture of
> AIs, and we score which one has the most dominant fighter and then model
> more after them

`?tournament` boots **four simultaneous team games** in a grid, each on a
distinct seed — the sim is deterministic, so identical seeds would replay the
same match four times — with a sidebar that aggregates every fighter across
all games into one standings table: per-engine totals, a crowned dominant
engine, top fighters across games. `tools/run-tournament.mjs` drives the whole
page headlessly and prints the verdict, so a tournament is something a script
(or an agent) can run and read.

And the four games aren't just four seeds — they're four *games*. The tuning
constants became a `GameTuning` instance (defaults byte-identical to the old
constants; `?play` untouched), and each tournament slot runs a named variant:
**baseline** (stock rules), **high-octane** (fire interval 6→4, reload 95→70,
quick respawns), **thin-air** (a 320-tick tank and zero air regen — gravity
matters again), and **marksman** (near-laser accuracy, 12-round mags, long
reloads). A round samples the engines across four metas instead of one.

First live verdict: **pilot crowned**, 124 kills / 67 deaths, dominance 90.5,
against classic's 62 / 125 and dominance −0.5. Every one of the top ten
fighters across all four games was a pilot. The first-principles thesis,
measured.

The original design then "evolved" the next round's rosters toward the winner
— re-weight by dominance, every engine keeps at least one slot. That verdict
produced a 5:1 pilot-to-classic roster, and the next user message killed the
feature, correctly:

> it appears every player is on pilot -- it should be each team is entirely
> in one mode with the knob turns and the turns should be shown in the UI

A 5-v-1 doesn't read as evolution; it reads as a bug ("everyone is on pilot"),
and it isn't an experiment either — it's a pile-on. Teams are now **whole**:
each team is entirely one engine, split evenly, and the next round (N key, or
the printed URL) keeps the same whole teams on fresh generation-derived seeds
instead of collapsing rosters toward the winner. The same correction demanded
the knob turns be *shown*, so every banner and sidebar entry spells out its
variant's deviations — `fire 6→4 · reload 95→70 · …` — instead of asking the
spectator to trust that the games differ.

Rounds got stakes, too: after ten sim-minutes the game freezes — the tick
no-ops while the UI and telemetry keep serving the final state — under a 56px
RED WINS / BLUE WINS banner naming the winning team *and its engine*. The
verdict (kills, then total dominance, then draw) is one pure, tested function.
Each game carries per-team MVP scoreboards live, and the round champion across
all four games is the engine with the most game wins. Pilot swept the first
full round 4–0, across all four variants. For about a day, the meta looked
solved.

![The tournament: four variant games, leaderboards and MVPs per tile, aggregated standings in the sidebar](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/docs/blog/img/08-tournament.png)

## Part 16: Reaper — designing the counter, then tuning it by telemetry

> lets make a third kind of AI model strategy then

A meta with one dominant doctrine is a solved game, so the third engine was
designed *against* the champion. Pilot wins by holding its 200–420px band with
a height edge: at that range its tap-bursts stay accurate, its jukes have time
to defeat lead aim, and its reload-disengage rhythm never gets interrupted.
`reaper` is built to deny the band:

- **Relentless gap-close.** Every tick spent at pilot's preferred range is a
  tick lost; every tick inside 150px is a tick won — spray bloom is free at
  knife range, and a juke that defeats lead aim at 300px moves you two degrees
  at 80px.
- **Dive entry.** Approach *above* the target and cut the jets to fall onto
  it. A diving body accelerates under gravity — harder to lead than any juke —
  and arrives with a full tank for the exit climb.
- **Knife-range commitment.** Inside the kill circle it never retreats:
  full-auto, push *through* the target, reload only on a dry mag. Half
  measures re-open the range and hand the duel back to the band.

Reaper v1 lost the round **0–4**. Pilot outscored it 84 kills to 53, and the
telemetry said exactly why: v1 held fire inside 320px on the run-in, politely
eating free tap-bursts the entire way down. One data-driven pass later —
return fire from 460px, approach 200px *above* the target (over pilot's
preferred height edge), commit at 180px — reaper v2 went **1–3**: one game
decided on a 16–16 tiebreak, two others by two kills, and it *won* the
marksman variant 13–11, the meta where 12-round mags and long reloads punish
pilot's spray-and-reposition rhythm hardest. The arena has its first real
rivalry, and the loop that produced it — design from doctrine, lose, read the
telemetry, tune, contest — is the Part 10 pipeline doing exactly what it was
built for.

One pilot bug from this era deserves its place in the bug ledger. The report:

> in pilot mode they all cling to the ceiling

Two pilots each demanding a 50px height edge over *each other* is a symmetric
arms race with no winner — and Skyreach has a ceiling slab (Part 10's fix for
the infinite climb), so entire matches ended pinned to it, six bots scraping
the lid forever. The fix is concession: a brain that has burned jet for 25
consecutive ticks without actually rising is in a climb it cannot win, so it
gives up the height contest — thrust cut, all climbing suppressed for about
three seconds — and gravity brings the duel back into the arena before the
next bid. Reaper inherits the same give-up. Doctrines need to know when their
axiom is unsatisfiable.

## Part 17: Watchability is a feature

Four simultaneous games exposed the information design. The 34px engine
banners that looked stately in one full window covered half the action in a
tournament tile, and the sound of four arenas at once is not sound, it's
punishment:

> can we have a button to turn off the PILOT VS REAPER stuff etc so the 4
> screen is viewable / can we also get a mute button thats on by default (m
> for short)

Small windows — tournament tiles are half-screen iframes — now auto-render a
compact semi-transparent corner card instead of the banner: engines, strategy,
the variant's knob turns, and a team-colored `▶ FOLLOWING Charlie — RED ·
pilot` line that tracks wherever the director camera is parked. B (or the ℹ
button) toggles the card; M toggles sound, **muted by default**; the buttons
blur themselves after a click so they never steal game keys from the arena.

And the chevrons. The teams *were* tinted — the Gostek shirt and pants take
the team color — but camo textures dominate at spectator zoom and a few tinted
pixels can't be read; in practice everyone looked vaguely blue. Each live
teamed soldier now carries a solid team-colored chevron above its head, drawn
in a dedicated always-cleared marker layer above all entities (FFA matches
stay unmarked). It's the cheapest change of the era and probably the highest
watchability-per-line in the codebase: at any zoom, the shape of the fight is
legible.

The principle underneath: **spectator legibility is a feature**, not chrome.
This game's default mode is watching, and the tournament made watching the
primary instrument for judging the AIs. An instrument you can't read isn't an
instrument.

![A pilot-vs-reaper team match: chevrons over heads, per-team MVP panel, the compact info card with its follow line](https://raw.githubusercontent.com/notactuallytreyanastasio/soldaTS/main/docs/blog/img/09-team-match.png)

## Part 18: Another line in the sand

> Let's commit where this is at as a line in the sand. we are going to take a
> large turn now.

The tag is `v0.2-ai-arena`: three engines behind the adapter, red-versus-blue
engine warfare with chevrons and MVP scoreboards, ten-minute rounds with
winner banners, four-game knob-variant tournaments with crowned champions, the
telemetry pipeline and its headless runner, keyboard-only human play — 439
tests green, 169 decision nodes deep.

The large turn is already written down, verbatim, on the goal node that opens
the next era:

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

Read that against the last six parts and you can see the arena was never just
a toy. The adapter is the harness's seam; the tracked knob variants are the
tracked brain tweaks; the telemetry that caught the 60× ballistics bug and
tuned reaper is the recording layer; the headless tournament runner is the
match scheduler. The era that just closed built the laboratory. The next one
runs the experiments — hand-written doctrines first, then models trained on
everything those doctrines record, then multiple Claude instances training
against the same datasets and getting pitted against each other in the same
arena that crowned pilot.

## Closing

Twenty-year-old games survive on feel, and feel doesn't live in any single
function — it lives in `0.06` gravity interacting with `0.98` damping at
exactly 60 Hz, in a jump that's a window and not an impulse, in jets that gate
fights but never strand you. The rewrite's bet is that you can move all of that
across a language boundary if you do three things relentlessly: read before you
write, make fidelity a test instead of a vibe, and write down *why* — every
choice, every reversal, every bug that turned out to be a one-line lights-on.

The AI-arena era applied the same three rules to the bots themselves: read
(the telemetry), test (the duels and tournaments), write down why (the
doctrine comments at the top of every brain, the decision nodes behind every
tuning pass). Pilot exists because a prompt asked what a CS pro would look
like rotated into 2D; reaper exists because a champion demanded a challenger;
both got better the same way — by losing measurably and being tuned against
the numbers.

The game opens on six bots dogfighting over Skyreach. Add `?play` to the URL
and go beat them — they won't get aim assist, you will. Or add
`?duel=pilot,reaper` and watch the rivalry, `?tournament` and crown a round
champion across four metas at once. The bots fight either way. They don't need
us to watch anymore. Which is, of course, the point of what comes next.

---

*All screenshots captured live from the running game on June 9, 2026 — four
from historical commits resurrected in git worktrees, and the three AI-arena
shots (Parts 13–17) from the `v0.2-ai-arena` build the day it was tagged. The
screenshot tool is `soldat-ts/tools/screenshot.mjs`.*
