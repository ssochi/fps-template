# M4 — Occlusion & vision

**Status:** ✅ Complete
**Slice:** per-room wall cutaway, storey lifting, line of sight, three-state fog
of war.

## Goal

Fix the genre's defining rendering problem: an isometric camera looking at a
building sees its roof and its two near walls, and the player is inside behind
all three. Then add the thing that makes exploring a town tense rather than
merely large — a fog of war that distinguishes *never been here* from
*been here, don't know what's there now*.

## What was built

| Area | File | Note |
| --- | --- | --- |
| Line of sight | `sim/Sight.js` | DDA edge walk, no diagonal corner leaks |
| Fog of war | `render/FogOfWar.js` | Three states in a grid-shaped texture |
| Cutaway | `render/Cutaway.js` | Per-building, eased, camera-facing mask |
| World shader | `render/WorldMaterial.js` | Cutaway + fog injected into Lambert |

## The decisions worth recording

**A wall face carries the room *behind* it, not the room it belongs to.** This
is the crux of the whole milestone and I got it wrong first. Tagging a face with
its own room and hiding every camera-facing face removes a room's *far* walls
along with its near ones, leaving the interior with no backdrop — a floating
floor with furniture on it. What the cutaway actually needs to ask is "is the
room I am looking into behind this wall?". Since each wall is two opposing
one-sided quads, and a quad facing away from the camera is already back-face
culled by the rasteriser, tagging each face with the room on its far side makes
the rule a single comparison and the far walls survive untouched.

**Ray casting rather than recursive shadowcasting.** Shadowcasting is faster and
is the standard answer, but every variant of it assumes opacity lives *in cells*.
Here opacity lives on *edges* — a wall is a property of a boundary, not of either
tile it separates. Reworking the slope tests to handle edges is exactly the sort
of change whose failure mode is sight leaking diagonally through the join of two
walls, which surfaces later as a bug in the horde's stealth rather than in the
renderer. Casting a line per tile reuses `blocksSight`, which is already the
tested authority on what blocks vision.

**Sight is cast on every storey at or above the observer's.** Casting on one
storey leaves every roof in town unseen — black holes in the middle of a lit
street — because a roof's visibility cannot be inherited from a ground-floor
interior nobody can see into. Casting per storey gets it right without a special
case: a roof has no walls at its own level so the sweep reaches all of it, while
an upper-storey *interior* still has its exterior walls and stays dark until the
player climbs up there. Storeys *below* the observer are left alone — you cannot
see the floor beneath the one you stand on.

**Fog lives in a texture, not in the mesh.** Visibility changes every time the
player crosses a tile; baking it into vertex colours would mean remeshing a dozen
chunks per step. The texture is laid out exactly like the grid, with storeys
stacked in rows, so a cell index and a texel index are the same number.

**The cutaway fade is dithered, not blended.** An alpha fade on world geometry
needs depth sorting, which for interpenetrating chunk meshes is both expensive
and unreliable. A 4×4 ordered dither gives a smooth-looking dissolve with a plain
`discard` and no sorting at all.

**Shadows go through the same cutaway.** The chunk meshes carry a
`customDepthMaterial` that shares the cutaway uniforms *and the dither function*
with the beauty material. Without it, lifting a roof leaves the roof's shadow
lying across the room it was hiding; with a different dither, a half-faded wall
would cast a full shadow through its own holes.

## Iteration passes

1. **Fog rendered, roofs did not.** Visibility was computed only on the player's
   storey, so every roof was a black hole.
2. **First fix was wrong.** Propagating a column's visibility to outdoor cells on
   other storeys only lit roof *edges* — the interior of a footprint is not
   visible from outside, so most of the column never propagated. Replaced with
   per-storey casting, which is both simpler and correct.
3. **`RangeError: Set maximum size exceeded`.** That propagation added to the
   visible Set while iterating it; the new entries were indices on other storeys,
   which the tile-recovery arithmetic then decoded wrongly and used to generate
   more. Snapshotting the set first fixed it, and the approach was replaced
   wholesale in the next pass anyway.
4. **The cutaway removed far walls as well as near ones.** See the first decision
   above — the room-tagging fix.
5. **Restructured the screenshot set.** Every shot now reveals the fog first, so
   a geometry or cutaway regression cannot hide behind unexplored blackness, and
   one dedicated shot exercises the fog. That shot also looks from a second
   position first, because otherwise it only ever shows two of the three states
   and *remembered* — the state the whole design exists for — is never captured.
6. **Optimised the visibility update.** `markWallSkirt` scanned the whole grid
   per storey: a hundred-thousand-cell sweep to service a two-thousand-cell
   result. Iterating the visible tiles instead took a tile-change from
   **3.21 ms to 2.30 ms**.

## Verification

- **113 unit tests** (up from 91). New coverage: line of sight symmetry, walls
  and opaque cells blocking, windows and open doors not blocking, the diagonal
  corner-leak case, radius containment, the exact disc size on open ground,
  strictly-less visibility once a wall is added; fog starting unseen, demoting to
  remembered and never back to unseen, skipping work when the observer has not
  moved, texture and state staying in step, roofs visible while the sealed room
  beneath them is not; cutaway opening a whole building including its roof,
  leaving neighbours alone, fading rather than popping, closing on exit, and
  masking exactly two facings — never both of an opposing pair, which would
  remove a room's backdrop.
- **Screenshot gate:** nine angles, including the indoor cutaway and a fog shot
  showing all three states at once.

## Numbers

A visibility update costs **2.30 ms** on a 104 × 104 × 3 town at radius 17 across
three storeys, and only runs when the player crosses a tile — a few times a
second. That is about 7% of a single 30 Hz simulation step, not a per-frame cost.
Indoors with the cutaway active: 44 draws, 14.5k triangles.

## Known gaps, deliberately left for later

- The cutaway keys off the *room* the player stands in. A player in a doorway
  belongs to one room or the other, so a building can briefly close as they cross
  a threshold. Worth revisiting once doors are used heavily.
- Nothing yet uses `Sight` for anything but the player — M5's horde will share it
  for its sight cones, which is why it was written as a free function over the
  grid rather than as a method on the fog.
- The fog radius is a flat disc. Torches, darkness and a night cycle would make it
  a real mechanic rather than a constant — M9/M10.
- Interiors have no light of their own, so a cut-open room is lit only by the
  sky. Fine at dusk, will need lamps once night exists.

## Verdict

The game is playable indoors now, which it was not before. The bug worth
remembering is the wall-tagging one: "hide walls facing the camera" sounds like a
complete rule and is not — it is only half of one, and the missing half is which
side of the wall the room you care about is on.

Proceed to M5 — the horde.
