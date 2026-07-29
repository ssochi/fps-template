# M3 — Player & movement

**Status:** ✅ Complete
**Slice:** player controller, cursor aiming, endurance, doors, stairs, vaulting,
and a procedurally built and animated character.

## Goal

Turn the capsule stand-in into something with the *feel* the genre needs:
retreating while facing a threat, sprinting that costs something, and doors and
stairs that are obstacles you resolve rather than geometry you pass through.

## What was built

| Area | File | Note |
| --- | --- | --- |
| Character rig | `entity/Character.js` | Segmented humanoid, procedural gait |
| Controller | `entity/Player.js` | Aiming, endurance, doors, stairs, vaults |
| Door state | `world/TileGrid.js` | `state` array, `canPass` vs `canWalk` |
| Door rendering | `world/Mesher.js` | Leaf fills the doorway shut, swings flat open |
| Cursor aiming | `main.js` | Pointer projected onto the player's *storey* plane |

## The decisions worth recording

**`canWalk` and `canPass` are deliberately different questions.** `canWalk`
answers the geometric one — is there a route? — and is what pathfinding and the
worldgen connectivity tests want, because a shut door is still a route, it just
needs opening. `canPass` additionally respects door state and is what movement
wants. Conflating them would either make the horde refuse to path through doors
or let the player walk through closed ones; there is no single answer that
serves both.

**Object state is a separate array from terrain flags.** `flags` describes the
terrain and is written by worldgen; `state` describes the object standing on the
tile and is written during play — a door swings, a window breaks, a container
gets emptied. Keeping them apart is what lets a save file store the state array
as a delta without re-storing the town.

**Facing is decoupled from movement, and backing away is slower.** The body
turns toward the cursor, not the direction of travel. Retreating while still
watching something is the core defensive action in this genre, and making it
cost speed is what stops it being free.

**Endurance recovers more slowly than it drains, with hysteresis.** Running the
bar to zero doesn't merely stop you; it leaves you *winded*, capped at a walk
until you recover well past empty. The asymmetry is what makes "should I run?"
a question. The hysteresis band exists so the winded state cannot flicker on and
off at a single threshold — a bug that would otherwise show up as stuttering
speed rather than as anything obviously wrong.

**Walking into a shut door opens it.** Requiring a keypress to get through your
own front door is friction without tension. It still costs a beat, and it still
makes noise — `noise:made` is emitted for M5's horde to hear.

**Rigid parts instead of a `SkinnedMesh` — a deliberate departure from the
blueprint.** Skinning exists to deform a surface smoothly across a joint, and at
the closest step on this camera's zoom ladder a shoulder seam is under two
pixels. A hierarchy of rigid boxes gives identical animation control with no
bind matrices, no weight painting and no per-frame skinning cost, and stays
compatible with M5's plan, since vertex animation textures bake out of whatever
poses these bones are in. Blueprint updated; revisit if the camera ever gains a
close-up.

**Animation is a function of distance, not a clip.** No keyframes: a gait is a
set of sine offsets over a phase that advances with *metres travelled*. Walk,
run and sneak are the same function with different amplitudes, blending between
them is arithmetic, and the feet stay planted at any speed by construction —
rather than by tuning a clip's playback rate against movement speed, which is
the usual cause of characters that ice-skate.

## Iteration passes

1. **Door state added; one existing test failed and was correct to.** M1's
   `blocksSight` treated every doorway as opaque, a placeholder from before doors
   existed. The real model: an empty doorway is a hole you can see through, a
   shut door is a wall, an open one is a hole. Test rewritten to the real
   semantics rather than the placeholder's.
2. **The character was invisible in every screenshot.** Not a rendering bug —
   the player spawns beside their building, which at this camera angle puts the
   building between them and the lens. That is precisely M4's wall cutaway, so
   two cropped verification shots were added with the character out on the road.
3. **The forced-gait screenshot hook fought the real update.** It ran *after*
   `player.update`, so the idle pass and the forced pass each pushed the
   animator's speed blend a different way and the pose landed at half amplitude
   — which reads as a broken gait rather than a driven one. It now replaces the
   update instead of following it.
4. **The gait phase was mis-scaled by roughly 6×.** The parameter was named
   `freq` and documented as "strides per metre", but used as metres-per-cycle.
   At 0.46 with a 5 m/s run the legs cycled about eleven times a second. Renamed
   to `stride`, set to real figures (~1.55 m per cycle walking, 3 m running), and
   pinned with a test that asserts the plausible range — the kind of error that
   is invisible in a still and obvious in motion.
5. **Run amplitude toned down.** A 1.12 rad thigh swing reads as the splits, not
   as running. Capped under 0.85 rad, with a test asserting it.
6. **Player colours lifted.** The palette reserves saturation for things that
   matter, and the player is the thing that matters most; at the original values
   they disappeared into the road.

## Verification

- **91 unit tests** (up from 69). New coverage: endurance drain/recovery
  asymmetry, the winded hysteresis band in both directions, clamping to 0–1,
  aim-independent facing, backpedal penalty, walking a door open, being stopped
  by a door not yet reached, the noise event, doors taking time, climbing a
  flight, descending a stairwell, and the rig itself — distance-driven phase,
  neutral idle pose, leg opposition, arm counter-swing, knees that only bend
  backwards, plausible stride length and swing amplitude.
- **Screenshot gate:** eight angles, two of them tight crops of the character so
  a pose can actually be judged — at 10 m of view height the figure is ~90 px in
  a 1280-wide frame, which is too small to review in a full-frame shot.

## Known gaps, deliberately left for later

- **The player is invisible whenever a wall is between them and the camera.**
  The single most important thing M4 fixes.
- Vaulting is implemented and tested via `canClimb`, but nothing yet breaks a
  window, so windows are climbable only where worldgen placed them.
- No combat, no health, no inventory — M6, M7, M8.
- The character has one body type and one outfit; variation waits for the horde
  in M5, which will need it far more.

## Verdict

The controller has the genre's feel: you can back away from something while
watching it, sprinting costs you, and doors and stairs are decisions. The most
valuable bug found was the 6× gait scaling — invisible in a still frame, obvious
in motion, and now pinned by a test that encodes what a plausible stride is.

Proceed to M4 — occlusion & vision.
