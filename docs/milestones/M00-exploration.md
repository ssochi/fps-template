# M0 — Exploration

**Status:** ✅ Complete
**Type:** Exploration (opens cycle 1)

## Goal

Understand the ground before building: what's in this repo, what *Project
Zomboid* actually is as a system, what the browser can carry, and where the hard
problems are. Output a blueprint the next ten milestones can be cut from.

---

## 1. State of the repo

Empty working tree. `git log` shows 15 commits from previous, unrelated projects
(an FPS template, a racing map, a PBR model studio, a procedural creature
generator) — all wiped by two "Remove all project files" commits. Nothing to
reuse as code.

Two things in that history are worth carrying forward as *lessons*, because both
were bugs expensive enough to earn their own commits:

- **`Fix vehicles and turrets facing backwards: two conflicting yaw conventions`**
  — two subsystems disagreed on which axis was forward. Fixed here by making one
  file the sole owner of orientation (§6.4).
- **`Fix see-through vehicle hulls: lofted sides were wound inward`** —
  procedurally generated geometry with inconsistent winding. Fixed here by
  asserting winding in unit tests on every generated mesh.

Toolchain available: Node 22, three.js r185, Vite 8, Chromium pre-installed for
headless screenshot tests.

## 2. What Project Zomboid actually is

Stripped to its load-bearing parts:

- **An isometric, multi-storey, fully interior world.** Every building is
  enterable, every room is furnished, every container has contextually sensible
  loot. The world is not a backdrop; it *is* the content.
- **A simulation, not an action game.** The famous *moodles* — hunger, thirst,
  fatigue, stress, panic, boredom, pain, temperature, sickness — are the actual
  gameplay. Combat is a failure state you survive, not a power fantasy.
- **Zombies as weather, not enemies.** Individually trivial, collectively
  lethal. They're driven by *sound and sight propagation*, so the interesting
  decisions are about noise discipline, sightlines and routes — not aim.
- **Death is permanent and the game says so.** "This is how you died" is the
  framing. Every system is tuned to make loss legible in hindsight.
- **Deep time.** Looting → basing → crafting → farming → the world decaying
  around you over in-game months.

### What we build vs. what we cut

| Keep (the identity) | Cut / defer to cycle 2 |
| --- | --- |
| Isometric multi-floor interiors, wall cutaway | Multiplayer |
| Moodles + body-part health + infection | Vehicles |
| Sound/sight-driven zombie hordes | Full Knox County-scale map |
| Container looting with plausible loot tables | Animals, electricity grid sim |
| Melee-first combat, durability, exhaustion | Weather beyond day/night + temperature |
| Skills/XP from doing, traits at character creation | Full 100-recipe crafting tree |

## 3. Platform reality check

Target: desktop browser, 60 fps at 1080p on integrated graphics.

- **No downloaded assets.** Everything procedural or generated in code —
  buildings, furniture, characters, textures, audio. This keeps the repo small,
  the cold start instant, and sidesteps the environment's network policy.
- The budget that binds is **draw calls**, then **skinned mesh count**.
- **The hard problem is the horde.** Research is unambiguous: three.js's stock
  `SkinnedMesh` collapses at ~20 animated characters, and stock `InstancedMesh`
  doesn't support skinning at all. A PZ-like needs *hundreds* on screen. Two
  viable routes:
  1. `InstancedSkinnedMesh` — community extension, per-instance bone textures.
  2. **Vertex Animation Textures (VAT)** — bake each animation clip's vertex
     positions into a float texture; the vertex shader reads a row per frame.
     One `InstancedMesh`, one draw call, per-instance clip + phase offset.

  **Decision: VAT.** Zombies have few, short, looping clips (shamble, lunge,
  fall, feed) and never need runtime IK, which is exactly the case VAT wins.
  The player — who *does* need blending and aiming — stays a normal
  `SkinnedMesh`; there is only one of them.
