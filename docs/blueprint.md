# Blueprint v1 — Knox

> Written at the close of M0. Rewritten at every Exploration milestone.
> An isometric, multi-storey zombie survival simulation in the browser.

**Amendments since v1**

- **M3 — the player is a hierarchy of rigid parts, not a `SkinnedMesh`.**
  Skinning deforms surfaces across joints, and at this camera's closest zoom a
  shoulder seam is under two pixels. It bought nothing and cost bind matrices,
  weight painting and per-frame skinning. Reasoning in
  [`milestones/M03-player-movement.md`](./milestones/M03-player-movement.md).

## 1. Pillars

1. **The tile grid is the game.** One authoritative data structure that
   rendering, pathfinding, line-of-sight, wall cutaway, loot and construction
   all query. Everything else is a view onto it.
2. **Simulation over action.** Moodles, injury, infection and exhaustion are the
   gameplay. Combat is something you survive, not something you win.
3. **Zombies are weather.** Driven by sound and sight propagation, dangerous in
   aggregate. Noise discipline and sightlines are the real mechanics.
4. **Procedural everything.** No downloaded assets — buildings, furniture,
   characters, textures and audio are generated in code.
5. **Hundreds on screen at 60 fps.** The horde is a rendering *and* an AI
   problem, and both are solved structurally (VAT, flow fields), not by tuning.

## 2. Stack

- **three.js r185** on WebGL2, **Vite 8**, ES modules with JSDoc types (no TS
  build step — keeps iteration instant).
- **Vitest** for the simulation: grid queries, flow fields, shadowcasting, loot
  tables, moodle maths, geometry winding assertions.
- **Playwright + the pre-installed Chromium** for smoke tests and screenshots.
  Screenshot review is the acceptance gate for every rendering milestone.

## 3. Architecture

```
src/
  main.js              bootstrap and wiring
  core/
    Loop.js            fixed 30 Hz simulation, interpolated render
    Rng.js             seeded PRNG + simplex/fbm noise
    Events.js          typed pub/sub; systems never import each other
    Input.js           raw events -> intent, one place
    Clock.js           in-game time, day/night, calendar
  world/
    TileGrid.js        THE data structure: (x, z, level) -> cell
    Cell.js            floor, walls[4], object, room id, flags
    Chunk.js           16x16x1 slab; owns its merged mesh + dirty flag
    World.js           chunk registry, streaming, tile<->world conversion
    Room.js            room/building topology, used by cutaway and loot
  worldgen/
    Town.js            street layout -> lots -> buildings
    Building.js        footprint -> rooms -> walls, doors, windows, stairs
    Furnish.js         room purpose -> furniture + container placement
    Meshers/           cell data -> merged BufferGeometry with baked AO
  render/
    Renderer.js        WebGLRenderer, passes, resize
    IsoCamera.js       orthographic rig, snapped 90-degree rotation + zoom steps
    Cutaway.js         per-room wall culling and storey fading
    FogOfWar.js        three-state visibility blended into tile shading
    Vat.js             vertex animation texture baking + instanced crowd mesh
    Palette.js         the desaturated dusk palette, one source of truth
  entity/
    Entity.js          transform + facing; the only file that writes rotation.y
    Player.js          controller, endurance, aiming, doors, stairs, vaults
    Character.js       segmented rig + distance-driven procedural gait
    Zombie.js          lightweight struct; the horde is SoA, not objects
  sim/
    Horde.js           spawn, migration, flow-field consumption
    FlowField.js       one Dijkstra sweep -> gradient for the whole horde
    Sight.js           recursive shadowcasting
    Sound.js           noise events -> attenuated grid propagation
    Combat.js          melee arcs, durability, body-part damage
    Body.js            body parts, bleeding, fracture, infection
    Moodles.js         hunger, thirst, fatigue, panic, pain, boredom, temp
    Skills.js          XP from doing, level curves
  items/
    ItemDb.js          generated item definitions
    Container.js       capacity, weight, contents
    Loot.js            room purpose -> plausible container contents
  ui/
    Hud.js             moodles, health, equipped, time
    Panels.js          inventory, crafting, character
  save/
    Save.js            IndexedDB: seed + deltas, never the world itself
docs/
```

