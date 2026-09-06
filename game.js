(() => {
    'use strict';
    const T = THREE, root = document.getElementById('game');
    
    // --- MAP LOADER SETUP ---
    const scene = new T.Scene(); scene.background = new T.Color(0x66727b); scene.fog = new T.Fog(0x66727b, 35, 100);
    const camera = new T.PerspectiveCamera(78, innerWidth / innerHeight, .05, 180); camera.rotation.order = 'YXZ';
    const renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.35)); renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap; root.appendChild(renderer.domElement);
    scene.add(new T.HemisphereLight(0xe9f4ff, 0x18212a, 1.55));
    const sun = new T.DirectionalLight(0xffffff, 2.0); sun.position.set(20, 35, 15); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); scene.add(sun);
    const clock = new T.Clock(), keys = {};
    let yaw = 0, pitch = 0, locked = false, running = false, paused = false, phase = 'menu', mode = 'ai', round = 1, roundWins = 0, enemyWins = 0, roundTime = 120, buyTime = 5, coins = 500, fireHeld = false, aiming = false, shootCD = 0, reloadT = 0, jumpVel = 0, slideT = 0, buildMode = false, buildRot = 0, shake = 0, world = [], builds = [], enemy = null, squad = [], spectating = false, specIndex = 0, bounds = { minX: -15, maxX: 15, minZ: -15, maxZ: 15 }, clashLayout = null, shopPrev = null, shopCanvases = [], weaponIndex = 0, ammo = [], killFeed = [], roundTransition = null;
    let audio = null, mp3 = {}, stepT = 0, weaponAnimT = 0, fireAnimT = 0, reloadAnimT = 0;
    let emoteActive = false, emoteT = 0, emoteMesh = null, emoteBaseYaw = 0, emotePrevHP = 100, emoteMenuOpen = false, currentEmote = 'laugh', emoteFx = null;
    let slideMax = 1.15, slideEnergy = slideMax, slideCooldown = 0, prone = false, climbing = null, ladderExitLatch = false;

    const weapons = [
        { name: 'USP', price: 500, mag: 7, reserve: 35, damage: 13, damageMin: 9, damageMax: 16, legDamage: 4, headDamage: 49, rate: 3.2, reload: 1.55, range: 90, spread: .006, recoil: .095, color: 0x34383b, icon: '◆', sound: 'deagle' },
        { name: 'SMG', price: 900, mag: 30, reserve: 120, damage: 18, headDamage: 1000, rate: 13, reload: 1.35, range: 75, spread: .018, recoil: .035, color: 0x30363b, icon: '▰', sound: 'smg' },
        { name: 'ASSAULT RIFLE', price: 1400, mag: 24, reserve: 96, damage: 24, headDamage: 1000, rate: 9, reload: 1.5, range: 105, spread: .012, recoil: .045, color: 0x252b30, icon: '▰', sound: 'rifle' },
        { name: 'SHOTGUN', price: 2000, mag: 6, reserve: 30, damage: 15, headDamage: 1000, rate: 1.25, reload: 1.65, range: 42, spread: .055, pellets: 8, recoil: .14, color: 0x272a2e, icon: '⬟', sound: 'shotgun' }
    ];

    const player = { pos: new T.Vector3(0, 1.75, 10), hp: 100, armor: 50, alive: true, kills: 0, deaths: 0, bob: 0, onGround: true, vel: new T.Vector3(), owned: new Set() };
    const arena = { size: 32 };
    const viewGun = new T.Group(); viewGun.position.set(.38, -.34, -.78); camera.add(viewGun); scene.add(camera);

    function mat(c, r = .7, m = .05) { return new T.MeshStandardMaterial({ color: c, roughness: r, metalness: m }) }
    function addBox(x, y, z, w, h, d, c, collide = true, opts = {}) {
        const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat(c, opts.r ?? .7, opts.m ?? .08));
        m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; scene.add(m);
        if (collide) world.push({ x, z, w, d, h, mesh: m }); return m
    }
    function addContainer(x, z, color, rot = 0) {
        const g = new T.Group(); g.position.set(x, 1.45, z); g.rotation.y = rot;
        const body = new T.Mesh(new T.BoxGeometry(5.4, 2.9, 2.4), mat(color, .72, .15)); body.castShadow = body.receiveShadow = true; g.add(body);
        for (let i = -2; i <= 2; i++) { const rib = new T.Mesh(new T.BoxGeometry(.10, 2.72, .12), mat(0x20262a, .6, .2)); rib.position.set(i * 1.02, 0, -1.22); g.add(rib); const rib2 = rib.clone(); rib2.position.z = 1.22; g.add(rib2) }
        scene.add(g); world.push({ x, z, w: rot % Math.PI === 0 ? 5.4 : 2.4, d: rot % Math.PI === 0 ? 2.4 : 5.4, h: 2.9, mesh: body }); return g
    }
    function addCrate(x, z, c = 0x8a6244, s = 1) { return addBox(x, s * .55, z, s, s, s, c, true) }
    function clearWorld() { for (const o of [...scene.children]) if (o !== camera && o !== sun && !o.isLight) scene.remove(o); world = []; builds = []; document.getElementById('labels').innerHTML = '' }

    function makeLoneWolfArena() {
        clearWorld(); const s = arena.size, edge = s / 2 - 1;
        bounds = { minX: -edge, maxX: edge, minZ: -edge, maxZ: edge };
        clashLayout = null;
        addBox(0, -.25, 0, s, .5, s, 0x313a42, false);
        addBox(0, 2, -s / 2 - .5, s, 4, 1, 0x171d22); addBox(0, 2, s / 2 + .5, s, 4, 1, 0x171d22);
        addBox(-s / 2 - .5, 2, 0, 1, 4, s, 0x171d22); addBox(s / 2 + .5, 2, 0, 1, 4, s, 0x171d22);
        addContainer(-8, -6, 0x9e242e, 0); addContainer(8, 6, 0x254f9b, 0);
        addContainer(-8, 6, 0x9e242e, Math.PI / 2); addContainer(8, -6, 0x254f9b, Math.PI / 2);
        addContainer(0, 0, 0x56636c, 0);
        addCrate(-12, -11); addCrate(12, 11); addCrate(-12, 11, 0x59636c, .8); addCrate(12, -11, 0x59636c, .8);
        addBox(0, -8, 0, 7, 2, 1.2, 0x53606a); addBox(0, 8, 0, 7, 2, 1.2, 0x53606a);
        addBox(-5, 0, 0, 1.2, 2, 7, 0x4a555e); addBox(5, 0, 0, 1.2, 2, 7, 0x4a555e);
        for (let x = -14; x <= 14; x += 2) addBox(x, .02, 0, .025, .05, s - 2, 0x727b82, false)
    }


    /* --- CLASH SQUAD MAP ---------------------------------------------------
       The arena IS assets/models/csmap.glb. It is read with a self-contained
       GLB parser (no GLTFLoader / CDN needed), rotated so its long side runs
       along the attack axis, scaled to a size the squad can actually fight
       across, and turned into collision + spawn layout from its own boxes.
    ------------------------------------------------------------------------ */
    const CS_MAP_URL = 'assets/models/csmap.glb';
    const CS_MAP_LENGTH = 47, CS_STEP = .6, CS_HEAD = 2.6;
    const GLB_COMPONENTS = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
    const GLB_CHANNELS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
    const GLB_READERS = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' };
    let csMap = null, csMapJob = null;

    function splitGLB(buffer) {
        const view = new DataView(buffer);
        if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546C67) throw new Error('Invalid GLB header');
        const chunks = {};
        let offset = 12;
        while (offset + 8 <= buffer.byteLength) {
            const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true), start = offset + 8;
            if (type === 0x4E4F534A) chunks.json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length)));
            else if (type === 0x004E4942) chunks.bin = buffer.slice(start, start + length);
            offset = start + length;
        }
        if (!chunks.json || !chunks.bin) throw new Error('GLB JSON/BIN chunk missing');
        return chunks;
    }

    function glbAccessor(json, bin) {
        const dv = new DataView(bin);
        return index => {
            const a = json.accessors[index], bv = json.bufferViews[a.bufferView], info = GLB_COMPONENTS[a.componentType];
            if (!info) throw new Error('Unsupported accessor component type: ' + a.componentType);
            const Ctor = info[0], bytes = info[1], channels = GLB_CHANNELS[a.type];
            const stride = bv.byteStride || bytes * channels, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
            if (stride === bytes * channels) return new Ctor(bin, base, a.count * channels).slice();
            const out = new Ctor(a.count * channels), read = dv[GLB_READERS[a.componentType]].bind(dv);
            for (let i = 0; i < a.count; i++) for (let c = 0; c < channels; c++) out[i * channels + c] = read(base + i * stride + c * bytes, true);
            return out;
        };
    }

    function glbMaterial(json, index) {
        const m = (json.materials && json.materials[index]) || null, pbr = m && m.pbrMetallicRoughness;
        const c = (pbr && pbr.baseColorFactor) || [.72, .72, .72, 1];
        return new T.MeshStandardMaterial({
            color: new T.Color(c[0], c[1], c[2]), opacity: c[3], transparent: c[3] < 1,
            roughness: pbr && pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : .8,
            metalness: pbr && pbr.metallicFactor !== undefined ? pbr.metallicFactor : 0,
            side: T.DoubleSide
        });
    }

    function glbScene(json, bin) {
        const read = glbAccessor(json, bin), nodes = json.nodes || [], cache = new Map(), hasParent = new Set();
        nodes.forEach(n => (n.children || []).forEach(c => hasParent.add(c)));
        function primitives(meshIndex) {
            if (cache.has(meshIndex)) return cache.get(meshIndex);
            const group = new T.Group();
            for (const prim of json.meshes[meshIndex].primitives) {
                if (prim.mode !== undefined && prim.mode !== 4) continue;
                const geo = new T.BufferGeometry();
                geo.setAttribute('position', new T.BufferAttribute(read(prim.attributes.POSITION), 3));
                if (prim.attributes.NORMAL !== undefined) geo.setAttribute('normal', new T.BufferAttribute(read(prim.attributes.NORMAL), 3));
                else geo.computeVertexNormals();
                if (prim.attributes.TEXCOORD_0 !== undefined) geo.setAttribute('uv', new T.BufferAttribute(read(prim.attributes.TEXCOORD_0), 2));
                if (prim.indices !== undefined) geo.setIndex(new T.BufferAttribute(read(prim.indices), 1));
                geo.computeBoundingSphere();
                const mesh = new T.Mesh(geo, glbMaterial(json, prim.material));
                mesh.castShadow = false; mesh.receiveShadow = true;
                group.add(mesh);
            }
            cache.set(meshIndex, group); return group;
        }
        function branch(i) {
            const n = nodes[i], o = new T.Group();
            if (n.name) o.name = n.name;
            if (n.matrix) { o.matrixAutoUpdate = false; o.matrix.fromArray(n.matrix) }
            else {
                if (n.translation) o.position.fromArray(n.translation);
                if (n.rotation) o.quaternion.fromArray(n.rotation);
                if (n.scale) o.scale.fromArray(n.scale);
            }
            if (n.mesh !== undefined) o.add(primitives(n.mesh).clone());
            (n.children || []).forEach(c => o.add(branch(c)));
            return o;
        }
        const built = new T.Group();
        nodes.forEach((n, i) => { if (!hasParent.has(i)) built.add(branch(i)) });
        return built;
    }

    function footprintArea(b) { return (b.max.x - b.min.x) * (b.max.z - b.min.z) }
    function mapBoxes(group) {
        group.updateMatrixWorld(true);
        const boxes = [];
        group.traverse(o => {
            if (!o.isMesh) return;
            const b = new T.Box3().setFromObject(o);
            if (Number.isFinite(b.min.x) && Number.isFinite(b.max.x)) boxes.push(b);
        });
        if (!boxes.length) throw new Error('csmap.glb has no usable geometry');
        return boxes;
    }
    function floorBoxOf(boxes) {
        let max = 0; for (const b of boxes) max = Math.max(max, footprintArea(b));
        return boxes.filter(b => footprintArea(b) >= max * .25)
            .reduce((a, b) => b.max.y < a.max.y - 1e-4 ? b : a);
    }

    function assembleCSMap(buffer) {
        const { json, bin } = splitGLB(buffer);
        const group = glbScene(json, bin);
        group.name = 'CSMAP_GLTF';
        const authored = floorBoxOf(mapBoxes(group));
        const aw = authored.max.x - authored.min.x, ad = authored.max.z - authored.min.z;
        group.rotation.y = aw >= ad ? Math.PI / 2 : 0;
        group.scale.setScalar(CS_MAP_LENGTH / Math.max(aw, ad));
        const sized = floorBoxOf(mapBoxes(group));
        group.position.set(-(sized.min.x + sized.max.x) / 2, -sized.max.y, -(sized.min.z + sized.max.z) / 2);
        const boxes = mapBoxes(group), floor = floorBoxOf(boxes), area = footprintArea(floor);

        const colliders = new T.Group(); colliders.name = 'CSMAP_COLLIDERS';
        const cube = new T.BoxGeometry(1, 1, 1), hidden = new T.MeshBasicMaterial(), solids = [];
        for (const b of boxes) {
            const w = b.max.x - b.min.x, h = b.max.y - b.min.y, d = b.max.z - b.min.z;
            // Skip only: the ground floor itself, geometry that is entirely below
            // a step height (can be walked over), geometry that floats fully above
            // the player's head so it can never be touched, and paper-thin slivers.
            if (w * d >= area * .9 || b.max.y < CS_STEP || b.min.y > CS_HEAD || h < .18 || Math.min(w, d) < .12) continue;
            const mesh = new T.Mesh(cube, hidden);
            mesh.scale.set(w, h, d);
            mesh.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
            mesh.visible = false;
            colliders.add(mesh);
            solids.push({ x: mesh.position.x, z: mesh.position.z, w, d, h, minY: b.min.y, maxY: b.max.y, mesh });
        }
        const ladders = solids
            .filter(s => {
                // Only tall narrow solids that look like actual ladder rungs/frames.
                // Must be substantially vertical and very narrow in at least one dimension.
                if (s.h <= 2.0) return false;
                const minSide = Math.min(s.w, s.d), maxSide = Math.max(s.w, s.d);
                // Real ladders are thin (< 0.8) and have a reasonable rung-to-height ratio.
                return minSide < 0.8 && maxSide < 2.4 && s.h / minSide > 3.5;
            })
            .map(s => ({ x: s.x, z: s.z, w: s.w + 1.6, d: s.d + 1.6, minY: s.minY, maxY: s.maxY }));
        // Every solid upper face (roof, platform, or walkway) becomes a landing
        // surface. Include narrow bridges/planks by removing the area minimum.
        const platforms = solids
            .filter(s => s.maxY > CS_STEP)
            .map(s => ({ x: s.x, z: s.z, w: s.w + .85, d: s.d + .85, y: s.maxY }));
        csMap = { visual: group, colliders, solids, ladders, platforms, halfX: (floor.max.x - floor.min.x) / 2, halfZ: (floor.max.z - floor.min.z) / 2 };
        console.log('CS MAP LOADED:', CS_MAP_URL, 'play area', (csMap.halfX * 2).toFixed(1) + ' x ' + (csMap.halfZ * 2).toFixed(1), 'collision boxes', solids.length);
        return csMap;
    }

    function ensureCSMap() {
        if (!csMapJob) csMapJob = fetch(CS_MAP_URL, { cache: 'no-store' })
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status + ' while loading csmap.glb'); return r.arrayBuffer() })
            .then(assembleCSMap)
            .catch(err => { console.error('CS MAP LOAD FAILED:', err); csMap = null; return null });
        return csMapJob;
    }

    function addBoundary(halfX, halfZ) {
        const walls = [[0, -halfZ, halfX * 2 + 2, 1], [0, halfZ, halfX * 2 + 2, 1], [-halfX, 0, 1, halfZ * 2 + 2], [halfX, 0, 1, halfZ * 2 + 2]];
        for (const [x, z, w, d] of walls) addBox(x, 6, z, w, 12, d, 0x171d22).visible = false;
    }

    function clashLayoutFrom(halfX, halfZ, solids) {
        const lanes = [-.55, -.18, .18, .55].map(k => k * halfX);
        const cols = [-.28, -.1, .1, .28].map(k => k * halfX);
        const depth = halfZ * .84, cover = [];
        for (const s of solids) {
            if (s.h < 1.1 || s.w > halfX * 1.6 || s.d > halfZ * 1.6) continue;
            const ex = s.w / 2 + 1.1, ez = s.d / 2 + 1.1;
            for (const p of [{ x: s.x + ex, z: s.z }, { x: s.x - ex, z: s.z }, { x: s.x, z: s.z + ez }, { x: s.x, z: s.z - ez }]) {
                if (Math.abs(p.x) > halfX - 1.2 || Math.abs(p.z) > depth - 2.5) continue;
                if (!blocked(p.x, p.z, .6)) cover.push(p);
            }
        }
        const kept = cover.length > 40 ? cover.filter((_, i) => i % Math.ceil(cover.length / 40) === 0) : cover;
        return {
            lanes, cover: kept.length ? kept : [{ x: 0, z: 0 }], pushZ: halfZ * .45,
            blueSpawns: cols.map(x => freeNear(x, depth)), redSpawns: cols.map(x => freeNear(x, -depth))
        };
    }

    function makeClashArena() {
        clearWorld();
        if (!csMap) return makeClashFallback();
        scene.add(csMap.visual); scene.add(csMap.colliders);
        world = csMap.solids.slice();
        bounds = { minX: -csMap.halfX, maxX: csMap.halfX, minZ: -csMap.halfZ, maxZ: csMap.halfZ };
        addBoundary(csMap.halfX, csMap.halfZ);
        clashLayout = clashLayoutFrom(csMap.halfX, csMap.halfZ, csMap.solids);
    }

    function makeClashFallback() {
        const halfX = 15, halfZ = 23;
        bounds = { minX: -halfX, maxX: halfX, minZ: -halfZ, maxZ: halfZ };
        addBox(0, -.25, 0, halfX * 2, .5, halfZ * 2, 0x313a42, false);
        addBoundary(halfX, halfZ);
        clashLayout = clashLayoutFrom(halfX, halfZ, []);
    }


    function blocked(x, z, r = .48, feetY = 0) {
        if (x < bounds.minX + r || x > bounds.maxX - r || z < bounds.minZ + r || z > bounds.maxZ - r) return true;
        for (const o of world) {
            // Ladder colliders should not block horizontal movement, only exist for
            // detection. This prevents getting stuck inside a ladder.
            const minSide = Math.min(o.w, o.d);
            const isLadder = o.h !== undefined && o.h > 2.0 && minSide < 0.8 && o.h / minSide > 3.5;
            if (isLadder) continue;

            // A solid only stops blocking when the player is genuinely standing
            // ON TOP of it (on its roof/upper face). In that case we let them walk
            // across the surface. In EVERY other case — walls, crates, barriers and
            // boxes of ANY size — the solid behaves like a real object and blocks
            // horizontal movement so players and NPCs can't clip through it.
            const onTopOfIt = o.maxY !== undefined && feetY >= o.maxY - .18;
            // Also treat it as passable overhead if it sits fully above the player's
            // body (e.g. a roof beam) so you can walk underneath tall structures.
            const bodyTopY = feetY + 2.0;
            const fullyOverhead = o.minY !== undefined && o.minY >= bodyTopY;
            if (onTopOfIt || fullyOverhead) continue;

            if (Math.abs(x - o.x) < o.w / 2 + r && Math.abs(z - o.z) < o.d / 2 + r) return true;
        }
        return false
    }
    function freeNear(x, z, r = .6) {
        if (!blocked(x, z, r)) return { x, z };
        for (let ring = 1; ring <= 14; ring++) {
            const s = ring * 1.3;
            for (const [dx, dz] of [[-s, 0], [s, 0], [0, -s], [0, s], [-s, -s], [s, -s], [-s, s], [s, s], [0, -s * 2.5], [0, s * 2.5]])
                if (!blocked(x + dx, z + dz, r)) return { x: x + dx, z: z + dz };
        }
        return { x, z }
    }
    function moveXZ(pos, dx, dz, r = .48, feetY = 0) {
        // Sub-step long moves so a fast sprint can never tunnel straight through
        // a thin box in a single frame. Each slice is at most ~1/4 of the radius.
        const dist = Math.hypot(dx, dz);
        const steps = Math.max(1, Math.ceil(dist / (r * .5)));
        const sx = dx / steps, sz = dz / steps;
        for (let i = 0; i < steps; i++) {
            const nx = pos.x + sx, nz = pos.z + sz;
            // Try full diagonal first; fall back to sliding along whichever single
            // axis is still free. This stops corner clipping while keeping the
            // player able to slide smoothly along a wall instead of sticking.
            if (!blocked(nx, nz, r, feetY)) { pos.x = nx; pos.z = nz; }
            else if (!blocked(nx, pos.z, r, feetY)) pos.x = nx;
            else if (!blocked(pos.x, nz, r, feetY)) pos.z = nz;
            else break; // fully boxed in on this axis pair — stop, never clip through
        }
    }
    function nearestLadder(pos, feetY = pos.y - 1.75) {
        if (!csMap?.ladders?.length) return null;
        const hit = csMap.ladders
            .filter(l => feetY >= l.minY - .75 && feetY <= l.maxY + .5)
            .map(l => ({
                l,
                // Ladder zones already include a small safety margin. Keep the
                // final grab radius tight so W never grabs a distant object.
                d: Math.max(0, Math.abs(pos.x - l.x) - l.w / 2, Math.abs(pos.z - l.z) - l.d / 2)
            }))
            .sort((a, b) => a.d - b.d)[0];
        return hit && hit.d <= .36 ? hit.l : null;
    }
    function canStartLadder(ladder) {
        if (!ladder) return false;
        const toLadder = new T.Vector3(ladder.x - player.pos.x, 0, ladder.z - player.pos.z);
        const distance = toLadder.length();
        if (distance > 2.0) return false;
        // The ladder must be in front of the player, preventing W from grabbing
        // it through a wall or from elsewhere on the map.
        return distance < .15 || forward().dot(toLadder.normalize()) > .28;
    }
    function roofHeightAt(x, z, feetY, maxStep = .52) {
        if (!csMap?.platforms?.length) return null;
        let landing = null;
        for (const p of csMap.platforms) {
            // Check if the player XZ position is within this platform's footprint.
            if (Math.abs(x - p.x) > p.w / 2 || Math.abs(z - p.z) > p.d / 2) continue;
            // The platform's surface must be reachable — slightly above or below.
            // Allow stepping up onto narrow bridges and walking across them.
            if (p.y > feetY + maxStep || p.y < feetY - 1.75) continue;
            landing = Math.max(landing ?? -Infinity, p.y);
        }
        return landing;
    }
    function forward() { return new T.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)) }
    function right() { return new T.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)) }

    function weaponModel(type, first = false) {
        const g = new T.Group(), w = weapons[type], body = new T.Mesh(new T.BoxGeometry(first ? .24 : .4, first ? .17 : .27, first ? .72 : 1.35), mat(w.color, .32, .72));
        body.position.set(0, 0, -.42); g.add(body);
        const slide = new T.Mesh(new T.BoxGeometry(first ? .20 : .3, first ? .11 : .14, first ? .50 : .95), mat(0x11161a, .24, .9));
        slide.position.set(0, .14, -.47); g.add(slide);
        const barrel = new T.Mesh(new T.CylinderGeometry(first ? .035 : .06, first ? .04 : .065, first ? .38 : .78, 10), mat(0x0b0e10, .22, .9));
        barrel.rotation.x = Math.PI / 2; barrel.position.set(0, .03, -.88); g.add(barrel);
        const grip = new T.Mesh(new T.BoxGeometry(first ? .13 : .16, first ? .30 : .33, first ? .15 : .2), mat(0x14181b));
        grip.position.set(0, -.2, -.08); grip.rotation.x = -.2; g.add(grip);
        if (type > 0) { const mg = new T.Mesh(new T.BoxGeometry(.14, .36, .24), mat(0x101417, .45, .45)); mg.position.set(0, -.24, -.31); mg.rotation.x = .25; g.add(mg) }
        if (type === 3) { const pump = new T.Mesh(new T.BoxGeometry(.23, .12, .36), mat(0x1a1e21)); pump.position.set(0, -.1, -.62); g.add(pump) }
        return g
    }

    function addViewHands(weaponType = weaponIndex) {
        const skin = mat(0xb87858, .82, .02), sleeve = mat(0x252b30, .86, .03), glove = mat(0x9d6b4d, .72, .04);
        const rig = new T.Group(); rig.name = 'TWO_HAND_RIG';
        function seg(a, b, r, m) {
            const v = new T.Vector3().subVectors(b, a);
            const mesh = new T.Mesh(new T.CylinderGeometry(r, r, v.length(), 7), m);
            mesh.position.copy(a).add(b).multiplyScalar(.5);
            mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), v.normalize());
            return mesh;
        }
        function handBox(size, pos, rot, name) {
            const mesh = new T.Mesh(new T.BoxGeometry(size.x, size.y, size.z), skin);
            mesh.position.copy(pos); mesh.rotation.set(rot.x, rot.y, rot.z);
            mesh.name = name; mesh.castShadow = false; return mesh;
        }
        const rElbow = new T.Vector3(.48, -.56, .16);
        const rWrist = new T.Vector3(.025, -.205, -.075);
        rig.add(seg(rElbow, rWrist, .052, sleeve));
        const lElbow = new T.Vector3(-.46, -.55, .16);
        const lWrist = new T.Vector3(-.105, -.025, -.52);
        rig.add(seg(lElbow, lWrist, .052, sleeve));
        const handR = handBox(new T.Vector3(.16, .135, .235), new T.Vector3(.025, -.205, -.09), new T.Vector3(-.16, 0, -.04), 'RIGHT_GRIP_HAND');
        handR.scale.set(1, .92, 1);
        const indexR = handBox(new T.Vector3(.055, .065, .17), new T.Vector3(.095, -.105, -.145), new T.Vector3(-.18, 0, .12), 'RIGHT_TRIGGER_FINGER');
        const handL = handBox(new T.Vector3(.17, .125, .245), new T.Vector3(-.105, -.035, -.53), new T.Vector3(-.08, 0, .04), 'LEFT_SUPPORT_HAND');
        const supportFingers = handBox(new T.Vector3(.18, .07, .17), new T.Vector3(-.105, -.10, -.48), new T.Vector3(.10, 0, .03), 'LEFT_SUPPORT_FINGERS');
        const cuffR = new T.Mesh(new T.CylinderGeometry(.064, .064, .09, 8), glove);
        cuffR.rotation.z = Math.PI / 2; cuffR.position.set(.025, -.205, .005);
        const cuffL = new T.Mesh(new T.CylinderGeometry(.064, .064, .09, 8), glove);
        cuffL.rotation.z = Math.PI / 2; cuffL.position.set(-.105, -.025, -.395);
        rig.add(handR, indexR, handL, supportFingers, cuffR, cuffL);
        viewGun.add(rig);
        return rig;
    }

    function rebuildViewWeapon(i) { viewGun.clear(); viewGun.add(weaponModel(i, true)); addViewHands(i); viewGun.userData.reload = 0 }
    function limb(w, h, d, c) { const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat(c)); m.castShadow = true; return m }
    function humanoid(team = 'red') {
        const g = new T.Group(), parts = {};
        const shirt = team === 'blue' ? 0x2a5cad : 0x8f2830; const vest = team === 'blue' ? 0x16325c : 0x421c20;
        parts.pelvis = limb(.58, .32, .36, 0x20262b); parts.pelvis.position.y = .82; g.add(parts.pelvis);
        parts.torso = limb(.72, .84, .4, shirt); parts.torso.position.y = 1.38; g.add(parts.torso);
        parts.vest = limb(.75, .5, .43, vest); parts.vest.position.set(0, 1.4, -.02); g.add(parts.vest);
        parts.head = new T.Mesh(new T.SphereGeometry(.25, 12, 8), mat(0xc98d69)); parts.head.name = 'HEAD'; parts.head.userData.hitZone = 'head'; parts.head.position.y = 2.05; g.add(parts.head);
        const helmet = new T.Mesh(new T.SphereGeometry(.28, 12, 7, 0, Math.PI * 2, 0, Math.PI * .55), mat(0x1b2228, .5, .25)); helmet.position.y = 2.14; g.add(helmet);
        parts.armL = limb(.16, .7, .17, shirt); parts.armR = limb(.16, .7, .17, shirt);
        parts.legL = limb(.19, .78, .2, 0x20262b); parts.legR = limb(.19, .78, .2, 0x20262b);
        parts.armL.position.set(-.46, 1.38, 0); parts.armR.position.set(.46, 1.38, 0);
        parts.legL.position.set(-.2, .43, 0); parts.legR.position.set(.2, .43, 0);
        g.add(parts.armL, parts.armR, parts.legL, parts.legR);
        const gun = weaponModel(0); gun.scale.set(.42, .42, .42); gun.position.set(.42, 1.2, -.34); g.add(gun);
        g.userData.parts = parts; return g
    }

    const EMOTES = {
        laugh: { name: 'LAUGH', icon: '😂', desc: 'Hansi wala', color: 'yellow' },
        cry: { name: 'CRY', icon: '😭', desc: 'Rone wala', color: 'blue' },
        money: { name: 'MONEY BATH', icon: '💰', desc: 'Paison pe nahaa o', color: 'gold' },
        shoot: { name: 'SHOOT', icon: '🔫', desc: 'Shooting style', color: 'red' },
        dance: { name: 'DANCE', icon: '🕺', desc: 'Victory dance', color: 'purple' },
        flex: { name: 'HERO FLEX', icon: '😎', desc: 'Meri apni choice', color: 'green' }
    };

    function createPlayerEmoteMesh() {
        const g = humanoid(); g.name = 'PLAYER_EMOTE_CHARACTER'; g.visible = false; scene.add(g);
        emoteFx = new T.Group(); emoteFx.name = 'EMOTE_FX'; g.add(emoteFx);
        return g;
    }

    function buildEmoteMenu() {
        let box = document.getElementById('emoteMenu');
        if (box) return box;
        box = document.createElement('div'); box.id = 'emoteMenu'; box.className = 'emoteMenu hidden';
        box.innerHTML = `<div class="emotePanel"><div class="emoteTitle">EMOTES<span>PRESS B TO OPEN</span></div><div class="emoteGrid"></div><div class="emoteHint">CLICK AN EMOTE · MOVEMENT OR DAMAGE CANCELS</div></div>`;
        document.body.appendChild(box);
        const grid = box.querySelector('.emoteGrid');
        Object.entries(EMOTES).forEach(([id, e], i) => {
            const b = document.createElement('button'); b.className = 'emoteCard'; b.dataset.emote = id;
            b.innerHTML = `<div class="emoteIcon">${e.icon}</div><strong>${i + 1}. ${e.name}</strong><small>${e.desc}</small>`;
            b.onclick = ev => { ev.stopPropagation(); startEmote(id) }; grid.appendChild(b);
        });
        return box;
    }

    function openEmoteMenu() {
        if (!running || paused || phase !== 'fight' || !player.alive || emoteActive) return;
        if (keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD || keys.Space || keys.ShiftLeft || keys.ShiftRight || keys.KeyC || keys.KeyX) return;
        emoteMenuOpen = true; fireHeld = false; aiming = false; document.exitPointerLock?.();
        buildEmoteMenu().classList.remove('hidden');
    }

    function closeEmoteMenu() { emoteMenuOpen = false; document.getElementById('emoteMenu')?.classList.add('hidden') }
    function clearEmoteFx() { if (emoteFx) { while (emoteFx.children.length) emoteFx.remove(emoteFx.children[0]) } }

    function coinFx() {
        if (!emoteFx) return; clearEmoteFx();
        const cm = mat(0xffc83d, .3, .5);
        for (let i = 0; i < 12; i++) {
            const c = new T.Mesh(new T.CylinderGeometry(.10, .10, .035, 12), cm);
            c.rotation.z = Math.PI / 2; c.position.set((Math.random() - .5) * 1.8, .25 + Math.random() * 1.9, (Math.random() - .5) * .8);
            c.userData.a = Math.random() * 6.28; c.userData.r = .45 + Math.random() * .75; emoteFx.add(c)
        }
    }

    function setEmotePose(t) {
        if (!emoteMesh) return; const p = emoteMesh.userData.parts; if (!p) return;
        const w = Math.sin(t * 7), slow = Math.sin(t * 2.5);
        emoteMesh.position.copy(player.pos); emoteMesh.rotation.y = emoteBaseYaw;
        p.torso.rotation.set(0, 0, 0); p.head.rotation.set(0, 0, 0); p.armL.rotation.set(0, 0, 0); p.armR.rotation.set(0, 0, 0); p.legL.rotation.set(0, 0, 0); p.legR.rotation.set(0, 0, 0);
        if (currentEmote === 'laugh') {
            p.torso.rotation.z = Math.sin(t * 5) * .08; p.head.rotation.x = -.22 + Math.sin(t * 9) * .13;
            p.armL.rotation.z = -.9 - w * .18; p.armR.rotation.z = .9 + w * .18; p.armL.rotation.x = -.35; p.armR.rotation.x = -.35;
            p.legL.rotation.x = .12; p.legR.rotation.x = -.12;
        } else if (currentEmote === 'cry') {
            p.torso.rotation.z = Math.sin(t * 4) * .04; p.head.rotation.x = .22 + Math.sin(t * 8) * .06;
            p.armL.rotation.z = -.55; p.armR.rotation.z = .55; p.armL.rotation.x = -.8 + Math.sin(t * 5) * .12; p.armR.rotation.x = -.8 - Math.sin(t * 5) * .12;
            p.legL.rotation.x = .05; p.legR.rotation.x = -.05;
        } else if (currentEmote === 'money') {
            p.torso.rotation.z = Math.sin(t * 3) * .1; p.head.rotation.x = -.15;
            p.armL.rotation.z = -1.05 + Math.sin(t * 6) * .3; p.armR.rotation.z = 1.05 - Math.sin(t * 6) * .3;
            p.armL.rotation.x = -.2; p.armR.rotation.x = -.2; p.legL.rotation.x = .35 + Math.sin(t * 3) * .08; p.legR.rotation.x = -.35 - Math.sin(t * 3) * .08;
            if (emoteFx) emoteFx.children.forEach(c => { c.userData.a += .055; c.position.y = .3 + ((t * 1.5 + c.userData.a * 0.2) % 2); c.position.x = Math.cos(c.userData.a) * c.userData.r; c.position.z = Math.sin(c.userData.a) * .45; c.rotation.y = t * 5 });
        } else if (currentEmote === 'shoot') {
            p.torso.rotation.z = Math.sin(t * 8) * .035; p.head.rotation.y = Math.sin(t * 5) * .05;
            p.armR.rotation.x = -1.35 + Math.sin(t * 9) * .18; p.armL.rotation.x = -1.05 + Math.sin(t * 9) * .15;
            p.armR.rotation.z = .15; p.armL.rotation.z = -.15; p.legL.rotation.x = Math.sin(t * 5) * .08; p.legR.rotation.x = -Math.sin(t * 5) * .08;
        } else if (currentEmote === 'dance') {
            const d = Math.sin(t * 7); p.torso.rotation.z = d * .18; p.head.rotation.z = -d * .12;
            p.armL.rotation.z = -.9 - d * .65; p.armR.rotation.z = .9 + d * .65; p.armL.rotation.x = d * .5; p.armR.rotation.x = -d * .5;
            p.legL.rotation.x = Math.sin(t * 7) * .3; p.legR.rotation.x = -Math.sin(t * 7) * .3; emoteMesh.rotation.y = emoteBaseYaw + Math.sin(t * 2.8) * .22;
        } else {
            p.torso.rotation.z = Math.sin(t * 3) * .04; p.head.rotation.y = Math.sin(t * 3) * .08;
            p.armL.rotation.z = -1.15; p.armR.rotation.z = 1.15; p.armL.rotation.x = -.2 + Math.sin(t * 4) * .12; p.armR.rotation.x = -.2 - Math.sin(t * 4) * .12;
            p.legL.rotation.x = .08; p.legR.rotation.x = -.08;
        }
    }

    function startEmote(id = 'laugh') {
        if (emoteActive || !running || paused || phase !== 'fight' || !player.alive) return;
        if (keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD || keys.Space || keys.ShiftLeft || keys.ShiftRight || keys.KeyC || keys.KeyX) return;
        currentEmote = EMOTES[id] ? id : 'laugh'; closeEmoteMenu(); emoteActive = true; emoteT = 0; emoteBaseYaw = yaw; emotePrevHP = player.hp;
        fireHeld = false; aiming = false; reloadT = 0; slideT = 0; buildMode = false;
        document.getElementById('build').classList.remove('on'); document.getElementById('cross').classList.remove('aiming'); viewGun.visible = false;
        if (!emoteMesh) emoteMesh = createPlayerEmoteMesh(); else if (!scene.children.includes(emoteMesh)) scene.add(emoteMesh);
        if (!emoteFx) { emoteFx = new T.Group(); emoteMesh.add(emoteFx) } clearEmoteFx(); if (currentEmote === 'money') coinFx();
        emoteMesh.visible = true; emoteMesh.position.copy(player.pos); emoteMesh.rotation.y = emoteBaseYaw; document.exitPointerLock?.();
    }

    function cancelEmote() {
        closeEmoteMenu(); if (!emoteActive) return; emoteActive = false; emoteT = 0; if (emoteMesh) emoteMesh.visible = false; clearEmoteFx();
        viewGun.visible = true; camera.rotation.set(pitch, yaw, 0); camera.position.copy(player.pos); document.getElementById('cross').classList.remove('aiming');
    }

    function updateEmoteCamera(dt) {
        if (!emoteActive) return; emoteT += dt;
        const target = player.pos.clone().add(new T.Vector3(0, 1.25, 0));
        const behind = new T.Vector3(-Math.sin(emoteBaseYaw) * 4.4, 2.15, -Math.cos(emoteBaseYaw) * 4.4);
        const desired = target.clone().add(behind);
        camera.position.lerp(desired, Math.min(1, dt * 8)); camera.lookAt(target); setEmotePose(emoteT);
    }

    function attachHitboxes(mesh) {
        const body = new T.Mesh(new T.BoxGeometry(.82, .98, .62)); body.position.y = 1.38; body.name = 'BODY_HITBOX'; body.material.visible = false; body.userData.hitZone = 'body'; mesh.add(body);
        const legL = new T.Mesh(new T.BoxGeometry(.24, .82, .3)); legL.position.set(-.2, .43, 0); legL.name = 'LEG_L_HITBOX'; legL.material.visible = false; legL.userData.hitZone = 'leg'; mesh.add(legL);
        const legR = legL.clone(); legR.position.x = .2; legR.name = 'LEG_R_HITBOX'; mesh.add(legR);
        const head = new T.Mesh(new T.SphereGeometry(.30, 10, 8)); head.position.y = 2.05; head.name = 'HEAD_HITBOX'; head.material.visible = false; head.userData.hitZone = 'head'; mesh.add(head)
    }

    function makeBot(x, z, team, name, yawFace = 0, lane = 0) {
        const mesh = humanoid(team); mesh.position.set(x, 0, z); mesh.rotation.y = yawFace; scene.add(mesh); attachHitboxes(mesh);
        return { mesh, pos: mesh.position, hp: 100, armor: 30, alive: true, phase: Math.random() * 6, think: .08 + Math.random() * .18, shoot: .35 + Math.random() * .5, weapon: Math.min(round - 1, 2), targetPos: new T.Vector3(x, 0, z), name, team, strafeDir: Math.random() < .5 ? -1 : 1, dodgeT: 0, lane, state: 'push', stateT: .3 + Math.random() * .7, peekT: 0, aimYaw: yawFace,
            // Per-bot personality so each one feels like a distinct human player.
            skill: .40 + Math.random() * .25,        // firing accuracy 40%–65%
            pauseT: 0,                                // countdown for a "human" stop
            moveT: .6 + Math.random() * .8,           // how long it commits to moving
            reactT: .12 + Math.random() * .22 }       // reaction delay before firing
    }

    function clearSquad() { for (const u of squad) { if (u?.mesh) { if (u.mesh.userData.tag) u.mesh.userData.tag.remove(); scene.remove(u.mesh) } } squad = []; enemy = null }

    function spawnEnemy() {
        clearSquad();
        if (mode !== 'clash') {
            enemy = makeBot(0, -10, 'red', mode === 'online' ? 'PLAYER-OPPONENT' : 'AI WOLF', 0, 0);
            squad = [enemy]; return
        }
        const { lanes, blueSpawns, redSpawns } = clashLayout;
        player.pos.set(blueSpawns[0].x, 1.75, blueSpawns[0].z); yaw = 0; pitch = 0;
        const allies = ['BLUE-2', 'BLUE-3', 'BLUE-4'];
        for (let i = 1; i < 4; i++) squad.push(makeBot(blueSpawns[i].x, blueSpawns[i].z, 'blue', allies[i - 1], 0, lanes[i]));
        const foes = ['RED-1', 'RED-2', 'RED-3', 'RED-4'];
        for (let i = 0; i < 4; i++) squad.push(makeBot(redSpawns[i].x, redSpawns[i].z, 'red', foes[i], Math.PI, lanes[i]));
        enemy = squad.find(u => u.team === 'red') || null
    }

    function living(team) { return squad.filter(u => u.team === team && u.alive) }
    function clashAlive() { return { blue: living('blue').length + (player.alive ? 1 : 0), red: living('red').length } }
    function checkClashRound() {
        if (mode !== 'clash' || phase !== 'fight') return;
        const a = clashAlive(); updateTeamPanel();
        if (a.red <= 0) winRound(false); else if (a.blue <= 0) loseRound()
    }

    function lineClear(a, b) {
        const start = new T.Vector3(a.x, 1.45, a.z), d = new T.Vector3(b.x - start.x, 0, b.z - start.z), len = d.length();
        if (!len) return true; d.normalize();
        const ray = new T.Raycaster(start, d, 0, len);
        return ray.intersectObjects(world.map(o => o.mesh), false).length === 0
    }

    function initAudio() { if (!audio) { try { const AC = window.AudioContext || window.webkitAudioContext; audio = new AC } catch (e) { } } if (audio?.state === 'suspended') audio.resume(); loadMP3() }
    function loadMP3() {
        if (Object.keys(mp3).length) return;
        ['deagle', 'smg', 'rifle', 'shotgun', 'reload', 'hit', 'headshot', 'round', 'victory', 'defeat', 'step'].forEach(n => {
            const a = new Audio('assets/sounds/' + n + '.mp3'); a.preload = 'auto'; mp3[n] = a
        })
    }
    function playMP3(name, volume = .8) { initAudio(); const a = mp3[name]; if (!a) return; try { a.pause(); a.currentTime = 0; a.volume = volume; const q = a.play(); if (q?.catch) q.catch(() => { }) } catch (e) { } }
    function gunSound(kind) { playMP3(kind, kind === 'shotgun' ? .9 : .72) }
    function reloadSound() { playMP3('reload', .65) }

    function showDamageNumber(amount, head, target) {
        const src = target?.mesh || enemy?.mesh; if (!src) return;
        const el = document.createElement('div'); el.className = 'damageNumber ' + (head ? 'head' : 'body'); el.textContent = '-' + Math.max(1, Math.round(amount));
        document.getElementById('labels').appendChild(el);
        const v = src.position.clone(); v.y = head ? 2.55 : 2.15; v.project(camera);
        el.style.left = ((v.x * .5 + .5) * innerWidth) + 'px'; el.style.top = ((-v.y * .5 + .5) * innerHeight) + 'px';
        setTimeout(() => el.remove(), 650); requestAnimationFrame(() => el.classList.add('damageFly'));
        playMP3(head ? 'headshot' : 'hit', head ? .75 : .42)
    }

    function applyDamage(v, amount, att, head = false) {
        if (v === player && emoteActive) cancelEmote();
        if (!v || v.alive === false) return 0;
        const raw = Math.max(0, Number(amount) || 0);
        const armorBefore = Math.max(0, Number(v.armor) || 0);
        const absorbed = Math.min(armorBefore, raw * .5);
        const dealt = Math.max(0, raw - absorbed);
        v.armor = Math.max(0, armorBefore - absorbed);
        const oldHP = Math.max(0, Number(v.hp) || 0);
        v.hp = Math.max(0, oldHP - dealt);
        if (v !== player) showDamageNumber(dealt, head, v);
        if (v === player) {
            document.getElementById('damage').style.opacity = .55; setTimeout(() => document.getElementById('damage').style.opacity = 0, 100);
            shake = .07; if (!player.alive) viewGun.visible = false
        }
        updateHUD();
        if (v !== player && v.hp > 0) updateUnitLabel(v);
        if (v.hp <= 0) {
            v.hp = 0; v.alive = false; if (v.mesh) v.mesh.visible = false; if (v.mesh?.userData.tag) v.mesh.userData.tag.style.opacity = 0;
            if (v === player) {
                if (mode === 'clash') { player.alive = false; spectating = true; specIndex = 0; feed('YOU ARE DOWN • SCROLL TO SWITCH', 'bad'); checkClashRound() } else loseRound()
            } else if (mode === 'clash') {
                feed((v.team === 'red' ? 'ELIMINATED ' : 'ALLY DOWN • ') + v.name, v.team === 'red' ? 'good' : 'bad'); checkClashRound()
            } else if (v === enemy && phase === 'fight') winRound(head)
        }
        return dealt;
    }

    function muzzleFlash() {
        const p = new T.PointLight(0xffc36a, 3, 4); p.position.set(.38, -.30, -1.05); camera.add(p); setTimeout(() => camera.remove(p), 45);
        const f = new T.Mesh(new T.ConeGeometry(.11, .32, 7), new T.MeshBasicMaterial({ color: 0xffd36a, transparent: true, opacity: .9 }));
        f.rotation.x = -Math.PI / 2; f.position.set(.38, -.30, -1.02); camera.add(f); setTimeout(() => camera.remove(f), 55)
    }

    function tracer(dir) {
        const start = camera.position.clone().add(dir.clone().multiplyScalar(.5)), end = start.clone().add(dir.clone().multiplyScalar(35));
        const geo = new T.BufferGeometry().setFromPoints([start, end]);
        const line = new T.Line(geo, new T.LineBasicMaterial({ color: 0xffd36a, transparent: true, opacity: .9 }));
        scene.add(line); setTimeout(() => scene.remove(line), 45)
    }

    function unitFromMesh(obj) { let n = obj; while (n) { const u = squad.find(s => s.mesh === n); if (u) return u; n = n.parent } return null }

    function hitscan(origin, dir, w, owner) {
        const ray = new T.Raycaster(origin, dir, 0, w.range);
        if (owner === player) {
            const foes = squad.filter(u => u.alive && u.team === 'red');
            if (!foes.length) return false;
            const targets = []; foes.forEach(u => { u.mesh.updateMatrixWorld(true); u.mesh.traverse(o => { if (o.isMesh && (o.name === 'HEAD_HITBOX' || o.name === 'BODY_HITBOX' || o.name === 'LEG_L_HITBOX' || o.name === 'LEG_R_HITBOX')) targets.push(o) }) });
            const hits = ray.intersectObjects(targets, false);
            if (hits.length) {
                const enemyHit = hits[0], worldHits = ray.intersectObjects(world.map(o => o.mesh), false);
                if (worldHits.length && worldHits[0].distance < enemyHit.distance - .01) return false;
                const victim = unitFromMesh(enemyHit.object); if (!victim || !victim.alive) return false;
                const zone = enemyHit.object.userData.hitZone; const head = zone === 'head'; const leg = zone === 'leg';
                const dmg = head ? w.headDamage : leg ? w.legDamage : (w.damageMin !== undefined ? (w.damageMin + Math.random() * (w.damageMax - w.damageMin)) : w.damage);
                applyDamage(victim, dmg, player, head); hitMarker(head); return true
            }
        } else {
            const ownerTeam = owner.team || 'red';
            const worldHits = ray.intersectObjects(world.map(o => o.mesh), false);
            if (ownerTeam === 'red' && player.alive) {
                const pbox = new T.Mesh(new T.BoxGeometry(.9, 2.2, .7)); pbox.position.set(player.pos.x, player.pos.y - .65, player.pos.z); pbox.updateMatrixWorld();
                const hit = ray.intersectObject(pbox, false)[0];
                if (hit && (!worldHits.length || worldHits[0].distance > hit.distance - .01)) { applyDamage(player, w.damage, owner, false); return true }
            }
            const foes = squad.filter(u => u.alive && u.team !== ownerTeam && u !== owner);
            const targets = []; foes.forEach(u => { u.mesh.updateMatrixWorld(true); u.mesh.traverse(o => { if (o.isMesh && (o.name === 'HEAD_HITBOX' || o.name === 'BODY_HITBOX' || o.name === 'LEG_L_HITBOX' || o.name === 'LEG_R_HITBOX')) targets.push(o) }) });
            if (targets.length) {
                const hits = ray.intersectObjects(targets, false);
                if (hits.length && (!worldHits.length || worldHits[0].distance > hits[0].distance - .01)) {
                    const victim = unitFromMesh(hits[0].object); if (victim && victim.alive) { applyDamage(victim, w.damage, owner, false); return true }
                }
            }
        }
        return false
    }

    function hitMarker(head = false) {
        const h = document.getElementById('hitmarker'); h.textContent = head ? 'X' : '×'; h.className = head ? 'head' : 'body';
        h.style.opacity = 1; h.style.transform = 'translate(-50%,-50%) scale(' + (head ? 1.35 : 1) + ')';
        setTimeout(() => h.style.opacity = 0, 120); if (head) showAchievement()
    }

    function showAchievement() {
        const a = document.getElementById('achievement'); if (!a) return;
        a.classList.remove('hidden'); a.classList.remove('achPop'); void a.offsetWidth; a.classList.add('achPop');
        setTimeout(() => a.classList.add('hidden'), 2000)
    }

    function showRoundResult(won) {
        const r = document.getElementById('roundResult'); if (!r) return;
        document.getElementById('roundResultTitle').textContent = won ? 'VICTORY' : 'DEFEAT';
        document.getElementById('roundResultSub').textContent = won ? 'ROUND WON' : 'ROUND LOST';
        const fill = document.getElementById('roundFill'); fill.style.width = '0%';
        r.classList.remove('hidden'); r.classList.remove('resultPop'); void r.offsetWidth; r.classList.add('resultPop');
        setTimeout(() => fill.style.width = '100%', 80); setTimeout(() => r.classList.add('hidden'), 1900)
    }

    function shoot() {
        if (!player.alive || phase !== 'fight' || reloadT > 0 || shootCD > 0) return;
        const w = weapons[weaponIndex], a = ammo[weaponIndex]; if (a.m <= 0) { reload(); return }
        a.m--; shootCD = 1 / w.rate; fireAnimT = .16; initAudio(); gunSound(w.sound); muzzleFlash();
        const o = camera.position.clone(), base = aimAssist(forward());
        for (let i = 0; i < (w.pellets || 1); i++) {
            const d = base.clone(); d.x += (Math.random() - .5) * w.spread; d.y += (Math.random() - .5) * w.spread; d.z += (Math.random() - .5) * w.spread;
            tracer(d.normalize()); hitscan(o, d, w, player); if (mode !== 'clash' && !enemy?.alive) break
        }
        pitch = Math.max(-1.3, pitch + w.recoil * (aiming ? .55 : 1)); viewGun.position.z = -.68; setTimeout(() => viewGun.position.z = -.78, 60); updateHUD()
    }

    function reload() {
        const w = weapons[weaponIndex], a = ammo[weaponIndex]; if (reloadT > 0 || a.m >= w.mag || a.r <= 0) return;
        reloadT = w.reload; reloadAnimT = w.reload; reloadSound(); viewGun.userData.reload = 0
    }

    function updateWeaponAnimation(dt, moving, sprinting, crouch) {
        weaponAnimT += dt; fireAnimT = Math.max(0, fireAnimT - dt); reloadAnimT = Math.max(0, reloadAnimT - dt);
        const hands = viewGun.getObjectByName('TWO_HAND_RIG'); if (!hands) return;
        const cycle = moving ? (sprinting ? 18 : 11) : 2.2;
        const bob = moving ? Math.sin(weaponAnimT * cycle) : Math.sin(weaponAnimT * 2.2) * .15;
        const side = moving ? Math.cos(weaponAnimT * cycle) * .018 : 0;
        let targetY = -.34, targetZ = -.78; let rx = 0, rz = 0;
        if (aiming) { targetY = -.30; targetZ = -.72; rx = -.025; rz = 0 }
        else if (sprinting) { targetY = -.38; targetZ = -.70; rx = -.10; rz = -.025 }
        else if (slideT > 0 || crouch) { targetY = -.43; targetZ = -.70; rx = .04 }
        else { targetY = -.34; targetZ = -.78; rx = 0 }
        if (fireAnimT > 0) { const p = fireAnimT / .16; targetY += Math.sin(p * Math.PI) * .055; targetZ += Math.sin(p * Math.PI) * .10; rx += Math.sin(p * Math.PI) * .10 }
        if (reloadT > 0) { const p = 1 - reloadT / weapons[weaponIndex].reload; const r = Math.sin(p * Math.PI); targetY -= r * .12; targetZ += r * .08; rx += r * .42; rz += Math.sin(p * Math.PI * 2) * .08 }
        viewGun.position.x += (.38 + side - viewGun.position.x) * Math.min(1, dt * 12);
        viewGun.position.y += (targetY + bob * .035 - viewGun.position.y) * Math.min(1, dt * 12);
        viewGun.position.z += (targetZ + Math.abs(bob) * .018 - viewGun.position.z) * Math.min(1, dt * 12);
        viewGun.rotation.x += (rx - viewGun.rotation.x) * Math.min(1, dt * 12);
        viewGun.rotation.z += (rz - viewGun.rotation.z) * Math.min(1, dt * 12);
        hands.rotation.set(0, 0, 0); hands.position.set(0, 0, 0)
    }

    function startSlide() { if (!player.onGround || !player.alive || phase !== 'fight' || prone || slideT > 0 || slideCooldown > 0 || slideEnergy <= 0) return; slideT = .001; player.pos.y = .95 }
    function stopSlide(consumed = false) { if (slideT <= 0) return; slideT = 0; player.pos.y = prone ? .48 : (keys.KeyC ? .95 : 1.75); if (consumed || slideEnergy <= 0) { slideEnergy = 0; slideCooldown = 6 } }
    function updateSlide(dt) {
        if (slideCooldown > 0) { slideCooldown = Math.max(0, slideCooldown - dt); if (slideCooldown === 0) slideEnergy = slideMax }
        if (slideT > 0) {
            if (!keys.KeyX) { stopSlide(false); return }
            slideEnergy = Math.max(0, slideEnergy - dt); if (slideEnergy <= 0) { stopSlide(true); return }
            slideT = 1; player.pos.y = .95
        }
    }

    function updatePlayer(dt) {
        if (!player.alive || phase !== 'fight' || emoteActive) return;
        updateSlide(dt);
        const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), moving = !!(f || s), sprinting = (keys.ShiftLeft || keys.ShiftRight) && f > 0 && !aiming && moving && !prone && !slideT;
        const crouch = keys.KeyC && !sprinting && !slideT && !prone;
        const h = prone ? .48 : (slideT > 0 || crouch ? .95 : 1.75);
        let v = new T.Vector3(), feetY = player.pos.y - h;
        const ladderNearby = nearestLadder(player.pos, feetY);

        // W begins climbing only when the player is close to, and facing, the
        // ladder. Never treat a far-away map collider as a ladder.
        if (!keys.KeyW) ladderExitLatch = false;
        if (!climbing && keys.KeyW && !ladderExitLatch && !prone && !slideT && canStartLadder(ladderNearby))
            climbing = ladderNearby;

        if (climbing && keys.KeyW && !prone && !slideT) {
            player.pos.x += (climbing.x - player.pos.x) * Math.min(1, dt * 12);
            player.pos.z += (climbing.z - player.pos.z) * Math.min(1, dt * 12);
            feetY = player.pos.y - h;
            if (feetY + 5.6 * dt >= climbing.maxY - .04) {
                const exits = [[.8, 0], [-.8, 0], [0, .8], [0, -.8]];
                const exit = exits.map(([x, z]) => ({ x: climbing.x + x * (climbing.w / 2 + 1), z: climbing.z + z * (climbing.d / 2 + 1) }))
                    .find(p => !blocked(p.x, p.z, .38, climbing.maxY)) || { x: climbing.x, z: climbing.z };
                player.pos.set(exit.x, climbing.maxY + h + .04, exit.z);
                climbing = null; ladderExitLatch = true; player.onGround = true; jumpVel = 0;
            } else {
                player.pos.y = Math.max(climbing.minY, feetY + 5.6 * dt) + h;
                player.onGround = false; jumpVel = 0;
            }
        } else {
            climbing = null;
            if (moving) {
                v.copy(forward()).multiplyScalar(f).add(right().multiplyScalar(s)).normalize();
                let speed = sprinting ? 13 : 8.5; if (aiming) speed = .72; if (slideT > 0) speed = 12; if (prone) speed = 3.4;
                moveXZ(player.pos, v.x * speed * dt, v.z * speed * dt, .48, feetY);
                player.bob += dt * (sprinting ? 18 : 11); stepT -= dt; if (stepT <= 0) { stepT = sprinting ? .30 : .48; playMP3('step', sprinting ? .22 : .12) }
            }
            jumpVel -= 22 * dt; player.pos.y += jumpVel * dt;
            const floorY = roofHeightAt(player.pos.x, player.pos.z, player.pos.y - h) ?? 0;
            if (player.pos.y <= floorY + h) {
                player.pos.y = floorY + h; jumpVel = 0; player.onGround = true;
            } else {
                player.onGround = false;
            }
            // Keep ground-level minimum; elevated platforms set their own heights.
            if (!prone && !slideT && !crouch && floorY === 0) player.pos.y = Math.max(player.pos.y, 1.75);
        }
        camera.position.copy(player.pos);
        const bobAmp = prone ? 0 : sprinting ? .075 : moving ? .035 : 0;
        camera.position.y += Math.sin(player.bob) * bobAmp;
        const targetFov = aiming ? 58 : sprinting ? 84 : 78;
        camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 10); camera.updateProjectionMatrix();
        camera.rotation.set(pitch, yaw, 0);
        updateWeaponAnimation(dt, moving, sprinting, crouch || prone);
        if (fireHeld && !prone) shoot()
    }

    function nearestFoe() {
        let best = null, bestD = 1e9;
        for (const u of squad) { if (!u.alive || u.team !== 'red') continue; const d = u.pos.distanceTo(player.pos); if (d < bestD) { bestD = d; best = u } }
        return best
    }

    function aimAssist(dir) {
        const foe = nearestFoe(); if (!aiming || !foe) return dir;
        const to = foe.pos.clone().add(new T.Vector3(0, 1.35, 0)).sub(camera.position), dist = to.length();
        if (dist > 55) return dir;
        const nd = to.normalize(), dot = dir.dot(nd);
        if (dot > .975) return dir.lerp(nd, .12 * (1 - dist / 55)).normalize();
        return dir
    }

    function pickTarget(unit) {
        const enemyTeam = unit.team === 'red' ? 'blue' : 'red';
        let best = null, bestD = 1e9;
        if (enemyTeam === 'blue' && player.alive) { best = player; bestD = unit.pos.distanceTo(player.pos) }
        for (const u of squad) { if (!u.alive || u.team !== enemyTeam || u === unit) continue; const d = unit.pos.distanceTo(u.pos); if (d < bestD) { bestD = d; best = u } }
        return best;
    }

    function tgtPosOf(tgt) { return tgt === player ? player.pos : tgt.pos }

    function clashCoverNear(unit, toward) {
        const spots = clashLayout.cover;
        let best = spots[0], bestS = 1e9;
        for (const s of spots) {
            if (blocked(s.x, s.z, .55)) continue;
            const toEnemy = toward ? Math.hypot(s.x - toward.x, s.z - toward.z) : 0;
            const toSelf = Math.hypot(s.x - unit.pos.x, s.z - unit.pos.z);
            const laneBias = Math.abs(s.x - unit.lane) * 0.18;
            const score = toSelf * 1.1 + toEnemy * .55 + laneBias;
            if (score < bestS) { bestS = score; best = s }
        }
        return new T.Vector3(best.x, 0, best.z);
    }

    function separateBots(unit, dt) {
        let ox = 0, oz = 0;
        for (const o of squad) {
            if (o === unit || !o.alive) continue;
            const dx = unit.pos.x - o.pos.x, dz = unit.pos.z - o.pos.z, d = Math.hypot(dx, dz) || .001;
            if (d < 2.15) { const f = (2.15 - d) / d; ox += dx * f; oz += dz * f }
        }
        if (mode === 'clash' && player.alive && unit.team === 'blue') {
            const dx = unit.pos.x - player.pos.x, dz = unit.pos.z - player.pos.z, d = Math.hypot(dx, dz) || .001;
            if (d < 2.4) { const f = (2.4 - d) / d; ox += dx * f; oz += dz * f }
        }
        if (ox || oz) moveXZ(unit.pos, ox * dt * 6.5, oz * dt * 6.5, .48);
    }

    function clashGoal(unit, tgt) {
        const pushZ = unit.team === 'blue' ? -clashLayout.pushZ : clashLayout.pushZ;
        if (!tgt) return new T.Vector3(unit.lane || 0, 0, pushZ);
        const tp = tgtPosOf(tgt);
        const vis = lineClear(unit.pos, tp);
        const dist = unit.pos.distanceTo(tp);
        const rush = !player.alive || unit.hp > 55;
        const flank = (unit.strafeDir || 1) * (rush ? 3.6 : 5.2);
        if (!rush && unit.hp < 32) return clashCoverNear(unit, tp);
        if (!vis) return new T.Vector3(tp.x + flank, 0, tp.z + (unit.team === 'blue' ? -1.5 : 1.5));
        if (dist > 10) return new T.Vector3(tp.x + flank * .35, 0, tp.z);
        return new T.Vector3(tp.x + unit.strafeDir * 3.2, 0, tp.z + (unit.team === 'blue' ? 2.4 : -2.4));
    }

    function unitShoot(unit) {
        const tgt = pickTarget(unit); if (!tgt) return;
        const tp = tgtPosOf(tgt);
        const w = weapons[unit.weapon], o = unit.pos.clone(); o.y = 1.55;
        const aimPos = (tgt === player ? player.pos.clone() : tgt.pos.clone()).add(new T.Vector3(0, 1.35, 0));
        const d = aimPos.sub(o).normalize();
        // Small human aim wobble. The actual hit/miss ratio is governed by the
        // 40–65% firing chance in the AI tick, so keep this spread modest so a
        // shot that "should" land does, and a missed shot visibly goes wide.
        const missAmt = mode === 'clash' ? .045 : .08;
        d.x += (Math.random() - .5) * missAmt;
        d.y += (Math.random() - .5) * missAmt * .6;
        d.z += (Math.random() - .5) * missAmt;
        d.normalize();
        hitscan(o, d, w, unit)
    }

    // Bots have no gravity sim, so derive their feet height from whatever
    // roof/platform they are standing over. This is passed to moveXZ so the
    // SAME collision rules that apply to the player apply to bots — they can
    // walk on roofs they've climbed onto but can never clip through a box.
    function botFeetY(unit) {
        return roofHeightAt(unit.pos.x, unit.pos.z, unit.pos.y ?? 0) ?? 0;
    }
    // Snap the bot's body/visual to the surface height under it so it doesn't
    // float above crates or sink into raised platforms.
    function groundUnit(unit) {
        const floorY = roofHeightAt(unit.pos.x, unit.pos.z, unit.pos.y ?? 0) ?? 0;
        unit.pos.y = floorY;
        if (unit.mesh) unit.mesh.position.set(unit.pos.x, floorY, unit.pos.z);
    }

    function updateUnitLone(unit, dt) {
        unit.phase += dt * 9; unit.think -= dt; unit.shoot -= dt; unit.dodgeT -= dt;
        const dist = unit.pos.distanceTo(player.pos), visible = player.alive && dist < 32 && lineClear(unit.pos, player.pos);
        if (unit.think <= 0) {
            unit.think = .14 + Math.random() * .16; if (Math.random() < .12) unit.strafeDir *= -1;
            unit.targetPos = visible ? player.pos.clone() : new T.Vector3((Math.random() - .5) * 20, 0, (Math.random() - .5) * 20)
        }
        const dir = unit.targetPos.clone().sub(unit.pos); dir.y = 0;
        // Human pacing for the 1v1 bot too: move in bursts, then settle to aim.
        unit.moveT -= dt; unit.pauseT -= dt;
        if (unit.moveT <= 0 && unit.pauseT <= 0) {
            if (visible && dist < 20 && Math.random() < .45) unit.pauseT = .3 + Math.random() * .5;
            else unit.moveT = .5 + Math.random() * .9;
        }
        const holding = unit.pauseT > 0;
        if (!holding && dir.length() > 3) {
            dir.normalize();
            const strafe = new T.Vector3(-dir.z, 0, dir.x).multiplyScalar(Math.sin(unit.phase * 1.1) * .45 * unit.strafeDir);
            const sp = visible ? 2.4 : 3.4; moveXZ(unit.pos, (dir.x + strafe.x) * dt * sp, (dir.z + strafe.z) * dt * sp, .48, botFeetY(unit))
        }
        groundUnit(unit);
        if (visible && dist < 18 && unit.dodgeT <= 0 && Math.random() < dt * .7) { unit.dodgeT = .7; unit.strafeDir *= -1 }
        unit.mesh.rotation.y = Math.atan2(-dir.x, -dir.z);
        const p = unit.mesh.userData.parts, s = Math.sin(unit.phase) * .65;
        p.legL.rotation.x = s; p.legR.rotation.x = -s; p.armL.rotation.x = -s * .18; p.armR.rotation.x = s * .18;
        if (visible && unit.shoot <= 0) { unit.shoot = .60 + Math.random() * .55; if (Math.random() < .40) unitShoot(unit) }
        updateUnitLabel(unit);
    }

    function updateUnitClash(unit, dt) {
        unit.phase += dt * 11; unit.think -= dt; unit.shoot -= dt; unit.dodgeT -= dt; unit.stateT -= dt;
        const tgt = pickTarget(unit);
        const tp = tgt ? tgtPosOf(tgt) : null;
        const dist = tp ? unit.pos.distanceTo(tp) : 99;
        const visible = !!tp && dist < 42; 

        if (unit.think <= 0) {
            unit.think = .12 + Math.random() * .16;
            if (Math.random() < .28) unit.strafeDir *= -1;
            unit.state = (!player.alive || (visible && dist < 18)) ? 'hunt' : (unit.hp < 32 ? 'cover' : 'push');
            unit.targetPos = clashGoal(unit, tgt);
        }

        if (visible && dist < 16 && unit.dodgeT <= 0 && Math.random() < dt * 1.4) { unit.dodgeT = .4; unit.strafeDir *= -1 }

        const px = unit.pos.x, pz = unit.pos.z;
        const goal = unit.targetPos.clone();
        const dir = goal.clone().sub(unit.pos); dir.y = 0;
        const face = (tp ? tp.clone().sub(unit.pos) : dir.clone()); face.y = 0;

        // Human-like pacing: a real player doesn't sprint non-stop. Bots commit
        // to a short move, then briefly hold position (to aim / check corners).
        unit.moveT -= dt; unit.pauseT -= dt;
        if (unit.moveT <= 0 && unit.pauseT <= 0) {
            // When in a firefight they hold still more often to aim steadily.
            if (visible && dist < 24 && Math.random() < .5) { unit.pauseT = .35 + Math.random() * .55; }
            else { unit.moveT = .5 + Math.random() * .9; }
        }
        const holding = unit.pauseT > 0;

        if (!holding && dir.length() > 0.9) {
            dir.normalize();
            // Gentler strafe so they lean/peek rather than jitter side to side.
            const strafe = new T.Vector3(-dir.z, 0, dir.x).multiplyScalar((visible ? .8 : .45) * unit.strafeDir);
            // Grounded, believable footspeed close to the player's own walk/jog.
            let sp = visible ? 3.6 : 4.8;
            if (!player.alive) sp += .8;
            if (unit.state === 'cover') sp = 3.2;
            moveXZ(unit.pos, (dir.x + strafe.x) * dt * sp, (dir.z + strafe.z) * dt * sp, .48, botFeetY(unit));
        }
        groundUnit(unit);

        const moved = Math.hypot(unit.pos.x - px, unit.pos.z - pz);
        unit.stuck = (moved < 0.035 ? (unit.stuck || 0) + dt : 0);
        if (unit.stuck > 0.45) {
            unit.strafeDir *= -1;
            unit.targetPos = new T.Vector3(unit.pos.x + unit.strafeDir * 7, 0, unit.pos.z + (unit.team === 'blue' ? -5 : 5));
            unit.stuck = 0;
        }

        separateBots(unit, dt);

        if (face.length() > .15) {
            const want = Math.atan2(-face.x, -face.z);
            let dy = want - unit.mesh.rotation.y;
            while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
            unit.mesh.rotation.y += dy * Math.min(1, dt * 10);
        }

        const moving = dir.length() > 0.9;
        const p = unit.mesh.userData.parts, s = moving ? Math.sin(unit.phase) * .9 : Math.sin(unit.phase) * .08;
        p.legL.rotation.x = s; p.legR.rotation.x = -s;
        if (visible) { p.armR.rotation.x = -1.2; p.armL.rotation.x = -.9; p.armR.rotation.z = .12; p.armL.rotation.z = -.12 }
        else { p.armL.rotation.x = -s * .22; p.armR.rotation.x = s * .22; p.armR.rotation.z = 0; p.armL.rotation.z = 0 }

        if (visible && unit.shoot <= 0 && dist < 32) {
            // Human-like cadence: don't spray every frame — small burst pauses.
            unit.shoot = .32 + Math.random() * .30;
            // Firing accuracy held between 40% and 65% as requested. Each bot has
            // its own skill (unit.skill) so some feel sharper than others, and
            // aim degrades a little at long range like a real player.
            const rangeFalloff = dist > 20 ? .88 : 1;
            const acc = Math.max(.40, Math.min(.65, (unit.skill ?? .52) * rangeFalloff));
            if (Math.random() < acc) unitShoot(unit);
        }
        updateUnitLabel(unit);
    }

    function updateUnit(unit, dt) { if (!unit || !unit.alive) return; if (mode === 'clash') updateUnitClash(unit, dt); else updateUnitLone(unit, dt) }
    function updateEnemy(dt) { for (const u of squad) updateUnit(u, dt) }
    function enemyShoot() { if (enemy) unitShoot(enemy) }

    function updateUnitLabel(unit) {
        if (!unit?.mesh) return;
        let t = unit.mesh.userData.tag;
        if (!t) { t = document.createElement('div'); t.className = 'nameplate ' + (unit.team === 'blue' ? 'ally' : 'enemy'); document.getElementById('labels').appendChild(t); unit.mesh.userData.tag = t }
        const v = unit.mesh.position.clone(); v.y = 2.8; v.project(camera);
        t.style.transform = `translate(${(v.x * .5 + .5) * innerWidth}px,${(-v.y * .5 + .5) * innerHeight}px) translate(-50%,-50%)`;
        const tag = mode === 'clash' ? (unit.team === 'blue' ? 'BLUE • ' : 'RED • ') : '';
        t.textContent = tag + unit.name + '  ' + Math.max(0, Math.ceil(unit.hp)) + ' HP';
        t.style.opacity = unit.alive && v.z < 1 ? 1 : 0
    }

    function updateLabel() { if (mode === 'clash') { for (const u of squad) updateUnitLabel(u); return } updateUnitLabel(enemy) }
    function updateTeamPanel() {
        const el = document.getElementById('teamPanel'); if (!el) return;
        if (mode !== 'clash') { el.innerHTML = `<span class="blueTeam">BLUE TEAM</span><span class="redTeam">RED TEAM</span>`; return }
        const a = clashAlive(); el.innerHTML = `<span class="blueTeam">BLUE ${a.blue}/4</span><span class="redTeam">RED ${a.red}/4</span>`
    }

    function specTargets() { return squad.filter(u => u.team === 'blue' && u.alive) }
    function cycleSpec(dir) { const list = specTargets(); if (!list.length) { specIndex = 0; return } specIndex = (specIndex + dir + list.length) % list.length }
    function currentSpec() { const list = specTargets(); if (!list.length) return squad.find(u => u.alive) || null; if (specIndex >= list.length) specIndex = 0; return list[specIndex] }
    function followSpec(dt, k = 5.5) {
        const camT = currentSpec(); if (!camT) return;
        const behind = new T.Vector3(Math.sin(camT.mesh.rotation.y) * 3.6, 2.35, Math.cos(camT.mesh.rotation.y) * 3.6);
        camera.position.lerp(camT.pos.clone().add(behind), Math.min(1, dt * k));
        camera.lookAt(camT.pos.clone().add(new T.Vector3(0, 1.25, 0)))
    }

    async function resetRound() {
        cancelEmote(); closeEmoteMenu(); spectating = false; specIndex = 0;
        if (mode === 'clash') { await ensureCSMap(); makeClashArena(); } else makeLoneWolfArena();
        document.getElementById('modeTitle').textContent = mode === 'clash' ? 'CLASH SQUAD 4V4' : '1v1 LONEWOLF';
        document.getElementById('teamBadge').textContent = mode === 'clash' ? 'BLUE TEAM' : 'SOLO';
        document.getElementById('teamBadge').className = mode === 'clash' ? 'blueTeam' : '';
        document.getElementById('teamPanel').classList.toggle('clashVisible', mode === 'clash');
        if (mode !== 'clash') player.pos.set(0, 1.75, 10);
        player.hp = 100; player.armor = 50; player.alive = true; player.vel.set(0, 0, 0); viewGun.visible = true; hudRefreshT = 0;
        yaw = 0; pitch = 0; reloadT = 0; shootCD = 0; aiming = false; fireHeld = false; slideT = 0; slideEnergy = slideMax; slideCooldown = 0; prone = false;
        document.getElementById('cross').classList.remove('aiming'); buildMode = false; builds = [];
        spawnEnemy(); ammo = weapons.map(w => ({ m: w.mag, r: w.reserve }));
        phase = 'shop'; buyTime = 5; document.getElementById('shop').classList.remove('hidden'); renderShop();
        document.getElementById('hud').classList.remove('hidden'); document.getElementById('result').classList.add('hidden');
        updateTeamPanel(); updateHUD(); showRoundTitle(round)
    }

    function beginMatch(m) {
        cancelEmote(); closeEmoteMenu(); mode = m; round = 1; roundWins = 0; enemyWins = 0; coins = 500;
        // USP is the permanent, free starter weapon in every game mode.
        player.owned = new Set([0]); weaponIndex = 0; running = true; paused = false;
        document.getElementById('menu').classList.add('hidden'); document.getElementById('modeMenu').classList.add('hidden');
        document.getElementById('clashMenu').classList.add('hidden'); document.getElementById('queue').classList.add('hidden');
        initAudio(); resetRound()
    }

    function requestLock() { renderer.domElement.requestPointerLock?.() }
    function playThssh() { playMP3('round', .7) }

    function showRoundTitle(n) {
        const el = document.getElementById('roundState'); if (!el) return;
        el.textContent = n === 1 ? '1st ROUND' : n === 2 ? '2nd ROUND' : n === 3 ? '3rd ROUND' : n + 'th ROUND';
        el.classList.add('roundPop'); playMP3('round', .7); setTimeout(() => el.classList.remove('roundPop'), 1000)
    }

    function startFight() {
        // Never charge for the default USP.
        player.owned.add(0);
        if (!player.owned.has(weaponIndex)) weaponIndex = 0;
        phase = 'fight'; roundTime = 120; document.getElementById('shop').classList.add('hidden'); requestLock(); feed('FIGHT!', 'good'); updateHUD()
    }

    function awardRound(won) { const reward = won ? 700 : 100; coins += reward; return reward }
    function finishMatch() {
        const won = roundWins > enemyWins; phase = 'result'; document.exitPointerLock?.();
        document.getElementById('resultTitle').textContent = won ? 'MATCH WON' : 'MATCH LOST';
        document.getElementById('resultSub').textContent = (mode === 'clash' ? '4' : '5') + ' ROUNDS COMPLETE  •  ' + roundWins + ' — ' + enemyWins + '  •  ' + coins + ' COINS';
        document.getElementById('nextRound').textContent = 'BACK TO MENU'; document.getElementById('result').classList.remove('hidden')
    }

    function scheduleNextRound() {
        if (round >= (mode === 'clash' ? 4 : 5)) { finishMatch(); return }
        roundTransition = setTimeout(() => { round++; roundTransition = null; resetRound() }, 850)
    }

    function winRound(head = false) {
        if (phase !== 'fight') return;
        if (mode !== 'clash') {
            if (!enemy) return;
            enemy.hp = 0; enemy.alive = false; if (enemy.mesh) enemy.mesh.visible = false
        }
        phase = 'transition'; spectating = false; roundWins++; coins += awardRound(true); player.kills++;
        document.exitPointerLock?.(); feed(head ? 'HEADSHOT • ROUND WON' : 'ROUND WON • +700 COINS', 'good');
        playMP3('victory', .8); showRoundResult(true);
        if (round >= (mode === 'clash' ? 4 : 5)) { finishMatch(); return }
        scheduleNextRound()
    }

    function loseRound() {
        if (phase !== 'fight') return; phase = 'transition'; spectating = mode === 'clash'; enemyWins++; player.deaths++; player.alive = false;
        coins += awardRound(false); document.exitPointerLock?.(); feed('ROUND LOST • +100 COINS', 'bad');
        playMP3('defeat', .8); showRoundResult(false);
        if (round >= (mode === 'clash' ? 4 : 5)) { finishMatch(); return }
        scheduleNextRound()
    }

    function nextRound() {
        if (round >= (mode === 'clash' ? 4 : 5)) { leaveToMenu(); return }
        if (roundTransition) { clearTimeout(roundTransition); roundTransition = null }
        round++; resetRound()
    }

    function leaveToMenu() {
        cancelEmote(); closeEmoteMenu(); if (roundTransition) clearTimeout(roundTransition);
        running = false; phase = 'menu'; document.exitPointerLock?.();
        document.getElementById('hud').classList.add('hidden'); document.getElementById('result').classList.add('hidden');
        document.getElementById('pause').classList.add('hidden'); document.getElementById('shop').classList.add('hidden');
        document.getElementById('menu').classList.remove('hidden')
    }

    function disposeShopPrev() { if (!shopPrev) return; shopCanvases = []; shopPrev.renderer.dispose(); shopPrev = null }
    function ensureShopPrev() {
        if (shopPrev) return shopPrev;
        const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
        renderer.setPixelRatio(1); renderer.setClearColor(0x000000, 0); renderer.setSize(220, 110);
        const scene = new T.Scene();
        scene.add(new T.AmbientLight(0xffffff, .9));
        const d = new T.DirectionalLight(0xffffff, 1.4); d.position.set(2, 3, 4); scene.add(d);
        const camera = new T.PerspectiveCamera(38, 160 / 90, .05, 20); camera.position.set(0, .28, 2.15); camera.lookAt(0, .05, 0);
        shopPrev = { renderer, scene, camera, models: [] };
        return shopPrev;
    }

    function drawShopGun(canvas, i) {
        const prev = ensureShopPrev();
        while (prev.scene.children.length > 2) prev.scene.remove(prev.scene.children[2]);
        const gun = weaponModel(i, false);
        gun.rotation.set(.22, 1.05, .12); gun.position.set(0, 0, 0); gun.scale.set(1.15, 1.15, 1.15);
        prev.scene.add(gun);
        prev.renderer.setSize(canvas.width, canvas.height, false);
        prev.renderer.render(prev.scene, prev.camera);
        const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(prev.renderer.domElement, 0, 0, canvas.width, canvas.height);
    }

    function renderShop() {
        const box = document.getElementById('gunCards'); document.getElementById('coins').textContent = coins; box.innerHTML = ''; shopCanvases = [];
        weapons.forEach((w, i) => {
            const starter = i === 0;
            const owned = starter || player.owned.has(i), selected = i === weaponIndex, can = starter || coins >= w.price || owned;
            const price = starter ? 'STARTER · FREE' : 'PRICE ' + w.price;
            const label = starter ? 'EQUIPPED' : (owned ? (selected ? 'EQUIPPED' : 'EQUIP') : 'BUY ' + w.price);
            const d = document.createElement('div'); d.className = 'gunCard ' + (selected ? 'selected' : '');
            d.innerHTML = `<canvas class="gunPreview" width="220" height="110"></canvas><h3>${w.name}</h3><div class="stats">${price} · DMG ${w.damage} · HS ONE-SHOT · MAG ${w.mag}<br>FIRE ${w.rate}/s · RANGE ${w.range} · RELOAD ${w.reload}s</div><button ${starter || !can ? 'disabled' : ''}>${label}</button>`;
            const cv = d.querySelector('canvas'); shopCanvases.push({ cv, i }); drawShopGun(cv, i);
            d.querySelector('button').onclick = () => {
                if (starter) return;
                if (!owned) { if (coins < w.price) return; coins -= w.price; player.owned.add(i) }
                weaponIndex = i; rebuildViewWeapon(i); renderShop(); updateHUD()
            };
            box.appendChild(d);
        });
    }

    function updateHUD() {
        const w = weapons[weaponIndex], a = ammo[weaponIndex] || { m: w.mag, r: w.reserve };
        document.getElementById('weapon').textContent = w.name; document.getElementById('mag').textContent = a.m; document.getElementById('reserve').textContent = a.r;
        document.getElementById('hp').textContent = Math.max(0, Math.ceil(player.hp)) + ' HP'; document.getElementById('armor').textContent = Math.max(0, Math.ceil(player.armor)) + ' ARM';
        document.getElementById('hpbar').style.width = Math.max(0, player.hp) + '%'; document.getElementById('roundScore').textContent = roundWins + ' — ' + enemyWins;
        document.getElementById('stance').textContent = !player.alive && mode === 'clash' ? 'SPECTATE' : slideT > 0 ? 'SLIDE' : prone ? 'PRONE' : keys.KeyC ? 'CROUCH' : (keys.ShiftLeft || keys.ShiftRight) ? 'SPRINT' : 'READY';
        const sb = document.getElementById('slideBar'), sf = document.getElementById('slideFill');
        if (sb && sf) { const show = slideT > 0 || keys.KeyX; sb.classList.toggle('show', show); sf.style.width = Math.max(0, Math.min(100, slideEnergy / slideMax * 100)) }
        if (mode === 'clash') updateTeamPanel();
        const sh = document.getElementById('specHint');
        if (sh) {
            const on = mode === 'clash' && !player.alive && (phase === 'fight' || phase === 'transition');
            sh.classList.toggle('show', on);
            if (on) { const t = currentSpec(); sh.textContent = t ? 'SPECTATING ' + t.name + ' · SCROLL TO SWITCH' : 'SPECTATING' }
        }
    }

    function feed(t, c = 'neutral') { killFeed.unshift({ t, c }); killFeed.splice(5); document.getElementById('feed').innerHTML = killFeed.map(x => `<div class="msg ${x.c}">${x.t}</div>`).join('') }
    function setWeapon(i) { if (player.owned.has(i)) { weaponIndex = i; rebuildViewWeapon(i); updateHUD() } }

    buildEmoteMenu();

    function tick() {
        requestAnimationFrame(tick); const dt = Math.min(clock.getDelta(), .05);
        if (running && !paused) {
            if (phase === 'shop') { buyTime = Math.max(0, buyTime - dt); document.getElementById('buyTimer').textContent = buyTime.toFixed(1); if (buyTime <= 0) startFight() }
            if (phase === 'fight') {
                roundTime -= dt; if (roundTime <= 0) { roundTime = 0; loseRound() }
                if (emoteActive && (keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD || keys.Space || keys.ShiftLeft || keys.ShiftRight || keys.KeyC || keys.KeyX)) cancelEmote();
                shootCD = Math.max(0, shootCD - dt);
                if (reloadT > 0) { reloadT -= dt; if (reloadT <= 0) { const w = weapons[weaponIndex], a = ammo[weaponIndex], need = w.mag - a.m, take = Math.min(need, a.r); a.m += take; a.r -= take } }
                updatePlayer(dt); if (emoteActive) updateEmoteCamera(dt); updateEnemy(dt);
                if (mode === 'clash') { if (!player.alive) { spectating = true; followSpec(dt, 6.2) } checkClashRound() }
                document.getElementById('roundTimer').textContent = String(Math.floor(roundTime / 60)).padStart(2, '0') + ':' + String(Math.ceil(roundTime % 60)).padStart(2, '0');
                hudRefreshT -= dt;
                if (hudRefreshT <= 0) { hudRefreshT = .10; updateHUD() }
            } else if (phase === 'transition' && spectating) { followSpec(dt, 4) }
        }
        if (shake > 0) { shake -= dt; camera.position.x += (Math.random() - .5) * shake; camera.position.y += (Math.random() - .5) * shake }
        renderer.render(scene, camera)
    }

    addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight) });
    addEventListener('keydown', e => {
        keys[e.code] = true;
        if (emoteActive && (e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD' || e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyC' || e.code === 'KeyX' || e.code === 'KeyZ')) { cancelEmote(); return }
        if (e.code === 'KeyB' && !e.repeat) { openEmoteMenu(); return }
        if (e.code === 'Space' && !e.repeat) jump();
        if (e.code === 'KeyR' && !e.repeat) reload();
        if (e.code === 'KeyX' && !e.repeat) startSlide();
        if (e.code === 'KeyZ' && !e.repeat && phase === 'fight' && player.alive && !slideT) { prone = !prone; player.pos.y = prone ? .48 : 1.75; player.onGround = true; fireHeld = false; aiming = false }
        if (e.code === 'KeyQ' && !e.repeat) { buildMode = !buildMode; document.getElementById('build').classList.toggle('on', buildMode) }
        if (e.code === 'KeyE' && buildMode) buildRot++;
        if (e.code === 'Digit1') setWeapon(0); if (e.code === 'Digit2') setWeapon(1); if (e.code === 'Digit3') setWeapon(2); if (e.code === 'Digit4') setWeapon(3);
        if (emoteMenuOpen && ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].includes(e.code)) { const ids = ['laugh', 'cry', 'money', 'shoot', 'dance', 'flex']; startEmote(ids[Number(e.code.slice(-1)) - 1]); return }
        if (e.code === 'Escape' && running && phase === 'fight') { paused = true; document.getElementById('pause').classList.remove('hidden'); document.exitPointerLock?.() }
    });
    addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'KeyX' && slideT > 0) stopSlide(false) });
    addEventListener('blur', () => { for (const k in keys) keys[k] = false; fireHeld = false; aiming = false; document.getElementById('cross').classList.remove('aiming') });
    addEventListener('mousedown', e => {
        if (!running || paused) return;
        if (emoteMenuOpen) { if (!e.target.closest?.('#emoteMenu .emotePanel')) closeEmoteMenu(); return }
        if (emoteActive) { cancelEmote(); return }
        if (phase === 'fight' && !locked) requestLock();
        if (e.button === 0) { if (buildMode) placeBuild(); else { fireHeld = true; shoot() } }
        if (e.button === 2) { if (buildMode) { buildMode = false; document.getElementById('build').classList.remove('on') } aiming = true; requestLock(); document.getElementById('cross').classList.add('aiming') }
    });
    addEventListener('mouseup', e => { if (e.button === 0) fireHeld = false; if (e.button === 2) { aiming = false; document.getElementById('cross').classList.remove('aiming') } });
    addEventListener('contextmenu', e => e.preventDefault());
    addEventListener('mousemove', e => {
        if (emoteMenuOpen || emoteActive || !locked || paused || phase !== 'fight' || !player.alive) return;
        const sens = .0022;
        const mx = Number.isFinite(e.movementX) ? e.movementX : 0;
        const my = Number.isFinite(e.movementY) ? e.movementY : 0;
        yaw -= mx * sens;
        pitch -= my * sens;
        pitch = Math.max(-1.3, Math.min(1.3, pitch));
    });
    document.addEventListener('pointerlockchange', () => locked = document.pointerLockElement === renderer.domElement);
    renderer.domElement.addEventListener('click', () => { if (running && phase === 'fight' && !paused && !locked) requestLock(); });
    
    addEventListener('wheel', e => {
        if (!(mode === 'clash' && !player.alive && (phase === 'fight' || phase === 'transition'))) return;
        e.preventDefault(); cycleSpec(e.deltaY > 0 ? 1 : -1)
    }, { passive: false });

    const show = x => document.getElementById(x).classList.remove('hidden'), hide = x => document.getElementById(x).classList.add('hidden');
    let queueTimer = null;
    let hudRefreshT = 0;
    document.getElementById('lonewolf').onclick = () => { hide('menu'); show('modeMenu') };
    document.getElementById('fightAI').onclick = () => beginMatch('ai');
    document.getElementById('fightOnline').onclick = () => {
        hide('modeMenu'); show('queue'); let n = 0;
        if (queueTimer) clearInterval(queueTimer);
        queueTimer = setInterval(() => { n++; document.getElementById('queueText').textContent = 'Searching… ' + (n * 20) + '%'; if (n >= 5) { clearInterval(queueTimer); queueTimer = null; document.getElementById('queueTitle').textContent = 'NO LIVE PLAYER FOUND'; document.getElementById('queueText').textContent = 'Starting a practice opponent so the mode remains playable offline.'; setTimeout(() => beginMatch('online'), 800) } }, 500)
    };
    document.getElementById('cancelQueue').onclick = () => { if (queueTimer) { clearInterval(queueTimer); queueTimer = null } hide('queue'); show('modeMenu') };
    document.querySelectorAll('[data-back="menu"]').forEach(back => {
        back.onclick = () => {
            const parentScreen = back.closest('.screen');
            if (parentScreen) hide(parentScreen.id);
            show('menu');
        };
    });
    document.getElementById('tdm').onclick = () => { hide('menu'); show('clashMenu') };
    document.getElementById('nextRound').onclick = nextRound;
    document.getElementById('leaveMatch').onclick = leaveToMenu;
    document.getElementById('resume').onclick = () => { paused = false; hide('pause'); requestLock() };
    document.getElementById('leavePause').onclick = leaveToMenu;
    document.getElementById('clashQuick').onclick = () => { hide('clashMenu'); beginMatch('clash') };
    document.getElementById('clashAI').onclick = () => { hide('clashMenu'); beginMatch('clash') };

    function jump() { if (phase === 'fight' && player.alive && player.onGround && !keys.KeyC && !slideT) { jumpVel = 8.2; player.onGround = false } }
    function placeBuild() {
        if (!buildMode || phase !== 'fight' || !player.alive) return;
        const p = player.pos.clone().add(forward().multiplyScalar(3));
        const horizontal = buildRot % 2 === 0, w = horizontal ? 3.4 : .55, d = horizontal ? .55 : 3.4;
        if (blocked(p.x, p.z, .3) || p.x < bounds.minX + 1 || p.x > bounds.maxX - 1 || p.z < bounds.minZ + 1 || p.z > bounds.maxZ - 1) return;
        const m = addBox(p.x, 1.5, p.z, w, 3, d, 0x657782, true); m.material.transparent = true; m.material.opacity = .9;
        builds.push({ mesh: m }); buildMode = false; document.getElementById('build').classList.remove('on')
    }

    makeLoneWolfArena(); rebuildViewWeapon(0); ensureCSMap(); tick();
})();