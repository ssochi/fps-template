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
  // Teleports the avatar inside a building, which is what drives the storey
  // cutaway. Capturing it exercises the real code path rather than poking
  // `setLevelCutoff` directly.
  { name: '06-indoors', rotation: 0, zoom: 1, indoors: true },
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
      if (s.level !== undefined) {
        avatar.level = s.level;
        avatar.syncLevelHeight();
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
    await page.screenshot({ path: `${OUT}${shot.name}.png` });
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
