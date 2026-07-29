# Blueprint v2 — Knox

> Written at the close of **M11**, replacing v1 (M0). Rewritten at every
> Exploration milestone.
> An isometric, multi-storey zombie survival simulation in the browser.

v1 was a statement of intent written before a line existed. This is a
description of a program that exists, plus the ten milestones that extend it.
Where v1 planned nouns and missed the joins between them, v2 states the
conventions, because the conventions are what actually survived.

**What v1 got right, kept verbatim:** the tile grid as the single source of
truth; simulation over action; zombies as weather; procedural everything;
hundreds on screen solved structurally rather than by tuning.

**What v1 got wrong:** it planned `Cell`, `Chunk`, `Room` and `Zombie` classes.
None exist and none should — a cell is an integer index into parallel typed
arrays, and so is a zombie. It also had no slot for a quarter of the code that
got written, nearly all of it the *seams* between planned systems.

---

## 1. Pillars

1. **The tile grid is the game.** One authoritative data structure that
   rendering, pathfinding, line-of-sight, cutaway, loot and construction all
   query. Everything else is a view onto it.
2. **Simulation over action.** Moodles, injury, infection and exhaustion are the
   gameplay. Combat is something you survive, not something you win.
3. **Zombies are weather.** Driven by sound and sight propagation, dangerous in
   aggregate. No system ever hands the horde the player's position.
4. **Procedural everything.** No downloaded assets — buildings, furniture,
   characters, textures and audio are generated in code.
5. **Hundreds on screen at 60 fps**, solved structurally (VAT, flow fields).
6. **— new in v2 — The world runs down on a clock.** Water and power fail,
   food rots, the dead redistribute. Cycle 1 made a game you can lose; cycle 2
   makes one you lose *slowly*, where what you build is why next week is
   survivable.

## 2. Stack

- **three.js r185** on WebGL2, **Vite 8**, ES modules with JSDoc types (no TS
  build step).
- **Vitest** for the simulation — 286 tests at the close of cycle 1.
- **Playwright + the pre-installed Chromium** for smoke tests and screenshots.
  Screenshot review is the acceptance gate for every rendering milestone, and
  it has caught bugs the unit suite structurally cannot (M8 shipped a crash on
  every tick with 240 green tests, because nothing in the unit suite imports
  `main.js`).

## 3. Conventions

These are load-bearing. Each was bought with a bug.

- **Fixed 30 Hz simulation, interpolated render.** Deterministic given a seed.
- **Two clocks, always passed explicitly.** `core/Clock.js` owns the scale.
  Anything that ages takes `(dt, gameDt)` — real seconds for what you react to
  (bleeding, panic), in-game seconds for what is measured in days (hunger,
  infection). Two separate bugs were rates written against the wrong clock;
  choosing one implicitly is no longer allowed.
- **Systems communicate through `core/Events.js`.** No system imports another
  system. This is why M10 could add audio and skills without touching combat.
- **Structure-of-arrays for anything there are hundreds of.** Zombies, cells,
  chunks. Not objects — GC pressure is the enemy.
- **The world is a seed plus deltas.** Saves store the seed and what changed.
  This only works because loot is *lazily* derived from `(seed, cellIndex)`.
- **Walls live on north/west edges only.** A wall belongs to exactly one cell,
  which makes "solid from one side, open from the other" unrepresentable.
- **`Entity.js` is the only file permitted to write `rotation.y`.** Two
  conflicting yaw conventions is a bug class, not a bug.
- **Gaits are keyed by stride in metres, not by frequency.** Animation advances
  with distance travelled, never with time.

## 4. Architecture as built

