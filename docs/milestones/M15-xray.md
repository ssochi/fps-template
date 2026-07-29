
# M15 — X-ray: nothing may cover the player

**Status:** ✅ Complete
**Slice:** the occlusion cutaway. Walls, roofs and furniture between the camera
and the survivor dissolve.

## Goal

M14 gave the player a silhouette that shows through walls, and the follow-up
from the same playtest was exact about why that is not the answer:

> 需要有透视机制啊 就和僵尸毁灭工程一样 主角不能被挡住，已经 房子不会有房顶啊

A silhouette tells you *where* you are. It does not let you see the doorway you
are walking toward, the zombie beside you, or the room you are standing behind.
The reference game does not draw an outline and leave the wall up — it takes the
wall down.

## What the reference game actually does

Two mechanisms, and it is worth separating them because we already had one:

1. **Room cutaway.** Step inside a building and its near walls and upper storeys
   go. That is M4, and it works.
2. **Occlusion cutaway.** Anything between the camera and the player is made
   transparent regardless of whose building it is. This is the one we did not
   have, and it is the one the complaint is about — *the wall you are standing
   behind is not a wall you are inside*, so M4 has nothing to say about it.

Build 42 rebuilt (2) and the community reaction is instructive: the current
implementation is
[criticised as visually inconsistent](https://steamcommunity.com/app/108600/discussions/0/846243771540634030/),
with objects appearing from one angle and vanishing at the next, and some
players preferring
[blacked-out rooms to x-ray walls](https://steamcommunity.com/app/108600/discussions/0/596287646583591084/).
The lesson taken from that: **make the rule simple enough to predict.** A hole
of a fixed size, always centred on the survivor, is something a player learns in
one second. A per-object visibility heuristic is not.

## What was built

| Piece | File |
| --- | --- |
| The cutaway itself | `render/WorldMaterial.js` |
| Floors marked exempt | `world/Mesher.js` — `FACING_FLOOR` |
| Pointing it at the player | `world/World.js` — `updateOcclusion` |
| Drawing-buffer size | `render/Renderer.js` |

## The decisions worth recording

**The test is in screen space, because that is the literal statement of the
problem.** A fragment is dissolved when it is (a) nearer the camera than the
player and (b) within a short distance of them *on screen*. Both halves are one
line each: compare `gl_FragCoord.z` against the player's projected depth, and
`length(gl_FragCoord.xy - uPlayerScreen.xy)` against a radius.

The world-space alternative — a cylinder drilled along the view axis — is worse
in a way worth recording, because it was the obvious first design. At a 31°
pitch the *ground plane in front of the player is always inside that cylinder*
somewhere, so it either eats a hole in the street or needs a dead zone tuned per
zoom level. Screen space has no such problem, and it says what we mean.

**The radius is stated in metres and converted to pixels.** So the hole is the
same size *in the world* at every zoom step. A fixed pixel radius swallows a
whole house at the closest zoom and is narrower than the character at the widest,
which is exactly the "inconsistent from one angle to the next" complaint above.
Converted from the **drawing buffer** size, not the CSS size — `gl_FragCoord` is
in device pixels and getting that wrong is wrong by the pixel ratio.

**Floors are exempt, ceilings are not.** Dissolving a wall in front of the
player reveals the room; dissolving the *ground* in front of them reveals the
void. So floors got their own facing id — `FACING_FLOOR`, distinct from
`FACING_NONE` — and the exemption is conditioned on level: a floor at or below
the player's storey is ground and stays, a floor above them is a ceiling and
goes. Furniture is not exempt, because a wardrobe between you and the lens is
exactly as much of a problem as a wall.

**The occlusion cutaway is not in the depth pass, and the room cutaway is.**
This looks like an inconsistency and is not. The room cutaway must be in both,
or a removed roof leaves its shadow lying across the room it just revealed — a
bug from M4. The occlusion cutaway must not: its test is in *camera* screen
space, which is meaningless while rendering from the light's point of view, and
a wall dissolved so you can see yourself should still shade the street.
Otherwise a hole of sunlight follows you around the town.

**Both cutaways dissolve, not blend.** Reusing M4's dithered discard rather than
adding alpha means no depth sorting on interpenetrating chunk meshes, and the
two effects combine with a single `max()`.

**The M14 silhouette stays.** It now almost never fires — the circle takes the
geometry down before it can occlude anything — but "almost never" is not never,
and the ground ring is a findability affordance in its own right. It costs three
draw calls and it is the fallback for anything the circle misses.

## Iteration passes

1. **Built, 389 tests green, and correct on the first screenshot** — which is
   rare enough to be worth noting, and is down to the shader already having a
   dithered-discard path with shared uniforms. The whole feature is one
   `max()` into an existing pipeline.

## Verification

- **389 unit tests** (up from 380). New: the ground tagged as floor rather than
  as "not a wall"; walls still tagged by direction so the room cutaway is
  unaffected; objects still dissolvable; the circle landing on the player and
  following them; the radius scaling with the zoom ladder *exactly* in
  proportion to view height; scaling with the drawing buffer rather than the CSS
  size; the inner radius inside the outer; and the uniforms existing where the
  depth material can see them.
- **Screenshot gate:** the three shots that matter are `01-default` (the spawn,
  behind a house — the frame that started all of this), `03-close` (the roof
  dissolved around the survivor) and `06-indoors` (room cutaway and occlusion
  cutaway composing without fighting).

## Numbers

No measurable cost: one `max()` and a `length()` in a fragment shader that
already had a dither and a discard. 75 draw calls, unchanged.

## Known gaps

- **The hole is a circle, not the wall segment.** The reference game fades whole
  wall *pieces*, which reads more like architecture and less like a spotlight.
  A circle is more predictable, which is the trade this milestone chose, but a
  segment-shaped version is worth trying.
- **Zombies behind walls are still invisible.** Correct — knowing where they are
  is what the fog of war is for — but the reference game's players
  [ask for outlines on them](https://steamcommunity.com/app/108600/discussions/0/592887423803878372/)
  and they may be right.
- **The horde is not exempt from the circle**, because it is not drawn with this
  material at all. A zombie standing between you and the camera will still cover
  you.
- **Shadows are unaffected**, deliberately, so there is a shadow with no wall
  above it at the edge of the hole. Visible in `01-default` and defensible; the
  alternative is a moving hole of sunlight.

## Verdict

Two milestones in a row driven entirely by someone playing the game, and both
were more valuable than what the plan had scheduled. That is now a pattern
rather than a coincidence, and it is worth saying what it means: **the docs in
this repository have been better at recording decisions than at noticing which
decisions were never tested against a person.** M4's cutaway doc is a good
document about a correct system that solves half the problem, and it took
fourteen milestones for anyone to say so.

**M16 is the metagame milestone** — the helicopter, the shutoff clock, and the
ambient broadcasts — whose code has been written and parked since M14 opened.
