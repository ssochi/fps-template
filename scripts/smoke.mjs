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
  // Stages a fight: a ring of zombies around the player, half of them killed.
  // Verifies the fall clip holds its last frame — a corpse that stood back up
  // would mean the non-looping clip path is broken.
  { name: '10-combat', rotation: 0, zoom: 0, fight: true },
  // Night, and the death report. Both are states the game spends real time in
  // and neither was previously captured by anything.
  { name: '11-night', rotation: 0, zoom: 3, hour: 1 },
  // Looting: the panels open over a container with something in it.
  { name: '12-looting', rotation: 0, zoom: 1, loot: true },
  { name: '13-death', rotation: 0, zoom: 2, death: true },
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
    const setupResult = await page.evaluate((s) => {
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
      // The player really does die during the combat shot, and the death card
      // is modal — without clearing it, every later shot is a screenshot of it.
      window.__knox.hud.el['hud-death'].classList.toggle('hidden', !s.death);

      // Panels are modal; leaving them open would cover every later shot.
      if (!s.loot) window.__knox.panels.close();

      if (s.loot) {
        const { avatar: av, loot: lootSys, panels: p, world: w, town: t } = window.__knox;
        // Find a container the town actually generated, and stand at it.
        let found = null;
        outer: for (const b of t.buildings) {
          for (let z = b.rect.z; z < b.rect.z + b.rect.d; z++) {
            for (let x = b.rect.x; x < b.rect.x + b.rect.w; x++) {
              const c = lootSys.open(x, z, 0);
              if (c && !c.isEmpty) {
                found = { x, z, container: c };
                break outer;
              }
            }
          }
        }
        if (found) {
          av.level = 0;
          av.position.set(found.x + 0.5, 0, found.z + 1.5);
          av.syncLevelHeight();
          isoCamera.snapTo(av.position);
          p.open = true;
          p.container = found.container;
          p.el.classList.remove('hidden');
          p.invalidate();
          p.render();
          return { container: found.container.name, items: found.container.items.length };
        }
        return { container: 'none found', items: 0 };
      }

      if (s.hour !== undefined) {
        window.__knox.clock.elapsed =
          Math.floor(window.__knox.clock.elapsed / 86400) * 86400 + s.hour * 3600;
      }
      if (s.death) {
        window.__knox.hud.showDeath({
          cause: 'Torn apart',
          days: '3 days',
          kills: window.__knox.combat.stats.kills,
        });
      }
      if (s.fight) {
        const { horde: hs, avatar: av } = window.__knox;
        const h = hs.horde;
        const cx = window.__knox.town.roads.vertical[1];
        const cz = window.__knox.town.roads.horizontal[1];
        av.level = 0;
        av.position.set(cx + 0.5, 0, cz + 6.5);
        av.syncLevelHeight();
        av.hasAim = false;
        av.setYaw(Math.PI * 0.75);
        isoCamera.snapTo(av.position);

        // Ring the player with zombies, then actually swing at them so the
        // kills come through the real combat path rather than being staged.
        const ring = [];
        for (let i = 0; i < h.count && ring.length < 9; i++) ring.push(i);
        ring.forEach((i, k) => {
          const a = (k / ring.length) * Math.PI * 2;
          // Inside the crowbar's 1.35 m reach. Staged any further out and every
          // swing correctly misses, which looks exactly like combat being broken.
          h.x[i] = av.position.x + Math.cos(a) * 1.05;
          h.z[i] = av.position.z + Math.sin(a) * 1.05;
          h.level[i] = 0;
          h.yaw[i] = Math.atan2(-Math.cos(a), -Math.sin(a)) + Math.PI;
          h.state[i] = 3; // CHASE
          h.busy[i] = 0;
          h.cooldown[i] = 0;
          h.health[i] = 100;
        });

        // Revive first. By this shot the player has spent the whole run standing
        // in a crowd and is usually dead — and a dead player's swings are
        // correctly refused, which looks exactly like combat being broken.
        av.body.health.fill(100);
        av.body.bleed.fill(0);
        av.body.fractured.fill(0);
        av.body.pain = 0;
        av.body.alive = true;
        av.body.causeOfDeath = null;

        // Swing until several are down, so the fall clip is exercised for real.
        av.endurance = 1;
        for (let s2 = 0; s2 < 14; s2++) {
          av.busy = 0;
          av.endurance = 1;
          window.__knox.combat.swing('attack');
          h.clock += 0.4;
        }
        // Let the corpses finish falling, and push the survivors back out of
        // reach. Being surrounded by nine is correctly fatal, and a dead player
        // is not what this shot is meant to show.
        ring.forEach((i, k) => {
          if (h.state[i] === 4) {
            h.deathTime[i] = h.clock - 3;
          } else {
            const a = (k / ring.length) * Math.PI * 2;
            h.x[i] = av.position.x + Math.cos(a) * 3.4;
            h.z[i] = av.position.z + Math.sin(a) * 3.4;
            h.cooldown[i] = 5;
          }
        });
        av.body.health.fill(100);
        av.body.bleed.fill(0);
        av.body.pain = 0;
        return { staged: ring.length, kills: window.__knox.combat.stats.kills };
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
      window.__knox.__hudTarget = start + 14;
    });
    await page.waitForFunction(() => window.__knox.loop.frame >= window.__knox.__hudTarget, {
      timeout: 5000,
    });
    // Character shots are cropped tight: at 10 m of view height the figure is
    // ~90 px in a 1280-wide frame, which is too small to judge a pose in.
    if (setupResult) process.stdout.write(`    setup: ${JSON.stringify(setupResult)}\n`);
    await page.screenshot({
      path: `${OUT}${shot.name}.png`,
      ...(shot.onRoad ? { clip: { x: 505, y: 225, width: 270, height: 270 } } : {}),
    });
    process.stdout.write(`  shot ${shot.name}\n`);
  }

  // Measure what the horde actually costs in draw calls, rather than asserting
  // it. Render a frame with it hidden, then with it shown, and take the delta.
  const hordeCost = await page.evaluate(async () => {
    const { renderer, horde, isoCamera } = window.__knox;
    const draw = () => {
      renderer.renderer.render(renderer.scene, isoCamera.camera);
      return renderer.renderer.info.render.calls;
    };
    horde.mesh.visible = false;
    const without = draw();
    horde.mesh.visible = true;
    const with_ = draw();
    return { without, with_, delta: with_ - without, instances: horde.stats.instances };
  });
  console.log(
    `\n  horde: ${hordeCost.instances} zombies in ${hordeCost.delta} draw call(s) ` +
      `(${hordeCost.without} -> ${hordeCost.with_})`,
  );

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
