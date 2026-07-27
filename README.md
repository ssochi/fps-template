# Three.js FPS Template

A complete, batteries-included first/third person shooter template built with **Three.js + TypeScript + Vite**.

It ships with **three maps** — a full shooting range, a race circuit whose garage holds three heavily
detailed **drivable** vehicles, and a model studio built to show how a PBR asset is actually authored —
plus **ten distinct weapons**, **frag / smoke / flash grenades**, first *and* third
person cameras, procedural weapon models, procedural character animation with IK, a pooled effects
system, and a synthesized audio engine — **with zero binary assets**. Everything (textures, models,
sounds) is generated at runtime, so the repo clones and runs instantly and works offline.

> 中文文档见 [README.zh-CN.md](README.zh-CN.md)

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # typecheck + production bundle into dist/
npm run preview  # serve the production build
npm run typecheck
```

Requires Node 20.19+ / 22.12+.

---

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| `Shift` | Sprint (drains stamina) |
| `Ctrl` / `C` | Crouch (hold or toggle, configurable) |
| `Shift` + `Ctrl` while sprinting | Slide |
| `Space` | Jump (coyote time + jump buffering) |
| `Mouse 1` | Fire |
| `Mouse 2` | Aim down sights (hold or toggle) |
| `R` | Reload |
| `1` – `9`, `0` | Select weapon |
| `Q` | Swap to previous weapon |
| `Mouse wheel` | Cycle weapons |
| `B` | Toggle fire mode (auto / burst / semi) |
| `G` | Throw grenade — hold to cook a frag, release to throw |
| `G` + `Mouse 2` | Underhand lob |
| `T` | Cycle grenade type (frag → smoke → flash) |
| `V` | Switch first ↔ third person |
| `F` | Inspect weapon |
| `E` | Interact — resupply ammo and grenades, take a weapon from a pedestal, open the studio fridge |
| `K` | Start / cancel the timed drill |
| `L` | Reset all targets |
| `M` | Next map (also selectable from the start and pause screens) |

### Driving

| Input | Action |
| --- | --- |
| `E` | Get in / out of a vehicle |
| `W` / `S` | Throttle / brake, then reverse |
| `A` / `D` | Steer |
| `Space` | Handbrake |
| `Mouse` | Look around — on the tank this traverses the turret and elevates the gun |
| `Mouse 1` | Fire the 120 mm main gun (tank) or the twin arm cannons (Thor) |
| `Mouse 2` | Javelin missile salvo (Thor) |
| `V` | Chase / cockpit camera |
| `H` | Toggle HUD |
| `P` | Toggle collision debug wireframes |
| `Esc` | Pause / settings |

---

## What's in the box

### Player & movement
- Quake-style acceleration model (separate ground/air accel with an explicit friction pass) for crisp,
  responsive movement.
- Coyote time, jump buffering, automatic step-up over ledges and stairs.
- Stances: stand, crouch (hold or toggle) and a momentum-preserving slide entered by crouching at sprint speed.
- Stamina-gated sprinting, fall damage, landing recovery.
- Surface-aware footsteps, head bob, strafe roll, landing dip and trauma-based screen shake.

### Cameras
- **First person** with a dedicated view-model scene rendered on top of the world with a cleared depth
  buffer — the weapon never clips through walls, and it uses its own narrower FOV so it does not distort
  at wide world FOVs.
- **Third person** with an over-the-shoulder boom that automatically pulls in when obstructed, and that
  tightens toward the shoulder while aiming.
- Recoil is folded into the authoritative aim angles, so rounds always follow what the player sees;
  purely cosmetic motion (bob, shake, lean) never affects where rounds land.

### Weapons
Ten weapons, each with its own handling, recoil signature, audio profile and reload style:

| Slot | Weapon | Notes |
| --- | --- | --- |
| 1 | M9 Sidearm | Semi-auto pistol, fast draw, forgiving recoil |
| 2 | TMP-18 Machine Pistol | 1200 RPM full-auto sidearm, 20 rounds, brutal bloom |
| 3 | Model 29 Magnum | Six-shot revolver, hand-cannon damage, heavy recoil |
| 4 | MP-9 Vector | 950 RPM SMG, auto/semi, low recoil, poor range |
| 5 | AR-15 Carbine | Auto/burst/semi, red-dot optic, learnable recoil pattern |
| 6 | SR-25 Marksman | Scoped semi-auto DMR, 20 rounds, punches through cover |
| 7 | M40 Marksman | Bolt-action, mil-dot scope, one-shot lethal |
| 8 | M249 Support | Belt-fed 100 rounds, suppressive fire, six-second reload |
| 9 | M870 Breacher | Pump-action, 9-pellet buckshot, interruptible shell-by-shell reload |
| 0 | AA-12 Sweeper | Fully automatic drum-fed buckshot |

Systems behind them:
- Hitscan ballistics with per-weapon damage falloff, hit zones (head / body / limb), and **material
  penetration** — the rifle and sniper punch through the plywood wall on lane 2 to reach the plate behind it.
- Spread model combining base cone, movement, airborne, crouch and per-shot bloom, with Gaussian sampling
  for bullets and a ring-plus-jitter pattern for buckshot.
- Recoil with optional scripted patterns (the rifle and SMG have one), a random ramp past the end of the
  pattern, and a "permanence" fraction the player has to pull down manually.
- Fire modes, burst fire that completes after trigger release, bolt/pump cycle lockouts, tactical vs.
  empty reloads, dry fire, draw/holster, weapon inspect.

### Throwables
Three grenades on a shared throw key, with physics projectiles that bounce off the world:

- **M67 Frag** — three-second fuse you can *cook* by holding the throw key; the timer starts when the pin
  comes out, and holding it too long detonates in your hand. Radial damage with falloff and a line-of-sight
  check, so cover actually protects.
- **M18 Smoke** — pops on its fuse and screens the lane for twenty seconds with a continuously emitting
  particle cloud dense enough to hide behind.
- **M84 Stun** — flash blindness scaled by distance, line of sight *and* whether you were looking at it,
  plus real hearing loss: the whole audio graph drops behind a lowpass with a tinnitus ring over the top.

Tap `G` for an overhand throw; hold `Mouse 2` as well for an underhand lob into cover.

### Effects
- Muzzle flashes (separate view-model and world versions so nothing doubles up), dynamic muzzle lights,
  travelling tracers, spent brass with bounce physics and impact audio.
- Material-aware impacts: sparks, dust, smoke and debris chunks tuned per surface.
- Bullet-hole decals oriented to the hit surface, pooled with a fade-out recycle.
- Explosions: fireball, fragments, rolling smoke, ground debris, an expanding shockwave ring and a
  blast light bright enough to relight the whole bay.
- A single-draw-call GPU particle system (CPU simulated, free-list pooled) for sparks and smoke.

### Audio
Every sound is synthesized with the WebAudio API at runtime — gunshots (noise crack + body sweep +
mid punch + reverb slap-back), mechanical actions, reload steps, footsteps, impacts by material, steel
target rings, shell drops, hitmarkers and UI blips. Sounds are positioned with manual distance
attenuation, stereo panning and distance-based air absorption, with a voice budget so full-auto fire can
never melt the audio graph.

### The maps

All three maps are subclasses of `LevelBuilder`, share the same helpers (`box`, `prop`, `sign`,
`pedestalRow`, `buildDustField`, `buildSkyAndSun`) and are hot-swappable at runtime with `M` or from the
menu. Swapping tears down the collision world, the score session and every level-owned GPU resource, then
rebuilds — the player, weapons and HUD simply re-point.

### The shooting range
- Five lanes: close-quarters steel, a pistol/SMG progression with a penetration demo, a centre precision
  lane with a clear alley to a 100 m gong, a moving-target lane, and a long-range lane out to 150 m.
- Six target types: paper bullseyes with 10-ring scoring, humanoid silhouettes that absorb damage and
  **topple backwards under gravity before springing upright again**, swinging steel plates, knock-down
  poppers, rail-mounted movers, and long-range gongs.
- Ten weapon pedestals, an ammo resupply crate, distance markers, cover props and a covered firing line.
- Scoring, live accuracy, and a timed drill (`K`) with a persisted personal best.

### The circuit

- A closed race track generated from a single spline. Sampling it once and offsetting the samples
  sideways produces every ribbon the map needs: asphalt, white edge lines, gravel run-off, armco rails
  and catch fencing — so the layout is defined in exactly one place.
- Kerbing is laid **only where the circuit is actually turning**, on the inside of every corner and both
  sides of the tight ones; tyre walls stack up on the outside of the fastest corners.
- Start/finish chequer, staggered grid boxes, a start gantry with a five-light sequence that runs on a
  loop, braking boards, marshal posts, sponsor hoardings, a 12-row grandstand and a timing tower.
- A pit lane with a chequered pit wall, timing stands, marked pit boxes, tyre sets, fuel rigs and wheel
  guns; behind it a paddock of transporters and freight containers, and floodlight masts.
- A three-bay garage holding the vehicles, with workbenches, tool chests, pegboards, tyre racks, trolley
  jacks, axle stands, drums, hose reels and the weapon pedestals along the back wall.
- A service-road gunnery range east of the pits — benches, five lanes, distance markers and a stop butt —
  so the scoring, drills and every weapon still have somewhere to work.

### The Thor

`src/world/Thor.ts` builds a Terran heavy assault mech in the mould of StarCraft II's Thor, and it is
pilotable: it walks, twists its torso to track your aim, and shoots. There is one on a marked hardstand on
the range and another on the circuit.

The silhouette is what carries the design: a small head with a glowing visor sunk between enormous
hazard-striped pauldrons, a deep slab-sided chest wearing the Terran skull-and-wings roundel, stubby arms
carrying twin cannons longer than the torso, shoulder missile pods, exhaust stacks over the engine deck,
and wide splayed three-toed feet. Everything else is greebles — bolt rows, hydraulic rams with polished
rods, cooling shrouds, ammo feeds, radiator fins.

Almost nothing on it is static, so the hierarchy is the model:

```
root ─ pelvis
     ├ legs[2] ─ hip pivot ─ knee pivot ─ ankle pivot ─ foot
     └ torso (twists about Y)
           └ arms (elevate about X) ─ twin cannon assemblies