- **Pathfinding must not be per-agent A\*.** With hundreds of agents converging
  on one target, a **flow field** (single Dijkstra sweep over the tile grid,
  every agent just reads its cell's gradient) is one cost for N agents instead
  of N costs. This is the difference between 40 zombies and 400.

## 4. The rendering problems specific to this genre

### 4.1 Isometric camera
`OrthographicCamera` with no perspective distortion — the genre's defining look.
PZ uses a fixed dimetric angle with discrete 90° rotation and zoom steps. Free
orbit is *wrong* here: it breaks the tile-grid readability the whole art style
depends on. Rotation snaps; zoom snaps.

### 4.2 Seeing inside buildings — the genre's signature problem
An isometric camera looking at a multi-storey building sees the roof and the two
near walls, not the player inside. PZ solves this per-room. Our approach, in
order of application:

1. **Cull walls facing the camera.** Each wall segment knows its facing; walls
   whose normal points camera-ward are hidden. Because rotation is snapped to 90°,
   this is a lookup, not a dot product per frame.
2. **Hide floors above the player's storey**, fading rather than popping.
3. **Fade the roof** of any building the player is inside.

Doing this per *room* rather than per *building* is what makes it feel right —
you see the room you're in and its neighbours, not a building with its lid off.

### 4.3 Fog of war and line of sight
PZ's black-to-grey memory fog is not decoration: it's the tension. Implemented
as a per-tile visibility grid updated by **recursive shadowcasting** from the
player's eye, with three states (unseen / remembered / visible) blended into the
tile shading. Cheap, and it happens on the grid, not in the renderer.

### 4.4 Style
Not photoreal, not cel-shaded. PZ's look is **desaturated, high-contrast, dusk**.
Flat-ish lighting with strong ambient occlusion at wall/floor joins, a muted
palette, and colour reserved almost entirely for *items and blood* so that
anything meaningful pops. Vertex-baked AO on chunk geometry gets most of the way
there for free.

## 5. What is missing (the honest gap list, by risk)

1. **No project at all.** No build, no loop, no camera. Blocks everything.
2. **No world representation.** Everything downstream — pathing, LOS, cutaway,
   loot, building — is a query against the tile grid. Get this data structure
   wrong and every later milestone pays for it. Highest-leverage decision.
3. **No horde technology.** VAT + flow field are both unproven in this repo and
   both are load-bearing. Prototype early (M5), not late.
4. **No simulation.** Moodles, health, infection — the actual game, and the part
   that is *cheap* to build once the world exists.
5. **No persistence.** A permadeath game still needs to survive a browser tab
   refresh mid-session.

## 6. Conventions locked now

- **Y is up. One tile = 1 m × 1 m. One storey = 2.6 m.** All speeds m/s.
- **Forward is −Z**, matching three.js's camera. `Entity` is the only file
  permitted to write `rotation.y`.
- **Tile coordinates are integers `(x, z, level)`**; world position is
  `(x + 0.5, level * 2.6, z + 0.5)` for tile centres. One conversion helper,
  used everywhere, never inlined.
- **Counter-clockwise winding = front face.** Generated geometry is
  winding-asserted in tests.
- **Simulation is fixed-step at 30 Hz**, render interpolates. A survival sim
  doesn't need 60 Hz simulation, and 30 Hz halves the horde's AI cost.

## 7. Blueprint

Published separately: [`../blueprint.md`](../blueprint.md).

## 8. Milestone plan for cycle 1

| # | Milestone | Slice |
| --- | --- | --- |
| M0 | Exploration | this document |
| M1 | Engine core & isometric camera | Build, fixed-step loop, ortho iso camera with snapped rotation/zoom, tile grid, chunked mesh rendering |
| M2 | Town generation | Procedural streets, lots, multi-storey buildings with rooms, doors, windows, stairs, furniture |
| M3 | Player & movement | Controller, tile collision, storey transitions, stamina, `SkinnedMesh` character |
| M4 | Occlusion & vision | Per-room wall cutaway, storey fading, shadowcast LOS, three-state fog of war |
| M5 | The horde | VAT crowd rendering, flow-field pathing, sound propagation, sight cones, horde migration |
| M6 | Combat & injury | Melee arcs, push/shove, durability, exhaustion, body-part damage, dismemberment, infection roll |
| M7 | Survival simulation | Moodles, body-part health, temperature, sleep, sickness, the death report |
| M8 | Inventory & looting | Item DB, containers, weight/encumbrance, equipment slots, plausible loot tables |
| M9 | Crafting & base building | Recipes, barricading, carpentry, farming, water/food preservation |
| M10 | Progression & polish | Skills/XP, traits & occupations, day/night, audio, save/load, death screen |

M11 opens cycle 2 as the next Exploration milestone.

---

## Verdict

Three decisions carry the project, and all three are made now rather than
discovered later:

1. **The tile grid is the game.** Rendering, pathing, LOS, cutaway, loot and
   building are all queries against one authoritative data structure. M1 exists
   mostly to get it right.
2. **VAT for the horde, `SkinnedMesh` for the player.** The genre needs hundreds
   of animated bodies; the standard three.js path caps out at tens.
3. **Flow field, not A\*.** One sweep for the whole horde.

Proceed to M1.

## Sources

- [Project Zomboid — PZwiki Survival Guide](https://pzwiki.net/wiki/Survival_Guide)
- [Project Zomboid Wiki (Fandom)](https://projectzomboid.fandom.com/wiki/Project_Zomboid)
- [Project Zomboid build status / Build 42 notes](https://projectzomboid.com/blog/news/2017/02/buildstatus/)
- [three.js OrthographicCamera docs](https://threejs.org/docs/#api/en/cameras/OrthographicCamera)
- [InstancedSkinnedMesh for hundreds of characters](https://dev.to/sagacheng/using-instancedskinnedmesh-in-threejs-enabling-the-rendering-of-hundreds-of-3d-characters-on-screen-simultaneously-15gm)
