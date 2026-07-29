/**
 * Knox — the shell.
 *
 * Show the menu, find out who the survivor is, then hand off to `Game.js` for
 * the run itself. This file deliberately knows almost nothing about the game:
 * it decides *whether* a run starts and with what, not what happens in one.
 *
 * ## Skipping the menu
 *
 * `?autostart` boots straight into a run, optionally with `?seed=` and
 * `?traits=a,b`. That exists for the screenshot gate — a still frame cannot
 * click a Begin button — and it is a query parameter rather than a debug flag
 * so the smoke test drives the same code path a player does.
 */
import { createGame } from './Game.js';
import { MainMenu, randomProfile } from './ui/MainMenu.js';
import { Profile } from './sim/Traits.js';
import * as Save from './save/Save.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('app'));
const params = new URLSearchParams(location.search);

const saved = await Save.load('slot1').catch(() => null);

let choice;
if (params.has('autostart')) {
  choice = {
    action: 'new',
    seed: params.get('seed') || 'knox-county',
    profile: params.has('traits')
      ? new Profile({ traits: params.get('traits').split(',').filter(Boolean) })
      : params.has('random')
        ? randomProfile()
        : Profile.default(),
  };
} else {
  const menu = new MainMenu({ hasSave: !!saved });
  choice = await menu.waitForStart();
}

// Continuing means restoring the survivor you were, not the one the menu was
// last showing — the profile is part of the snapshot for exactly that reason.
const profile =
  choice.action === 'continue' && saved?.profile
    ? Profile.fromJSON(saved.profile)
    : choice.profile;

const seed = choice.action === 'continue' && saved ? saved.seed : choice.seed;

const game = createGame({
  canvas,
  seed,
  profile,
  // Restarting from the death card returns to the menu rather than reloading
  // into the same character: the run is over, so the choice should be live again.
  onRestart: () => window.location.assign(window.location.pathname),
});

if (choice.action === 'continue' && saved) game.restoreFrom(saved);

window.__knox = game;
