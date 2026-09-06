/* HAMU STRIKE // ADVANCED FPS BOT AI v8
 * Runtime tactical NavMesh + A* + waypoint steering + raycast avoidance.
 * Also provides BT/Utility decisions, squad roles, shared enemy memory,
 * cover/flank selection, smooth aiming targets and stuck recovery.
 * Dependency: existing THREE + game scene. No CDN required.
 */
(() => {
  'use strict';
  if (!window.THREE) return;
  const T = THREE;
  const CFG = {
    cell: 0.85,
    maxCells: 62,
    rebuildEvery: 2.5,
    pathEvery: 0.45,
    waypointRadius: 0.62,
    bodyRadius: 0.48,
    eyeHeight: 1.45,
    visionRange: 38,
    visionFov: Math.cos(Math.PI * 0.68),
    stuckTime: 0.85,
    stuckDistance: 0.13,
    maxSpeed: 3.7,
    combatSpeed: 3.15,
    strafeSpeed: 2.8,
    rayLength: 1.35
  };

  let scene = null, camera = null, lastNow = performance.now(), navTimer = 0;
  const bots = new Set(), S = new WeakMap();
  const nav = { nodes: [], byKey: new Map(), minX: 0, minZ: 0, cols: 0, rows: 0, yLevels: [] };
  const worldMeshes = [], ray = new T.Raycaster();
  const blackboard = { enemies: new Map(), danger: [], deaths: [], shots: [], assignments: new Map() };
  let lastSceneSignature = '';

  // Capture the real game scene/camera. This works without touching game.js globals.
  const oldRender = T.WebGLRenderer.prototype.render;
  T.WebGLRenderer.prototype.render = function(s, c) {
    if (s && s.isScene) scene = s;
    if (c && c.isCamera) camera = c;
    return oldRender.apply(this, arguments);
  };

  const clamp = (v,a,b) => Math.max(a, Math.min(b,v));
  const dist = (a,b) => Math.hypot(a.x-b.x, a.z-b.z);
  const alive = o => !!(o && o.parent && o.visible !== false && !(o.userData && (o.userData.dead || o.userData.eliminated || o.userData.alive === false)) && ((o.userData && (o.userData.hp ?? o.userData.health)) === undefined || (o.userData.hp ?? o.userData.health) > 0));
  const botLike = o => !!(o && o.isObject3D && o.userData && o.userData.parts && o.position);
  const team = o => {
    const u=o?.userData||{}, e=u.team||u.teamName||u.side;
    if(typeof e==='string'){const x=e.toLowerCase(); if(x.includes('blue'))return'blue'; if(x.includes('red'))return'red';}
    const torso=u.parts?.torso, m=Array.isArray(torso?.material)?torso.material[0]:torso?.material, c=m?.color;
    if(c){if(c.b>c.r*1.18)return'blue'; if(c.r>c.b*1.18)return'red';}
    return'unknown';
  };
  const hp01=o=>clamp(Number(o?.userData?.hp ?? o?.userData?.health ?? 100)/100,0,1);
  const ammo01=o=>clamp(Number(o?.userData?.ammo ?? o?.userData?.mag ?? o?.userData?.clip ?? 20)/30,0,1);

  function captureBots(){
    if(!scene)return;
    scene.traverse(o=>{if(botLike(o))bots.add(o);});
    for(const b of [...bots])if(!b.parent){bots.delete(b);S.delete(b);}
  }
  function isCameraChild(o){let p=o;while(p){if(p===camera)return true;p=p.parent;}return false;}

  function rebuildWorld(){
    if(!scene)return;
    worldMeshes.length=0; scene.updateMatrixWorld(true);
    scene.traverse(o=>{
      if(!o.isMesh || botLike(o) || isCameraChild(o) || !o.visible)return;
      const n=(o.name||'').toLowerCase();
      if(/crosshair|weapon|label|ui|viewgun/.test(n))return;
      const box=new T.Box3().setFromObject(o); if(box.isEmpty())return;
      const w=box.max.x-box.min.x,d=box.max.z-box.min.z,h=box.max.y-box.min.y;
      if(w>.05&&d>.05&&h>.01)worldMeshes.push(o);
    });
  }

  function walkSurface(x,z,nearY){
    const from=new T.Vector3(x, Math.max(nearY+5, 20), z);
    ray.set(from,new T.Vector3(0,-1,0)); ray.near=0; ray.far=80;
    const hits=ray.intersectObjects(worldMeshes,true);
    let best=null, bestScore=Infinity;
    for(const h of hits){
      if(!h.face||!h.object)continue;
      const n=h.face.normal.clone().transformDirection(h.object.matrixWorld);
      if(n.y<0.62)continue; // not a floor/roof surface
      const y=h.point.y, score=Math.abs(y-(nearY??0));
      if(score<bestScore){bestScore=score;best={x,z,y};}
    }
    return best;
  }

  // Builds a lightweight runtime NavMesh grid from actual map floor/roof geometry.
  // Nodes only exist where a downward ray hits walkable geometry.
  function rebuildNav(){
    if(!scene||!worldMeshes.length)return;
    const box=new T.Box3(); worldMeshes.forEach(m=>box.expandByObject(m));
    if(box.isEmpty())return;
    const margin=2.5;
    let minX=box.min.x-margin,maxX=box.max.x+margin,minZ=box.min.z-margin,maxZ=box.max.z+margin;
    const spanX=Math.max(8,maxX-minX),spanZ=Math.max(8,maxZ-minZ),cell=Math.max(CFG.cell,Math.max(spanX,spanZ)/(CFG.maxCells-1));
    const cols=Math.min(CFG.maxCells,Math.ceil(spanX/cell)+1),rows=Math.min(CFG.maxCells,Math.ceil(spanZ/cell)+1);
    minX=(minX+maxX-cols*cell/2)*0.5; minZ=(minZ+maxZ-rows*cell/2)*0.5;
    nav.nodes=[];nav.byKey.clear();nav.minX=minX;nav.minZ=minZ;nav.cols=cols;nav.rows=rows;nav.cell=cell;
    // Use several reference heights so upper floors/roofs can be represented.
    const refs=[0,1.5,3,5,8,12];
    for(let zc=0;zc<rows;zc++)for(let xc=0;xc<cols;xc++){
      const x=minX+xc*cell,z=minZ+zc*cell;
      let candidates=[];
      for(const ry of refs){const s=walkSurface(x,z,ry);if(s)candidates.push(s);}
      candidates.sort((a,b)=>a.y-b.y);
      const unique=[];
      for(const c of candidates)if(!unique.some(q=>Math.abs(q.y-c.y)<0.35))unique.push(c);
      for(const c of unique){
        const k=`${xc},${zc},${Math.round(c.y*2)}`;
        if(nav.byKey.has(k))continue;
        const node={x:c.x,z:c.z,y:c.y,xc,zc,key:k,links:[]}; nav.byKey.set(k,node);nav.nodes.push(node);
      }
    }
    // Connect neighboring walkable cells. Diagonals are rejected if either side is blocked.
    const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
    const buckets=new Map();
    for(const n of nav.nodes){const k=`${n.xc},${n.zc}`;(buckets.get(k)||buckets.set(k,[]).get(k)).push(n);}
    for(const n of nav.nodes){
      for(const [dx,dz] of dirs){
        const arr=buckets.get(`${n.xc+dx},${n.zc+dz}`)||[];
        let best=null,bd=Infinity;
        for(const q of arr){const dy=Math.abs(q.y-n.y);if(dy>1.35)continue;const d=Math.hypot(q.x-n.x,q.z-n.z);if(d<bd){bd=d;best=q;}}
        if(!best)continue;
        if(dx&&dz){const a=buckets.get(`${n.xc+dx},${n.zc}`)||[],b=buckets.get(`${n.xc},${n.zc+dz}`)||[];if(!a.some(q=>Math.abs(q.y-n.y)<1.2)||!b.some(q=>Math.abs(q.y-n.y)<1.2))continue;}
        n.links.push(best);
      }
    }
    lastSceneSignature=`${worldMeshes.length}:${Math.round(box.min.x)}:${Math.round(box.max.x)}:${Math.round(box.min.z)}:${Math.round(box.max.z)}`;
  }

  function nearestNode(p){
    let best=null,score=Infinity;
    for(const n of nav.nodes){const dy=Math.abs(n.y-p.y);if(dy>2.0)continue;const d=Math.hypot(n.x-p.x,n.z-p.z)+dy*1.7;if(d<score){score=d;best=n;}}
    return best;
  }
  function nodeNear(p){
    let best=null,score=Infinity;
    for(const n of nav.nodes){const d=Math.hypot(n.x-p.x,n.z-p.z)+Math.abs(n.y-p.y)*1.2;if(d<score){score=d;best=n;}}
    return best;
  }
  function blockedSegment(a,b,r=.48){
    const d=Math.hypot(b.x-a.x,b.z-a.z),steps=Math.max(2,Math.ceil(d/.32));
    for(let i=1;i<steps;i++){
      const t=i/steps,x=a.x+(b.x-a.x)*t,z=a.z+(b.z-a.z)*t,y=a.y+(b.y-a.y)*t;
      const p=new T.Vector3(x,y+1.0,z); ray.set(p,new T.Vector3(0,-1,0));
      // A quick lateral collision probe: cast horizontal rays toward the segment.
      const dir=new T.Vector3(b.x-a.x,0,b.z-a.z).normalize();
      ray.set(new T.Vector3(x,y+.8,z),dir);ray.far=.01;
      // Horizontal ray is intentionally only supplementary; actual NavMesh controls movement.
      if(isPointInsideObstacle(x,z,y,r))return true;
    }
    return false;
  }
  function isPointInsideObstacle(x,z,y,r=.48){
    // Use ray parity-style probes instead of maintaining a second collider list.
    const probes=[new T.Vector3(x+r,y+.9,z),new T.Vector3(x-r,y+.9,z),new T.Vector3(x,y+.9,z+r),new T.Vector3(x,y+.9,z-r)];
    for(const p of probes){ray.set(p,new T.Vector3(0,-1,0));const h=ray.intersectObjects(worldMeshes,true)[0];if(h&&Math.abs(h.point.y-y)<1.0)continue;}
    return false;
  }

  function navPath(start,goal){
    if(!nav.nodes.length)return[];
    const a=nearestNode(start),b=nodeNear(goal);if(!a||!b)return[];
    const open=[a],came=new Map(),g=new Map([[a.key,0]]),closed=new Set();
    while(open.length){
      let bi=0;for(let i=1;i<open.length;i++){const ai=g.get(open[i].key)+Math.hypot(open[i].x-b.x,open[i].z-b.z);const ab=g.get(open[bi].key)+Math.hypot(open[bi].x-b.x,open[bi].z-b.z);if(ai<ab)bi=i;}
      const cur=open.splice(bi,1)[0];if(closed.has(cur.key))continue;closed.add(cur.key);
      if(cur===b){const out=[];let q=cur;while(q){out.push({x:q.x,y:q.y,z:q.z});q=came.get(q.key);}out.reverse();return smoothPath(out,start,goal);}
      for(const q of cur.links){if(closed.has(q.key))continue;const ng=g.get(cur.key)+Math.hypot(q.x-cur.x,q.z-cur.z)+Math.abs(q.y-cur.y)*1.8;if(ng<(g.get(q.key)??Infinity)){g.set(q.key,ng);came.set(q.key,cur);if(!open.includes(q))open.push(q);}}
    }
    return[];
  }
  function smoothPath(points,start,goal){
    if(!points.length)return[];const out=[];let anchor=start;
    for(let i=0;i<points.length;i++){
      let j=points.length-1;
      for(;j>i;j--){if(clear2D(anchor,points[j]))break;}
      out.push(points[j]);anchor=points[j];i=j;
    }
    if(!out.length||dist(out[out.length-1],goal)>.8)out.push({x:goal.x,y:goal.y??anchor.y,z:goal.z});
    return out;
  }
  function clear2D(a,b){
    // NavMesh is authoritative. This extra raycast catches thin visual walls/props.
    const d=Math.hypot(b.x-a.x,b.z-a.z);if(d<.7)return true;
    const dir=new T.Vector3(b.x-a.x,0,b.z-a.z).normalize();
    const origin=new T.Vector3(a.x,a.y+1.0,a.z);ray.set(origin,dir);ray.near=.05;ray.far=d-.2;
    const hit=ray.intersectObjects(worldMeshes,true).find(h=>h.object && h.point.y>Math.min(a.y,b.y)-.2);
    return !hit;
  }

  function eye(o){return new T.Vector3(o.position.x,o.position.y+CFG.eyeHeight,o.position.z);}
  function targetEye(o){return new T.Vector3(o.position.x,o.position.y+1.25,o.position.z);}
  function los(bot,target){
    if(!target)return false;const a=eye(bot),b=targetEye(target),d=b.clone().sub(a),len=d.length();if(len>.1){d.normalize();ray.set(a,d);ray.near=.04;ray.far=len-.12;const hit=ray.intersectObjects(worldMeshes,true)[0];if(hit)return false;}return true;
  }
  function visible(bot,target){
    const dx=target.position.x-bot.position.x,dz=target.position.z-bot.position.z,d=Math.hypot(dx,dz);if(d>CFG.visionRange)return false;
    const f=new T.Vector3(0,0,-1).applyQuaternion(bot.quaternion);f.y=0;f.normalize();const to=new T.Vector3(dx,0,dz).normalize();
    if(d>2.2&&f.dot(to)<CFG.visionFov)return false;return los(bot,target);
  }

  function enemies(bot){
    const t=team(bot),out=[];
    for(const b of bots){if(b===bot||!alive(b))continue;const bt=team(b);if(t!=='unknown'&&bt===t)continue;out.push(b);}
    // Existing game represents the human as the camera in both modes.
    if(camera&&t==='red')out.push(camera);
    if(camera&&t==='blue'&&(![...bots].some(b=>team(b)==='red')))out.push(camera);
    return out;
  }
  function rememberEnemy(e){if(!e||!e.position)return;blackboard.enemies.set(e,{x:e.position.x,y:e.position.y,z:e.position.z,t:performance.now()/1000});}
  function danger(x,z){let v=0,now=performance.now()/1000;for(const m of blackboard.enemies.values()){const d=Math.hypot(x-m.x,z-m.z),age=now-m.t;if(d<15&&age<7)v+=(1-d/15)*(1-age/7)*2;}for(const m of blackboard.deaths){const d=Math.hypot(x-m.x,z-m.z);if(d<12)v+=(1-d/12)*2.5;}return v;}

  function squadRole(bot){
    const all=[...bots].filter(alive).filter(b=>team(b)===team(bot));const idx=Math.max(0,all.indexOf(bot));return ['ASSAULT','FLANKER','SUPPORT','ANCHOR'][idx%4];
  }
  function utility(bot,e,s){
    const d=dist(bot.position,e.position),seen=visible(bot,e)?1:0, remembered=blackboard.enemies.has(e)?1:0;
    return (1-clamp(d/40,0,1))*2.1+seen*5+remembered*1.4+(1-hp01(e))*1.2+danger(e.position.x,e.position.z)*.25;
  }
  function chooseTarget(bot,s){let best=null,score=-Infinity;for(const e of enemies(bot)){if(!alive(e))continue;const u=utility(bot,e,s);if(u>score){score=u;best=e;}}return best;}

  function coverPoint(bot,target){
    let best=null,score=-Infinity;
    for(let i=0;i<30;i++){
      const a=Math.random()*Math.PI*2,d=3+Math.random()*9,q={x:bot.position.x+Math.cos(a)*d,z:bot.position.z+Math.sin(a)*d,y:bot.position.y};
      const n=nodeNear(q);if(!n)continue;const p={x:n.x,y:n.y,z:n.z};
      const threat=danger(p.x,p.z),exposure=clear2D(p,target.position)?1:0,spacing=dist(p,target.position);
      const sc=(1-exposure)*5+Math.min(spacing/10,2)-threat*1.4+(Math.random()*.25);
      if(sc>score){score=sc;best=p;}
    }return best;
  }
  function flankPoint(bot,target){
    let best=null,score=-Infinity;for(let i=0;i<24;i++){
      const a=(i/24)*Math.PI*2,d=5+Math.random()*8,p={x:target.position.x+Math.cos(a)*d,y:target.position.y,z:target.position.z+Math.sin(a)*d};
      const n=nodeNear(p);if(!n)continue;const q={x:n.x,y:n.y,z:n.z};const path=navPath(bot.position,q);if(!path.length)continue;
      const side=Math.abs(Math.sin(a));const sc=side*3+Math.min(dist(q,target.position)/12,2)-danger(q.x,q.z)*1.2-path.length*.035;if(sc>score){score=sc;best=q;}
    }return best;
  }

  function aim(bot,target,dt,s){
    if(!target)return;const dx=target.position.x-bot.position.x,dz=target.position.z-bot.position.z;
    let desired=Math.atan2(dx,dz); // Three.js character forward is normally -Z; compensate below.
    desired+=s.aimBias;
    let delta=((desired-bot.rotation.y+Math.PI*3)%(Math.PI*2))-Math.PI;
    const rate=1-Math.exp(-dt*(3.8+Math.min(5,dist(bot.position,target.position)/8)));
    bot.rotation.y+=delta*rate;
    const head=bot.userData?.parts?.head||bot.userData?.parts?.torso;
    if(head){const dy=(target.position.y+1.2)-(bot.position.y+1.0);head.rotation.x=clamp((head.rotation.x||0)+dy*.012,-.45,.45);}
    s.aimBiasT-=dt;if(s.aimBiasT<=0){s.aimBiasT=.25+Math.random()*.55;s.aimBias=(Math.random()-.5)*.055;}
  }

  function avoid(bot,desired){
    const origin=new T.Vector3(bot.position.x,bot.position.y+1.0,bot.position.z),f=new T.Vector3(desired.x,0,desired.z).normalize();
    const right=new T.Vector3(-f.z,0,f.x), left=right.clone().multiplyScalar(-1);let steer=new T.Vector3();
    const casts=[[f,1],[right,.75],[left,.75]];
    for(const [d,w] of casts){ray.set(origin,d);ray.near=.05;ray.far=CFG.rayLength;const h=ray.intersectObjects(worldMeshes,true)[0];if(h){const strength=1-h.distance/CFG.rayLength;steer.addScaledVector(new T.Vector3(-d.z,0,d.x),strength*w);}}
    if(steer.lengthSq()>.001)desired.add(steer.normalize().multiplyScalar(.8));return desired.normalize();
  }

  function stateFor(bot){
    let s=S.get(bot);if(!s){s={bt:'SEARCH',role:squadRole(bot),target:null,path:[],pi:0,goal:null,repath:0,decision:0,stuck:0,last:new T.Vector3(bot.position.x,bot.position.y,bot.position.z),aimBias:0,aimBiasT:.2,strafe:Math.random()<.5?-1:1,roam:null};S.set(bot,s);}return s;
  }

  // Public modular movement function requested by the project.
  function updateBotMovement(bot,dt){
    if(!alive(bot)||!nav.nodes.length)return;
    const s=stateFor(bot);s.repath-=dt;s.decision-=dt;
    if(s.decision<=0){
      s.decision=.18+Math.random()*.18;s.role=squadRole(bot);s.target=chooseTarget(bot,s);
      if(s.target&&visible(bot,s.target))rememberEnemy(s.target);
      const hp=hp01(bot),ammo=ammo01(bot),d=s.target?dist(bot.position,s.target.position):99,seen=s.target?visible(bot,s.target):false;
      const underPressure=danger(bot.position.x,bot.position.z);
      if(!s.target)s.bt='SEARCH';
      else if(hp<.25||underPressure>4.2)s.bt='RETREAT';
      else if(ammo<.12)s.bt='REPOSITION';
      else if(s.role==='FLANKER'&&d<28)s.bt='FLANK';
      else if(seen&&d<20)s.bt='ATTACK';
      else s.bt='PURSUE';
      let g=null;
      if(s.bt==='ATTACK'){
        // Strafe around the target rather than stand in front of it.
        const side=new T.Vector3(-(s.target.position.z-bot.position.z),0,s.target.position.x-bot.position.x).normalize().multiplyScalar(s.strafe*(2.5+Math.random()*2));
        g={x:s.target.position.x+side.x,y:bot.position.y,z:s.target.position.z+side.z};
      } else if(s.bt==='FLANK')g=flankPoint(bot,s.target);
      else if(s.bt==='RETREAT'||s.bt==='REPOSITION')g=coverPoint(bot,s.target)||{x:bot.position.x-s.strafe*5,y:bot.position.y,z:bot.position.z};
      else if(s.bt==='PURSUE')g={x:s.target.position.x,y:s.target.position.y,z:s.target.position.z};
      else if(!s.roam||dist(bot.position,s.roam)<1.2)s.roam=coverPoint(bot,s.target)||{x:bot.position.x+(Math.random()-.5)*8,y:bot.position.y,z:bot.position.z+(Math.random()-.5)*8};
      if(g){s.goal=g;s.path=navPath(bot.position,g);s.pi=0;s.repath=CFG.pathEvery;}
    }
    if(s.target&&alive(s.target))aim(bot,s.target,dt,s);
    if(s.repath<=0&&s.goal){s.path=navPath(bot.position,s.goal);s.pi=0;s.repath=CFG.pathEvery;}
    while(s.pi<s.path.length&&dist(bot.position,s.path[s.pi])<CFG.waypointRadius)s.pi++;
    if(s.pi>=s.path.length){s.goal=null;return;}
    const wp=s.path[s.pi],desired=new T.Vector3(wp.x-bot.position.x,0,wp.z-bot.position.z);if(desired.lengthSq()<.001)return;
    const dir=avoid(bot,desired),speed=(s.bt==='ATTACK'||s.bt==='FLANK')?CFG.combatSpeed:CFG.maxSpeed;
    const side=new T.Vector3(-dir.z,0,dir.x).multiplyScalar(s.bt==='ATTACK'?s.strafe*.65:0);
    const move=dir.multiplyScalar(speed*dt).add(side.multiplyScalar(dt));
    bot.position.x+=move.x;bot.position.z+=move.z;
    // Snap only the vertical coordinate to the current NavMesh surface when close.
    const n=nodeNear(bot.position);if(n&&Math.abs(n.y-bot.position.y)<1.25)bot.position.y+=clamp(n.y-bot.position.y,-speed*dt,speed*dt);
    if(s.target&&s.bt!=='RETREAT')bot.userData.aiAimTarget=s.target;
    // Stuck detector: a bot that barely moved while it has a path forces a new route.
    const moved=Math.hypot(bot.position.x-s.last.x,bot.position.z-s.last.z);if(moved<CFG.stuckDistance)s.stuck+=dt;else s.stuck=0;
    s.last.copy(bot.position);
    if(s.stuck>CFG.stuckTime){s.stuck=0;s.path=[];s.pi=0;s.repath=0;s.strafe*=-1;const escape=coverPoint(bot,s.target);if(escape){s.goal=escape;s.path=navPath(bot.position,escape);}}
  }

  function updateSquadMemory(dt){
    const now=performance.now()/1000;
    for(const b of bots){if(!alive(b))continue;const s=stateFor(b);if(s.target&&visible(b,s.target))rememberEnemy(s.target);}
    // Keep memory bounded; recent locations are enough for tactical decisions.
    if(blackboard.enemies.size>64){for(const [k,v] of blackboard.enemies){if(now-v.t>8)blackboard.enemies.delete(k);}}
  }

  function loop(now){
    const dt=clamp((now-lastNow)/1000,0,.05);lastNow=now;
    captureBots();
    if(scene){
      navTimer-=dt;
      if(navTimer<=0){navTimer=CFG.rebuildEvery;rebuildWorld();const box=new T.Box3();worldMeshes.forEach(m=>box.expandByObject(m));const sig=`${worldMeshes.length}:${Math.round(box.min.x)}:${Math.round(box.max.x)}:${Math.round(box.min.z)}:${Math.round(box.max.z)}`;if(sig!==lastSceneSignature||!nav.nodes.length)rebuildNav();}
      updateSquadMemory(dt);
      for(const b of bots)updateBotMovement(b,dt);
    }
    requestAnimationFrame(loop);
  }

  window.HAMU_ADVANCED_AI = {
    config:CFG,
    nav,
    blackboard,
    updateBotMovement,
    rebuildNav,
    rebuildWorld,
    getState:stateFor,
    getBots:()=>[...bots]
  };
  setTimeout(()=>{captureBots();rebuildWorld();rebuildNav();requestAnimationFrame(loop);},900);
})();
