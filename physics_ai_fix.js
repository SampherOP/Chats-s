/* HAMU STRIKE // PHYSICS + BOT GROUNDING v9
 * Final physical layer for the runtime AI:
 * - keeps NPC feet glued to the actual map surface
 * - ejects NPCs that are inside thin walls/crates/structural meshes
 * - detects repeated stuck states and performs a safe side-step/repath request
 * - keeps the player camera from falling below a real floor surface
 * - never treats bots as navigation geometry
 */
(() => {
  'use strict';
  const T = window.THREE;
  if (!T) return;

  const CFG = {
    botGroundSnap: 0.42,
    botGroundMaxSnap: 1.15,
    playerEye: 1.75,
    stuckAfter: 0.72,
    stuckDistance: 0.045,
    escapeStep: 0.48,
    wallPadding: 0.16,
    maxGroundDrop: 1.8,
    probeHeight: 3.2
  };

  let scene = null;
  let camera = null;
  let solids = [];
  let solidTimer = 0;
  const ray = new T.Raycaster();
  const states = new WeakMap();

  const oldRender = T.WebGLRenderer.prototype.render;
  T.WebGLRenderer.prototype.render = function(s, c) {
    if (s && s.isScene) scene = s;
    if (c && c.isCamera) camera = c;
    const out = oldRender.apply(this, arguments);
    try { tick(); } catch (e) { /* physics layer must never stop the renderer */ }
    return out;
  };

  function isBot(o) {
    return !!(o && o.isObject3D && o.userData && o.userData.parts && o.position);
  }

  function cameraChild(o) {
    let p = o;
    while (p) {
      if (p === camera) return true;
      p = p.parent;
    }
    return false;
  }

  function rebuildSolids(now) {
    if (!scene || now - solidTimer < 900) return;
    solidTimer = now;
    solids = [];
    scene.updateMatrixWorld(true);
    scene.traverse(o => {
      if (!o.isMesh || !o.visible || isBot(o) || cameraChild(o)) return;
      const n = String(o.name || '').toLowerCase();
      if (/weapon|crosshair|label|ui|viewgun|hand|arm/.test(n)) return;
      const b = new T.Box3().setFromObject(o);
      if (b.isEmpty()) return;
      const sx = b.max.x - b.min.x;
      const sy = b.max.y - b.min.y;
      const sz = b.max.z - b.min.z;
      if (sx < .06 || sz < .06 || sy < .03) return;
      solids.push({ mesh:o, box:b, sx, sy, sz });
    });
  }

  function floorAt(x, z, nearY, maxDistance = 6) {
    if (!solids.length) return null;
    ray.set(new T.Vector3(x, nearY + CFG.probeHeight, z), new T.Vector3(0,-1,0));
    ray.near = 0;
    ray.far = maxDistance + CFG.probeHeight;
    const hits = ray.intersectObjects(solids.map(s => s.mesh), true);
    let best = null;
    for (const h of hits) {
      if (!h.face) continue;
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      if (n.y < 0.62) continue;
      const d = nearY - h.point.y;
      if (d < -0.35 || d > maxDistance) continue;
      if (!best || Math.abs(d) < Math.abs(nearY - best.y)) best = { y:h.point.y, object:h.object };
    }
    return best;
  }

  function horizontalContain(box, p, pad = 0) {
    return p.x > box.min.x-pad && p.x < box.max.x+pad &&
           p.z > box.min.z-pad && p.z < box.max.z+pad;
  }

  function resolveBotOverlap(bot, box, state) {
    const p = bot.position;
    if (!horizontalContain(box, p, CFG.wallPadding)) return false;

    const bottom = state.bottom;
    if (bottom > box.max.y + 1.35 || bottom < box.min.y - 1.25) return false;

    const px = Math.min(Math.abs(p.x-box.min.x), Math.abs(box.max.x-p.x));
    const pz = Math.min(Math.abs(p.z-box.min.z), Math.abs(box.max.z-p.z));
    if (px <= pz) {
      if (Math.abs(p.x-box.min.x) < Math.abs(box.max.x-p.x)) p.x = box.min.x - CFG.wallPadding;
      else p.x = box.max.x + CFG.wallPadding;
    } else {
      if (Math.abs(p.z-box.min.z) < Math.abs(box.max.z-p.z)) p.z = box.min.z - CFG.wallPadding;
      else p.z = box.max.z + CFG.wallPadding;
    }
    state.lastEscape = performance.now();
    bot.userData.aiPath = [];
    bot.userData.navPath = [];
    bot.userData.repath = true;
    bot.userData.aiRepath = true;
    return true;
  }

  function groundBot(bot, state) {
    bot.updateMatrixWorld(true);
    const before = new T.Box3().setFromObject(bot);
    if (before.isEmpty()) return;
    state.bottom = before.min.y;

    const f = floorAt(bot.position.x, bot.position.z, before.min.y + .15, 4.5);
    if (!f) return;

    const delta = f.y - before.min.y;
    if (Math.abs(delta) <= CFG.botGroundMaxSnap) {
      if (Math.abs(delta) > CFG.botGroundSnap || before.min.y < f.y - .08) {
        bot.position.y += delta;
        state.bottom = f.y;
      }
    }
  }

  function botStuck(bot, state, now) {
    const p = bot.position;
    if (!state.lastPos) state.lastPos = p.clone();
    const moved = p.distanceTo(state.lastPos);
    state.lastPos.copy(p);

    if (moved < CFG.stuckDistance) state.stillFor += .016;
    else state.stillFor = 0;
    if (state.stillFor < CFG.stuckAfter) return;
    if (now - (state.lastEscape || 0) < 650) return;

    const dirs = [
      new T.Vector3(1,0,0), new T.Vector3(-1,0,0),
      new T.Vector3(0,0,1), new T.Vector3(0,0,-1),
      new T.Vector3(.707,0,.707), new T.Vector3(-.707,0,.707),
      new T.Vector3(.707,0,-.707), new T.Vector3(-.707,0,-.707)
    ];
    let best = null, bestScore = -Infinity;
    for (const d of dirs) {
      let blocked = false, nearest = 9;
      for (const s of solids) {
        const b = s.box;
        const q = new T.Vector3(p.x + d.x*CFG.escapeStep, p.y, p.z + d.z*CFG.escapeStep);
        if (horizontalContain(b, q, .22) && q.y > b.min.y-1 && q.y < b.max.y+2) {
          blocked = true; break;
        }
        const dx = Math.max(b.min.x-q.x, 0, q.x-b.max.x);
        const dz = Math.max(b.min.z-q.z, 0, q.z-b.max.z);
        nearest = Math.min(nearest, Math.hypot(dx,dz));
      }
      if (!blocked && nearest > bestScore) { bestScore = nearest; best = d; }
    }
    if (best) {
      bot.position.x += best.x * CFG.escapeStep;
      bot.position.z += best.z * CFG.escapeStep;
      bot.userData.aiPath = [];
      bot.userData.navPath = [];
      bot.userData.repath = true;
      bot.userData.aiRepath = true;
    }
    state.stillFor = 0;
    state.lastEscape = now;
  }

  function fixPlayerGround() {
    if (!camera) return;
    const f = floorAt(camera.position.x, camera.position.z, camera.position.y - CFG.playerEye + .1, 5);
    if (!f) return;
    const expected = f.y + CFG.playerEye;
    const dy = expected - camera.position.y;
    if (dy > 0.12 && dy < CFG.maxGroundDrop) {
      camera.position.y += Math.min(dy, .38);
    } else if (camera.position.y < f.y + 1.15) {
      camera.position.y = expected;
    }
  }

  function tick() {
    if (!scene) return;
    const now = performance.now();
    rebuildSolids(now);
    if (!solids.length) return;

    const bots = [];
    scene.traverse(o => { if (isBot(o) && o.visible !== false) bots.push(o); });
    for (const bot of bots) {
      let st = states.get(bot);
      if (!st) {
        st = { lastPos:bot.position.clone(), stillFor:0, lastEscape:0, bottom:bot.position.y };
        states.set(bot, st);
      }
      groundBot(bot, st);
      const near = solids.filter(s => {
        const b=s.box, p=bot.position;
        const dx=Math.max(b.min.x-p.x,0,p.x-b.max.x), dz=Math.max(b.min.z-p.z,0,p.z-b.max.z);
        return Math.hypot(dx,dz)<1.2;
      }).slice(0,10);
      for (const s of near) resolveBotOverlap(bot, s.box, st);
      botStuck(bot, st, now);
    }
    fixPlayerGround();
  }

  window.HAMU_PHYSICS_AI = { rebuild: () => { solidTimer = 0; rebuildSolids(performance.now()); } };
})();