```

- **The walk cycle is driven by distance travelled, not by time**, so the legs always match the ground
  whatever the speed does and the feet never skate. Each leg swings through the first half of its cycle
  and pushes through the second; the ankle subtracts its parents' angles so the sole stays flat however
  the leg is folded; the body dips once per footfall, and each plant kicks dust, thumps and shakes the
  camera.
- **The torso twist is limited** relative to the chassis, so anything behind you means turning the legs.
- **Arm cannons** are hitscan and go through exactly the same raycast, impact and scoring path as a rifle
  shot. They converge on whatever the camera is looking at rather than firing along the barrel axis —
  the guns sit seven metres up and two metres out, so a barrel-axis shot would sail far over the
  crosshair.
- **Javelin salvo** on `Mouse 2`: six missiles out of the shoulder pods, each on the same ballistic path
  and explosion handling as a tank shell.

### The vehicles

`src/world/Vehicles.ts` builds three vehicles from primitives, each with its origin on the ground and its
nose pointing `+Z`. Bodies are **lofted** rather than boxed: `loft()` skins a list of rectangular
cross-sections, which is what lets a wedge-shaped hypercar nose, a boxy jeep tub and a sloped tank glacis
all come out of the same sixty lines. Roll cages, bull bars and tow cables are swept tubes.

- **Hypercar** — lofted wedge body with a separate glass canopy, carbon floor, splitter, dive planes,
  side skirts and a five-strake diffuser; swan-neck rear wing; quad exhausts; a full-width light bar;
  exposed engine bay under slatted louvres; door livery; mirrors on slim stalks; arch lips; and
  five-twin-spoke wheels with carbon discs and calipers.
- **4x4** — separate chassis rails, live axles, leaf springs and dampers; seven-slot grille with round
  lamps in chrome bezels; bull bar with a winch; a swept-tube roll cage with a canvas roof and a light
  bar; snorkel; jerry cans, shovel and axe; spare wheel on a swing-out carrier; rock sliders and fender
  flares; a modelled interior with seats, dash, instruments and a steering wheel; and chunky staggered
  tread blocks on steel wheels.
- **Main battle tank** — sloped-glacis hull with sponsons and six hinged skirt plates a side; drive
  sprocket with teeth, idler, seven doubled road wheels on swing arms, three return rollers, and a
  **closed band of ~120 track links** generated along the running-gear path; faceted turret with mantlet,
  thermal sleeve, fume extractor and muzzle brake, commander's cupola with vision blocks and a pintle MG,
  smoke-grenade launchers, a rear stowage basket, tow cables, spare track links and antennas.

All three are drivable. `VehicleSystem` owns them: the hull is flattened to one mesh per material, while
the wheels (steer pivot + spin node) and the tank's turret and gun trunnion stay live. A parked vehicle
holds a collider so you bump into it; the one you are driving has that collider emptied, because it must
not collide with itself.

The driving model is arcade rather than simulation — a single forward speed scalar plus a yaw, with no
solver. Wheeled vehicles turn on a bicycle model (yaw rate = speed · tan(steer) / wheelbase) with steering
authority that decays with speed; the tank skid-steers and can pivot on the spot. Everything moves through
the same AABB collision world via `CollisionWorld.moveBox`, with a step height generous enough to ride
kerbs and the garage threshold. Balance lives in one object per vehicle in
`src/vehicles/VehicleConfigs.ts`.

**Lap timing.** The circuit exposes a `LapCourse` — a start/finish line plus three checkpoints. A lap
counts only when you cross the line in the racing direction *having passed every checkpoint*, so it can
neither be gamed by shuffling over the line nor by cutting the infield. Current, last and best lap are on
the dash.

**The tank's gun.** `Mouse 1` fires a shell with a real muzzle velocity and gravity; it is traced against
the world each step, and on impact it goes through the same explosion path as a frag grenade — blast
falloff, line-of-sight checks and all. Reload is gated and shown on the dash.

### The model studio

A test scene for looking at models, built the way the industry builds one. Three showpieces on lit
turntables, a reference wall to judge them against, and a texture inspector to diagnose them with.

**The showpieces.** Six, chosen so each one breaks something the others do not.
- **Meridian GT-9**, a mid-engine supercar. Twelve lofted body sections with chamfered, tumblehome
  cross-sections; metallic base coat under a `clearcoat` layer with its own near-zero roughness and a
  sparse flake normal map; tinted transmissive glazing; carbon aero with `anisotropy`; ten-spoke painted
  alloys over cross-drilled discs and red calipers; shut lines, arch flares, tyre sidewall lettering.
- **Halden 3-seat sofa**. `sheen` upholstery over a procedural weave, button tufting, welt cord, top
  stitching, and splayed oiled-walnut legs with brass ferrules.
- **Coldline CF-90 fridge**, which **opens** — walk up and press `E`. Both doors swing on their real
  hinge lines, the freezer drawer slides, the interior lamp fades up, and inside there are glass shelves,
  crispers, door bins and groceries. Anisotropic brushed steel outside.
- **A monstera in a terracotta pot** — the organic one. Each leaf is a single alpha-cut quad: the splits
  and holes *are* the model, since they cannot be geometry at this budget. `alphaTest` rather than
  `transparent` keeps them in the opaque pass with no sort order to get wrong, and three.js compiles a
  matching depth variant on its own so the shadows are cut out too.
- **A Halden No.5 typewriter**, which **types** — press `E` and a key goes down, its typebar swings up to
  the platen, and *then* the carriage steps left; at the end of the line it returns. It is here for the
  material, though: chipped enamel over bare steel with grime in the crinkle, which is the one thing
  every other piece in the room is not. Its forty keytops share one geometry, one material and one
  texture, each glyph selected by baked UVs out of an atlas.
- **Cut-crystal decanter, tumblers and a pour** — almost no geometry, entirely a shading test:
  `attenuationColor` and `attenuationDistance` (Beer-Lambert absorption through the volume, so the belly
  is deep amber and the shoulder pale from one flat parameter) plus `dispersion`.

**The rig.** Three `RectAreaLight` softboxes as key / fill / rim, each with its visible panel, frame and
stand; a dim directional light purely to put contact shadows back (area lights cast none); optional
practical spots over each plinth; and a coved cyclorama so there is no floor-to-wall seam.

**The reference wall.** A nine-step roughness sweep at metalness 0 and another at metalness 1; a row of
six balls each isolating one `MeshPhysicalMaterial` feature — clearcoat, sheen, anisotropy, iridescence,
transmission, specular tint; an eleven-step greyscale wedge and an eight-patch colour checker for
exposure and white balance; and a 1.8 m figure for scale.

**The map inspector.** For each surface — carbon fibre, brushed steel, upholstery, walnut, worn enamel,
terracotta — its albedo,
normal and packed ORM shown unlit and side by side, next to a sphere wearing the full set. This is the
panel you actually diagnose a broken texture on: a roughness channel that has saturated to white, or a
normal map that has been tagged as colour, is obvious here and invisible on the model.

### Scene and lighting
No ray tracing — everything is conventional forward rendering, tuned so the space reads as a real place:
- Sun placed *behind* the firing line so the shooter never stares into it, plus hemisphere, ambient and a
  bounce light standing in for the concrete pad.
- Four strong overhead lamps carry the covered bay, with a second bank on the higher presets; the dozens
  of emissive strip fixtures above them are geometry, not lights.
- Additive light shafts under the fixtures and GPU-animated dust motes drifting through the bay.
- Dense scenery: roof trusses, corrugated decking, cable trays and conduit, a glazed range-control booth,
  wall posters, benches with kit laid out, brass buckets, a tool cart, ammo crates, sandbags, Jersey
  barriers, tyre stacks, pallets, drums, cones, a derelict vehicle hulk, a perimeter chain-link fence,
  a treeline and a distant ridge line.

### UI
- DOM HUD: a dynamic crosshair whose gap is derived from the *actual* spread cone in screen pixels,
  ammo, fire mode, health/stamina, loadout, hitmarkers, floating damage numbers, event log, prompts,
  damage vignette and a live FPS/draw-call/triangle counter.
- Sniper scope overlay with a mil-dot ladder.
- Start screen, pause screen with persisted settings (sensitivity, ADS sensitivity scale, FOV, view bob,
  volumes, quality preset, invert Y, toggle ADS/crouch, crosshair, damage numbers, FPS), and a death screen.
- Three quality presets that drive pixel ratio, shadows, bloom, SMAA, particle counts and dynamic lights.

---

## Project structure

```
src/
├── main.ts                     Entry point + WebGL capability check
├── core/
│   ├── Game.ts                 Orchestrator, frame loop, input mapping, shot handling
│   ├── RenderPipeline.ts       Renderer, EffectComposer, view-model pass, quality presets
│   ├── Input.ts                Keyboard/mouse with pointer lock and per-frame edges
│   ├── Settings.ts             Persisted user settings
│   └── MathUtils.ts            damp/lerp/clamp, springs, noise
├── physics/
│   └── CollisionWorld.ts       Static AABB world, swept AABB character movement, step-up
├── player/
│   ├── Player.ts               Movement, stances, stamina, health, footsteps
│   ├── CameraController.ts     First/third person placement, recoil, bob, shake, FOV
│   ├── ViewModel.ts            First-person weapon scene + procedural animation
│   └── CharacterModel.ts       Third-person humanoid, walk cycle, two-bone IK arms
├── vehicles/
│   ├── VehicleConfigs.ts       Driving balance, one object per vehicle
│   ├── VehicleSystem.ts        Driving physics, enter/exit, turret, shells
│   └── LapTimer.ts             Checkpoint-gated lap counting
├── weapons/
│   ├── WeaponTypes.ts          The config schema — every tunable lives here
│   ├── WeaponConfigs.ts        The ten weapons' balance data
│   ├── WeaponMeshes.ts         Procedural weapon geometry + named anchors
│   ├── WeaponSystem.ts         Loadout, firing state machine, spread, recoil, ballistics
│   ├── ThrowableConfigs.ts     Grenade data + procedural grenade models
│   └── ThrowableSystem.ts      Cook/throw state machine, projectile physics
├── fx/
│   ├── EffectsSystem.ts        Flashes, tracers, impacts, decals, brass, explosions
│   └── ParticleSystem.ts       Pooled GPU point particles
├── audio/
│   └── AudioEngine.ts          Fully procedural WebAudio sound
├── world/
│   ├── LevelBuilder.ts         Shared level scaffolding: box/prop/sign helpers, sky, dust, pedestals
│   ├── ShootingRange.ts        The range: firing line, lanes, targets, props
│   ├── RaceTrack.ts            The circuit: spline-driven track, pit lane, garage, gunnery range
│   ├── ModelKit.ts             Modelling primitives shared by every hand-built machine
│   ├── VehicleMaterials.ts     Cached materials for the vehicles
│   ├── Vehicles.ts             Lofted hypercar / 4x4 / tank models
│   ├── Thor.ts                 Walking Terran assault mech
│   ├── StudioLevel.ts          The model studio: light rig, reference charts, map inspector
│   ├── Showpieces.ts           The six studio models: car, sofa, fridge, plant, typewriter, glassware
│   ├── PbrSurface.ts           Procedural albedo / normal / packed-ORM authoring, single and layered
│   ├── Targets.ts              Reactive range targets and scoring
│   ├── RangeSession.ts         Score, accuracy, timed drill
│   ├── GeometryMerge.ts        Static batching so scenery density stays cheap
│   └── Materials.ts            Procedural textures and shared materials
└── ui/
    ├── HUD.ts                  In-game overlay
    ├── Menu.ts                 Start / pause / settings / death screens
    └── styles.css              All HUD and menu styling
