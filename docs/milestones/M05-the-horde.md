# M5 — The horde

**Status:** ✅ Complete
**Slice:** vertex-animation-texture crowd rendering, flow-field pathing, sound
propagation, sight cones, and the AI that consumes all three.

## Goal

Prove the two technologies M0 flagged as the highest risk in the whole plan, and
build the thing this genre is actually about: zombies as *weather* — individually
trivial, collectively lethal, and driven by what they hear and see rather than by
knowing where you are.

## What was built

| Area | File | Note |
| --- | --- | --- |
| Clip baking | `render/Vat.js` | Poses the shared rig, bakes to float textures |
| Crowd shader | `render/CrowdMaterial.js` | Texture-fetched vertices, position+yaw instances |
| Pathing | `sim/FlowField.js` | One bucketed Dijkstra sweep for the whole horde |
| Hearing | `sim/Sound.js` | Attenuated flood fill, decays over time |
| Agents | `sim/Horde.js` | Structure-of-arrays, four states, attention decay |
| Wiring | `sim/HordeSystem.js` | Three update rates, one per system |

## The decisions worth recording

**The horde never reads the player's position as a heading.** Nothing in
`Horde.js` steers toward the player. Its only inputs are the sound field and a
line-of-sight test; pursuit happens because the *flow field* is built from the
player, and following a gradient is not the same as knowing where someone is.
That constraint is what makes hiding, sneaking and noise discipline real rather
than numbers the AI politely ignores — and it is easy to break by accident, which
is why it is stated here and asserted in tests.

**One Dijkstra sweep instead of per-agent A\*.** With hundreds of agents
converging on one target, A* costs O(agents × path); a sweep costs O(cells)
*once* and every agent reads the direction in its own cell. Measured: **1.79 ms**
for a 104 × 104 town, serving 400 zombies at the same price as four.

**The sweep is bucketed Dijkstra, not BFS, because edges cost different amounts.**
A shut door is passable but slow, so the dead route around it when they can and
converge on it only when they cannot. That is what makes barricading a doorway
meaningful rather than decorative.

**Clips are baked from the player's own rig.** `Character` is the one body
definition in this project. Baking from it means the dead are visibly the same
species as the living — and, more practically, there is no second pose function
to drift out of sync. `applyPose` was split out of `Character.update` precisely
so the baker and gameplay call the same code.

**The difference between living and dead is posture, not detail.** At this camera
distance a face is four pixels. The dead get a short dragging stride, almost no
arm counter-swing, a forward lean the living would fall over from, and arms that
come up when they charge. Silhouette is the entire vocabulary available.

**A zombie in a room you cannot see is not drawn at all.** The crowd shader
samples the same fog-of-war texture the world does and discards below the
*visible* threshold — not the remembered one. Remembering where a wall was is
knowledge; remembering where a zombie was is a lie, and seeing one through a wall
removes the reason to be careful.

**Three update rates.** Sound decays every step; AI runs every step; the flow
field rebuilds only when the player has moved three tiles or 1.5 s has passed. A
zombie two hundred tiles away does not care that its target moved one tile, and
the sweep is by far the most expensive thing here.

## Iteration passes

1. **First render worked**, which was the genuinely uncertain part — VAT was
   unproven in this codebase and is the reason M0 ranked this milestone as the
   riskiest.
2. **The dead were bent double.** A 0.19–0.30 rad hip lean stacked on top of
   1.35 rad arm reach read as "lying down at an angle" rather than "shambling".
   Both pulled back; the silhouette now reads as hunched.
3. **My sound benchmark was measuring nothing.** It emitted thirty times into an
   already-saturated field, so every call after the first spread zero cells and
   reported 0.05 ms. Clearing between emissions gave the real figure, 0.55 ms.
   Worth recording because the number looked *good* — a benchmark that flatters
   the code is worse than none.
4. **Pooling the flow field's bucket arrays did nothing** (2.63 → 2.63 ms). The
   guess was wrong; the cost was elsewhere.
5. **Inlining the wall lookups did.** A sweep makes ~42,000 step-cost queries,
   each going through `wallBetween` → `wallAt` → `index` with its bounds checks
   and switch. Reading the typed arrays directly took the sweep to **1.79 ms**.
   The duplicated rule is pinned by a test that re-derives every edge in the
   finished field against the reference implementation — a silent disagreement
   between the two would path the horde through walls.
6. **A VAT test compared only X.** A gait swings limbs in the sagittal plane, so
   "does the last frame differ from the first" found no difference on that axis
   alone even though the pose had plainly changed.

## Verification

- **142 unit tests** (up from 113). New coverage: flow fields leading every
  reachable tile home, sealed pockets reported unreachable rather than guessed,
  routing around a shut door, fences passable but expensive, multiple goals,
  never routing through a wall, and the inlined-vs-reference cost agreement;
  sound loudest at source, muffled more by walls than air, passing an open door
  better than a shut one, decaying to silence, and pointing uphill; zombies
  wandering when blind and deaf, chasing what they see, *not* seeing through
  walls or behind themselves, investigating a noise they did not witness,
  pursuing after losing sight and then giving up, never walking through a wall,
  only spawning on walkable ground, and respecting capacity; and the baked clips
  — one block of rows each, vertex ids matching texture rows, finite positions
  inside a human-sized box, unit-length normals, frames that actually differ, and
  a loop with no duplicated end frame.
- **Screenshot gate:** nine angles, with the horde visible in the town and in the
  cropped character shots where the living/dead posture contrast is legible.

## Numbers

Measured, not estimated:

| | |
| --- | --- |
| **260 zombies** | **2 draw calls** (one beauty, one shadow) — measured by toggling the mesh and taking the delta |
| Horde AI, 400 agents | 0.221 ms per 30 Hz tick |
| Flow field sweep | 1.79 ms, ~1.7×/s at a sprint |
| Sound emission | 0.55 ms, 1330 cells |
| In-browser sim step | 0.6 ms with 260 alive |

## Known gaps, deliberately left for later

- **The dead cannot hurt you and you cannot hurt them.** Combat is M6; right now
  a chase ends with a zombie standing on your feet.
- Zombies do not open or break doors; they path through open ones and pile
  against shut ones. Door-breaking belongs with combat and barricading.
- The flow field and sound field are ground-floor only. Zombies on upper storeys
  wander. Multi-storey pathing needs stair edges in the sweep.
- No migration: the horde is scattered once at load and never redistributes, so
  clearing an area clears it permanently.
- No corpses — a killed zombie will need a `fall` clip and a body left behind.

## Verdict

Both risky bets paid off, and one of them by a wide margin: 260 animated
characters in two draw calls, with the AI for four hundred costing less than a
quarter of a millisecond. The bet that mattered more, though, is the constraint
that the horde never reads the player's position — it costs nothing to hold now
and would be nearly impossible to retrofit once combat, spawning and migration
are all leaning on it.

The lesson worth carrying: two of the six passes were bad measurements rather
than bad code. A benchmark that flatters the implementation is worse than no
benchmark, and a guess about where time goes is worth exactly nothing next to
measuring it.

Proceed to M6 — combat & injury.