```
src/
  main.js              the shell: menu, then hand off (52 lines)
  Game.js              one run — everything main.js used to build at import time
  core/
    constants.js       units: TILE, STOREY, CHUNK, DIR, tile<->world
    Loop.js            fixed 30 Hz sim, interpolated render, sub-step guard
    Clock.js           the two clocks; day length, daylight ramp, sun angles
    Events.js          typed pub/sub singleton
    Input.js           raw events -> named ACTIONs
    Rng.js             seeded PRNG + noise
  world/
    TileGrid.js        THE data structure — parallel typed arrays
    Mesher.js          chunk -> merged BufferGeometry, vertex-baked AO
    World.js           grid + chunk meshes + fog + cutaway + shared uniforms
    Objects.js         23 object types, packed as id*4 + facing
  worldgen/
    Town.js            road grid -> blocks -> street-fronting lots
    Building.js        BSP rooms; the doorway is punched before recursing
    Furnish.js         room *purpose* first, then furniture
  render/
    Renderer.js        lights, shadow frustum sized to zoom, torch
    IsoCamera.js       orthographic, snapped 90 degrees, zoom ladder
    WorldMaterial.js   cutaway + fog injected via onBeforeCompile
    Cutaway.js         per-building wall removal with eased fade
    FogOfWar.js        unseen / remembered / visible, in a DataTexture
    Vat.js             vertex animation texture baking
    CrowdMaterial.js   texture-fetched vertices; the whole horde in 2 draws
  entity/
    Entity.js          transform + facing
    Character.js       segmented rigid-part humanoid; one pose function, shared
                       between the VAT baker and gameplay
    Player.js          endurance, aiming, doors, stairs, vaulting, items
    Walker.js          moveOnGrid — axis-at-a-time grid collision
  sim/
    Horde.js           SoA horde: state, health, velocity, hit flash
    HordeSystem.js     the driver
    FlowField.js       bucketed Dijkstra; costs inlined against raw arrays
    Sight.js           Amanatides & Woo DDA, so sight cannot leak diagonally
    Sound.js           attenuated flood fill; loudestDirection()
    Combat.js          owns proximity, so Horde stays ignorant of the player
    Body.js            six parts, bleeding, fracture, infection
    Moodles.js         seven tracks, each changing a number someone else reads
    Skills.js          XP from doing; every skill is a plain multiplier
    Traits.js          occupations, traits, and a closed list of 16 multipliers
    Construction.js    player build jobs, and the dead breaking in
  items/
    ItemDb.js          24 items; age, spoilage, degrading nutrition
    Container.js       weight capacity; Inventory adds soft overload
    Loot.js            room purpose x object type, rolled lazily from the seed
    Recipes.js         a zero-count material means "held, not spent"
    Weapons.js
  audio/Audio.js       synthesised; no audio files anywhere in the repo
  ui/
    Hud.js, Panels.js  DOM, not canvas
    MainMenu.js        title and character creation
  save/Save.js         seed + deltas into IndexedDB; fog deliberately not saved
```

## 5. The tile grid

Parallel typed arrays over `(x, z, level)`: `floor`, `wallN`, `wallW`,
`object`, `room`, `flags`, `state`, `barricadeN/W`, `barricadeHpN/W`. Chunks are
**16 × 16 tiles × 1 storey**, each owning one merged `BufferGeometry` rebuilt
only when dirty — a destroyed door dirties one chunk, not the town.

Every consumer is a query against it:

| System | Query |
| --- | --- |
| Mesher | walls, floors, objects, per-vertex room *behind* each face |
| Cutaway | `aRoom` + facing mask |
| Sight | `blocksSight`, DDA from the observer |
| Sound | attenuated flood fill |
| FlowField | `canWalk` — geometric; a shut door is still a route |
| Movement | `canPass` — respects doors and barricades |
| Loot | room purpose -> container contents |
| Construction | write, then dirty |

Memory scales linearly and is a non-issue: a 300² × 3 town is 3.5 MB.

## 6. The horde

Settled bets, measured: **260 zombies in 2 draw calls** (VAT + one
`InstancedMesh`), **AI for 400 in 0.22 ms/tick** (one flow-field sweep serves
everyone).

**The open problem, and cycle 2's largest architectural item:** the sweep is
O(cells) over *the entire reachable map*, every rebuild. At 300² that is 270,000
cells swept to steer zombies at most forty metres away, and it is what stops the
map growing. The fix is not a faster sweep — it is **two fields**:

- a **fine field**, bounded to a radius around the player, at full tile
  resolution, which is what chasers read;
- a **coarse field** on a heavily downsampled grid covering the whole map, which
  is what everything off-screen drifts along.

The coarse field is also exactly what **migration** needs, so one change closes
the scaling wall and the biggest behavioural gap together. Stair edges enter
both sweeps, which is what finally makes upstairs zombies path.

## 7. Look

Desaturated, high-contrast dusk. Flat-ish key light, strong vertex-baked AO at
wall/floor joins. **Colour is reserved for items, blood and fire.** No distance
fog — under an orthographic camera everything sits at the same depth, so fog is a
flat grey wash. Fog of war blends toward near-black for unseen, grey-blue for
remembered.

## 8. Cycle 2 — M12 to M21

