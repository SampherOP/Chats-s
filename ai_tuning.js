/* HAMU STRIKE - AI combat + movement watchdog
 * Loaded after game.js. Keeps the existing AI logic, but improves firing
 * consistency and prevents bots from permanently freezing against corners.
 */
(() => {
    'use strict';
    const nativeRandom = Math.random.bind(Math);

    // More reliable NPC fire decisions + centered aim wobble.
    Math.random = function () {
        const stack = new Error().stack || '';
        if ((stack.includes('updateUnitClash') || stack.includes('updateUnitLone')) && !stack.includes('unitShoot')) return 0.28;
        if (stack.includes('unitShoot')) return 0.5;
        return nativeRandom();
    };

    const state = new WeakMap();

    function isBot(o) { return o && o.isGroup && o.userData && o.userData.parts && o.visible; }

    function insideObstacle(x, z, y) {
        const pad = .42; let blocked = false;
        scene.traverse(o => {
            if (blocked || o === camera || isBot(o) || o.name === 'PLAYER_EMOTE_CHARACTER') return;
            if (!o.isMesh) return;
            // Hidden CSMAP_COLLIDERS are intentionally included; hidden helper
            // meshes from unrelated systems are ignored.
            if (!o.visible && !o.parent?.name?.startsWith('CSMAP_COLLIDERS')) return;
            const b = new THREE.Box3().setFromObject(o);
            if (b.isEmpty()) return;
            if (y + 2.1 < b.min.y || y > b.max.y + .25) return;
            if (x > b.min.x - pad && x < b.max.x + pad && z > b.min.z - pad && z < b.max.z + pad) blocked = true;
        });
        return blocked;
    }

    function nudgeBot(bot) {
        const p = bot.position, base = Math.atan2(camera.position.x - p.x, camera.position.z - p.z);
        for (let i = 0; i < 12; i++) {
            const a = base + (i - 5.5) * Math.PI / 8;
            const nx = p.x + Math.sin(a) * 1.05, nz = p.z + Math.cos(a) * 1.05;
            if (!insideObstacle(nx, nz, p.y)) { p.x = nx; p.z = nz; return true; }
        }
        return false;
    }

    function watchdog() {
        if (!window.running || window.phase !== 'fight') return;
        const now = performance.now(), bots = [];
        scene.traverse(o => { if (isBot(o)) bots.push(o); });
        for (const bot of bots) {
            let s = state.get(bot);
            if (!s) { s = { x: bot.position.x, z: bot.position.z, t: now }; state.set(bot, s); continue; }
            const moved = Math.hypot(bot.position.x - s.x, bot.position.z - s.z);
            if (moved > .08) { s.x = bot.position.x; s.z = bot.position.z; s.t = now; continue; }
            // Normal AI pauses briefly to aim; only rescue a bot after 2.3 sec
            // of truly zero movement so legitimate aiming is not disturbed.
            if (now - s.t > 2300) {
                if (!nudgeBot(bot)) {
                    const a = nativeRandom() * Math.PI * 2;
                    bot.position.x += Math.cos(a) * .7;
                    bot.position.z += Math.sin(a) * .7;
                }
                s.x = bot.position.x; s.z = bot.position.z; s.t = now;
            }
        }
    }

    setInterval(watchdog, 500);
})();
