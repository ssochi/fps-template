# M1 — Engine core & isometric camera

**Status:** ✅ Complete
**Slice:** build, fixed-step loop, tile grid, chunk mesher, isometric rig,
screen-relative movement with grid collision.

## Goal

Stand up the parts every later milestone queries, and get the *camera* right —
because the isometric rig is not a rendering detail in this genre, it is the
interface. Verified against a hand-authored test block whose correct appearance
is known in advance, so the mesher can be judged rather than guessed at.

## What was built

| Area | File | Note |
| --- | --- | --- |
| Units & directions | `core/constants.js` | One definition of north, one tile↔world conversion |
| Fixed-step loop | `core/Loop.js` | 30 Hz sim, interpolated render, spiral-of-death guard |
| Seeded RNG & noise | `core/Rng.js` | Named sub-streams so adding a system doesn't reshuffle the town |
| Intent mapping | `core/Input.js` | Keys → named actions, never read raw in gameplay code |
| Event bus | `core/Events.js` | Systems never import each other |
| **Tile grid** | `world/TileGrid.js` | The load-bearing structure (see below) |
| Chunk mesher | `world/Mesher.js` | Cell data → one merged geometry, AO and colour baked in |
| Chunk registry | `world/World.js` | Grid is truth, meshes are a cache of it |
| Isometric rig | `render/IsoCamera.js` | Snapped rotation & zoom, screen-space movement basis |
| Renderer | `render/Renderer.js` | Hemisphere fill + shadow-casting key, frustum tracks zoom |
| Palette | `render/Palette.js` | Desaturated dusk, in one place |
| Orientation | `entity/Entity.js` | The only file that writes `rotation.y` |
| Grid movement | `entity/Walker.js` | Axis-separated resolution, slides along walls |

## The two decisions worth recording

**Walls live on edges, not in cells.** Each cell stores only its north and west
wall; the south edge of a cell *is* the north edge of its southern neighbour.
The obvious alternative — four walls per cell — stores every wall twice, so
every write has to keep both copies in sync and any missed write leaves a wall
that is solid from one side and open from the other. Storing it once makes that
class of bug unrepresentable. `wallAt()` hides the indirection.

**Walls are zero-thickness pairs of one-sided quads.** Two quads with opposing
normals rather than one double-sided quad, because M4's cutaway hides the face
pointing at the camera and keeps the one pointing away — which is only possible
if they are separate primitives. They are separated by 12 mm (`WALL_SKIN`); see
pass 4 below for why.

## Iteration passes

1. **First render.** Geometry correct, but the frame was almost black.
2. **Removed distance fog.** `scene.fog` is computed from view-space depth, and
   under an orthographic rig every visible surface sits at roughly the same
   depth — with the rig 120 m back, the whole frame sat deep in the fog ramp and
   got a flat grey wash. Distance fog is simply the wrong tool for this
   projection; "you can't see far" here is fog of war (M4), a grid query.
3. **Moved the sun off the camera axis.** The key light was at roughly the same
   azimuth as the rig, so both visible facades lit identically and buildings read
   as flat silhouettes. Offsetting it puts one facade in key light and the other
   in fill, which is where isometric depth actually comes from.
4. **Separated coplanar wall faces.** Perfectly coplanar front and back faces are
   degenerate for the depth test — each wall shadowed itself in hard diagonal
   wedges. Also set `shadowSide = FrontSide`, since three.js's default of casting
   from back faces assumes closed solids, which these are not.
5. **Sized the shadow frustum to the zoom.** A fixed extent lost shadows along a
   straight diagonal at wide zoom. The orthographic camera's visible area is
   exactly known, so the frustum can track it — which is why isometric shadows
   stay crisp where a perspective game needs cascades.
6. **Hemisphere fill instead of flat ambient.** A constant ambient term lights
   every shaded surface identically, so a wall in shadow and a floor in shadow
   collapse to the same value exactly where the key light stopped helping.
7. **Coherent noise for ground cover.** Per-tile coin flips read as confetti;
   ground wants patches.

## Verification

- **46 unit tests.** Grid indexing, edge-wall resolution from both sides,
  movement/sight/climb queries, chunk-boundary dirtying, key round-tripping,
  wall-opening rectangles, AO darkening, camera basis handedness, wall sliding,
  corner squeeze-through, and entity facing.
- **Geometry winding is asserted, not eyeballed.** This repo's history contains
  *"Fix see-through vehicle hulls: lofted sides were wound inward"*; inverted
  winding is invisible until someone looks from the wrong angle. Tests assert the
  exact normal set for floors and for both wall orientations.
- **The camera basis is asserted against three.js's own camera matrix**, so "W"
  can never silently become "A" after a rotation.
- **Screenshot gate:** `npm run smoke` captures five angles to `shots/` and fails
  on any console error.

## Numbers

48 × 32 × 2 test world: **22 draw calls, 8.8k triangles, 10 chunk meshes**,
sim step 0.1 ms. Draw calls scale with populated chunks, not with objects — the
whole point of the chunked mesher.

## Known gaps, deliberately left for later

- No roofs, and storeys above the player are drawn — **M4** (cutaway).
- Window openings read as black holes; interiors have no light of their own — **M2/M4**.
- No furniture, no doors as objects, no stairs — **M2**.
- The avatar is a capsule with no animation — **M3**.

## Verdict

The grid, the mesher and the rig are all in place and tested, and the camera
already feels like the genre. Six of the seven passes above were fixes to things
that *looked* wrong rather than things that were broken, which is the expected
shape for a rendering milestone.

Proceed to M2 — town generation.
