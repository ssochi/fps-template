/**
 * Headless smoke test + screenshot capture.
 *
 * Rendering can't be unit-tested, but it can be regression-tested: boot the app
 * in real Chromium, assert a clean console, then capture fixed camera angles to
 * `shots/`. Reviewing those images is the acceptance gate for every milestone
 * that changes what the game looks like.
 *
 *   npm run smoke              — capture the standard set
 *   npm run smoke -- --keep    — leave the dev server running afterwards
 */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 5178;
const APP_URL = `http://127.0.0.1:${PORT}/`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = fileURLToPath(new URL('../shots/', import.meta.url));

/** Each entry drives the app's debug handle, then screenshots. */
const SHOTS = [
  { name: '01-default', rotation: 0, zoom: 2 },
  { name: '02-rotated', rotation: 1, zoom: 2 },
  { name: '03-close', rotation: 0, zoom: 0 },
  { name: '04-wide', rotation: 3, zoom: 5 },
  { name: '05-upstairs', rotation: 0, zoom: 2, level: 1 },
  // Teleports the avatar inside a building, which is what drives the per-room
  // cutaway. Capturing it exercises the real code path rather than poking the
  // cutaway state directly.
  { name: '06-indoors', rotation: 0, zoom: 1, indoors: true },
  // The player spawns beside their building, which at this camera angle puts
  // the building between them and the lens — that occlusion is M4's problem.
  // These two put the character in the open so the rig itself is inspectable.
  { name: '07-character-idle', rotation: 0, zoom: 0, onRoad: true },
  { name: '08-character-run', rotation: 0, zoom: 0, onRoad: true, running: true },
  // Fog of war gets its own shot. Every other shot reveals the map first, so
  // that geometry and cutaway regressions are not masked by darkness.
  { name: '09-fog-of-war', rotation: 0, zoom: 3, fog: true },
];

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => (serverOut += d));
server.stderr.on('data', (d) => (serverOut += d));

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(APP_URL)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`dev server never came up:\n${serverOut}`);
}

const problems = [];
let exitCode = 0;

try {
  await waitForServer();
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({
    // The environment pre-installs Chromium and symlinks it here; using it
    // directly avoids a revision mismatch with whatever playwright expects.
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.stack || e.message}`));

  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__knox && window.__knox.loop.frame > 20, { timeout: 20000 });

  for (const shot of SHOTS) {
    await page.evaluate((s) => {
      const { isoCamera, avatar, town, world } = window.__knox;
      isoCamera.rotationStep = s.rotation;
      isoCamera.zoomStep = s.zoom;

      // Fog is revealed by default so a geometry or cutaway regression is not
      // hidden behind unexplored blackness.
      if (s.fog) {
        world.fog.enabled = true;
        world.fog.reset();
        // Look from somewhere else first, then come back. Without that step the
        // shot only ever shows two of the three states — nothing has had the
        // chance to become "remembered", which is the state the whole design
        // exists for.
        const t = { x: Math.floor(avatar.position.x), z: Math.floor(avatar.position.z) };
        world.fog.update(t.x - 14, t.z - 14, 0);
        world.fog.update(t.x, t.z, 0);
      } else {
        world.fog.enabled = false;
        world.fog.revealAll();
      }
      if (s.level !== undefined) {
        avatar.level = s.level;
        avatar.syncLevelHeight();
      }
      if (s.onRoad) {
        // Middle of the widest clear stretch of road, away from any facade.
        const cx = town.roads.vertical[Math.floor(town.roads.vertical.length / 2)];
        const cz = town.roads.horizontal[Math.floor(town.roads.horizontal.length / 2)];
        avatar.level = 0;
        avatar.position.set(cx + 0.5, 0, cz + 6.5);
        avatar.syncLevelHeight();
        avatar.hasAim = false;
        avatar.setYaw(Math.PI * 0.75);
        isoCamera.snapTo(avatar.position);
      }
      if (s.running) {
        // Drive the gait directly: a screenshot cannot hold a key down.
        window.__knox.__forceGait = { gait: 'run', speed: 5 };
      } else {
        window.__knox.__forceGait = null;
      }
      if (s.indoors) {
        // Step one tile in from a two-storey building's front door.
        const b = town.buildings.find((x) => x.rect.storeys > 1) ?? town.buildings[0];
        avatar.level = 0;
        avatar.position.set(b.entrance.x + 0.5, 0, b.entrance.z + 1.5);
        avatar.syncLevelHeight();
        isoCamera.snapTo(avatar.position);
        world.grid.__lastIndoor = b.entrance;
      }
    }, shot);
    // Wait for the eased rotation/zoom to actually arrive before capturing.
    await page.waitForFunction(() => window.__knox.isoCamera.isSettled, { timeout: 5000 });
    // The HUD only redraws every 15th frame, so a screenshot taken the instant
    // the camera settles shows the *previous* shot's readout.
    await page.evaluate(() => {
      const start = window.__knox.loop.frame;
      window.__knox.__hudTarget = start + 20;
    });
    await page.waitForFunction(() => window.__knox.loop.frame >= window.__knox.__hudTarget, {
      timeout: 5000,
    });
    // Character shots are cropped tight: at 10 m of view height the figure is
    // ~90 px in a 1280-wide frame, which is too small to judge a pose in.
    await page.screenshot({
      path: `${OUT}${shot.name}.png`,
      ...(shot.onRoad ? { clip: { x: 505, y: 225, width: 270, height: 270 } } : {}),
    });
    process.stdout.write(`  shot ${shot.name}\n`);
  }

  const stats = await page.evaluate(() => {
    const { renderer, world, loop } = window.__knox;
    return {
      calls: renderer.info.calls,
      triangles: renderer.info.triangles,
      chunks: world.stats.chunks,
      buildings: window.__knox.town.buildings.length,
      rooms: window.__knox.town.rooms.length,
      simMs: loop.lastUpdateMs,
    };
  });
  console.log(`\n  draw calls: ${stats.calls}   (one per chunk mesh + entities)`);
  console.log(`  triangles:  ${stats.triangles}`);
  console.log(`  chunks:     ${stats.chunks}`);
  console.log(`  buildings:  ${stats.buildings}   rooms: ${stats.rooms}`);
  console.log(`  sim step:   ${stats.simMs.toFixed(3)} ms`);

  await browser.close();

  const fatal = problems.filter((p) => !/DevTools|deprecat|Failed to load resource/i.test(p));
  if (fatal.length) {
    console.error('\n  console problems:');
    for (const p of fatal) console.error(`   - ${p}`);
    exitCode = 1;
  } else {
    console.log('\n  clean console ✓');
  }
} catch (err) {
  console.error(err);
  if (problems.length) {
    console.error('\n  console output before failure:');
    for (const p of problems) console.error(`   - ${p}`);
  }
  exitCode = 1;
} finally {
  if (!process.argv.includes('--keep')) server.kill('SIGTERM');
}

process.exit(exitCode);
