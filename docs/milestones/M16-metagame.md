# M16 — Metagame events & the shutoff clock

**Status:** ✅ Complete
**Slice:** water and power failing on a schedule, taps that can run dry, the
helicopter, and distant gunshots, screams and car alarms.

## Goal

Answer cycle 2's question directly: **why does the world get harder on its own?**

Everything the player had faced so far was a *reaction* to something they did —
they made a noise, so the dead came; they got hurt, so they bled. Nothing had
ever happened because time passed, which is the whole reason day twenty felt
like day three.

## The decisions worth recording

**The shutoff introduces nothing.** It takes things away. The taps that have
been standing in every bathroom since M2 become a water source and then stop
being one; the night that has always been survivable stops being. That is the
cheapest possible way to make a world get harder, and it retroactively gives
every water bottle in M8's loot tables a meaning it did not have.

**A cistern holds what it holds.** A toilet keeps one drink after the mains die
— once, and then it does not. So the morning the water goes off is not the end
of water, it is the beginning of going through the neighbours' bathrooms one at a
time, which is a far better afternoon than an empty tap.

**The power cut is what M7's night floor was waiting for.** That comment has
been in `Renderer.js` for nine milestones: *"When torches and lamps exist this
can come back down, because then darkness will have an answer."* A power cut is
that moment. While the grid is up the town has streetlight; when it fails the
floor drops by half and M9's torch stops being optional.

**A metagame event is a scheduled noise emission.** That is the entire
implementation. Gunshots, screams, alarms and the helicopter all emit
`noise:made` into M5's sound field, so the horde reacts to them exactly as it
reacts to a hammer — no special case anywhere, and M13's migration remembers
them for minutes after the sound has faded.

**Ambient events thin out as the days pass, because the people making them are
dying.** One multiplication, and it tells the whole story of what happened to
everyone without a line of dialogue: a town that is noisy on day one and silent
by day ten.

**The helicopter is the one thing allowed to know where you are, and the pillar
survives.** The rule is that *the horde* never reads the player's position, and
it still does not — the dead follow the helicopter's noise. The helicopter is a
machine with people in it looking for survivors; knowing where you are is its
function. It cannot see through a roof, which is what makes the counterplay
interesting: hiding indoors does not save you, because it keeps circling the
last place it saw you and that is where the town is now walking. What saves you
is leaving.

**The schedule is derived from the seed, so a save stores three booleans.** The
same town always fails on the same days; only what has *already happened* needs
storing.

**The days are scaled to a session.** The reference game puts the shutoff around
day thirty; thirty of our days is fifteen real hours. Scaled to days 3–7, which
preserves the thing a schedule is *for* — a stated deadline you can see coming.

## Iteration passes

1. **Written during M14 and parked** when playtest feedback displaced it.
2. **Restored and wired**: taps on `E`, broadcasts in the HUD, the power cut into
   the night floor, rotor/gunshot/alarm into the synthesised audio, and the
   schedule into the save.
3. **The helicopter's hunt was on the wrong clock, and the screenshot caught
   it.** `HELI_DURATION` was written in in-game seconds; eight in-game minutes is
   **ten real seconds**, so the machine turned round and left before it had
   finished crossing the town. The shot showed it at x = −1.6 — still off the
   map — in the LEAVING state. **This is the third time this project has put a
   rate on the wrong clock** (M6's bleeding, M7's panic) and all three looked
   like the feature being broken rather than like a unit error. Now on the real
   clock, with a test that asserts it is well onto the map after thirty seconds.
4. **A helicopter off the edge of the map made no noise at all**, because the
   sound field only covers the town and the emission was being skipped. Clamped
   to the edge instead: the whole point of entering from a distant edge is that
   the noise arrives first and drags the crowd across town on its way in.

## Verification

- **411 unit tests** (up from 389). New: the schedule deriving from the seed and
  differing between seeds, water always before power, each utility failing
  exactly once, warnings a day out and not before; taps giving water while the
  mains are on, tables never giving water, sinks dying at the shutoff, a cistern
  holding exactly one drink afterwards and each cistern draining separately; the
  helicopter coming once on its day, entering from off the map, being blind
  through a roof and sighted outdoors, **dragging the horde by making a noise
  rather than by reporting a position**, hunting on the real clock long enough
  to arrive, and eventually leaving; ambient events thinning with the days and
  emitting into the shared sound field; alarms running down; every broadcast
  said once and containing text rather than a lookup key; and the save storing
  what happened rather than the schedule.
- **Screenshot gate:** twenty-one images, now including the helicopter's
  searchlight on the survivor with five chasers converging, and the first night
  after the grid fails.

## Known gaps

- **The helicopter mesh flies off the top of the frame.** At nineteen metres and
  a 31° pitch it projects well above the player, so what you see is the beam and
  the shadow rather than the machine. Either it comes down or the camera has to
  know about it.
- **No generator, no rain collection.** The shutoff poses the question and M17
  answers it; right now the answer is "carry more bottles".
- **Nothing else uses `Utilities.power`.** Lighting is the only consumer, so a
  fridge does not stop preserving food when the grid fails, which it should.
- **A helicopter caught by a save is simply gone** rather than resuming.
- **Car alarms are only ever triggered by the scheduler.** Hitting a car should
  set one off, and `triggerAlarm` is public so that it can.

## Verdict

The cheapest milestone since M12, and for the same reason: the sound field, the
event bus, the clock, the seed and the save were all already there, and every
feature here is a scheduled call into one of them. The one real bug was a unit
error that three milestones of documentation had failed to prevent — which
suggests the convention needs a test, not another paragraph.
