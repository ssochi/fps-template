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
  // A barricaded window with the dead working on it, at night with a torch lit.
  { name: '13-siege', rotation: 0, zoom: 0, siege: true },
  { name: '14-death', rotation: 0, zoom: 2, death: true, skills: true, profile: true },
  // M13: the dead following you upstairs. Before this milestone the flow field
  // was one storey and an upstairs zombie could only wander, so a first floor
  // was a place you could always retreat to.
  { name: '15-upstairs-chase', rotation: 0, zoom: 0, upstairsChase: true },
];

/**
 * The two screens that come *before* a run, captured from the plain URL. Every
 * other shot boots through `?autostart` because a screenshot cannot click Begin.
 */
const MENU_SHOTS = [
  { name: '00-title', screen: 'title' },
  { name: '00b-creation', screen: 'create' },
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

  // --- the menu, before any run exists ---------------------------------
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#menu .m-title', { timeout: 10000 });
  for (const shot of MENU_SHOTS) {
    if (shot.screen === 'create') {
      await page.click('[data-act="new"]');
      await page.waitForSelector('.m-create', { timeout: 5000 });
      // Pick a build so the screen shows a spent budget rather than a blank
      // one — an untouched creation screen does not exercise any of its states.
      for (const id of ['burglar', 'lightFooted', 'cowardly', 'restless', 'eagleEyed']) {
        const sel = `[data-id="${id}"]`;
        if (await page.$(sel)) await page.click(sel);
      }
    }
    await page.screenshot({ path: `${OUT}${shot.name}.png` });
  }

  // --- the run ----------------------------------------------------------
  await page.goto(`${APP_URL}?autostart`, { waitUntil: 'networkidle' });
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

      if (s.siege) {
        const { avatar: av, world: w, town: t, horde: hs, clock: ck } = window.__knox;
        const g = w.grid;
        const b = t.buildings.find((x) => x.rect.w >= 8) ?? t.buildings[0];
        // Stand just inside the front door and plank the whole facade.
        const ex = b.entrance.x;
        const ez = b.entrance.z;
        av.level = 0;
        av.position.set(ex + 0.5, 0, ez + 1.5);
        av.syncLevelHeight();
        av.setYaw(Math.PI);
        av.torchOn = true;
        av.inventory.add(new (window.__knox.avatar.inventory.items[0].constructor)('torch'));

        let planked = 0;
        for (let x = b.rect.x; x < b.rect.x + b.rect.w; x++) {
          for (const dir of [0, 2]) {
            const wall = g.wallAt(x, dir === 0 ? b.rect.z : b.rect.z + b.rect.d - 1, 0, dir);
            if (wall === 5 || wall === 6) {
              for (let n = 0; n < 3; n++) {
                if (g.addPlank(x, dir === 0 ? b.rect.z : b.rect.z + b.rect.d - 1, 0, dir, 60, 4)) planked++;
              }
            }
          }
        }
        w.flushDirty(Infinity);

        // Bring the dead to the door and set them working on it.
        let brought = 0;
        for (let i = 0; i < hs.horde.count && brought < 12; i++) {
          hs.horde.x[i] = ex + 0.5 + (brought % 4) - 1.5;
          hs.horde.z[i] = ez - 1.5 - Math.floor(brought / 4);
          hs.horde.level[i] = 0;
          hs.horde.state[i] = 3;
          hs.horde.health[i] = 100;
          brought++;
        }
        ck.elapsed = Math.floor(ck.elapsed / 86400) * 86400 + 2 * 3600;
        isoCamera.snapTo(av.position);
        return { planked, brought };
      }

      if (s.hour !== undefined) {
        window.__knox.clock.elapsed =
          Math.floor(window.__knox.clock.elapsed / 86400) * 86400 + s.hour * 3600;
      }
      if (s.death) {
        // Give the run a history, so the report shows what it is meant to.
        const sk = window.__knox.skills;
        sk.award('blunt', 900);
        sk.award('carpentry', 240);
        sk.award('scavenging', 90);
        // Give the survivor a build too, so the report shows the choice as well
        // as the outcome — the two halves M12 put on this card together.
        const prof = window.__knox.profile;
        prof.occupation = 'police';
        prof.traits = ['strong', 'clumsy', 'shortSighted'];
        prof._mods = null;
        prof.name = 'Marion Vance';
        window.__knox.hud.showDeath({
          cause: 'Torn apart',
          days: '3 days',
          kills: window.__knox.combat.stats.kills,
          skills: sk.summary().filter((x) => x.level > 0),
          profile: prof.describe(),
          name: prof.name,
          onRestart: () => {},
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
      if (s.upstairsChase) {
        const { avatar: av, town: t, world: w, horde: hs, isoCamera: cam } = window.__knox;
        const g = w.grid;
        // Find a building with a staircase, and the landing at the top of it.
        let landing = null;
        outer2: for (const b of t.buildings) {
          if (b.rect.storeys < 2) continue;
          for (let z = b.rect.z; z < b.rect.z + b.rect.d; z++) {
            for (let x = b.rect.x; x < b.rect.x + b.rect.w; x++) {
              if (g.descendFrom(x, z, 1) === 0) {
                landing = { x, z, building: b };
                break outer2;
              }
            }
          }
        }
        if (!landing) return { landing: 'none found' };

        // Stand the player upstairs, away from the stairhead.
        av.level = 1;
        av.position.set(landing.x + 2.5, 2.6, landing.z + 0.5);
        av.syncLevelHeight();
        av.hasAim = false;
        cam.snapTo(av.position);

        // Put the dead at the foot of the flight and let the real systems carry
        // them up: rebuild the field, then run the sim. Staging them on the
        // upper storey directly would prove nothing at all.
        const h = hs.horde;
        let brought = 0;
        for (let i = 0; i < h.count && brought < 10; i++) {
          if (h.state[i] === 4) continue;
          h.x[i] = landing.x + 0.5;
          h.z[i] = landing.z + 0.5 + (brought % 3) - 1;
          h.level[i] = 0;
          h.state[i] = 3; // CHASE
          h.attention[i] = 1;
          h.health[i] = 100;
          h.busy[i] = 0;
          h._climbTimer[i] = 0.1;
          brought++;
        }
        const tile = av.tile();
        hs.flow.build([{ x: tile.x, z: tile.z, level: 1 }], 500);
        for (let step = 0; step < 120; step++) {
          for (let i = 0; i < h.count; i++) if (h.state[i] === 3) h.attention[i] = 1;
          h.update(1 / 30, { x: tile.x, z: tile.z, level: 1 });
        }
        let upstairs = 0;
        for (let i = 0; i < h.count; i++) {
          if (h.state[i] !== 4 && h.level[i] === 1) upstairs++;
          // Ten chasers in a bedroom is correctly fatal, and a screenshot of the
          // death card is not what this shot is for. Hold them off long enough
          // for the camera to settle.
          if (h.level[i] === 1) h.cooldown[i] = 30;
        }
        av.body.health.fill(100);
        av.body.bleed.fill(0);
        av.body.pain = 0;
        av.body.alive = true;
        av.body.causeOfDeath = null;
        window.__knox.hud.el['hud-death'].classList.add('hidden');
        // Daylight: shot 13 leaves the clock at two in the morning, and this
        // shot is about where the bodies are rather than about the dark.
        window.__knox.clock.elapsed =
          Math.floor(window.__knox.clock.elapsed / 86400) * 86400 + 11 * 3600;
        return { brought, upstairs, landing: `${landing.x},${landing.z}` };
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

  // --- save and continue, end to end -----------------------------------
  // Unit tests cannot cover this: `Save` round-trips in isolation, but whether
  // the *menu* reaches it goes through `main.js`, which no unit test imports.
  // M8 shipped a crash that 240 green tests missed for exactly that reason.
  const before = await page.evaluate(async () => {
    const g = window.__knox;
    g.avatar.position.set(g.avatar.position.x + 3, g.avatar.position.y, g.avatar.position.z);
    g.skills.award('blade', 400);
    await g.saveNow();
    return { x: g.avatar.position.x, blade: g.skills.level('blade'), seed: g.seed };
  });

  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#menu .m-title', { timeout: 10000 });
  const continueEnabled = await page.$eval('[data-act="continue"]', (b) => !b.disabled);
  if (!continueEnabled) problems.push('Continue was still disabled after a save');
  await page.click('[data-act="continue"]');
  // Restoring marks every chunk dirty, and `flushDirty` deliberately spreads
  // the rebuild over frames. Wait for that queue to drain rather than for a
  // frame count, or the numbers below report the cost of loading rather than
  // the cost of playing — and a frame count is a guess about swiftshader's
  // frame rate, which is not a thing worth guessing about.
  await page.waitForFunction(
    () => window.__knox && window.__knox.loop.frame > 10 && window.__knox.world.grid.dirtyChunks.size === 0,
    { timeout: 60000 },
  );

  const after = await page.evaluate(() => ({
    x: window.__knox.avatar.position.x,
    blade: window.__knox.skills.level('blade'),
    seed: window.__knox.seed,
  }));
  if (Math.abs(after.x - before.x) > 0.05) {
    problems.push(`continue lost the player position: ${before.x} -> ${after.x}`);
  }
  if (after.blade !== before.blade) {
    problems.push(`continue lost skills: blade ${before.blade} -> ${after.blade}`);
  }
  if (after.seed !== before.seed) problems.push(`continue lost the seed: ${after.seed}`);
  console.log(`\n  continue: restored at x=${after.x.toFixed(1)}, blade ${after.blade} ✓`);

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
