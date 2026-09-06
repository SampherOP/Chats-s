/* HAMU STRIKE // SOLDIER GLB TEAM MODEL LOADER
 * Loads one soldier GLB and gives every NPC the same model.
 * Blue team -> blue tint, Red team -> red tint.
 * Keeps bot roots/userData intact so the AI/collision systems continue working.
 */
(() => {
  'use strict';
  const T = window.THREE;
  if (!T) return;

  const MODEL_URL = 'assets/models/blue_soldier_game_ready.glb';
  const TARGET_HEIGHT = 2.15;
  const models = new Map();
  let template = null;
  let scene = null;
  let camera = null;
  let loading = false;
  const attached = new WeakSet();

  const oldRender = T.WebGLRenderer.prototype.render;
  T.WebGLRenderer.prototype.render = function(s, c) {
    if (s && s.isScene) scene = s;
    if (c && c.isCamera) camera = c;
    return oldRender.apply(this, arguments);
  };

  function isBot(o) {
    return !!(o && o.isObject3D && o.userData && o.userData.parts && o.position);
  }

  function getTeam(o) {
    const u = o.userData || {};
    const raw = u.team || u.teamName || u.side || u.color || '';
    const s = String(raw).toLowerCase();
    if (s.includes('red')) return 'red';
    if (s.includes('blue')) return 'blue';

    // Existing game bots use coloured torso materials when an explicit team flag
    // is not exposed, so infer the side from the torso/head material.
    const torso = u.parts && (u.parts.torso || u.parts.body || u.parts.chest);
    const mat = torso && (Array.isArray(torso.material) ? torso.material[0] : torso.material);
    const c = mat && mat.color;
    if (c) {
      if (c.r > c.b * 1.18) return 'red';
      if (c.b > c.r * 1.18) return 'blue';
    }
    return 'blue';
  }

  function parseGLB(buffer) {
    const dv = new DataView(buffer);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Invalid GLB');
    let off = 12, json = null, bin = null;
    while (off + 8 <= buffer.byteLength) {
      const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true), start = off + 8;
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, len)));
      if (type === 0x004e4942) bin = buffer.slice(start, start + len);
      off = start + len;
    }
    if (!json || !bin) throw new Error('GLB chunks missing');

    const component = {
      5120:[Int8Array,1,'getInt8'], 5121:[Uint8Array,1,'getUint8'],
      5122:[Int16Array,2,'getInt16'], 5123:[Uint16Array,2,'getUint16'],
      5125:[Uint32Array,4,'getUint32'], 5126:[Float32Array,4,'getFloat32']
    };
    const channels = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};
    const read = index => {
      const a = json.accessors[index], bv = json.bufferViews[a.bufferView], inf = component[a.componentType];
      if (!inf) throw new Error('Unsupported accessor');
      const C = inf[0], bytes = inf[1], count = channels[a.type];
      const stride = bv.byteStride || bytes * count;
      const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
      if (stride === bytes * count) return new C(bin, base, a.count * count).slice();
      const out = new C(a.count * count), bview = new DataView(bin);
      const fn = inf[2];
      for (let i=0;i<a.count;i++) for (let j=0;j<count;j++)
        out[i*count+j] = bview[fn](base+i*stride+j*bytes, true);
      return out;
    };

    const material = idx => {
      const m = (json.materials || [])[idx] || {};
      const p = m.pbrMetallicRoughness || {};
      const c = p.baseColorFactor || [0.7,0.7,0.7,1];
      const mat = new T.MeshStandardMaterial({
        color:new T.Color(c[0],c[1],c[2]),
        roughness:p.roughnessFactor ?? .78,
        metalness:p.metallicFactor ?? .02,
        transparent:c[3] < .99, opacity:c[3], side:T.DoubleSide
      });
      return mat;
    };

    const meshCache = new Map();
    function makeMesh(mi) {
      if (meshCache.has(mi)) return meshCache.get(mi).clone(true);
      const group = new T.Group(), m = json.meshes[mi];
      for (const prim of m.primitives || []) {
        if (prim.mode !== undefined && prim.mode !== 4) continue;
        const g = new T.BufferGeometry();
        if (prim.attributes && prim.attributes.POSITION !== undefined)
          g.setAttribute('position', new T.BufferAttribute(read(prim.attributes.POSITION),3));
        if (prim.attributes && prim.attributes.NORMAL !== undefined)
          g.setAttribute('normal', new T.BufferAttribute(read(prim.attributes.NORMAL),3));
        else g.computeVertexNormals();
        if (prim.attributes && prim.attributes.TEXCOORD_0 !== undefined)
          g.setAttribute('uv',new T.BufferAttribute(read(prim.attributes.TEXCOORD_0),2));
        if (prim.indices !== undefined) g.setIndex(new T.BufferAttribute(read(prim.indices),1));
        g.computeBoundingSphere();
        const mesh = new T.Mesh(g, material(prim.material));
        mesh.castShadow = true; mesh.receiveShadow = true;
        group.add(mesh);
      }
      meshCache.set(mi,group);
      return group.clone(true);
    }

    const nodes = json.nodes || [], hasParent = new Set();
    nodes.forEach(n => (n.children || []).forEach(c => hasParent.add(c)));
    function node(i) {
      const n = nodes[i], g = new T.Group();
      g.name = n.name || ('soldier_node_'+i);
      if (n.matrix) { g.matrixAutoUpdate=false; g.matrix.fromArray(n.matrix); }
      else {
        if (n.translation) g.position.fromArray(n.translation);
        if (n.rotation) g.quaternion.fromArray(n.rotation);
        if (n.scale) g.scale.fromArray(n.scale);
      }
      if (n.mesh !== undefined) g.add(makeMesh(n.mesh));
      (n.children || []).forEach(c => g.add(node(c)));
      return g;
    }
    const root = new T.Group();
    nodes.forEach((n,i)=>{if(!hasParent.has(i))root.add(node(i));});
    root.updateMatrixWorld(true);
    const box = new T.Box3().setFromObject(root);
    const h = Math.max(.01, box.max.y-box.min.y);
    const scale = TARGET_HEIGHT/h;
    root.scale.setScalar(scale);
    root.position.y = -box.min.y*scale;
    root.updateMatrixWorld(true);
    return root;
  }

  function recolor(root, team) {
    const color = team === 'red' ? 0xd52b36 : 0x2563eb;
    root.traverse(o => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => {
        if (!m) return;
        m = m.clone();
        // Multiply the existing soldier palette so skin/gear stays recognizable
        // while the uniform becomes unambiguous for team identification.
        if (m.color) {
          const base = m.color.clone();
          const tint = new T.Color(color);
          m.color.setRGB(
            Math.min(1, base.r*.35 + tint.r*.65),
            Math.min(1, base.g*.35 + tint.g*.65),
            Math.min(1, base.b*.35 + tint.b*.65)
          );
        }
        o.material = m;
      });
    });
  }

  function attach(bot) {
    if (!template || !isBot(bot) || attached.has(bot)) return;
    const team = getTeam(bot);
    const model = template.clone(true);
    recolor(model, team);
    model.userData.isSoldierVisual = true;
    model.userData.teamVisual = team;
    model.position.set(0,0,0);
    model.rotation.set(0,0,0);
    bot.add(model);
    // Hide the old primitive body, but leave userData.parts intact for AI/aiming.
    const parts = bot.userData.parts || {};
    Object.values(parts).forEach(p => {
      if (p && p.isObject3D) p.visible = false;
    });
    bot.userData.soldierModel = model;
    bot.userData.modelTeam = team;
    attached.add(bot);
  }

  function scan() {
    if (!scene || !template) return;
    scene.traverse(o => { if (isBot(o)) attach(o); });
  }

  async function load() {
    if (loading || template) return;
    loading = true;
    try {
      const r = await fetch(MODEL_URL + '?v=1', {cache:'no-store'});
      if (!r.ok) throw new Error('Soldier model HTTP '+r.status);
      template = parseGLB(await r.arrayBuffer());
      models.set('base',template);
      scan();
      window.HAMU_SOLDIER_MODELS = { template, scan, attach, recolor };
    } catch (e) {
      console.warn('[HAMU] Soldier GLB load failed:', e.message || e);
    } finally { loading=false; }
  }

  window.HAMU_SOLDIER_MODELS = {load,scan,attach,recolor,get template(){return template;}};
  setTimeout(load, 500);
  setInterval(scan, 900);
})();
