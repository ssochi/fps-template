# Progress ledger

An Exploration milestone opens each cycle: it re-surveys the code, measures where
it breaks, reads what the reference game does, and rewrites the blueprint.

## Cycle 1 — M0 to M10 ✅

| # | Milestone | Status | Passes | Notes |
| --- | --- | --- | --- | --- |
| M0 | Exploration | ✅ Complete | 1 | Blueprint v1 published |
| M1 | Engine core & isometric camera | ✅ Complete | 7 | 46 tests; 22 draws / 8.8k tris on the test block |
| M2 | Town generation | ✅ Complete | 6 | 63 tests; 23 buildings / 93 rooms on a 104² town |
| M3 | Player & movement | ✅ Complete | 6 | 91 tests; procedural rig, endurance, doors, stairs |
| M4 | Occlusion & vision | ✅ Complete | 6 | 113 tests; per-room cutaway, LOS, 3-state fog |
| M5 | The horde | ✅ Complete | 6 | 142 tests; 260 zombies in 2 draw calls, AI 0.22 ms/400 |
| M6 | Combat & injury | ✅ Complete | 5 | 176 tests; located damage, infection, corpses |
| M7 | Survival simulation | ✅ Complete | 6 | 204 tests; clock, 7 moodles, HUD, death report |
| M8 | Inventory & looting | ✅ Complete | 4 | 240 tests; weight-based, room-keyed lazy loot |
| M9 | Crafting & base building | ✅ Complete | 4 | 262 tests; destructible barricades, torch, recipes |
| M10 | Progression & polish | ✅ Complete | 4 | 286 tests; skills, audio, saving — **closes cycle 1** |

**Cycle 1 shipped a complete short loop:** you go out because you are thirsty,
you search a house because that is where water is, you are heard, you fight or
you run, and eventually one of those goes wrong.

## Cycle 2 — M11 to M21

Thesis, from [M11's survey](./milestones/M11-exploration.md): *cycle 1 has no
answer to why day 20 is different from day 3.* Cycle 2 is ten answers. Full
reasoning in [`blueprint.md` §8](./blueprint.md).

| # | Milestone | Status | Passes | Notes |
| --- | --- | --- | --- | --- |
| M11 | Exploration (opens cycle 2) | ✅ Complete | 1 | Blueprint **v2** published; flow-field scaling wall identified; dead `Walker` class removed |
| M12 | Character creation & the main menu | ✅ Complete | 5 | 326 tests; 25 traits / 9 occupations, autosave, `main.js` 411 → 52 lines |
| M13 | The horde that moves | ✅ Complete | 6 | 357 tests; bounded 3D flow field — **flat 0.75 ms at any map size**; stairs; migration |
| M14 | **Playable** | ✅ Complete | 4 | 380 tests; 中文 UI, controls screen, a marker you can find, facing follows travel, 260 → 90 zombies |
| M15 | **X-ray** | ✅ Complete | 1 | 389 tests; screen-space occlusion cutaway — walls, roofs and furniture between the camera and you dissolve |
| M16 | Metagame events & the shutoff clock | ✅ Complete | 4 | 411 tests; water and power fail on a seeded schedule, taps run dry, the helicopter hunts |
| M17 | **Legible** | ✅ Complete | 4 | 422 tests; a face and a heading notch, the cutaway stops at the roof, occlusion decided by line of sight |
| M18 | Water, fire and food | 🟡 Next | — | Rain collectors, campfires, cooking, generators |
| M19 | Full carpentry | ⬜ Planned | — | Placeable furniture and storage, built walls, barricade repair |
| M20 | The world beyond houses | ⬜ Planned | — | Shops, warehouse, fuel station; loot tables per archetype |
| M21 | Streaming & scale | ⬜ Planned | — | 300² map, chunked simulation, mesh streaming — **closes cycle 2** |

**M22 opens cycle 3** as a fresh Exploration milestone. **Three** planned
milestones were displaced by playtest feedback (M14, M15 and M17); vehicles,
farming and meta-progression move into cycle 3.

## Notes on the process

- **The *Known gaps* section at the end of each milestone doc is the real
  backlog.** It is specific, it accumulates, and M9, M10 and M11 all worked from
  it rather than from the blueprint. The blueprint is kept short for that reason.
- **Pass counts are recorded because they are diagnostic.** Cycle 1 trended
  7 → 4 as milestones shifted from building systems to connecting them. M16–M20
  build new systems; if they land in three passes, suspect the verification
  rather than celebrate the velocity.
- **A clever trick that cannot be verified is worse than a plain one that can.**
  M17 spent four attempts on a `depthFunc = GreaterDepth` silhouette that was
  elegant, free, and wrong because two shader programs need not agree on depth
  in the last bit. The line-of-sight replacement is six grid lookups, has five
  tests, and worked immediately.
- **The two-clock convention needs a test, not another paragraph.** M6's
  bleeding, M7's panic and M16's helicopter were all rates written against the
  wrong clock, and all three read as the feature being broken. Three milestone
  docs warning about it did not stop the third.
- **A correct system can solve half a problem for fourteen milestones.** M4's
  cutaway opens the building you are *inside*; nothing ever opened the building
  you are standing *behind*, and its doc reads as complete because the half it
  built is right. Both M14 and M15 came from someone playing, not from the plan.
- **Review at least one screenshot as a player, not as a renderer.** M14 was an
  unplanned milestone built entirely from six lines of playtest feedback, and
  five of the six complaints were visible in `01-default.png` — a frame that had
  been reviewed eleven times as a *rendering* regression test and never once as
  the first thing somebody sees.
- **Look for getters nothing reads, not only exports nothing imports.** M12 found
  two effects — `Skills.noiseScale` and `Moodles.enduranceRecovery` — that had
  been computed and thrown away for two milestones. M11's dead-code survey missed
  both because they are *used* within their own class. M22's should not.
