/* HAMU STRIKE - AI combat + movement watchdog
 * Loaded after game.js. Tracks NPC groups created by the game and recovers
 * bots that remain trapped against collision geometry for too long.
 */
(() => {
    'use strict';
    const nativeRandom = Math.random.bind(Math);

    // Keep NPC firing reliable while preserving unrelated game randomness.
    Math.random = function () {
        const stack = new Error().stack || '';
        if ((stack.includes('updateUnitClash') || stack.includes('updateUnitLone')) && !stack.includes('unitShoot')) return 0.28;
        if (stack.includes('unitShoot')) return 0.5;
        return nativeRandom();
    };

    let gameScene = null;
    const bots = new Set();
    const state = new WeakMap();
    const originalSceneAdd = THREE.Scene.prototype.add;

    // game.js keeps scene/squad private inside its IIFE. Hook Scene.add instead
    // so this helper can still see every humanoid bot when a round spawns.
    THREE.Scene.prototype.add = function (...objects) {
        if (!gameScene) gameScene = this;
        for (const o of objects) {
            if (o && o.userData && o.userData.parts) bots.add(o);
        }
        return originalSceneAdd.apply(this, objects);
    };

    function obstacleAt(x, z, y, ignore) {
        if (!gameScene) return false;
        const pad = .46; let hit = false;
        gameScene.traverse(o => {
            if (hit || o === ignore || !o.isMesh) return;
            if (o.parent?.userData?.parts || o.userData?.parts) return;
            // Include visible Lonewolf geometry and the intentionally hidden
            // CSMAP collider meshes.
            if (!o.visible && !o.parent?.name?.startsWith('CSMAP_COLLIDERS')) return;
            const b = new THREE.Box3().setFromObject(o);
            if (b.isEmpty()) return;
            if (y + 2.05 < b.min.y || y > b.max.y + .25) return;
            if (x > b.min.x - pad && x < b.max.x + pad && z > b.min.z - pad && z < b.max.z + pad) hit = true;
        });
        return hit;
    }

    function recover(bot) {
        const p = bot.position;
        // Try side/back/forward escape positions. The normal AI resumes on the
        // very next frame, so this is a recovery rather than a teleport system.
        const forward = new THREE.Vector3(-Math.sin(bot.rotation.y), 0, -Math.cos(bot.rotation.y));
        const right = new THREE.Vector3(Math.cos(bot.rotation.y), 0, -Math.sin(bot.rotation.y));
        const dirs = [right, right.clone().multiplyScalar(-1), forward, forward.clone().multiplyScalar(-1),
            right.clone().add(forward).normalize(), right.clone().sub(forward).normalize(),
            right.clone().multiplyScalar(-1).add(forward).normalize(), right.clone().multiplyScalar(-1).sub(forward).normalize()];
        for (const d of dirs) {
            const nx = p.x + d.x * 1.15, nz = p.z + d.z * 1.15;
            if (!obstacleAt(nx, nz, p.y, bot)) { p.x = nx; p.z = nz; return true; }
        }
        return false;
    }

    function watchdog() {
        for (const bot of [...bots]) {
            if (!bot.parent || !bot.visible) { bots.delete(bot); state.delete(bot); continue; }
            let s = state.get(bot);
            const now = performance.now();
            if (!s) { state.set(bot, s = { x: bot.position.x, z: bot.position.z, t: now }); continue; }
            const moved = Math.hypot(bot.position.x - s.x, bot.position.z - s.z);
            if (moved > .08) { s.x = bot.position.x; s.z = bot.position.z; s.t = now; continue; }
            // Bots intentionally pause to aim. Only rescue a bot after 2.5 sec
            // without meaningful horizontal movement.
            if (now - s.t > 2500) {
                if (!recover(bot)) {
                    const a = nativeRandom() * Math.PI * 2;
                    bot.position.x += Math.cos(a) * .65;
                    bot.position.z += Math.sin(a) * .65;
                }
                s.x = bot.position.x; s.z = bot.position.z; s.t = now;
            }
        }
    }

    setInterval(watchdog, 500);
})();
