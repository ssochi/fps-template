# M12 — Character creation & the main menu

**Status:** ✅ Complete
**Slice:** occupations, traits, the menu that precedes a run, autosave, and the
death report's record of who you chose to be.

## Goal

Answer cycle 2's question — *why is day 20 different from day 3?* — for the
first minute rather than the twentieth day: **why is this run different from the
last one?**

Smallest item in the cycle, deliberately first. It changes the game from the
opening frame, and it carries the menu that save/load has been waiting for since
M10.

## What was built

| Area | File | Note |
| --- | --- | --- |
| Traits & occupations | `sim/Traits.js` | 25 traits, 9 occupations, one `Profile` |
| The menu | `ui/MainMenu.js` | Title, creation, Continue |
| One run, constructible | `Game.js` | Everything `main.js` used to build at import time |
| The shell | `main.js` | 411 lines → 52 |
| Autosave | `Game.js` | Every 90 s and on `pagehide` |
| The record of a choice | `ui/Hud.js` | Traits on the death card |

## The decisions worth recording

**Every trait must multiply a number some system already reads.** The same rule
the moodles were held to in M7 and the skills in M10, and it is why this is a
table rather than a framework. `MOD` is a **closed list of sixteen multipliers**,
each one consumed by an existing system; adding a seventeenth means changing that
system first. "Lucky" is not a trait here because nothing in the game rolls
against luck.

The rule is enforced, not merely stated. `test/traits.test.js` has one case per
modifier that builds a profile with a single trait and asserts a number *some
other file computes* moves in the right direction — the player really covers more
ground, the same wound really bleeds harder, the same hour really costs more
water. A modifier that cannot be written as one of those is a modifier nothing
reads.

**Traits are a budget, not a menu.** Negative traits are how you afford positive
ones, so creation is a set of trades rather than a wish list. You do not pick
Strong; you decide what you are willing to be bad at in order to be strong. That
is also why the point counter is the largest thing on the screen and why the
negative column is headed *Give — earns points* rather than presented as a
penalty box: it is the currency column.

**One trait per axis, derived from a declared `axis` field.** Athletic and Out of
Shape both touch `walkSpeed`, and taking both would be six free points. Deriving
the conflict from a shared *modifier* would have been cleverer and wrong — Strong
and Pack Mule both raise what you can do with your body and should stack. A
declared axis is one word per trait and it never surprises anyone.

**A starting level and an earned level are the same thing.** An occupation's
training is applied as the *XP total that reaches that level*, not as a separate
"starting level" field. So a Nurse's First Aid 4 and a survivor who bandaged
their way to 4 are indistinguishable afterwards, and there is exactly one
representation of "how good are you at this".

**Infection risk is a multiplier on a base that can be zero.** Thin-skinned makes
a scratch very nearly a bite, and still cannot make a blunt wound infectious,
because 0 × 1.5 is 0. That falls out of choosing a scale over an offset, and
there is a test for it.

**Two effects that existed and were read by nobody are now wired.**
`Skills.noiseScale` was computed since M10 and consumed nowhere — *sneaking
levelled up and changed nothing*. `Moodles.enduranceRecovery` was the same.
Both now meet the traits at a single point each: `Player.noiseScale`, applied
wherever **the player** emits noise (doors, vaults, swings, hammering), and the
recovery branch of `_drainEndurance`. Zombie and siege noise deliberately does
not pass through the player's scale.

**`main.js` split a milestone early.** Blueprint v2 said to split it at M13, "the
first milestone that would grow it". M12 was the first milestone that would grow
it: a menu means a run has to be something you *construct*, not something that
happens when a module loads. `Game.js` owns a run; `main.js` decides whether one
starts and with what, and is now 52 lines.

**`?autostart` is a query parameter, not a debug flag.** The screenshot gate
cannot click a Begin button, so it boots through a URL — the same code path a
player takes, one branch earlier.