### 3.1 System rules

- **Fixed-step simulation at 30 Hz.** Deterministic given a seed; render
  interpolates. A survival sim gains nothing from 60 Hz AI and the horde costs
  half as much.
- **Systems communicate through `Events`.** `Combat` emits `noise:made`;
  `Sound` listens. No system imports another system.
- **The horde is structure-of-arrays.** Hundreds of zombies are typed arrays of
  position/state/clip, not hundreds of JS objects — GC pressure is the enemy.
- **The world is a seed plus deltas.** Saves store the seed and what changed
  (looted, built, broken, killed), never the generated town.

## 4. The tile grid (the load-bearing decision)

```
cell = {
  floor:   material id | 0 for void
  walls:   [north, east, south, west]  wall id | 0
  object:  furniture / door / window / stairs id | 0
  room:    room id | 0 for outdoors
  flags:   solid, opaque, blocksSound, indoor, ...
}
```

Stored as parallel typed arrays per chunk, not objects. Chunks are
**16 × 16 tiles × 1 storey**, each owning one merged `BufferGeometry` with
vertex-baked ambient occlusion, rebuilt only when marked dirty. A destroyed door
dirties one chunk, not the town.

Every consumer is a query against this:

| System | Query |
| --- | --- |
| Renderer | chunk meshes, rebuilt on dirty |
| Cutaway | walls by facing + room membership |
| Sight | `opaque` flag, shadowcast from the player |
| Sound | `blocksSound` flag, attenuated flood fill |
| FlowField | `solid` flag, single Dijkstra sweep |
| Loot | room purpose → container contents |
| Building | write floor/wall/object, dirty the chunk |

## 5. The horde (the hard problem)

- **Rendering — Vertex Animation Textures.** Each clip (shamble, lunge, stagger,
  fall, feed) is baked once into a float texture: one row per frame, one texel
  per vertex. The vertex shader reads position by `(vertexId, frame)`. The whole
  horde is one `InstancedMesh` — one draw call — with per-instance clip index and
  phase offset so they don't march in lockstep. The clips are baked by posing
  the same segmented rig the player uses (`entity/Character.js`), so there is one
  body definition rather than two that can drift apart.
- **Pathing — flow field.** One Dijkstra sweep from the player (or from a noise
  event) across the walkable grid produces a per-cell direction. Every zombie
  reads its own cell and moves. Cost is O(cells) once, not O(agents × A\*).
  Secondary fields for noise sources, blended by recency and loudness.
- **Perception.** Zombies react to *sound* (attenuated flood fill through the
  `blocksSound` flags) and *sight* (a cone tested against the same shadowcast the
  player uses). Neither ever consults the player's position directly — that's
  what makes stealth real.
- **Migration.** Off-screen hordes drift on a coarse grid, so the world is not
  empty behind you and is not a fixed set of spawn points.

## 6. Look

Desaturated, high-contrast dusk. Flat-ish key light, strong vertex-baked AO at
wall/floor joins, muted palette. **Colour is reserved for items, blood and
fire** — anything saturated is meaningful. Fog of war blends toward near-black
for unseen and toward grey-blue for remembered.

## 7. Content targets for cycle 1

- One procedurally generated town: ~40 buildings, ~10 building archetypes,
  multi-storey, fully furnished interiors.
- 300+ concurrent zombies at 60 fps.
- ~80 item types, ~25 crafting recipes, 6 container archetypes.
- Full moodle set, body-part health, infection, permadeath + death report.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| VAT proves too rigid for readable zombies | Prototype in M5 with a fallback to InstancedSkinnedMesh; keep the crowd behind one interface |
| Chunk rebuilds stutter when a wall breaks | 16×16×1 chunks keep a rebuild under a millisecond; rebuild off the critical path |
| Procedural buildings feel same-y | Archetype templates + furnishing rules, not pure noise |
| Simulation depth becomes busywork, not tension | Every moodle must change a decision, not just a number; cut any that doesn't |
| Scope creep into vehicles/multiplayer | Explicitly deferred to cycle 2 |
