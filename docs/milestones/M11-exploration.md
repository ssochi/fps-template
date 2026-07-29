# M11 — Exploration (opens cycle 2)

**Status:** ✅ Complete
**Slice:** none — this milestone reads, measures and decides. Its output is
[blueprint v2](../blueprint.md) and the cycle 2 plan.

## Goal

Cycle 1 shipped eleven commits and a playable game. This milestone asks three
questions and answers them with evidence rather than intent:

1. What did we actually build, versus what the blueprint said we would?
2. Where does it break when we push on it?
3. What is the reference game doing that we are not — and which of those things
   are worth the code?

## 1. What exists

45 source files, **9,463 lines**; 12 test files, **3,275 lines**; 286 tests.

| Area | Lines | Largest file |
| --- | --- | --- |
| `sim/` | 2,344 | `Horde.js` 469 |
| `render/` | 1,321 | `WorldMaterial.js` |
| `world/` | 1,314 | `Mesher.js` 533, `TileGrid.js` 505 |
| `entity/` | 870 | `Player.js` 392 |
| `items/` | 828 | |
| `worldgen/` | 727 | |
| `core/` | 660 | |
| `ui/` | 465 | |
| `audio/` | 307 | |
| `save/` | 216 | |
| root | — | `main.js` 411 |

### Blueprint drift

Worth stating plainly, because the whole point of rewriting the blueprint is
that v1 stopped describing the program.

**Planned, never built:** `Cell.js`, `Chunk.js`, `Room.js`, `Zombie.js`,
`Palette.js`, `Meshers/`. Every one of these was an *object* the design assumed
we would need, and every one was obviated by the same decision: cells, chunks
and zombies are all indices into parallel typed arrays. There is no `Cell`
because a cell is an integer. That is not drift, that is the load-bearing
decision working, and v2 should describe it as such.

**Built, never planned:** `Audio.js`, `Construction.js`, `CrowdMaterial.js`,
`WorldMaterial.js`, `HordeSystem.js`, `Mesher.js`, `Objects.js`, `Recipes.js`,
`Walker.js`, `Weapons.js`, `constants.js`, `main.js`. Twelve files — a quarter
of the codebase — that v1 had no slot for. Most are the *seams* between planned
systems: material injection, the horde's driver, the wiring file. v1 planned
nouns and missed the joins.

### Dead code

41 unused exports. Most are legitimate — named constants that document a
tuning value next to the code that uses it (`BITE_CHANCE`, `POUND_INTERVAL`,
`TIER_STEPS`), or enums exported for symmetry. Two are not:

- **`Walker` — an entirely dead class.** Its own docstring says *"a stand-in
  mover for M1 … M3 replaces this with a real controller"*, and M3 did. Only its
  `moveOnGrid` function is live. **Removed in this milestone**, because a survey
  that finds a corpse should bury it.
- **`Skills.rate`** — a multiplier on XP gain, wired into `award()`, read by
  nothing. It was left as the hook for traits and occupations. Cycle 2 uses it.

No `TODO`, `FIXME` or `HACK` markers anywhere in `src/`. That is not discipline,
it is the milestone docs doing the job: every deferral was written down in a
*Known gaps* section instead of buried in a comment.

## 2. Where it breaks

Benchmarked worldgen, one full flow-field sweep, one fog update and grid memory
at three map sizes:

| Map | Worldgen | Flow sweep | Fog update | Grid memory |
| --- | --- | --- | --- | --- |
| 104² × 3 (shipping) | 31 ms | 8.8 ms | 6.0 ms | 0.4 MB |
| 200² × 3 | 20 ms | 17.9 ms | 2.3 ms | 1.6 MB |
| 300² × 3 | 48 ms | 12.2 ms | 9.0 ms | 3.5 MB |

Memory is a non-issue — a 300² town is 3.5 MB of typed arrays, and the numbers
scale exactly linearly because they are typed arrays.

**The flow field is the wall.** It is O(cells) and it sweeps *the entire
reachable map*, every rebuild, regardless of where anything is. At 300² that is
270,000 cells swept to steer zombies that are, at worst, forty metres away. The
sweep is already the most-optimised code in the project (M5 inlined the wall
lookups against the raw arrays for a 1.5× win) and it is still the thing that
stops the map growing.

