# M8 — Inventory & looting

**Status:** ✅ Complete
**Slice:** item database, weight-based containers and inventory, room-keyed loot
tables, spoilage, eating, drinking, dressings, weapon swapping, and the looting
UI.

## Goal

Close M7's stated gap. Hunger and thirst were ticking up in a world with nothing
to eat, which made them timers rather than decisions. This is what turns them
into a reason to go into a building you would rather avoid.

## What was built

| Area | File | Note |
| --- | --- | --- |
| Items | `items/ItemDb.js` | 24 items, weight and spoilage per definition |
| Storage | `items/Container.js` | One class for bags and fridges; weight capacity |
| Loot | `items/Loot.js` | Room-purpose tables, rolled lazily and deterministically |
| UI | `ui/Panels.js` | Side-by-side carried/container lists |
| Actions | `entity/Player.js` | Eat, drink, dress a wound, swap weapon |

## The decisions worth recording

**Capacity is weight, not slots.** Slot counts make a tin of beans and a fire axe
interchangeable, which erases the only interesting question in looting. With
weight, every tin is measured against the axe you would have to leave behind.

**Encumbrance is soft, not a wall.** You *can* pick up more than you should carry
— you just move like it. A hard cap makes the player put things back; a soft one
makes them decide whether the trip is worth being slow for, which is a far more
interesting moment when there is something behind you. Three separate things now
multiply into your speed — a wounded leg, the moodles, and what you chose to
carry — and all three are consequences of decisions you made.

**Loot comes from the room, not from a global table.** M2's furnishing pass
assigned every room a *purpose* before placing any furniture, and this is what
that was for: a kitchen fridge holds food, a bedroom wardrobe holds linen, a
storage shelf holds tools. The thing that makes a house worth searching is being
able to *guess* where to look, and one global table puts bandages in the oven.

**Loot is rolled lazily and derived from the seed.** A town has thousands of
containers and a player opens dozens. Nothing is generated until a container is
opened, and when it is, the contents come from `(world seed, cell index)` — so
the same jar of beans is in the same cupboard whether you reach it on day one or
day nine, and an unopened room costs a save file nothing.

**Some containers are empty, on purpose.** An empty cupboard is what makes a full
one worth something. A test asserts that a meaningful fraction of them come up
empty, because "always something" and "nothing anywhere" are both failures and
only the first looks fine in a screenshot.

**Food is a clock.** Perishables carry an age; fresh food is more nourishing than
tinned and stops being food, tinned is worse and never does. That is why a fridge
is worth checking on day one and worthless on day ten, and it gives looting a
rhythm instead of being a single sweep. Loot generation ages perishables at spawn
too — they have been sitting there since the outbreak.

**Stacks will not merge across ages.** Two loaves of very different ages stay
separate, because merging them would silently launder spoilage, which is the one
thing an age exists to prevent.

**Unequipping puts the old weapon back in the bag.** Losing an axe because you
picked up a knife would be a bad surprise, and bad surprises in inventory systems
are the ones players never forgive.

## Iteration passes

1. **First build** — items, containers, loot and panels all working.
2. **Dressings behaved differently depending on how hurt you were.** A first aid
   kit did not fully stop a bleed, because `stopsBleeding` was a flat subtraction
   against a severity-scaled bleed rate. Changed to a *fraction*, so a dressing
   works the same way on a scratch and on a deep wound, and only a full kit stops
   one outright. Pinned by a test that compares the ratio on a light and a bad
   wound.
3. **A temporal-dead-zone crash, caught by the smoke run.** My edit inserted
   `loot.age(hoursSince)` above the `const hoursSince` that defines it, so the
   simulation threw on every tick. The unit tests were all green — nothing in
   them exercises `main.js` — and the screenshot gate is what found it. Worth
   noting: this is the class of bug that only an integration check catches.
4. **The looting panel leaked into later screenshots**, the same modal-state
   mistake as M7's death card. Closed explicitly per shot.

## Verification

- **240 unit tests** (up from 204). New coverage: stack weights, unknown ids
  throwing rather than producing an empty item, perishables spoiling while tinned
  food does not, spoiled food being worthless rather than merely worse, gradual
  degradation before spoiling, labels saying so, fresh food out-nourishing tinned
  as the trade for spoiling; weight capacity rather than slots, stack merging,
  refusal to merge across ages, partial stack removal, transfers only when there
  is room, ageing and discarding, heaviest-first ordering; soft overload,
  proportional speed cost, never slowing to a standstill; loot only from real
  containers, kitchen contents drawn from the kitchen table over 40 seeds,
  determinism, generate-once, a meaningful fraction of empty containers,
  perishables pre-aged, the searched flag, and every loot table pointing at an
  object actually flagged as a container; eating, drinking, refusing rotten food,
  weapon swapping returning the old weapon, refusing to equip food, dressing the
  worst wound without asking, first aid healing as well as stopping bleeding, and
  dressings being severity-independent.
- **Screenshot gate:** fourteen angles, including the looting panels over a
  kitchen counter.

## Numbers

260 zombies still 2 draw calls. Loot is generated on demand, so an unexplored
town costs nothing; the smoke run's staged search generated one container.

## Known gaps, deliberately left for later

- **No containers you can place.** A base needs somewhere to put things down;
  that is M9's job along with barricading.
- No bags that increase capacity — `bag` exists as an item and does nothing yet.
- The torch is an item and emits no light, which is what the M7 night floor is
  waiting on.
- Painkillers reduce nothing; `Body.pain` needs a suppression term.
- No cooking, no water containers to refill, no rain collection.
- Item transfer is one item per click with no multi-select or drag.

## Verdict

Hunger and thirst are decisions now: there is food in the world, it is where you
would expect it, it runs out, and carrying it costs you speed.

The pass worth remembering is the third. Every unit test was green while the game
threw an exception on every single tick, because nothing in the unit suite
imports `main.js` — the wiring is exactly the part that unit tests do not cover.
The screenshot gate has now caught two bugs of that shape, and it is the only
thing that would have.

Proceed to M9 — crafting & base building.