**A Continue button that can never light up is a dead control.** M10 built saving
and nothing called it. Shipping the button without an autosave would have been
shipping a lie, so a run saves itself every 90 seconds and on `pagehide` — and
**not while dead**, because a snapshot of a corpse would let Continue reload the
run you just lost, which is the one thing permadeath is for.

**Who you chose to be goes on the death card.** The traits and the cause of death
are the two halves of the same sentence. Short-sighted and *torn apart* read as
an explanation; either alone reads as a fact.

## Iteration passes

1. **Traits, profile, menu, the `Game.js` split and 40 tests — all green.**
2. **The panic test was testing nothing.** It staged eight zombies in the dark,
   where pressure saturates and *every* survivor reaches 1 regardless of nerve.
   Rewritten to two zombies in daylight, and split into two properties: where
   fear settles, and how long it takes to leave.
3. **The creation screen scrolled its own point counter off-screen.** The first
   layout was a plain document, so picking a trait at the bottom of the list
   pushed the budget — the thing the whole screen is about — out of view. Header
   and footer are now pinned and only the trait lists scroll.
4. **The Continue button was verified end to end, and it needed to be.** Nothing
   in the unit suite imports `main.js`, which is exactly the hole M8's TDZ crash
   fell through. The smoke gate now saves a run, reloads to the title, clicks
   Continue and asserts the position, skills and seed came back.
5. **The metrics were measuring the wrong frame.** Restoring marks every chunk
   dirty and `flushDirty` deliberately spreads the rebuild over frames, so
   sampling right after Continue reported 13.5 ms and called it the sim step.
   That was the cost of *loading*, not of playing. The gate now waits for the
   rebuild to drain.

## Verification

- **326 unit tests** (up from 286). New coverage: every trait having an effect
  and using only known modifiers; every axis having both something to take and a
  way to pay for it; unique ids; occupations training skills that exist; the
  budget refusing what it cannot afford, negatives funding positives, one trait
  per axis, no duplicates, unknown ids dropped, JSON round-tripping; modifiers
  defaulting to 1 and multiplying; starting levels becoming XP; the XP rate
  reaching the hook unused since M10; **one case per modifier asserting it moves
  a number another system computes**; Surprise Me producing a legal build over
  200 seeds and spending most of the budget; and the character sheet ordering.
- **Screenshot gate:** seventeen images, now including the title screen and a
  half-built character.
- **End-to-end:** save → reload → Continue, asserting position, skills and seed.

## Numbers

260 zombies still 2 draw calls. A profile is three strings in the save. Traits
cost one multiplication each at one call site; there is no per-frame cost at all.
`main.js` went from 411 lines to 52.

## Known gaps, deliberately left for later

- **One save slot, no manual save, no sandbox settings.** M21's job; this
  milestone built the minimum that makes Continue honest.
- **Restoring remeshes the whole town in one flush**, which is a visible hitch on
  load. It is a one-off and it belongs with M20's streaming work.
- **No trait is visible in the world.** Short-sighted changes the fog radius but
  nothing on the HUD says why your sight is short; the character sheet is only on
  the death card.
- **Occupations do not gate recipes or interactions** — they only seed skills.
  Mechanics (M18) and Cooking (M15) will want occupations of their own.
- Traits cannot change during a run. Nothing makes you Out of Shape by living
  badly, which the reference game does through its fitness track.

## Verdict

The cheapest milestone in the cycle bought the most per line, and for a reason
worth naming: **almost every trait was a multiplication inserted into a number
that already existed.** Sixteen modifiers, sixteen call sites, no new subsystem.
That is the same pattern M9 and M10 reported, and it says the M0–M2 architecture
is still paying.

The one surprise was how much *dead wiring* the milestone exposed. Two effects —
sneaking's noise and endurance recovery — had been computed and discarded for two
milestones. They were only found because a trait needed somewhere to attach, which
suggests the next exploration milestone should look specifically for getters that
nothing reads rather than only for exports that nothing imports.

Proceed to M13 — the horde that moves, which is cycle 2's architectural item.
