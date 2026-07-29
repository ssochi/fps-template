# M14 — Playable

**Status:** ✅ Complete
**Slice:** the six things the first playtest said were wrong.

## Goal

Cycle 2's plan had M14 as metagame events and the shutoff clock. Then someone
played the game and sent six lines:

> 1. 游戏文案支持中文
> 2. 人物怎么不在画面中心
> 3. 人物朝向移动方向
> 4. 僵尸也不会
> 5. 僵尸太多了
> 6. 完全不知道怎么操作

Every one of those is right, and together they say something the plan did not:
**the game is not legible enough to play.** A helicopter that drags the town onto
your position is worth nothing to a player who cannot find their own character,
does not know Tab opens a bag, and cannot read the interface. So the metagame
work was parked mid-file and this became the playability milestone.

Worth stating plainly because it is a process point: fourteen milestones of
screenshots did not catch any of this. I have been looking at these images as
*renders* — is the cutaway right, does the fall clip hold — and not once as
*what a player sees when they sit down*. The single frame of `01-default.png`
contained five of the six complaints and I had reviewed it eleven times.

## What was built

| Complaint | Fix | File |
| --- | --- | --- |
| 完全不知道怎么操作 | A controls screen, shown unasked on a new run | `ui/Help.js` |
| 游戏文案支持中文 | Full localisation, Chinese by default | `ui/i18n.js` |
| 人物怎么不在画面中心 | A silhouette that shows through walls, and a ring | `entity/Marker.js` |
| 人物朝向移动方向 | The body faces travel | `entity/Player.js` |
| 僵尸也不会 | Fixed a yaw snap on arrival | `sim/Horde.js` |
| 僵尸太多了 | 260 → 90, and a choice on the menu | `ui/MainMenu.js` |

## The decisions worth recording

**The character was never off-centre — it was behind a house.** The camera has
always targeted the avatar exactly. The spawn is beside a building, at this
camera angle the building is between the player and the lens, and M4's cutaway
has nothing to say about it: cutaway removes the walls of the room you are
*inside*, not a wall you are merely standing behind. The report was "not in the
centre" because the only sensible reading of an empty centre is that the
character is somewhere else.

The fix is `depthFunc = GreaterDepth`, which is the whole trick: a silhouette
rendered **only where something is already in front of it**. No occlusion test,
no raycast, no per-frame logic — the depth buffer already holds the answer and
this asks it. Invisible when you can see yourself, solid when you cannot.

It needed one more thing to work: the silhouette has to render **after the world
and before the body**, or it tests against the character's own limbs and shows
as slivers between them. That means it must be *opaque* — a transparent material
lands in three.js's transparent pass, which runs after everything opaque
including its owner — plus an explicit `renderOrder` on both.

**You face where you are going.** M3's rule was that the body tracks the cursor
so you can back away from something while still looking at it. That is a good
mechanic and it is not what the game feels like, because **the pointer starts at
the centre of the screen, which is where the player is standing**: a survivor who
has not touched the mouse spins to face a point a metre from their own feet, and
walking looks like being dragged sideways. Now: moving faces travel, standing
still faces the cursor, and a swing snaps to the cursor — which keeps the one
thing aiming was for (choosing what to hit) and drops it from the ninety percent
of the time you are walking. The backpedal penalty went with it; it was charging
for a state that can no longer occur.

**The zombies' twitch was `atan2(-0, -0)`.** They *did* face their movement — but
a zombie arriving exactly on a tile centre has a zero delta, and `atan2(0, 0)` is
0, so it snapped to due north for a frame. Across a crowd that reads as a twitch
running through it. One `if (dist < 1e-4) return`.

**Ninety, not two hundred and sixty.** A fixed 260 on a 104-tile town puts about
twenty-five on screen at the default zoom on the morning of day one. That is not
tension, it is a queue. Normal is now 90 with a sixteen-tile clear radius at the
spawn — and this is only affordable *because* M13 shipped migration: a quiet
street is now a temporary condition rather than a promise, so a lower starting
count does not mean a permanently emptier town.

