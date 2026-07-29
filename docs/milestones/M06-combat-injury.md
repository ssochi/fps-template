# M6 — Combat & injury

**Status:** ✅ Complete
**Slice:** melee swings, shoving, weapon wear, zombie health and death, corpses,
body-part damage, bleeding, fractures and infection.

## Goal

Make the encounter resolve. Before this, a chase ended with a zombie standing on
your feet. Both directions of that had to become real, and the *injury* half
matters more than the *damage* half — this genre is about what a fight costs you
afterwards.

## What was built

| Area | File | Note |
| --- | --- | --- |
| Injury model | `sim/Body.js` | Six parts, bleeding, fractures, infection |
| Weapons | `items/Weapons.js` | Five melee weapons + shove, wear and tear |
| Resolution | `sim/Combat.js` | Swing arcs, zombie windups, both directions |
| Zombie damage | `sim/Horde.js` | Health, stagger, knockback, death, corpses |
| Clips | `sim/HordeSystem.js` | `attack` and `fall`, both non-looping |
| Non-looping clips | `render/CrowdMaterial.js` | Negative rate = play once and hold |

## The decisions worth recording

**Damage is located, not pooled.** A single hit-point bar cannot express what
makes an injury interesting: not that it cost health, but that it cost a
*capability*. A hurt leg slows you (`mobility` feeds directly into the player's
speed); a hurt arm shortens and weakens your swing (`dexterity` feeds into range
and damage). Both are things you feel while deciding whether to keep fighting.

**Infection is a countdown, not a debuff.** It does nothing to your stats. It
tells you roughly how long you have, and the run ends when you decide what to do
with that. That is the reference game's cruellest idea and it does not survive
being softened into a status effect.

**The player's body runs on two clocks.** Bleeding, clotting, pain and healing
use real seconds; infection uses the accelerated in-game clock. Running both on
the game clock is a bug I shipped and caught in a screenshot — at 60× the player
bled out from one bite in about three seconds. There is now a test named for
exactly that.

**Combat owns proximity, so `Horde` still never reads the player's position.**
The zombie AI's only inputs remain sound and line of sight. Combat is the system
that owns damage, so it is also the one that notices a zombie has arrived and
starts its swing. The M5 constraint survives M6 intact, which was the point of
stating it.

**A zombie's swing has a windup.** It does not connect on contact; there is a
0.45 s window in which backing away or shoving makes it miss. That window *is*
the defensive game — without it, being touched is being hit and there is nothing
to play.

**Shoving deals no damage at all.** "I need one more second" is a real thing to
want and it should have an answer that is not violence. It costs less stamina
than any weapon, hits more targets than any weapon, and buys distance.

**Weapons trade reach and crowd control against damage.** A knife out-damages a
bat and cannot hold a doorway; a crowbar is mediocre at everything and
essentially never breaks, which over a long run beats being good. Endurance per
swing is the real limit — every weapon can kill, the question is whether you can
afford the seconds and the stamina while the rest of the crowd closes.

**Corpses stay.** A cleared street should look cleared. Dead zombies keep their
slot in the instance buffer and hold the last frame of the fall clip, which the
shader supports via a negative playback rate meaning "play once and hold".

## Iteration passes

1. **First combat render worked** — corpses prone, attack poses reading, HUD
   showing located damage.
2. **The two-clock bug.** Caught by reading the HUD in a screenshot rather than
   by a test: every body part bleeding and dead within seconds.
3. **The staged fight killed nothing.** My fixture ringed the zombies at 1.6 m
   and the crowbar reaches 1.35 m, so every swing correctly missed. The code was
   right and the fixture was wrong — which looks identical to combat being
   broken.
4. **It still killed nothing after fixing the radius.** Instrumenting the swing
   showed it worked in isolation, so the difference had to be run state: by shot
   10 the player had spent the whole smoke run standing in a crowd and was
   already dead, and `swing()` correctly refuses when you are. The fixture
   revived the player *after* swinging. Two consecutive passes lost to a test
   fixture rather than to the system under test.
5. **Balance check on the staged scenario.** Being surrounded by nine zombies at
   point-blank kills you in about three seconds. That is correct for the genre
   and was left alone; the screenshot works around it instead.

## Verification

- **176 unit tests** (up from 142). New coverage: damage locating to parts,
  mobility and dexterity penalties, limb fractures but never a fractured torso,
  death only from lethal parts, bleeding and bandaging, infection only from the
  dead and only once, infection killing on its own clock, and the bleed-out
  regression pinned by name; weapon trade-offs, wear, breakage, bare hands never
  wearing out, damage staying flat until nearly spent; swings hitting in front
  and missing behind, missing out of reach, wide vs narrow arcs, killing and
  leaving a corpse, refusal when exhausted or dead, shoving without wounding,
  and always being able to hit something standing on you; zombie windups not
  connecting instantly, landing if you stay, missing if you back away, not
  reaching across storeys, bites infecting where scratches do not, and a dead
  zombie stopping mid-swing; knockback not pushing through walls, and stagger
  costing a zombie its next action.
- **Screenshot gate:** ten angles, including a staged fight that kills through
  the real combat path — verifying that the fall clip holds its last frame,
  since a corpse standing back up would mean the non-looping path is broken.

## Numbers

260 zombies still in 2 draw calls; corpses cost nothing extra since they keep
their existing instance slot. Sim step 0.6–1.2 ms with combat active.

## Known gaps, deliberately left for later

- **No moodles.** Pain, panic, hunger and fatigue are M7; `Body` already tracks
  pain and exposes it for that.
- Zombies do not break doors or windows, so barricading is currently absolute.
  The flow field already costs a shut door higher than an open one, so the
  routing half is ready for it.
- No blood, no hit flash, no sound. A swing that connects and a swing that
  misses look the same, which is the biggest feel gap remaining.
- Dismemberment is rolled and recorded but not rendered — it needs per-instance
  limb suppression in the crowd shader.
- No death screen. `player:died` fires with a cause; nothing listens yet.
- The player has one fixed weapon. Swapping waits for M8's inventory.

## Verdict

The fight resolves in both directions, and the injury model is doing the work I
wanted from it — a hurt leg genuinely changes whether running is an option.

The lesson from this milestone is uncomfortable and worth writing down: **two of
the five passes were spent debugging my own test fixture, not the game.** Both
times the symptom was "combat does nothing" and both times the system was
correct — once staged out of reach, once staged with a dead player who was
rightly refused. A fixture that is wrong in a plausible way costs more than one
that is obviously wrong.

Proceed to M7 — survival simulation.
