# Knox — project docs

A browser-native isometric zombie survival sim in the mould of *Project Zomboid*:
same camera, same "this is how you died" fantasy, same simulation-first design —
but rendered in real 3D with Three.js instead of pre-rendered sprites.

## How this repo is developed

Development runs as a **milestone loop**:

1. **M0 is an Exploration milestone.** Survey the code, the reference game, the
   web, the state of the art. Write down what's missing, what's next, and build
   the blueprint.
2. Each following milestone takes one vertical slice of the blueprint and is
   iterated over multiple passes until it is genuinely good — not merely
   "it compiles".
3. When a milestone closes, the next one is cut from the blueprint.
4. **Every 10 milestones, a new Exploration milestone opens**, re-surveying
   everything and rewriting the blueprint. That is the big loop.

| Doc | Purpose |
| --- | --- |
| [`blueprint.md`](./blueprint.md) | Living architecture + design target |
| [`progress.md`](./progress.md) | Running ledger of milestones and their state |
| [`milestones/`](./milestones/) | One file per milestone: goal, passes, verdict |

## Current cycle

**Cycle 2 — M11 … M21.** Opened by [M11's
survey](./milestones/M11-exploration.md), which published
[blueprint v2](./blueprint.md).

Cycle 1 (M0 … M10) is complete: it shipped a game you can lose. Cycle 2 answers
the question that survey asked — *why is day 20 different from day 3?* — with a
world that runs down on a clock and a horde that keeps arriving.
