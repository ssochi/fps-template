# M17 — Legible: a face, a heading, and a cutaway that stops at the roof

**Status:** ✅ Complete
**Slice:** the three things the second playtest reported.

## Goal

> 操作起来还是非常别扭 朝向控制，已经人物正面和反面都是一样的没有脸，然后透视
> 还需要优化，研究僵尸毁灭工程机制，面前的门窗子不能透视啊，应该只是透视头顶的
> 东西。

Three reports, and the first two are the same report:

1. **The facing controls feel awkward.**
2. **The character's front and back are identical — there is no face.**
3. **The cutaway is wrong: the door and window in front of you must not be
   x-rayed. It should only x-ray the things above your head.**

## The decisions worth recording

**The facing was never broken. It was invisible.** M14 changed the body to turn
toward travel and that change was correct — but the rig had a head that was a
plain box, so the front and the back of a survivor were the same silhouette and
there was no way at all to tell which way they were pointing. No amount of
control tuning fixes a body with no front. Three marks, all cheap and all chosen
to read at a hundred pixels tall: **hair that stops at the hairline** instead of
wrapping the skull, **two dark eyes**, and **a collar**. The horde shares the
rig, so the dead get faces too — and a direction you can read before they reach
you.

Plus a **heading notch on the ground ring**, because the face stops reading two
zoom steps out and the ring does not. The marker is a child of the entity, so it
inherits the yaw with nothing to keep in sync.

**The cutaway now stops at the roof.** M15 dissolved everything nearer to the
camera than the player, and the report is right that this is worse than the
problem it solved: a facade you cannot *read* is less useful than one you cannot
see past. A door is 2.05 m and a wall is 2.6 m, so the fade now begins at 2.12 m
— deliberately above the door head, with a test asserting the gap. What gets
taken is the roof, the storey above, and the top strip of the near wall, which
at a 31° pitch is exactly the geometry that covers a standing body. Everything a
player needs to read stays put. Measured from the storey the survivor is
standing on, so going upstairs takes the ceiling with them rather than the roof
two floors up.

**And that promoted the silhouette from a fallback to the main event.** With the
cutaway stopping at head height, a survivor behind a low wall is hidden by it —
so the silhouette is now how you see yourself, and two static boxes was not
enough. It is now the **body's own animated geometry**, drawn again: each large
part gets a sibling mesh sharing its geometry, added as a *child* so it inherits
the animated world matrix for free.

**The depth buffer is the wrong place to ask "is this occluded".** This is the
finding worth keeping. M14 and M15 both used `depthFunc = GreaterDepth` on a
mesh sharing the body's geometry — draw it only where something is already in
front of it, no raycast, the depth buffer already knows. It is a lovely trick
and it does not survive contact with a second shader program: the body is
Lambert, the ghost was Basic, and **GLSL makes no promise that two programs
computing the same transform agree in the last bit.** Without
`invariant gl_Position` the comparison is a per-pixel coin flip. The screenshot
showed a survivor painted cyan while standing in plain sight, and the render
order was provably correct, a matching material class did not fix it, and a
polygon offset did not fix it.

The game already knew the answer. `sim/Sight.js` has been casting rays across
this grid since M4; casting one from the survivor toward the camera is a handful
of tile lookups and it is *exact*. Occlusion is now decided on the CPU by the
same code the horde's eyes use, and the shader does nothing clever at all.

## Iteration passes

1. **Face, notch and the height-limited cutaway.**
2. **The silhouette recursed into a stack overflow.** Attaching a ghost during
   `traverse` means the walk visits it, and a ghost shares its host's geometry —
   so it passes the same size test, gets a ghost of its own, for ever. It took
   out all 411 tests at once, which is at least a clear signal. Collect first,
   attach second.
3. **The ghost painted a visible survivor cyan.** Swapping the draw order did
   not fix it; nor did matching the material class; nor did a polygon offset. A
   runtime probe confirmed the render state was exactly as intended, which is
   what pointed at shader-program invariance rather than at the ordering.
4. **Replaced the whole trick with a line-of-sight cast**, and it worked
   first time.

## Verification

- **422 unit tests** (up from 416). New: the silhouette mirroring the body
  without recursing, sharing geometry so it animates for free, and skipping
  parts too small to read; the draw order; the cutaway starting above a doorway
  and below the top of a wall, and measured from the storey you are on; and the
  occlusion predicate saying no on an empty street, yes behind a wall, yes under
  a ceiling, and **changing its mind when the camera turns**.
- **Screenshot gate:** twenty-one images. `07-character-idle` shows a survivor
  with a face and a heading notch and *no* cyan wash; `03-close` shows the
  animated silhouette through a wall with the roof dissolved above it.

## Known gaps

- **The silhouette is all-or-nothing.** One ray decides it, so a survivor half
  behind a doorframe is either fully ghosted or not at all.
- **The horde has faces but no silhouette.** A zombie behind a wall is still
  invisible, which is what the fog of war is for, but the reference game's
  players ask for outlines and they may be right.
- **`OCCLUSION_PROBE` is six tiles and a constant.** At the widest zoom a
  building further away than that can still cover you.
- **The cutaway is still a circle**, not a wall segment. The reference game
  fades whole pieces of architecture, which reads better; a circle is more
  predictable, which is the trade this milestone kept.

## Verdict

Three milestones in a row driven by someone playing the game, and this one
produced the most reusable lesson of the three: **a clever trick that cannot be
verified is worse than a plain one that can.** The `GreaterDepth` silhouette was
elegant, cost nothing, and was wrong in a way that took a runtime probe and four
attempts to pin down. The line-of-sight version is six grid lookups, has five
unit tests, and worked immediately.
