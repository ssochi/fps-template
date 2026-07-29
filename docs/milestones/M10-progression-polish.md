# M10 — Progression & polish

**Status:** ✅ Complete — **closes cycle 1**
**Slice:** skills and XP, procedural audio, hit feedback, the death report's
record of the run, restart, and save/load.

## Goal

Close the cycle. Worked from the accumulated *known gaps* lists rather than from
the blueprint, per the note at the end of M9 — those lists are specific and they
compound, where the blueprint had drifted into being a statement of intent.

## What was built

| Area | File | Note |
| --- | --- | --- |
| Skills | `sim/Skills.js` | Seven skills, XP from doing, each with an effect |
| Audio | `audio/Audio.js` | Synthesised; no files anywhere in the repo |
| Saving | `save/Save.js` | Seed plus deltas, into IndexedDB |
| Hit feedback | `sim/Horde.js` | Per-instance flash on a landed blow |
| Death report | `ui/Hud.js` | What you learned, and a restart button |

## The decisions worth recording

**You get better at what you do, not at what you chose.** No skill tree, nothing
to spend. Swinging a bat raises Blunt, boarding windows raises Carpentry,
searching containers raises Scavenging. The character sheet becomes a *record of
how you played* rather than a plan committed to in a menu on day one — and that
is why it belongs on the death screen.

**Every skill changes a number some other system already reads.** The same rule
the moodles are held to, and it kept the list to seven. Each is a plain
multiplier so callers never have to know the curve, and there is a test per
effect.

**XP is awarded from the event bus, not at call sites.** Crafting, treating a
wound and building a barricade all already emitted events, so progression needed
no bookkeeping sprinkled through those systems. The same bus now drives audio.

**Audio is synthesised, not sampled.** "Procedural everything" applies as much
here as to the geometry — there are no audio files. More usefully, it means every
sound is *parameterised by the thing that made it*: a zombie's groan is pitched
by which zombie it is, so a crowd sounds like a crowd rather than one clip played
thirty times. Everything is panned and attenuated by world position, because what
the player needs from audio in this genre is *where* and *how many*.

**Footsteps advance with distance, not time** — the same reason the gait does.
A sound that lands on a timer instead of on the footfall is worse than no sound.
And sneaking is silent, which is the entire point of sneaking.

**A save is the seed plus what you changed.** A third of a million cells
regenerate identically from six characters, so the payload is doors, barricades,
opened containers and downed zombies — a few kilobytes. This only works because
M8's loot was made lazy and seed-derived at the time, which is the payoff for a
decision made two milestones earlier.

**Fog of war is deliberately not saved.** It is knowledge the *player* has, not
state the world has. Storing it would be a third of a million bytes to avoid
re-revealing a map as you walk it.

**Restarting clears the save.** A run is permanent; reloading into the corpse you
just made would undo the only thing permadeath is for.

## Iteration passes

1. **Skills, audio, saving and hit feedback built; all green.**
2. **Audio had to be safe before it could exist.** Browsers refuse to start an
   `AudioContext` outside a user gesture, so every method is callable from boot
   and silently does nothing until the first click. Tested by calling all of them
   in Node, where there is no Web Audio at all.
3. **Rate-limited the crowd.** The first version let every zombie groan, which in
   a horde of 260 is a wall of noise and hundreds of oscillators. Now a short
   budget per sound type, and ambient groans pick the nearest few.
4. **The death report gained the run's history.** Cause and duration alone read
   as a failure notice; the skills you built read as a story.

## Verification

- **286 unit tests** (up from 262). New coverage: skills starting at zero, an
  early-fast/late-slow curve, levelling from doing, capping, progress reporting,
  ignoring unknown skills, weapon-to-skill routing, blade training not improving
  a bat, every effect multiplier moving in the right direction and never reaching
  zero, JSON round-tripping, and every summary entry being explainable; audio
  being safe before its context exists, disabling itself where Web Audio is
  absent, and clamping volume; saves storing the seed rather than the world,
  recording only changed cells, recording the downed, carrying the player
  faithfully, *not* storing fog of war, and refusing snapshots from another
  version or none at all.
- **Screenshot gate:** fifteen angles, including the death report showing
  learned skills and a restart button.

## Numbers

260 zombies still 2 draw calls. Audio adds no per-frame cost when silent and is
budget-limited when not. A save of an explored town is a few kilobytes.

## Cycle 1: what exists now

A procedurally generated town of 23 buildings and 93 furnished rooms, rendered
isometrically with per-room cutaway and three-state fog of war. A player who
walks, sneaks, runs out of breath, opens doors, climbs, and gets hurt in
locatable ways that change what they can do. 260 zombies driven by sound and
sight, rendered in two draw calls, who chase, lose interest, break down
barricades and kill you. Loot where you would expect it, food that rots, weight
that slows you, recipes that turn it into a fortification, a clock with a day
and a night, moodles that push you outdoors, skills that record how you played,
sound that tells you where things are, and a death screen that says how it ended.

## Known gaps, carried into cycle 2

Worth listing plainly, because M11's exploration milestone should start here:

- **No character creation.** No traits, no occupation, no starting-skill choice.
  The `Skills.rate` hook exists for it and nothing uses it.
- **No zombie migration.** The horde is scattered once and never redistributes,
  so a cleared area stays cleared forever. M5 flagged this and it is now the
  largest gap in the horde's behaviour.
- **Multi-storey pathing.** The flow field and sound field are ground-floor only;
  upstairs zombies wander. Stair edges need to enter the sweep.
- **No placeable furniture or built walls** — only boarding existing openings.
- **The cutaway keys off the room you stand in**, so a doorway can flicker.
- **No shops, warehouses or civic buildings** — only houses.
- **Save/load is implemented but not exposed** — there is no menu, no autosave,
  and nothing calls it outside the debug handle.
- Torches never run out; bags do not add capacity; dismemberment is rolled but
  not rendered; zombies cannot break windows.

## Verdict

Cycle 1 is a game. Not a large one, but a complete loop: you go out because you
are thirsty, you search a house because that is where water is, you are heard,
you fight or you run, and eventually one of those goes wrong.

The pattern worth carrying forward is the one from M9 and again here: the last
three milestones have mostly been *connecting systems that already existed*
rather than building new ones. Every M10 feature landed on an event bus, a clock
or a seed that was already there. Where earlier milestones took six passes and
found real bugs, these took four and found almost none — the architecture
decisions from M0–M2 are what bought that, and they were the right ones to spend
the first three milestones on.

**M11 opens cycle 2 as a fresh Exploration milestone**, which re-surveys
everything and rewrites the blueprint. It should start from the gaps list above.
