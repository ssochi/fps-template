# M19 — Full carpentry

**Status:** ✅ Complete
**Slice:** furniture and storage you build, walls where there was a gap, and the
half that was missing since M9 — taking things back down and mending them.

## Goal

M18 made three specific objects placeable. This generalises it, and answers the
milestone's question: **why is this building *mine*?** Until now the only mark a
survivor could leave on a house was planks over its existing windows. Everything
else — where the storage is, where the walls are, what gets removed — belonged
to worldgen.

## The decisions worth recording

**A built wall is the barricade mechanism applied to an open edge.** Not a new
`WALL.PLANK` material, and that is the whole design. Everything a built wall
needs already exists for barricades: it blocks movement, it blocks sight, the
mesher draws it, the horde breaks it, and it saves. A new wall material would
have needed all five written again — and, crucially, would have shipped
**indestructible**, which is the exact mistake M6 made and M9 had to undo. A
base that cannot be broken into is an off switch.

The code for it is one relaxation of `facingEdge()`: when the recipe says
`openEdge`, require *no* wall rather than an opening, and require the tile
beyond to be somewhere you could otherwise have walked — or you are building a
wall across the void.

**Three planks in, three planks of wall out.** The first version charged three
planks and added one, because `addPlank` adds one per job and nothing said
otherwise. A test caught it by asking how many swings the dead needed: seven.
Boarding a window is meant to be a decision you *repeat*, so one plank per job
is right there; building a wall from nothing is one job, and charging triple for
single thickness would have been a quiet swindle.

**Repair and reinforce are different decisions, so they are different verbs.**
Adding a plank makes a barricade stronger and costs a plank you may not have.
Repairing makes a damaged one whole and costs nails. A base that can only ever
be reinforced runs down in one direction, which is a treadmill rather than a
choice.

**Dismantling costs you a plank overall.** Build a crate for three and get two
back. That is what stops build-and-dismantle being a way to turn time into
materials, and it is the only balancing number in the milestone.

**Doors and staircases are structure, not furniture.** Letting a survivor
dismantle the stairs they are standing on is a way to lose a run to a mis-click.

**A crate you built is empty.** Loot is a function of `(seed, cell)`, which is
exactly right for a cupboard that has been standing in a kitchen since before
the outbreak and exactly wrong for one you nailed together thirty seconds ago.
`LootSystem` now keeps a set of player-placed cells; there is a test for a crate
arriving full of somebody else's tinned beans, because that is precisely what
would have happened.

## Iteration passes

1. **Recipes, walls, repair, dismantle, placed storage — 21 new tests.**
2. **Two real findings, both from tests written to the *intent* rather than to
   the implementation.** A plank wall was one plank thick for a three-plank
   price; and "every build must be noisy" was too broad a rule — laying sticks
   in a ring for a campfire is genuinely quiet, and a rule that forced it to be
   loud would have been the rule enforcing itself rather than the fiction. The
   test now scopes to jobs that use nails.

## Verification

- **473 unit tests** (up from 452). New: a wall built on an open edge blocking
  movement and sight both ways, refused across the void and where a wall already
  is, and **breakable by the dead in about twenty swings**; repair making a
  barricade whole without reinforcing it, refused when nothing is damaged, and
  spending its nails only on completion; dismantling a barricade a plank at a
  time, removing furniture, refusing stairs and doors, costing a plank overall,
  and forgetting the station that stood there; storage you built arriving empty,
  keeping what you put in it, and leaving a pre-outbreak cupboard rolling from
  the seed as before; and every recipe having a description, a duration, and —
  where it involves nails — enough noise to draw the street.
- **Screenshot gate:** twenty-three images, now including a run of plank wall
  built with the real recipes, a crate and a bunk beside it, and six of the dead
  working on the wall.

## Known gaps

- **You cannot build a floor**, so a second storey is still something you find
  rather than something you make.
- **Placement does not preview.** You aim, you commit, and the object lands on
  the tile ahead — there is no ghost showing where.
- **Dismantling gives planks whatever it was made of.** A brick wall would give
  planks too, if brick walls could be dismantled; they cannot, which is the only
  reason it does not show.
- **No skill gate.** Carpentry level changes barricade strength and build speed
  and does not gate any recipe, so a survivor with no training builds the same
  wall as a carpenter, only slower.
- **Nothing can be locked.** A door you barricade is a door you cannot use.

## Verdict

The cheapest way to build a feature is to notice it is a feature you already
have. A plank wall is a barricade on an edge that had no opening; the whole
milestone is one boolean on a recipe row, one relaxation of a guard, and a
handful of verbs that were always implied by the ones already there.

The two bugs are both worth keeping in mind: they were found by tests written
against *what the thing is for* — how many swings should a wall survive, should
this job be loud — rather than against what the code does. A test that asserts
`addPlank` was called once would have passed on a one-plank wall for ever.

Proceed to M20 — the world beyond houses.