The fix is not to make the sweep faster. It is to **stop sweeping the whole
map**: bound the Dijkstra to a radius around the player and let everything
outside that radius be steered by a coarse field on a much smaller grid. This is
the same answer the wider three.js world literature gives for geometry —
[chunked loading and spatial partitioning rather than
whole-scene work](https://www.utsubo.com/blog/threejs-best-practices-100-tips) —
applied to simulation instead of rendering. Conveniently it also solves the
largest *behavioural* gap we have, because a coarse off-screen field is exactly
what horde migration needs.

Two other structural limits, both already known and both cheap next to the above:

- **Pathing and sound are ground-floor only.** The sweep never crosses a stair
  edge, so upstairs zombies can only wander. Stairs are already stored as
  objects with a `canClimb` query; the sweep just does not consult it.
- **`main.js` is the wiring bottleneck.** 411 lines, and every new system adds
  to it. It is not yet painful, but cycle 2 adds vehicles, farming and metagame
  events, and the file is the one place with no seam.

## 3. What the reference game does that we do not

One clear finding runs through all of it: **cycle 1 has no answer to the question
"why is day 20 different from day 3?"** Everything we built is a *short* loop —
thirst, a house, a fight, a death. The reference game's long game is built from
four things, and we have none of them.

**The world degrades on a schedule.** Around day 30 the
[water and power shut off](https://www.ibtimes.com/project-zomboid-how-survive-late-game-stages-3373665);
players are expected to have built rain collectors and stockpiled non-perishables
*before* that happens. This is the highest-leverage idea available to us, because
it is not new content — it is a **scheduled degradation of a resource we already
simulate**. The instant water taps can run dry, every bottle in M8's loot tables
means something different, and M9's crafting acquires a reason to exist past the
first barricade.

**The world acts on you off-screen.** The
[metagame](https://pzwiki.net/wiki/Metagame) simulates events between
zombies and the environment which become concrete when they come on-screen:
screams, gunshots, alarms, and the
[helicopter](https://projectzomboid.fandom.com/wiki/Helicopter_Event) that
appears once between days 6–9, hunts for the player, and drags the horde across
the map to wherever it finds them. For us this is nearly free: **a metagame event
is a scheduled noise emission**, and M5 already has a sound field that the horde
reads and that never consults the player's position. The helicopter is perhaps
fifty lines on top of systems that exist.

**Somewhere is worth the trip.** Louisville is the endgame destination — highest
zombie density, best loot, gun stores. We generate houses and only houses, so
every building is the same proposition and there is no reason to go two streets
further. Building archetypes with their own loot tables are what turn a map into
a set of *decisions about where to go*.

**A vehicle rewrites the shape of play** — it
[turns a slow dangerous looting run into a fast supply run, gives you mobile
storage, and doubles as an escape
pod](https://xgamingserver.com/blog/project-zomboid-vehicles-guide/), gated
behind keys, hotwiring, fuel, parts and a Mechanics skill. It is the single
largest feature in the list and the one that most changes what a session
*is*.

Two more, from where the reference game has gone recently and from where players
say it still falls short:

- **Build 42** rebuilt crafting into disciplines that progress from stone-age
  setups to advanced machines, broke the height limit to allow basements and up
  to 32 floors, and added animal husbandry and hunting so that leather and bone
  feed advanced recipes. The direction is clear: *from a one-month survival sim
  toward something multi-generational.*
- **Late-game boredom is an acknowledged problem in the reference game itself.**
  Players report that
  [eventually everything runs by itself and you get
  bored](https://steamcommunity.com/app/108600/discussions/0/3776867914942099326/).
  This is the most useful finding in the whole survey, because it says copying
  the reference game's late game is not sufficient. Whatever we build has to
  keep *pressing*. Our version of that is the horde: if it migrates, a cleared
  neighbourhood does not stay cleared, and the base you finished is a thing you
  have to keep.

## 4. What cycle 2 is

Stated as one sentence so the milestones can be checked against it:

> **Cycle 1 made a game you can lose. Cycle 2 makes a game you can lose *slowly*
> — where the world runs down on a clock, the dead keep arriving, and the things
> you build are the reason the next week is survivable.**

The ten milestones, and why they are in this order, are in
[blueprint v2 §8](../blueprint.md). The two ordering decisions worth defending
here:

- **The horde's migration comes second (M13), not late.** It is the largest
  architectural change, it is the fix for the flow field's scaling wall, and
  every later milestone is more valuable with it than without — a base is only
  interesting if it can be threatened again.
- **Character creation comes first (M12) despite being the smallest.** It is the
  only item that changes the game from its first minute, it is a natural home
  for the main menu that save/load has been waiting for since M10, and it costs
  a day. Cheap things that reframe everything after them belong at the front.

## 5. A process observation

Cycle 1's pass counts: 1, 7, 6, 6, 6, 6, 5, 6, 4, 4, 4. The trend is real and it
has a cause — the last three milestones mostly *connected systems that already
existed*, and every M8–M10 feature landed on an event bus, a clock or a seed that
was already there.

Cycle 2 will not look like that. M12–M14 connect existing systems and should be
cheap; **M16–M20 build genuinely new ones** (carpentry, building archetypes,
vehicles, farming, streaming) and the pass count should be expected to climb back
toward six. If it does not, that is more likely to mean the verification got
lazier than that the work got easier.

The other thing worth carrying: **the *Known gaps* section at the end of each
milestone has been more useful than the blueprint was.** It is specific, it
accumulates, and M9, M10 and this survey all worked from it. v2 keeps the
blueprint short for that reason — the gaps lists are where the real backlog
lives.

## Verification

- 286 tests still green after removing the dead `Walker` class.
- No screenshot gate: this milestone changes no rendering.

## Verdict

The architecture from M0–M2 held for eleven milestones and the survey found one
real wall (the whole-map flow sweep) rather than a list of them. That wall has a
known fix which doubles as the fix for the biggest gameplay gap, which is a good
position to open a cycle from.

Proceed to M12 — character creation, traits and the main menu.
