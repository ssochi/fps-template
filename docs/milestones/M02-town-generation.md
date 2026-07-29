# M2 — Town generation

**Status:** ✅ Complete
**Slice:** streets, blocks, lots, multi-storey buildings with rooms, doors,
windows, stairs, roofs and furnished interiors; plus the object layer that all
of it writes into.

## Goal

Replace the hand-authored test block with a town the player could actually get
lost in — and make "getting lost" mean *learning a street layout*, not being
confused by noise.

## What was built

| Area | File | Note |
| --- | --- | --- |
| Object layer | `world/Objects.js` | 23 object types, id+facing packed into one cell value |
| Object meshing | `world/Mesher.js` | Boxes, stepped stairs, trees, lampposts |
| Street layout | `worldgen/Town.js` | Road grid → blocks → lots → buildings → street clutter |
| Interiors | `worldgen/Building.js` | BSP rooms, doorway tree, windows, stairs, roof |
| Furnishing | `worldgen/Furnish.js` | Room purpose → furniture, placed against walls |
| Storey cutaway | `world/World.js` | Hide storeys above the player when indoors |

## The decisions worth recording

**Top-down layout, not organic growth.** A road grid carving blocks, blocks
carved into lots, one building per lot. The reference game's world is memorable
because its street layout is *learnable*; a town grown from noise never becomes
navigable, only surprising. Lots are always cut so each keeps a street frontage,
because a lot buried mid-block generates a house whose front door opens onto
nothing.

**Room connectivity is structural, not checked afterwards.** The partitioner
punches the doorway between a split's two halves *immediately after* raising the
wall, before recursing. That makes the rooms a tree whose edges are doorways, so
"every room is reachable" holds by construction rather than by luck. It is then
asserted anyway, by flood fill, over 40 seeds — because the property that
actually ruins a generated town is a room you cannot enter, and that is invisible
in a screenshot.

**Furniture is placed by room purpose, and never in a doorway.** A room is
assigned "kitchen" and then given kitchen things; scattering plausible objects
uniformly produces a bath beside a stove. The doorway exclusion covers both the
doorway tile *and* the tile it opens into — a wardrobe one tile inside a door
seals a room just as effectively as one in the doorway. Both the exclusion and
post-furnishing reachability are asserted over 25 seeds.

**Objects are meshed into chunk geometry, not scene nodes.** A furnished town is
tens of thousands of objects that never move. As `Object3D`s that is tens of
thousands of draw calls and matrix updates; baked into the chunk mesh it is zero
extra draw calls.

**Roofs are ordinary floors on the storey above.** Modelling a roof as a special
case would mean the mesher, the cutaway and eventually rooftop access each need
to know about it. As a floor at level `storeys`, they all get it for free.

## Iteration passes

1. **First generation.** Streets and buildings correct; two bugs surfaced
   immediately, both caught by tests rather than by eye.
2. **Stairwell openings were being paved over.** The hole above a staircase was
   carved during the storey that owned the stairs, and the *next* iteration of
   the storey loop floored its whole footprint straight back over it. Fixed by
   deferring every opening until all storeys are laid — the hole is a property of
   the finished building, not of the storey below it.
3. **Corrected a wrong test, not the code.** The furnishing test forbade any
   object in a doorway, which a *door* legitimately is. Narrowed to furniture.
4. **Spawn landed in the map corner.** Iterating buildings in generation order
   put the player wherever was built first, with half the view off the edge of
   the world. Now sorted by distance to centre.
5. **Trees rendered as featureless pillars.** A single box at tree height reads
   as a column, and trees are half the outdoor silhouette in an isometric view.
   Now a trunk and two tapering canopy blocks; lampposts likewise got an arm and
   a head.
6. **Added roofs and the storey cutaway.** Without roofs the town read as a
   doll's house. With them and no cutaway it was unplayable. The cutaway hides
   storeys above the player *while indoors only*, which is the reference game's
   behaviour and makes the town legible from outside and from within.

## Verification

- **63 unit tests** (up from 46). New coverage: room connectivity by flood fill
  over 40 seeds, exact footprint tiling with no gaps or overlaps, unique room
  ids, stairwell openings, doorway clearance and post-furnishing reachability
  over 25 seeds, determinism per seed, different seeds producing different towns,
  no building ever placed on asphalt, spawn always outdoors and walkable, and
  object geometry (five-faced boxes, footprint rotation, in-tile containment,
  stairs climbing exactly one storey).
- **Screenshot gate:** six angles including an indoor shot that drives the real
  cutaway path rather than poking the API directly.

## Numbers

104 × 104 × 3 town: **23 buildings, 93 rooms, 112 chunk meshes**.
Outdoors at full zoom-out: 200 draws / 90k triangles (half of those are the
shadow pass). Indoors with the cutaway: 14 draws / 12.5k triangles from 49
visible chunks. Generation is a single synchronous pass at load.

## Known gaps, deliberately left for later

- The cutaway is per-*storey* and global — stepping indoors removes every roof
  in town. **M4** makes it per-room, and adds the wall cutaway (hiding the
  facades between the camera and the player, which is why the avatar is still
  invisible indoors).
- No fog of war, no line of sight — **M4**.
- Doors are objects but do not open; stairs are geometry you cannot yet climb —
  **M3**.
- Containers are flagged but hold nothing — **M8**.
- Only houses: no shops, warehouses or civic buildings — worth a pass in **M10**
  or the next Exploration milestone.

## Verdict

The town is navigable, its interiors are legible, and the two properties that
would quietly ruin it — unreachable rooms and blocked doorways — are asserted
across dozens of seeds rather than spot-checked. Both bugs found this milestone
were found by those tests, which is the argument for having written them.

Proceed to M3 — player & movement.