```

---

## Extending it

### Add a weapon

1. Add an id to `WeaponId` in `src/weapons/WeaponTypes.ts`.
2. Add a `WeaponConfig` in `src/weapons/WeaponConfigs.ts` and register it in `WEAPON_CONFIGS` /
   `WEAPON_ORDER`. Every gameplay number the systems read lives in that one object.
3. Add a builder in `src/weapons/WeaponMeshes.ts` returning a `WeaponModel` with the named anchors
   (`muzzle`, `sight`, `ejectPort`, `gripAnchor`, `foreAnchor`, and optionally `magazine`, `slide`,
   `charging`, `scopeLens`).

Nothing else needs to change: the view model derives its hip depth and ADS pose from the model's bounds
and its `sight` anchor, the third-person character IKs both hands onto `gripAnchor` / `foreAnchor`, and the
HUD, pedestals and slot keys all read `WEAPON_ORDER`.

### Add a throwable

Add an id to `ThrowableId` and a config to `THROWABLE_CONFIGS` in
`src/weapons/ThrowableConfigs.ts`, extend `buildThrowable()` with its model, then handle the new payload
in `Game.onDetonate()`. The cook/throw state machine, physics and HUD are payload-agnostic.

### Use real art instead of primitives

`buildWeaponModel()` is the only place weapon geometry is created. Swap it for a `GLTFLoader` call and
tag the equivalent nodes as the anchors above — the rest of the codebase talks only to anchors.
The same applies to `CharacterModel`: replace the primitive rig with a skinned mesh and drive the same
joints.

### Add a target

`new RangeTarget({ kind, position, ... })` in `ShootingRange.buildTargets()`. Add a new `TargetKind` by
writing a `buildX()` method, tagging its meshes with `tag(mesh, zone, surface)` and adding a case to
`registerHit()` / `update()`.

### Change or add a level

Levels subclass `LevelBuilder` (`src/world/LevelBuilder.ts`) and implement `build(): LevelBuildResult`.
The `box()` helper adds a mesh, registers a collision AABB and adds it to the shooting raycast list in
one call, so new geometry is fully wired up by construction. Surfaces are tagged with
`userData.surface`, which drives impact FX, impact audio and footstep sounds.

To add a map: add an id to `LevelId` and an entry to `LEVELS`, write the builder, and add a case to
`Game.buildLevel()`. Everything else — the menu picker, the `M` key, teardown and rebuild — follows from
`LEVELS`.

Two things worth knowing before you build a large outdoor level:

- **Batch aggressively.** Queue static geometry through `box`/`prop`/`propObject` and call `flushBatch()`
  at the end of `build()`. The circuit is ~800 primitives and lands at roughly 550 draw calls including
  everything else on screen.
- **Watch the collider count, not the triangle count.** Collision is AABB-only and linear, so a long
  diagonal wall must not become one hugely inflated box. `RaceTrack.barrierColliders()` shows the
  approach: walk the polyline and emit one collider per run of near-constant heading.

### Add a vehicle

1. Add an id to `VehicleId` in `src/world/Vehicles.ts` and a builder returning a `VehicleBuildResult`.
   Build it nose-`+Z` with the origin on the ground; `loft()`, `tube()`, `axle()`, `bothSides()` and
   `buildWheel()` cover most of what a vehicle needs. Hang the wheels with `mountWheel()` so they end up
   in `parts.wheels` with a steer pivot and a spin node.
2. Add a `VehicleConfig` in `src/vehicles/VehicleConfigs.ts`. Give it a `cannon` block if it should shoot.
3. Add a spawn to the level's `vehicleSpawns`.

Nothing else changes: enter/exit, the dash, the chase camera and lap timing all read from the config and
the parts.

Two things to get right when modelling one:

- **Wind the hull outward.** `loft()` walks each cross-section before stepping to the next one for exactly
  this reason — the obvious ordering winds every side inward, back-face culling then removes the surfaces
  facing the viewer, and you see straight through the vehicle to the inside of its far wall. The end caps
  use a different ordering and stay correct, which makes it easy to miss.
- **An open cockpit has to actually be open.** Model the tub as a solid body whose top surface *is* the
  floor and add the sides back as separate panels. A closed loft that merely looks open because its roof
  is being culled will seal the interior in the moment the winding is fixed.

### Tune the feel

- Movement: `DEFAULT_PLAYER_CONFIG` in `src/player/Player.ts`.
- Camera: constants at the top of `src/player/CameraController.ts`.
- View model poses: `HIP_POSITION`, `SPRINT_ROTATION`, `STOCK_CLEARANCE` in `src/player/ViewModel.ts`.
- Rendering: `QUALITY_PRESETS` in `src/core/RenderPipeline.ts`.

---

## Implementation notes

**View-model rendering.** The first-person weapon lives in its own `THREE.Scene` with its own camera and
lighting, composited over the world by a custom `ViewModelPass` that binds the render target *then*
clears depth. (`RenderPass.clearDepth` clears before it binds its target, which is unreliable when it is
not the first pass.)

**ADS alignment is automatic.** On equip, the view model reads the world-space position of the weapon's
`sight` anchor while the model is at identity, then solves the pose that places that point exactly on the
screen-centre axis. New weapon art needs no hand-tuned ADS offsets. The same bounds check derives how far
forward the gun must sit so the stock never crosses the near plane.

**Aim authority.** `CameraController.aimYaw/aimPitch` (player look + recoil) are what shots are traced
along. Bob, shake, lean and strafe roll are applied afterwards and are purely cosmetic. In third person,
the camera raycasts to find the aim point and the shot is traced from the character's muzzle toward it,
so the crosshair stays honest without letting you shoot from behind cover.

**Frame ordering.** Input → player physics → camera → weapons → view model / character → FX → HUD. The
camera is placed *before* the weapons run so a shot fired this frame uses this frame's aim.

**Static batching.** The level is authored as hundreds of small primitives, then merged per material into
a couple of dozen meshes by `StaticBatcher` before the first frame. The surface tag is part of the batch
key so a merged mesh still reports the right material for impact effects and footsteps, and front-face-only
raycasting means a round entering a solid box never registers a second hit on the way out — so penetration
is unaffected. Target furniture and the pedestal display weapons go through the same path. Without it the
prop density above would cost well over two thousand draw calls.

**Depth precision.** `EffectComposer`'s default render target allocates a *16-bit* depth renderbuffer,
which across a 2000 m far plane is not enough to keep a track ribbon, its run-off and the terrain apart —
they z-fight within tens of metres. The composer is therefore given a target with `stencilBuffer: true`,
which gets a `DEPTH24_STENCIL8` attachment instead. Worth knowing before you author any large, flat,
layered outdoor geometry.

**Sky and bloom.** `Sky` writes physical radiance, comfortably above 1.0 across the whole upper half of
the screen. Tone mapping copes, but bloom runs *before* it, so an unmodified sky dome hands the bloom pass
a full-screen over-bright source and the result is a milky veil over everything. `LevelBuilder` splices a
Reinhard roll-off into the sky shader whose asymptote sits below the bloom threshold: the gradient
survives, no sky pixel ever reaches the high-pass, and muzzle flashes and emissives are untouched.

**Sun placement.** A directional light's direction is `position - target`, so anchoring the sun at a fixed
world offset while its shadow target sits a hundred metres away silently flattens the sun elevation.
`buildSkyAndSun` places the sun *relative to its target*, which is why a level can ask for a 46 degree sun
and get one.

**PBR authoring.** `PbrSurface` generates metallic-roughness sets on a canvas — albedo in sRGB, a
tangent-space normal derived from a height field by central differences, and **occlusion, roughness and
metalness packed into the R, G and B channels of one texture**. That packing is the glTF convention and
three.js reads exactly those channels (`aomap_fragment` takes `.r`, `roughnessmap_fragment` `.g`,
`metalnessmap_fragment` `.b`), so one sample and one upload serve all three maps. The map factors
*multiply* the material scalars, which is why `applySurface` sets `roughness = metalness = 1` — leaving
them at their defaults silently halves the metalness of every metal.

Three things that are easy to get wrong and hard to see:

- **Normal strength is not a taste knob.** It is the slope in height units per texel, and the central
  difference already spans two texels. A value of 10 asks for an 83 degree facet on every thread of a
  weave — carbon that renders as a mirrorball. Calibrate against the real feature size.
- **Stacked semi-transparent strokes are a one-way ratchet.** Painting a channel by laying down many
  white scratches at low alpha drives it to white whatever the base was; brushed steel authored that way
  came out at roughness 0.9. Draw half the scratches dark so the mean stays where you put it.
- **Data maps are not colour maps.** Normal and ORM textures must be linear on the material. The
  inspector deliberately does the opposite and tags its previews sRGB, because there the goal is to show
  the bytes: the shader decodes and the output pass re-encodes, so the texel survives the round trip.

**Image-based lighting.** `PMREMGenerator.fromScene(new RoomEnvironment())` prefilters a studio interior
into a radiance map with the mip chain that lets a material sample the right blur for its roughness.
Clearcoat, sheen, anisotropy, iridescence and transmission are all reflection effects — without an
environment they have nothing to reflect and collapse to flat shading however good the textures are.
`RenderPipeline.setEnvironment` builds it per level and the level asks for its own intensity. Treat that
intensity as a light: at 1.0 the studio's white-lined fridge interior renders past the bloom threshold
with every lamp in the room switched off.

**Exposure discipline in a bright room.** Post-processing runs before tone mapping, so *any* diffuse
surface whose radiance passes bloom's 1.0 high-pass smears a veil over the whole frame — the same failure
as the sky dome above, but from a white wall. A studio is mostly large pale surfaces, so its cyclorama is
painted a mid grey, its rig is set by measurement rather than by eye, and its light panels are tone
mapped. Turning the lights *up* past that point does not make the image brighter, only milkier.

**Area lights point the other way.** `Object3D.lookAt` aims local **-Z** at the target for lights and
cameras but local **+Z** for everything else, and a `RectAreaLight` emits along that same -Z. Copying a
light's quaternion onto the plane that represents it therefore faces the lit side away from the subject
and buries it behind its own frame. `RectAreaLight` also needs `RectAreaLightUniformsLib.init()`, only
lights Standard and Physical materials, and casts no shadows at all.

**Layered materials.** A used object is not one material with a dirt texture on it, it is a stack:
steel, enamel over most of it, grime settled into whatever the enamel did not cover. `layeredSurface`
blends two complete layers through a mask, and blends *every* channel — a chip has to change the colour
and the roughness and the metalness at once, because getting only the first gives you a decal of a chip
rather than a chip. Real edge wear follows the mesh's curvature and is baked from a high-poly source; a
tiling texture has no idea where the model's edges are, so `chipMask` does what a texture artist does
instead and scatters ragged-edged flakes. Hard edges, because a soft-edged blob reads as a stain.

Two calibration notes, both learned the expensive way: a hundred small chips read as granite, and cutting
the count alone made the wear invisible — *size* is what separates worn from noisy. And the chart is
where you see it. On the ORM panel a chip is a hole where G and B jump from rough dielectric to smooth
metal; on the albedo panel alone it is just a light speck, and a fake would look identical.

**Absorption, and why the textbook model does not render.** Volumetric colour comes from
`attenuationColor` with `attenuationDistance` — Beer-Lambert, so the tint deepens with the path length
and one flat parameter gives you a pale rim and a deep middle. The reference wall's ABSORPTION ball is
the control that proves it works.

The obvious way to model a decanter is a liquid shell at IOR 1.36 nested inside a glass shell at 1.55.
That renders as *nothing*: three.js transmission refracts a backdrop containing only the **opaque**
scene, so a transmissive volume inside another transmissive volume is in nobody's backdrop and is simply
invisible — measured, the pour came out neutral grey while the same absorption on a free-standing ball
came out amber. Each vessel is therefore two stacked solids split at the fill line: one volume carrying
the whisky's absorption below, a hollow crystal shell above. That is what the eye receives anyway, since
glass-whisky-glass reads as one amber body, and it survives a renderer that only refracts once. The
limit that remains is real: nothing refracts twice, so a tumbler seen through the decanter does not bend.

**A refractive exhibit picks up its surroundings.** Every other plinth in the studio wears a glowing cyan
rim. Under the crystal it made the pour render green — measured at (111,183,111) — because saturated cyan
seen through amber absorption *is* green. The renderer was right and the set dressing was wrong; the ring
is simply omitted there, which is also what a real studio does with coloured practicals near glassware.

**Performance.** ~550-700 draw calls and ~190k triangles on the range; ~700-900 and ~600k on the circuit
with the pit complex, all three vehicles and half the track in frame. Comfortable on any discrete GPU or a
modern integrated one; ~700-1300 and ~340k in the studio, where the cost is materials rather than
geometry. Lighting is deliberately restrained — a forward renderer pays for every light on
every lit pixel, so the range bay is lit by four strong lamps rather than one per fixture, and the garage
by two per bay. If you need more headroom, drop the quality preset: it disables bloom, SMAA, shadows, the
second lamp bank, the floodlights and the atmospherics, and halves particle counts.

---

## License

MIT — see [LICENSE](LICENSE).
