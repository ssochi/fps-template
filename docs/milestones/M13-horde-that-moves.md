# M13 — The horde that moves

**Status:** ✅ Complete
**Slice:** a bounded, three-dimensional flow field; sound that crosses storeys;
zombies that use stairs; and migration, so a cleared street refills.

## Goal

Cycle 2's architectural item, and the answer to the milestone's own question:
**why does the neighbourhood I cleared stop being safe?**

Three things were wrong and they turned out to be one thing. The flow field swept
the whole map to steer zombies forty metres away; it swept one *storey*, so
upstairs was a place you could always retreat to; and the horde was scattered
once at worldgen and never redistributed, so killing forty zombies on your block
made that block permanently safe. All three are the field being the wrong shape.

## What was built

| Area | File | Note |
| --- | --- | --- |
| One vertical-link rule | `world/TileGrid.js` | `climbFrom` / `descendFrom` |
| 3D, bounded flow field | `sim/FlowField.js` | `UP`/`DOWN` codes, radius-limited sweep |
| 3D sound | `sim/Sound.js` | Through floors, freely up a stairwell |
| Migration | `sim/Migration.js` | Coarse census, crowding and noise memory |
| Zombies on stairs | `sim/Horde.js` | A vertical step takes a beat |
| The player's descent | `entity/Player.js` | It had never worked |
| Measurement | `scripts/bench-horde.mjs` | The claim, at four map sizes |

## The decisions worth recording

**Bounding the sweep costs nothing behavioural, and that is why it is allowed.**
The field is only ever consulted by an agent standing in it, and an agent with no
direction already had somewhere to go: hearing. That fallback has been in
`Horde.update` since M5. So the bound is not a compromise — a zombie beyond fifty
tiles could not have been chasing anyway, because sight reaches thirteen and
attention decays in about seven seconds.

**The sweep now clears only what it touched.** Once it is bounded, `dist.fill()`
costs more than the sweep does: on a 420² town that is 529,000 writes to undo
about 4,800. The touched list is the fix, and the way to get it wrong is to leave
a stale direction outside the new radius — there is a test that builds two fields
far apart and checks the first one's answers are gone.

**One rule for where the stairs are, and it exposed a two-year-old bug.**
`TileGrid.climbFrom`/`descendFrom` are now the single definition, read by the
flow field, the sound field and the player alike. Before this, the player had its
own: ascent used the top step, descent used the *opened ceiling above the bottom
step* — a cell with no floor, which `canWalk` correctly refuses to enter. **Going
upstairs was a one-way trip**, and the M3 test that covered descent placed the
player on the void tile by hand with a comment explaining that walking there was
impossible. The comment was the bug report; nobody read it as one.

The join is the single tile column above the *top* step: from below you climb it,
from above you descend it. Symmetric, which is what made it a lift shaft until a
cooldown was added — one column, both directions, so a naive check flips you
every tick.

**A vertical step is taken all at once, and costs a beat.** There is no half-way
up a staircase in a grid of storeys. `COST.stairs` is dearer than open ground so
a route that stays on one floor wins wherever one exists — otherwise the dead
would treat a staircase as a shortcut across a room — and the climb takes a
second and a bit, so a body on the stairs is visibly slower than one crossing a
room.

**Sound crosses a floor, expensively, and a stairwell cheaply.** Hammering planks
over a first-floor window is among the loudest things in the game and the street
could not hear it. A floor is a thick wall you happen to be standing on; a
stairwell is a hole. That difference is what makes a shut stairwell door worth
having.

**Migration is two local rules, and neither reads the player.** *Crowding
repels* — a wanderer prefers the emptier neighbouring district, which is
conservative (nothing spawns, nothing is deleted) and refills a cleared street
from the streets around it over minutes. *Noise draws* — a district that heard
something stays attractive long after the sound field has forgotten it, because
the dead remember the direction of a gunshot far longer than the gunshot lasts.
Together they mean the town slowly walks toward wherever you keep making noise,
which is the reference game's feel and falls out of two arrays.

**Districts, not tiles.** Both rules are about *areas*, so they live on a coarse
4 × 4 grid: 676 cells for a 104² town, under 6 KB for the whole structure. Per
tile would be a hundred times the memory to express the same idea.

**Migration only biases the re-roll, never the tick.** A wanderer picks its
heading every few seconds and migration influences that choice. Applying it every
tick would make the entire horde turn in unison the moment a census landed, which
looks like a flock rather than a crowd.

## Iteration passes

1. **Grid links, 3D field, 3D sound, migration and 30 tests — green.**
2. **The old tests were calling the old shapes.** `SoundField(g, 0)` and
   `emit(x, z, loudness)` no longer exist; mechanical, but it forced the question
   of whether the level argument belonged in the constructor or the call, and it
   belongs in the call — a field that is 3D everywhere has no default storey.
3. **The descent test had to be replaced, not fixed.** It asserted the broken
   rule. The new one walks upstairs, steps off the landing, walks back, and
   checks the storey changed — plus a case that holds a direction into the join
   for two seconds and asserts it does not oscillate.