**Translation is a lookup with the English as the fallback.** Every data table
already carries an English `name` used by code, tests and saves. Rewriting them
would touch all three, so `t('item.water')` returns Chinese if there is any and
the existing English otherwise. A missing translation degrades to readable
English rather than to `item.water`, and adding a language is adding one object.

The rule is enforced: `test/i18n.test.js` walks the real tables — every trait,
occupation, skill, item, weapon, recipe, moodle tier, population setting and
cause of death — and fails if any lacks a Chinese string. A game that is *mostly*
translated is worse than one that is not, because the gaps look like bugs.

**The controls screen is modal on the first run, and unapologetic about it.** The
one-line hint along the bottom edge has been there since M7 and it was never
enough: eleven-point type on a screen with a town on it, nine bindings, no
statement of what any of them are *for*, and half the game's verbs missing. A
player who does not know Tab opens a bag will not discover one by looking harder
at a street. It costs one keypress, and a game that cannot be played is worse
than a game that made you press a key.

## Iteration passes

1. **All six addressed; 380 tests green.**
2. **Two tests asserted the design that was wrong.** `faces the aim target
   rather than the direction of travel` and `moves slower backwards than
   forwards` both encoded M3's rule. They were replaced rather than fixed —
   including a new case for the exact bug: a player whose cursor has never
   moved must hold their heading.
3. **The silhouette leaked through the character's own legs.** Correct
   behaviour, bad image: the gap between the legs has no geometry to hide it and
   the ground behind is further away, so the marker showed as a glowing patch
   under a perfectly visible survivor. Fixed by the render-order change above,
   and by sizing the box to sit inside the torso.
4. **The date read `七月9 日`.** Composing a month name and a day number and
   hoping is how localisation goes wrong; it is now one format string per
   language.

## Verification

- **380 unit tests** (up from 357). New: the lookup falling back to English
  rather than to the key, substitution in both languages, an unknown language
  not blanking the interface, `?lang=` beating the browser, every variety of
  `zh` detected; **coverage of every id in every table a player reads**; no
  blank strings; item labels keeping their count and spoilage marker when
  translated; the clock formatting in both; no lookup key ever leaking into a
  label. Plus the four facing cases above.
- **Screenshot gate:** nineteen images, captured with `?lang=zh` — the
  screenshots are the only place an overflowing or mis-sized label shows.

## Numbers

**122 draw calls → 75** at the default zoom, and 43,300 triangles against
93,972, almost entirely from the population change. 90 zombies are still 2 draw
calls. The marker costs 3.

## Known gaps

- **Only Chinese and English.** The table is one object per language, so a third
  is cheap, but nothing else is written.
- **No in-game language switch** — it is `?lang=` or the browser.
- **The help screen is not context-sensitive.** It does not know you are standing
  next to a container.
- **Nothing prompts an interaction.** There is still no "press E" over a door,
  which is the next thing a new player will not discover.
- **The marker has no equivalent for the horde.** A zombie behind a wall is
  invisible, which is correct, but a zombie behind the *building you are in* is
  arguably something the fog of war should already be handling.

## Verdict

The most useful milestone in the cycle so far, and none of it was on the plan.

The lesson is not "listen to playtesters" — that is obvious. It is that **the
screenshot gate was answering the wrong question for fourteen milestones.** It
has been a rendering regression test, and a very good one; it caught coplanar
walls, a broken gait, a cutaway that removed the wrong faces. It has never once
been reviewed as *the first thing somebody sees*. From here, at least one shot in
every gate is looked at that way, starting with `01-default.png`.

The metagame work is parked, not dropped — `Utilities`, the helicopter and the
ambient broadcasts are written and waiting. **M15 is that milestone.**
