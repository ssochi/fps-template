import './ui/styles.css';
import { Game } from './core/Game';

/**
 * Entry point.
 *
 * Building the range (procedural textures, geometry, collision) takes a moment,
 * so it happens after a frame has been painted — otherwise the loading screen
 * would never actually appear.
 */

function fail(message: string, detail?: unknown): void {
  const el = document.getElementById('loading');
  if (el) {
    el.innerHTML = `<div style="max-width:520px;text-align:center;line-height:1.6;letter-spacing:1px">
      ${message}
    </div>`;
  }
  if (detail) console.error(detail);
}

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext('webgl2') || canvas.getContext('webgl')),
    );
  } catch {
    return false;
  }
}

function boot(): void {
  const container = document.getElementById('app');
  const hudRoot = document.getElementById('hud');
  const menuRoot = document.getElementById('menus');

  if (!container || !hudRoot || !menuRoot) {
    fail('Page markup is missing the required containers.');
    return;
  }

  if (!supportsWebGL()) {
    fail('This browser does not support WebGL, which this template requires.');
    return;
  }

  try {
    const game = new Game(container, hudRoot, menuRoot);
    game.start();
    // Exposed for tinkering from the devtools console.
    (window as unknown as { game: Game }).game = game;
  } catch (error) {
    fail('Failed to start. Check the browser console for details.', error);
  }
}

// Two frames: one to paint the loading screen, one to start the heavy work.
requestAnimationFrame(() => requestAnimationFrame(boot));