4. **A position test was over-specified.** "Lands on the tile centre" was checked
   ninety ticks after the climb, by which time the zombie had walked on. The
   property is about the tick the storey changes, so the test now watches for it.
5. **The benchmark found the next O(cells) cost.** With the flow field bounded,
   *sound decay* became the most map-size-sensitive thing left — a full pass over
   every cell every tick, 0.52 ms on a 420² town to fade a few hundred cells. It
   is the same mistake in a different file, so it got the same fix: the field
   keeps a list of what is audible and walks that. 0.007 ms, flat.
6. **The new screenshot staged its own failure.** Ten chasers arriving in a
   bedroom killed the player during the frames between setup and capture, so the
   shot was of the death card. Correct behaviour, useless image.

## Verification

- **357 unit tests** (up from 326). New coverage: the vertical link joining the
  right column, refusing where there is nothing to land on, and never linking a
  storey that does not exist; the field routing up and down, marking the
  staircase `UP`/`DOWN`, leaving a stairless upper storey unreachable, and
  preferring a flat route where one exists; the bounded sweep visiting a disc
  rather than a map, still answering inside the radius, leaving no stale
  direction outside it, and **agreeing cell-for-cell with the unbounded sweep**
  where both reach; sound through a floor and up a stairwell, offering a vertical
  heading only where a body could take it, and the decay list neither dropping a
  loud cell nor leaking; zombies climbing to a target above, taking a beat to do
  it, and landing on the tile centre; migration measuring floor area, counting
  only the living, sending wanderers from crowded to empty, staying put in an
  even quiet town, remembering a noise the sound field has forgotten, ignoring
  footsteps, being drawn by a loud one, forgetting eventually, and never routing
  into a district with no floor; and — the claim the milestone rests on — **a
  two-minute simulation in which a district nothing ever walked into fills up.**
- **Screenshot gate:** eighteen images, now including the dead arriving on the
  first floor after being placed at the foot of the stairs and left to the real
  systems.

## Numbers

`node scripts/bench-horde.mjs` — the flow-field sweep, radius 50 tiles:

| Map | Cells | Bounded | Unbounded | Speed-up |
| --- | --- | --- | --- | --- |
| 104² × 3 | 32,448 | 0.75 ms / 4,920 visited | 3.46 ms / 11,168 | 1.9× |
| 200² × 3 | 120,000 | 0.79 ms / 4,916 | 7.01 ms / 40,532 | 8.9× |
| 300² × 3 | 270,000 | 0.75 ms / 4,859 | 16.79 ms / 90,311 | 22.3× |
| 420² × 3 | 529,200 | 0.73 ms / 4,796 | 36.96 ms / 178,803 | 50.9× |

The bounded sweep is **flat**: about 4,900 cells and three quarters of a
millisecond, whatever the map's size. That is the whole point — the town can now
grow without the AI noticing, which is what M20 needs.

Per simulation step, the rest of the horde:

| Map | Sound emit | Sound decay | Census (300) | Horde tick (300) | Migration memory |
| --- | --- | --- | --- | --- | --- |
| 104² × 3 | 1.97 ms | 0.041 ms | 0.060 ms | 0.427 ms | 5.3 KB |
| 420² × 3 | 1.61 ms | 0.007 ms | 0.024 ms | 0.067 ms | 86.1 KB |

260 zombies still 2 draw calls.

## Known gaps, deliberately left for later

- **Sound emission is now the most expensive single call in the horde** at about
  1.5 ms. It is flat in map size — the flood is bounded by loudness — and it
  happens a few times a second at most, but it is the next thing to look at.
- **Migration is ground-floor only.** Upper storeys are excluded from the census
  and from drift, because a first floor is a property of a building rather than
  of a district. A zombie that follows you upstairs and loses you will wander
  that floor for ever.
- **Nothing repopulates the map.** Migration is conservative: it moves the dead
  around, it does not make more. Killing every zombie in Knox still empties it,
  which is what M14's metagame events are for.
- **The player still cannot be followed through a window.** The dead use doors,
  barricades and now stairs, but a vaulted window is a route only you can take.
- **The coarse grid is rebuilt from scratch by `measureCapacity`** and never
  updated, so a wall you build in M16 will not change where the dead prefer to
  walk.
- **They stack on the staircase.** Everyone following one field takes the same
  route, so a flight of stairs delivers a column of bodies into the same tile
  rather than a crowd spreading through a room. Visible in shot 15. Local
  avoidance is the fix and it is not in this milestone.

## Verdict

The most satisfying kind of milestone: three problems that looked separate — a
scaling wall, a gameplay gap and an old bug — were one problem, and the fix for
each was the fix for the others. Bounding the sweep is what makes the map able to
grow; making it three-dimensional is what closes the retreat upstairs; and the
rule that made *that* work is the rule the player's staircase had been getting
wrong since M3.

The process lesson is pass 5. Fixing the flow field's O(cells) sweep did not make
the horde flat — it just promoted the *next* O(cells) thing to being the problem,
and only the benchmark said so. M11's survey found one wall; there was a second
one directly behind it, in a file nobody suspected. Measuring after a fix is not
a formality.

Proceed to M14 — metagame events and the shutoff clock, which is where the world
starts getting harder on its own.
