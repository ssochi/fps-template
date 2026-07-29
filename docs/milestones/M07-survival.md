# M7 — Survival simulation

**Status:** ✅ Complete
**Slice:** in-game clock and day/night, the moodle set, sleep, temperature,
panic, a real HUD, and the death report.

## Goal

Turn the thing you are surviving *from* — a horde — into a thing you are
surviving *in*: a world with a clock, where the hour of day changes what you can
see and what you are willing to do, and where hunger, thirst and exhaustion make
you leave the building you were safe in.

Also to fix M6's biggest stated gap: the HUD was a debug blob and a landed hit
looked identical to a missed one.

## What was built

| Area | File | Note |
| --- | --- | --- |
| Time | `core/Clock.js` | One place that owns the time scale |
| Moodles | `sim/Moodles.js` | Seven tracks, each with a mechanical effect |
| HUD | `ui/Hud.js` | Moodles, body diagram, bars, death report |
| Day/night | `render/Renderer.js` | Sun and palette driven by the clock |

## The decisions worth recording

**Every moodle changes a decision.** The blueprint's rule — cut any that doesn't
— did real work: an early draft had boredom and unhappiness as separate tracks
with no mechanical difference, and they collapsed into one. The surviving seven
each have an effect read by a system that already existed: hunger and thirst
throttle endurance recovery, fatigue caps endurance outright, pain costs mobility
and dexterity, panic costs dexterity, cold costs dexterity and burns food, heat
burns water, sickness stops you healing. The file states the table and the tests
assert every row.

**Tiers, not percentages.** A moodle reports 0–4 and a name, because that is the
resolution a player acts on. "Peckish" and "Hungry" are different decisions;
41% and 43% are not.

**One place owns the time scale.** `Clock` converts real seconds to in-game ones
and everything that ages reads from it. That rule exists because of the M6 bug
where bleeding was fed the accelerated clock and killed the player in three
seconds — and it was still not enough (see pass 3).

**The sun's azimuth is deliberately unphysical.** Elevation is honest, because
that is what the player reads the hour from. Azimuth sweeps a 70° arc instead of
a full circle: a correct azimuth spends most of the day *behind* the camera, and
since an isometric view shows only two facades, both end up shaded and every
building flattens to a silhouette. That is precisely the problem M1 solved by
moving the sun off the camera axis — undone by making it accurate. There is now a
test that walks every hour from 06:00 to 20:00 and asserts the sun still lights
exactly one visible facade.

**Night has a moonlight floor.** The first pass was physically reasonable and
completely unplayable: a black screen with a HUD on it. The dynamic that makes
night dangerous is not being unable to see *at all*, it is being unable to see
*far* — which the fog of war already provides. The floor sits where silhouettes
and doorways still read, and can come back down once torches exist, because then
darkness will have an answer.

**The HUD is DOM.** It is text and boxes that change a few times a second, and
the GPU is already drawing a town. It also flashes the body panel on a wound,
which closes M6's "a hit and a miss look identical" gap for at least the
receiving half.

## Iteration passes

1. **First run** — clock, moodles and HUD all rendering.
2. **The sun regression.** Clock-driven azimuth put the light behind the camera
   for most of the day and flattened every building. Constrained the arc; pinned
   it with an hour-by-hour test.
3. **Panic was on the wrong clock — the same mistake as M6's bleeding.** Its
   decay was written in in-game seconds, so it settled in under two real
   seconds and behaved as a proximity readout rather than an emotion. `Moodles`
   now takes both clocks exactly as `Body` does. Documenting the M6 bug clearly
   was evidently not sufficient to prevent me repeating its shape.
4. **The clock displayed 13:46 at 13:47.** Minutes were derived by
   round-tripping through a 0–1 day fraction, which loses enough precision to
   truncate a minute. Now computed from whole seconds.
5. **A test was over-specified, not a bug.** I asserted panic was still nonzero
   30 s after the threat left; it fully settles in ~24 s, which is fine. Rewrote
   it to pin the property that matters — still high 3 s later, zero by 60 s.
6. **The death card leaked into later screenshots.** The player genuinely dies
   during the combat shot, and the card is modal, so every subsequent shot was a
   picture of it. Also fixed a `PCFSoftShadowMap` deprecation the smoke run had
   been reporting.

## Verification

- **204 unit tests** (up from 176). New coverage: a full in-game day taking the
  stated real duration, the time scale being derived rather than hard-coded,
  hours and minutes matching elapsed time, darkness at night and light at
  midday, dawn ramping rather than switching, the sun staying off the camera
  axis at every daylight hour, and elevation peaking at noon; moodles starting
  clean, hunger and thirst accruing with thirst first, exertion accelerating
  both, tiers rather than percentages, worst-first ordering, and one test per
  row of the effects table; panic spiking fast and outlasting the threat, being
  worse in the dark, cold being worse outdoors than in, sleep recovering fatigue,
  collapse when it is ignored, waking when rested, eating and drinking helping,
  dehydration killing and naming its cause, sickness preceding a fatal infection,
  and everything stopping when the player is dead.
- **Screenshot gate:** twelve angles, now including night and the death report.

## Numbers

260 zombies still 2 draw calls. Sim step 0.6–1.0 ms with the full survival
simulation running alongside combat and the horde.

## Known gaps, deliberately left for later

- **Nothing to eat or drink.** Hunger and thirst tick up and there is no food in
  the world — M8's loot is what makes them a decision rather than a timer.
- No bed, so sleeping is involuntary (collapse) only.
- No torches or lamps, which is why the night floor is where it is.
- Temperature has no clothing to interact with; it is ambient only.
- The death screen says "reload to begin again" because there is no restart.
- Panic has no effect on aim beyond dexterity, and no visual treatment.

## Verdict

The world has a clock now, and the moodles genuinely push you out of the door
rather than decorating the screen.

The uncomfortable lesson repeats from M6 and is worth stating plainly: **two of
this milestone's six passes were unit-confusion bugs**, both of the form "a rate
written against the wrong clock". I documented that failure at the end of M6 and
then made the same mistake three passes into M7. Writing a lesson down is not the
same as building a guard against it — `Clock` exists partly to be that guard, and
every system that ages now has to be handed both clocks explicitly rather than
choosing one.

Proceed to M8 — inventory & looting.
