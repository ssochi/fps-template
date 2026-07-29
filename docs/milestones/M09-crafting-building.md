# M9 — Crafting & base building

**Status:** ✅ Complete
**Slice:** recipes, barricading, destructible barricades and doors, the torch,
painkillers, and the crafting UI.

## Goal

Give the planks and nails M8 puts in the world a purpose, and — more importantly
— close the gap M6 left open: *barricading was absolute*. The dead simply could
not get through, which makes a base an off switch rather than a decision.

This milestone also closes two other gaps I had flagged and left: the torch was
an item that emitted no light (M7's night floor was waiting on it), and
painkillers did nothing at all.

## What was built

| Area | File | Note |
| --- | --- | --- |
| Recipes | `items/Recipes.js` | Five recipes; two output kinds |
| Building & siege | `sim/Construction.js` | Player jobs, and the dead breaking in |
| Barricade storage | `world/TileGrid.js` | Planks and health on the same edges as walls |
| Barricade rendering | `world/Mesher.js` | Slats drawn from plank count, not health |
| Torch | `render/Renderer.js` | The one local light source |
| Crafting UI | `ui/Panels.js` | Third column, greyed where materials are missing |

## The decisions worth recording

**A barricade is a delay, not a wall.** A chasing zombie blocked by planks
attacks them, and enough of them for long enough get through. This is the whole
correction to M6: an absolute barricade turns the game off, whereas a barricade
that buys ninety seconds turns it into a question about what you do with ninety
seconds. Shut doors get forced the same way — they lean on it until it opens.

**Fortifying is the loudest thing you can do.** Every construction job emits
noise through the same `noise:made` event a gunshot does, and the barricade
recipe is by far the loudest. So hammering planks over a window genuinely draws
the crowd you are hammering them against, and the tension of base building is
that the act of making a place safe is the act of announcing where you are.
Nothing special-cases this — it falls out of M5's sound field.

**Only wanderers are exempt from the siege.** A zombie that is merely drifting
and bumps into a barricade should drift off, not demolish the neighbourhood.
Only the ones actually coming for you do damage, which means a barricade is
attacked exactly when it matters and is otherwise stable.

**Planks block sight in both directions.** You cannot see out of a barricaded
window either. That is the trade, and it makes the choice of *which* openings to
board a real one rather than a checklist.

**Plank count and plank health are stored separately.** A half-smashed barricade
still renders as four boards with two broken off, rather than silently becoming a
smaller tidy barricade. The gap you can see through is the gap they are coming
through.

**A zero-count material means "held, not spent".** That is how salvaging planks
requires a crowbar in your hands without the recipe eating it. One convention,
stated in the file and asserted in a test, rather than a special case per recipe.

**The torch is short-ranged on purpose.** It shows you the room you are in, not
the street. Carrying one changes *where* you can see rather than how far, which
is what makes night a navigation problem instead of a brightness slider. It is
also the reason the M7 night floor can eventually come back down.

**Painkillers suppress pain and heal nothing.** Pain is what slows your legs and
spoils your swing, so removing it is a real decision without being a heal.

## Iteration passes

1. **Grid, recipes and construction built and green.**
2. **Barricade rendering from health rather than plank count** would have made a
   damaged barricade shrink into a tidy smaller one; split into two arrays before
   it shipped.
3. **Siege tuning.** First version had every zombie attacking anything in its
   way, so wandering crowds dismantled the town's doors on their own. Restricted
   to chasers.
4. **Verified the torch under the smoke gate** — the shot at 02:01 is the first
   frame in this project where night reads as a place rather than an absence.

## Verification

- **262 unit tests** (up from 240). New coverage: every recipe's materials being
  real items, missing-material reporting, held-not-spent tools, consuming across
  several stacks, fortifying being far louder than quiet work; refusing to
  barricade a solid wall, barricading the faced opening, planks blocking movement
  and sight in both directions, stacking to a limit, refusing concurrent jobs,
  emitting noise throughout, producing into the bag, and holding the player in
  place; a barricade blocking at first, chasers hammering it, wanderers not,
  breaching it eventually, the racket it makes, doors being forced, and the
  hits-per-plank ratio being high enough for the delay to be real; painkillers
  suppressing pain without healing, and the torch only lighting when carried.
- **Screenshot gate:** fifteen angles, including the night siege with the torch
  lit and a boarded facade.

## Numbers

260 zombies still 2 draw calls. Barricades add four `Uint8Array`s over the grid —
about 43 KB for a 104 × 104 × 3 town — and no per-frame cost.

## Known gaps, deliberately left for later

- **No placeable furniture or containers.** You cannot put a crate down, so a
  base has no storage of its own; you still carry everything.
- No walls or floors you can build from scratch — only boarding existing
  openings. Full carpentry is a cycle-2 item.
- No farming, no rain collection, no cooking. Water comes only from bottles.
- Barricades cannot be repaired or removed once up.
- The torch has no battery and never runs out, which makes it strictly better
  than not having one.
- Zombies still cannot break *windows* to climb through — they only work on
  barricades and doors.

## Verdict

The base-building loop closes properly: you find planks, you board a window, the
hammering brings them, and they get through eventually. Every one of those steps
already existed as a system — sound from M5, combat from M6, loot from M8 — and
this milestone was mostly about connecting them rather than inventing anything.
That is a good sign about the architecture.

Three previously-flagged gaps are closed. One passing observation on process: the
gaps list at the end of each milestone has been more useful than the blueprint,
because it is specific and it accumulates. M10 should probably work from it.

Proceed to M10 — progression & polish, which closes the first cycle.
