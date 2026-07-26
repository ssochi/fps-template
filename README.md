# Three.js FPS Template

A complete, batteries-included first/third person shooter template built with **Three.js + TypeScript + Vite**.

It ships with a full shooting range, five distinct weapons, first *and* third person cameras, procedural
weapon models, procedural character animation with IK, a pooled effects system, and a synthesized audio
engine — **with zero binary assets**. Everything (textures, models, sounds) is generated at runtime, so the
repo clones and runs instantly and works offline.

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
| `1` – `5` | Select weapon |
| `Q` | Swap to previous weapon |
| `Mouse wheel` | Cycle weapons |
| `B` | Toggle fire mode (auto / burst / semi) |
| `V` | Switch first ↔ third person |
| `F` | Inspect weapon |
| `E` | Interact — resupply ammo, take a weapon from a pedestal |
| `T` | Reset all targets |
| `G` | Start / cancel the timed drill |
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
Five weapons, each with its own handling, recoil signature, audio profile and reload style:

| Slot | Weapon | Notes |
| --- | --- | --- |
| 1 | M9 Sidearm | Semi-auto pistol, fast draw, forgiving recoil |
| 2 | MP-9 Vector | 950 RPM SMG, auto/semi, low recoil, poor range |
| 3 | AR-15 Carbine | Auto/burst/semi, red-dot optic, learnable recoil pattern |
| 4 | M40 Marksman | Bolt-action, scoped optics with a mil-dot reticle, one-shot lethal |
| 5 | M870 Breacher | Pump-action, 9-pellet buckshot, shell-by-shell reload you can interrupt to fire |

Systems behind them:
- Hitscan ballistics with per-weapon damage falloff, hit zones (head / body / limb), and **material
  penetration** — the rifle and sniper punch through the plywood wall on lane 2 to reach the plate behind it.
- Spread model combining base cone, movement, airborne, crouch and per-shot bloom, with Gaussian sampling
  for bullets and a ring-plus-jitter pattern for buckshot.
- Recoil with optional scripted patterns (the rifle and SMG have one), a random ramp past the end of the
  pattern, and a "permanence" fraction the player has to pull down manually.
- Fire modes, burst fire that completes after trigger release, bolt/pump cycle lockouts, tactical vs.
  empty reloads, dry fire, draw/holster, weapon inspect.

### Effects
- Muzzle flashes (separate view-model and world versions so nothing doubles up), dynamic muzzle lights,
  travelling tracers, spent brass with bounce physics and impact audio.
- Material-aware impacts: sparks, dust, smoke and debris chunks tuned per surface.
- Bullet-hole decals oriented to the hit surface, pooled with a fade-out recycle.
- A single-draw-call GPU particle system (CPU simulated, free-list pooled) for sparks and smoke.

### Audio
Every sound is synthesized with the WebAudio API at runtime — gunshots (noise crack + body sweep +
mid punch + reverb slap-back), mechanical actions, reload steps, footsteps, impacts by material, steel
target rings, shell drops, hitmarkers and UI blips. Sounds are positioned with manual distance
attenuation, stereo panning and distance-based air absorption, with a voice budget so full-auto fire can
never melt the audio graph.

### The range
- Five lanes: close-quarters steel, a pistol/SMG progression with a penetration demo, a centre precision
  lane with a clear alley to a 100 m gong, a moving-target lane, and a long-range lane out to 150 m.
- Six target types: paper bullseyes with 10-ring scoring, humanoid silhouettes with a head zone, swinging
  steel plates, knock-down poppers that auto-reset, rail-mounted movers, and long-range gongs.
- Weapon pedestals, an ammo resupply crate, distance markers, cover props and a covered firing line.
- Scoring, live accuracy, and a timed drill (`G`) with a persisted personal best.

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
├── weapons/
│   ├── WeaponTypes.ts          The config schema — every tunable lives here
│   ├── WeaponConfigs.ts        The five weapons' balance data
│   ├── WeaponMeshes.ts         Procedural weapon geometry + named anchors
│   └── WeaponSystem.ts         Loadout, firing state machine, spread, recoil, ballistics
├── fx/
│   ├── EffectsSystem.ts        Flashes, tracers, impacts, decals, brass
│   └── ParticleSystem.ts       Pooled GPU point particles
├── audio/
│   └── AudioEngine.ts          Fully procedural WebAudio sound
├── world/
│   ├── ShootingRange.ts        Level construction, lighting, collision registration
│   ├── Targets.ts              Reactive range targets and scoring
│   ├── RangeSession.ts         Score, accuracy, timed drill
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
and its `sight` anchor, and the third-person character IKs both hands onto `gripAnchor` / `foreAnchor`.

### Use real art instead of primitives

`buildWeaponModel()` is the only place weapon geometry is created. Swap it for a `GLTFLoader` call and
tag the equivalent nodes as the anchors above — the rest of the codebase talks only to anchors.
The same applies to `CharacterModel`: replace the primitive rig with a skinned mesh and drive the same
joints.

### Add a target

`new RangeTarget({ kind, position, ... })` in `ShootingRange.buildTargets()`. Add a new `TargetKind` by
writing a `buildX()` method, tagging its meshes with `tag(mesh, zone, surface)` and adding a case to
`registerHit()` / `update()`.

### Change the level

Everything is built in `src/world/ShootingRange.ts`. The `box()` helper adds a mesh, registers a
collision AABB and adds it to the shooting raycast list in one call, so new geometry is fully wired up by
construction. Surfaces are tagged with `userData.surface`, which drives impact FX, impact audio and
footstep sounds.

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

**Performance.** ~800 draw calls and ~100k triangles with everything on screen, which is comfortable on
any discrete GPU or modern integrated one. If you need more headroom: drop the quality preset (disables
bloom, SMAA, shadows and the roof point lights, and halves particle counts), or merge the static level
geometry per material with `BufferGeometryUtils.mergeGeometries` — most of the draw calls are small
static props and the pedestal display weapons.

---

## License

MIT — see [LICENSE](LICENSE).
