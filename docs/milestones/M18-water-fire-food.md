# M18 — Water, fire and food

**Status:** ✅ Complete
**Slice:** weather, rain barrels, campfires, cooking, and a generator.

## Goal

M16 turned the water off and the lights out and left the player with "carry more
bottles". This is the reply, and cycle 2's question for this milestone is
literally the one M16 posed: **what do I do when the taps run dry?**

## The decisions worth recording

**What you build has to be kept fed.** A barricade is a thing you build once.
These are three clocks you keep winding, and each charges a different currency:
the barrel costs patience and the weather, the fire eats planks, the generator
eats petrol you have to go and find. That is the actual shape of a base — not a
place that is safe, but a set of things running down.

**Every one of them is loud, and that is the tension.** The generator that gives
you light at night is the loudest thing in the town, emitted into M5's sound
field like everything else — so it draws the crowd, and M13's migration
*remembers* where the noise was for minutes afterwards. Nothing in the horde
knows generators exist. The screenshot for this milestone has three zombies
converging on a camp that is lit because its owner switched a generator on.

**Rain is the only weather that earns its place.** Not because the others are
hard, but because rain is the only one that changes a decision, and it changes
three numbers that already existed: it fills the barrel, it makes you cold, and
— the good one — **it covers the noise you make**. A downpour is the safest hour
of the day to hammer planks over a window and the worst hour to be outdoors in.
Snow, wind and fog would each be a rendering job and none of them would change
what you do next.

The mask is deliberately large: a storm swallows over half your loudness.
A tenth would be a number nobody could feel, and the mechanic is supposed to be
a *window* — this is the hour to do the loud thing.

**Weather is a function of `(seed, day)`.** A day is eight three-hour fronts and
each front's sky is derived from the seed, so the same town has the same summer
and a save stores nothing at all. Fronts last hours rather than minutes because
the whole point is that you can look outside and plan.

**Cooking is a recipe with a requirement, not a new system.** `needsFire` on a
recipe row, checked in `Construction.begin` — which is the right place, because
a recipe is a table row and knows nothing about where anybody is standing.
Raw meat is the only item in the game whose nutrition is close to worthless as
it is, which is what gives a campfire a job beyond warmth.

**A generator is a trip, not a pickup.** Twenty-five kilograms against a ten
kilogram bag: you carry it or you carry everything else. Finding it is the easy
half. This is what M8's weight-based inventory was for, and it took ten
milestones to get an item that uses it properly.

**A third recipe output kind: `PLACE`.** Crafting stops being "make a thing to
carry" and becomes "change this place". Everything M18 adds is one of these, and
M19's full carpentry gets the mechanism for free. Placement prefers the tile
*ahead* of you and falls back to the one underfoot — putting a barrel down on
yourself and then being unable to move is a way to lose a run to the interface.

**The power cut has an answer now, so M7's night floor finally means something.**
Lighting reads `stations.powered || utilities.power`, so a running generator is
the mains coming back for as long as the petrol lasts.

## Iteration passes

1. **Weather, stations, recipes, cooking, the Cooking skill and the wiring.**
2. **The i18n coverage test caught every new string before anything else did** —
   seven items, seven recipes, a skill and three object names, all failing at
   once because M14's test walks the real tables rather than a hand-written list.
   This is the second milestone where that test has been the first reviewer.
3. **A weather test was over-specified.** "Arrives rather than appearing"
   asserted an intensity above 0.4 after twenty seconds, which is only true for
   a storm; the front it happened to find was ordinary rain. Rewritten to pin
   the property — partway at twenty seconds, arrived at two minutes — rather
   than a number that depends on which sky the seed produced.

## Verification

- **452 unit tests** (up from 422). New: weather being identical per seed and
  different across seeds, raining a minority of the time, easing in, swallowing
  noise only while it rains, **reaching the player's own `noiseScale`**, and
  storing nothing; barrels filling only in rain, capping, giving one drink at a
  time, and **letting a survivor drink with the mains off**; fires lighting
  themselves when fed, burning out, refusing overfill, warming by distance,
  warming a survivor a storm was chilling, and crackling into the shared sound
  field; generators running on petrol, stopping without it, capping, and being
  by far the loudest thing you can leave switched on; placement putting the
  object in front of you and registering it, never placing on top of something,
  refusing to cook without a fire and allowing it with one, cooking being worth
  several times the raw item, a generator overloading a bag on its own, and
  feeding a fire on the same key that opens a door; stations round-tripping
  through a save as a short list; and every placement recipe naming a real
  object.
- **Screenshot gate:** twenty-two images, now including a camp at three in the
  morning with the mains dead — a lit fire, a filling barrel, a running
  generator and three zombies walking toward the noise.

## Known gaps

- **Rain has no visual.** The sky dims and the world gets darker, but there are
  no droplets and no sound. The mechanics are all there and the presentation is
  not.
- **Nothing can be picked back up.** A barrel you put in the wrong place is
  there for ever; M19's carpentry needs a general "take it down" verb.
- **The generator powers the whole town.** The fiction is a grid, which is
  convenient and wrong — it should light one building.
- **Water is never dirty.** Boiling exists as a recipe but rain water is already
  drinkable, so it is a convenience rather than a requirement.
- **No farming.** Potatoes are found, not grown, which makes them a loot item
  with extra steps until cycle 3.
- **The campfire is a dark box.** It reads entirely by its light, which works at
  night and not at all at noon.

## Verdict

The first milestone in four that was on the plan, and it went in cleanly — one
real bug, and that in a test rather than the code. The reason is worth naming:
weather, stations and cooking all landed on the sound field, the two clocks, the
seeded-derivation convention and the recipe table, and every one of those was
built for something else. Adding `OUTPUT.PLACE` was nine lines because
`Construction` already had the shape of "spend materials, change the world".

Proceed to M19 — full carpentry, which generalises what this milestone did to
three specific objects.