The thesis, from [M11's survey](./milestones/M11-exploration.md): cycle 1 has no
answer to *why is day 20 different from day 3?* Each milestone below is one
answer.

| # | Milestone | The question it answers |
| --- | --- | --- |
| M12 | **Character creation & the main menu** | Why is *this run* different from the last? |
| M13 | **The horde that moves** | Why does the neighbourhood I cleared stop being safe? |
| M14 | **Metagame events & the shutoff clock** | Why does the world get harder on its own? |
| M15 | **Water, fire and food** | What do I do when the taps run dry? |
| M16 | **Full carpentry** | Why is this building *mine*? |
| M17 | **The world beyond houses** | Why walk two streets further? |
| M18 | **Vehicles** | Why is a supply run a different activity from a loot run? |
| M19 | **Farming, foraging and animals** | What do I eat in month two? |
| M20 | **Streaming & scale** | Why is the map bigger than a neighbourhood? |
| M21 | **Meta-progression & polish** | *closes cycle 2* |

**M12 — Character creation & the main menu.** Traits (positive and negative,
paid for from one budget), occupations that seed starting skills, and the
`Skills.rate` hook that has sat unused since M10. Carries the menu that save/load
has been waiting for: new game, continue, sandbox seed. Smallest item in the
cycle and it goes first, because it changes the game from its first minute.

**M13 — The horde that moves.** The two-field rewrite in §6, plus stair edges in
the sweep, plus migration: the dead drift toward noise and toward the map's
population centres, so a cleared street refills. The architectural item; every
later milestone is worth more with it than without.

**M14 — Metagame events & the shutoff clock.** A metagame event is a *scheduled
noise emission* — the sound field from M5 already does the rest. The helicopter
that appears once in the first fortnight and drags the horde to wherever it
finds you; distant gunshots, alarms, screams. And the shutoff: water and power
fail on a schedule, which retroactively gives every bottle in M8's loot tables a
meaning it did not have.

**M15 — Water, fire and food.** The answer to M14. Rain collectors, campfires,
cooking, generators and fuel. Cooking joins the skill list; a cooked meal beats a
raw one; a fire is warmth, light and the loudest thing in the neighbourhood.

**M16 — Full carpentry.** Placeable furniture and containers (a base with no
storage of its own is why you still carry everything), built walls and floors,
repairing and removing barricades. Closes M9's largest gap.

**M17 — The world beyond houses.** Building archetypes with their own loot
tables — shops, a warehouse, a fuel station, a school. The map becomes a set of
decisions about where to go rather than a uniform field of houses.

**M18 — Vehicles.** Keys, hotwiring, fuel, parts, condition, a Mechanics skill,
mobile storage, and the noise a car makes. The largest single feature in the
cycle and the one that most changes what a session *is*.

**M19 — Farming, foraging and animals.** The multi-week food answer, and the
thing that makes a base a place you return to on a schedule rather than a
storeroom.

**M20 — Streaming & scale.** Where M13's coarse field pays off: a 300² map with
chunked simulation and mesh streaming, so distance is a real cost.

**M21 — Meta-progression & polish.** Autosave, exposed save slots, sandbox
settings, death report v2. Closes cycle 2; **M22 opens cycle 3 as a fresh
Exploration milestone.**

## 9. Risks

**Amendment (M12).** `main.js` split into a shell plus `Game.js` a milestone
early: a menu means a run has to be something you *construct*, not something that
happens when a module loads. The M13 entry below is discharged.

| Risk | Mitigation |
| --- | --- |
| The two-field horde desyncs — zombies teleport at the radius boundary | Coarse cells hand off to fine cells at the seam, never the reverse; a test that walks an agent across the boundary and asserts continuity |
| Late game becomes busywork rather than tension — *the reference game's own acknowledged failure* | Every cycle 2 system must either **press** (migration, shutoff, events) or **be pressed on** (base, farm, vehicle). Anything that is neither is cut |
| Vehicles are a physics project in disguise | Grid-collided, arcade handling on the same `moveOnGrid` primitive the player uses. No suspension, no rigid bodies |
| `main.js` becomes unmaintainable as cycle 2 adds seven systems | Split it at M13, the first milestone that would grow it |
| Milestones get cheaper because verification got lazier, not because the work got easier | Pass counts are recorded per milestone in the ledger; M16–M20 building new systems should cost ~6 passes, and a 3-pass new-system milestone is a smell |
| Scope creep into multiplayer and NPC survivors | Explicitly deferred past cycle 2 |
