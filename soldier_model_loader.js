/* HAMU STRIKE // SOLDIER GLB MODEL SYSTEM v1
 * Loads the supplied blue_soldier_game_ready.glb and replaces every bot's
 * placeholder body with the animated soldier. Blue stays BLUE; Red gets a
 * material-only team recolor while the gun/black gear remain dark.
 * The runtime controller keeps the original bot root/AI state intact.
 */
(() => {
  'use strict';
  const T = window.THREE;
  if (!T) return;

  const URL = 'assets/models/blue_soldier_game_ready.glb';
  const bots = new Set();
  const applied = new WeakSet();
  let scene = null;
  let source = null;
  let clips = [];
  let ready = false;
  const mixers = new WeakMap();
  const actions = new WeakMap();
  const oldRender = T.WebGLRenderer.prototype.render;
  T.WebGLRenderer.prototype.render = function(s, c) {
    if (s && s.isScene) scene = s;
    const out = oldRender.apply(this, arguments);
    try { scanAndApply(); } catch (_) {}
    return out;
  };

  const isBot = o => !!(o && o.isObject3D && o.userData && o.userData.parts && o.position);
  const team = o => {
    const u = o.userData || {};
    const v = String(u.team || u.teamName || u.side || '').toLowerCase();
    if (v.includes('red')) return 'red';
    if (v.includes('blue')) return 'blue';
    const torso = u.parts && u.parts.torso;
    const m = Array.isArray(torso?.material) ? torso.material[0] : torso?.material;
    const c = m?.color;
    if (c) return c.r > c.b * 1.15 ? 'red' : 'blue';
    return 'blue';
  };

  function readGLB(buf) {
    const v = new DataView(buf), chunks = {};
    if (v.getUint32(0, true) !== 0x46546c67) throw Error('Not GLB');
    let off = 12;
    while (off + 8 <= buf.byteLength) {
      const len = v.getUint32(off, true), type = v.getUint32(off + 4, true), start = off + 8;
      if (type === 0x4e4f534a) chunks.json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len)));
      if (type === 0x004e4942) chunks.bin = buf.slice(start, start + len);
      off = start + len;
    }
    return chunks;
  }

  const comps = {
    5120: [Int8Array, 1, 'getInt8'], 5121: [Uint8Array, 1, 'getUint8'],
    5122: [Int16Array, 2, 'getInt16'], 5123: [Uint16Array, 2, 'getUint16'],
    5125: [Uint32Array, 4, 'getUint32'], 5126: [Float32Array, 4, 'getFloat32']
  };
  const channels = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT2:4, MAT3:9, MAT4:16 };

  function accessor(json, bin) {
    const dv = new DataView(bin);
    return i => {
      const a=json.accessors[i], bv=json.bufferViews[a.bufferView], info=comps[a.componentType];
      const Ctor=info[0], bytes=info[1], ch=channels[a.type], stride=bv.byteStride||bytes*ch, base=(bv.byteOffset||0)+(a.byteOffset||0);
      if (stride===bytes*ch) return new Ctor(bin,base,a.count*ch).slice();
      const out=new Ctor(a.count*ch), get=dv[info[2]].bind(dv);
      for(let n=0;n<a.count;n++) for(let k=0;k<ch;k++) out[n*ch+k]=get(base+n*stride+k*bytes,true);
      return out;
    };
  }

  function material(json, index) {
    const m=(json.materials||[])[index]||{}, p=m.pbrMetallicRoughness||{};
    const c=p.baseColorFactor||[.65,.65,.65,1];
    return new T.MeshStandardMaterial({color:new T.Color(c[0],c[1],c[2]),opacity:c[3],transparent:c[3]<1,roughness:p.roughnessFactor??.8,metalness:p.metallicFactor??0,side:T.DoubleSide});
  }

  function build(json, bin) {
    const read=accessor(json,bin), nodes=json.nodes||[], cache=new Map(), hasParent=new Set();
    nodes.forEach(n=>(n.children||[]).forEach(c=>hasParent.add(c)));
    function mesh(mi){
      if(cache.has(mi)) return cache.get(mi).clone(true);
      const g=new T.Group();
      for(const p of (json.meshes[mi].primitives||[])){
        if(p.mode!==undefined&&p.mode!==4)continue;
        const geo=new T.BufferGeometry();
        geo.setAttribute('position',new T.BufferAttribute(read(p.attributes.POSITION),3));
        if(p.attributes.NORMAL!==undefined)geo.setAttribute('normal',new T.BufferAttribute(read(p.attributes.NORMAL),3));else geo.computeVertexNormals();
        if(p.attributes.TEXCOORD_0!==undefined)geo.setAttribute('uv',new T.BufferAttribute(read(p.attributes.TEXCOORD_0),2));
        if(p.indices!==undefined)geo.setIndex(new T.BufferAttribute(read(p.indices),1));
        geo.computeBoundingSphere();
        const me=material(json,p.material); const m=new T.Mesh(geo,me);m.castShadow=true;m.receiveShadow=true;g.add(m);
      }
      cache.set(mi,g);return g.clone(true);
    }
    function branch(i){
      const n=nodes[i],o=new T.Group();o.name=n.name||('node_'+i);
      if(n.matrix){o.matrixAutoUpdate=false;o.matrix.fromArray(n.matrix);}else{if(n.translation)o.position.fromArray(n.translation);if(n.rotation)o.quaternion.fromArray(n.rotation);if(n.scale)o.scale.fromArray(n.scale);}
      if(n.mesh!==undefined)o.add(mesh(n.mesh));
      (n.children||[]).forEach(c=>o.add(branch(c)));
      return o;
    }
    const root=new T.Group();root.name='HAMU_SOLDIER';
    nodes.forEach((n,i)=>{if(!hasParent.has(i))root.add(branch(i));});

    const builtClips=[];
    for(const a of (json.animations||[])){
      const tracks=[];
      for(const ch of a.channels||[]){
        const node=nodes[ch.target.node], sampler=a.samplers[ch.sampler], path=ch.target.path;
        if(!node||!sampler||!path)continue;
        const times=read(sampler.input), vals=read(sampler.output), name=node.name||('node_'+ch.target.node);
        let track=null;
        if(path==='rotation')track=new T.QuaternionKeyframeTrack(name+'.quaternion',times,vals);
        else if(path==='translation')track=new T.VectorKeyframeTrack(name+'.position',times,vals);
        else if(path==='scale')track=new T.VectorKeyframeTrack(name+'.scale',times,vals);
        if(track)tracks.push(track);
      }
      if(tracks.length)builtClips.push(new T.AnimationClip(a.name||'Idle',-1,tracks));
    }
    return {root,clips:builtClips};
  }

  function recolor(root, which) {
    const red=new T.Color(0xb51f2a), blue=new T.Color(0x245db5);
    root.traverse(o=>{
      if(!o.isMesh)return;
      const mats=Array.isArray(o.material)?o.material:[o.material];
      mats.forEach(m=>{
        if(!m?.color)return;
        const c=m.color;
        // Preserve gun, helmet, boots, gloves and very dark equipment.
        if(c.r<.16&&c.g<.16&&c.b<.16)return;
        const blueish=c.b>c.r*1.05 || (c.b>c.g*.95&&c.b>.25);
        if(blueish)m.color.copy(which==='red'?red:blue);
        if(which==='red'&&c.r>c.b*1.18&&c.g<.55)m.color.set(0x8d1d28);
      });
    });
  }

  function attach(bot) {
    if(!ready||applied.has(bot)||!source)return;
    const model=source.root.clone(true);
    model.traverse(o=>{if(o.isMesh){o.material=Array.isArray(o.material)?o.material.map(m=>m.clone()):o.material.clone();o.castShadow=true;o.receiveShadow=true;}});
    recolor(model,team(bot));
    model.position.set(0,0,0);model.rotation.set(0,0,0);
    bot.updateMatrixWorld(true);
    const oldBox=new T.Box3().setFromObject(bot), newBox=new T.Box3().setFromObject(model);
    const oldH=Math.max(.1,oldBox.max.y-oldBox.min.y), newH=Math.max(.1,newBox.max.y-newBox.min.y);
    const scale=clamp(oldH/newH*.98,.72,1.25);model.scale.setScalar(scale);
    // The model root is positioned at the bot root; scale around its own origin.
    bot.add(model);
    bot.userData.__hamuSoldierModel=model;
    bot.userData.__hamuSoldierTeam=team(bot);
    applied.add(bot);
    const mixer=new T.AnimationMixer(model);mixers.set(bot,mixer);
    const map={};for(const clip of source.clips){const a=mixer.clipAction(clip);a.loop=T.LoopRepeat;a.clampWhenFinished=false;map[clip.name.toLowerCase()]=a;}
    actions.set(bot,map);
    play(bot,'Idle');
    // Keep original logic parts available to game.js but invisible.
    const parts=bot.userData.parts||{};Object.values(parts).forEach(p=>{if(p&&p.isObject3D&&p!==model)p.visible=false;});
  }

  function play(bot,name){
    const map=actions.get(bot);if(!map)return;const key=name.toLowerCase();const next=map[key]||map.idle;if(!next)return;
    const cur=bot.userData.__hamuAnim;if(cur===next)return;
    if(cur)cur.fadeOut(.16);next.reset().fadeIn(.16).play();bot.userData.__hamuAnim=next;
  }

  function updateAnimations(dt){
    for(const bot of bots){const m=mixers.get(bot);if(!m)continue;const model=bot.userData.__hamuSoldierModel;const v=bot.userData.__hamuPrevPos;
      let speed=0;if(v){speed=Math.hypot(bot.position.x-v.x,bot.position.z-v.z)/Math.max(dt,.001);}else bot.userData.__hamuPrevPos=bot.position.clone();
      bot.userData.__hamuPrevPos.copy(bot.position);
      play(bot,speed>2.9?'Run':speed>.18?'Walk':'Idle');m.update(dt);
    }
  }

  function scanAndApply(){
    if(!scene)return;
    scene.traverse(o=>{if(isBot(o))bots.add(o);});
    if(!ready)return;
    for(const b of bots)attach(b);
  }

  async function load(){
    try{
      const r=await fetch(URL+'?v=1');if(!r.ok)throw Error('Soldier GLB HTTP '+r.status);
      source=build(...Object.values(readGLB(await r.arrayBuffer())));ready=true;scanAndApply();
    }catch(e){console.warn('[HAMU SOLDIER] Model not found yet:',e.message);}
  }

  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  setInterval(()=>{try{const now=performance.now();const dt=Math.min(.05,(now-(window.__hamuSoldierT||now))/1000);window.__hamuSoldierT=now;scanAndApply();updateAnimations(dt);}catch(_){}},33);
  load();
  window.HAMU_SOLDIER_MODELS={reload:load,apply:scanAndApply};
})();
