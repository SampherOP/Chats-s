/* HAMU STRIKE // BOT AI OVERHAUL v10
 * One authoritative runtime controller for the NPCs.
 * - Ground-first navigation: never uses a wall/roof top as the default floor.
 * - Grid A* over the actual map with clearance around tall obstacles.
 * - Waypoint steering + front/left/right ray avoidance.
 * - Behavior/utility decisions: attack, pursue, flank, cover, retreat, search.
 * - Shared enemy memory and squad roles.
 * - Smooth LERP aiming; no instant aimbot snaps.
 * - Stuck recovery and physical de-penetration.
 * - Runs after the game's own frame so it becomes the final movement authority.
 */
(() => {
  'use strict';
  const T = window.THREE;
  if (!T || !T.WebGLRenderer) return;

  const C = {
    cell: 0.9,
    maxGrid: 54,
    body: 0.48,
    speed: 3.25,
    combatSpeed: 2.75,
    waypoint: 0.58,
    repath: 0.55,
    vision: 42,
    fov: Math.cos(Math.PI * 0.64),
    obstacleRay: 1.25,
    stuckAfter: 0.9,
    groundSearch: 7,
    groundSnap: 2.8,
    floorHeight: 0.7
  };

  let scene = null, camera = null, rendererSeen = false;
  let last = performance.now(), navDirty = true, navAt = 0;
  const bots = new Set(), states = new WeakMap();
  const meshes = [], obstacles = [];
  const ray = new T.Raycaster();
  const tmp = new T.Vector3(), tmp2 = new T.Vector3();
  const memory = new Map();

  const oldRender = T.WebGLRenderer.prototype.render;
  T.WebGLRenderer.prototype.render = function(s, c) {
    if (s && s.isScene) scene = s;
    if (c && c.isCamera) camera = c;
    const out = oldRender.apply(this, arguments);
    rendererSeen = true;
    return out;
  };

  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const d2=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  const alive=o=>!!(o&&o.parent&&o.visible!==false&&!(o.userData&&(o.userData.dead||o.userData.eliminated||o.userData.alive===false)));
  const isBot=o=>!!(o&&o.isObject3D&&o.userData&&o.userData.parts&&o.position);
  const cameraChild=o=>{let p=o;while(p){if(p===camera)return true;p=p.parent;}return false;};

  function team(o){
    const u=o?.userData||{}, v=u.team||u.teamName||u.side;
    if(typeof v==='string'){
      const s=v.toLowerCase();
      if(s.includes('blue'))return'blue';
      if(s.includes('red'))return'red';
    }
    const torso=u.parts?.torso, m=Array.isArray(torso?.material)?torso.material[0]:torso?.material, col=m?.color;
    if(col){if(col.b>col.r*1.15)return'blue';if(col.r>col.b*1.15)return'red';}
    return'unknown';
  }

  function capture(){
    if(!scene)return;
    scene.traverse(o=>{if(isBot(o))bots.add(o);});
    for(const b of [...bots])if(!b.parent){bots.delete(b);states.delete(b);}
  }

  function rebuildWorld(){
    if(!scene)return;
    meshes.length=0; obstacles.length=0; scene.updateMatrixWorld(true);
    scene.traverse(o=>{
      if(!o.isMesh||!o.visible||isBot(o)||cameraChild(o))return;
      const n=String(o.name||'').toLowerCase();
      if(/weapon|crosshair|label|ui|viewgun|hand|arm/.test(n))return;
      const b=new T.Box3().setFromObject(o); if(b.isEmpty())return;
      const sx=b.max.x-b.min.x, sy=b.max.y-b.min.y, sz=b.max.z-b.min.z;
      if(sx<.05||sz<.05||sy<.02)return;
      meshes.push(o);
      // Tall geometry is an obstacle. Ignore the giant floor slab and paper-thin decals.
      const area=sx*sz;
      if(sy>0.85 && area<1800) obstacles.push({mesh:o,box:b});
    });
    navDirty=true;
  }

  // Choose the LOWEST valid horizontal surface under a point. This is deliberate:
  // it prevents bots from standing on the top of walls/crates and looking like they fly.
  function groundY(x,z,referenceY=3){
    if(!meshes.length)return null;
    ray.set(new T.Vector3(x,Math.max(referenceY+4,8),z),new T.Vector3(0,-1,0));
    ray.near=0;ray.far=80;
    const hits=ray.intersectObjects(meshes,true);
    let best=null;
    for(const h of hits){
      if(!h.face||!h.object)continue;
      const n=h.face.normal.clone().transformDirection(h.object.matrixWorld);
      if(n.y<0.72)continue;
      const y=h.point.y;
      if(y>referenceY+0.8)continue;
      if(y<referenceY-C.groundSearch)continue;
      // Prefer a broad/low support surface. Tiny props should not become floors.
      const ob=obstacles.find(q=>q.mesh===h.object);
      if(ob){const sx=ob.box.max.x-ob.box.min.x,sz=ob.box.max.z-ob.box.min.z;if(sx<0.55&&sz<0.55)continue;}
      if(best===null||y<best)best=y;
    }
    return best;
  }

  function botGround(bot){
    bot.updateMatrixWorld(true);
    const box=new T.Box3().setFromObject(bot); if(box.isEmpty())return;
    const footOffset=bot.position.y-box.min.y;
    const gy=groundY(bot.position.x,bot.position.z,box.min.y+0.2);
    if(gy===null)return;
    const target=gy+footOffset;
    const dy=target-bot.position.y;
    if(Math.abs(dy)<=C.groundSnap)bot.position.y=target;
    bot.userData.__hamuGroundY=gy;
  }

  function inside(box,x,z,pad=C.body){
    return x>box.min.x-pad&&x<box.max.x+pad&&z>box.min.z-pad&&z<box.max.z+pad;
  }

  function pushOut(bot){
    let moved=false;
    const p=bot.position;
    for(const o of obstacles){
      const b=o.box;
      if(p.y<b.min.y-0.7||p.y>b.max.y+0.7||!inside(b,p.x,p.z,.34))continue;
      const lx=Math.abs(p.x-b.min.x),rx=Math.abs(b.max.x-p.x),tz=Math.abs(p.z-b.min.z),bz=Math.abs(b.max.z-p.z);
      const m=Math.min(lx,rx,tz,bz)+.14;
      if(m===lx)p.x=b.min.x-.34;
      else if(m===rx)p.x=b.max.x+.34;
      else if(m===tz)p.z=b.min.z-.34;
      else p.z=b.max.z+.34;
      moved=true;
    }
    if(moved){const s=state(bot);s.path=[];s.pi=0;s.repath=0;}
  }

  function blocked(x,z,y){
    for(const o of obstacles){const b=o.box;if(y<b.min.y-.8||y>b.max.y+0.8)continue;if(inside(b,x,z,.24))return true;}
    return false;
  }

  function clearLine(a,b){
    const dx=b.x-a.x,dz=b.z-a.z,len=Math.hypot(dx,dz);if(len<.2)return true;
    const dir=new T.Vector3(dx/len,0,dz/len);
    ray.set(new T.Vector3(a.x,a.y+1.05,a.z),dir);ray.near=.05;ray.far=Math.max(.05,len-.12);
    const hit=ray.intersectObjects(meshes,true).find(h=>h.object&&h.point.y>Math.min(a.y,b.y)-.4);
    return !hit;
  }

  const nav={nodes:[],by:new Map(),minX:0,minZ:0,cell:C.cell,cols:0,rows:0};
  function buildNav(){
    if(!scene||!meshes.length)return;
    const world=new T.Box3();meshes.forEach(m=>world.expandByObject(m));
    if(world.isEmpty())return;
    const minX=world.min.x-1.5,maxX=world.max.x+1.5,minZ=world.min.z-1.5,maxZ=world.max.z+1.5;
    const span=Math.max(maxX-minX,maxZ-minZ),cell=Math.max(C.cell,span/(C.maxGrid-1));
    const cols=Math.min(C.maxGrid,Math.ceil((maxX-minX)/cell)+1),rows=Math.min(C.maxGrid,Math.ceil((maxZ-minZ)/cell)+1);
    nav.nodes=[];nav.by.clear();nav.cell=cell;nav.cols=cols;nav.rows=rows;nav.minX=minX;nav.minZ=minZ;
    for(let zc=0;zc<rows;zc++)for(let xc=0;xc<cols;xc++){
      const x=minX+xc*cell,z=minZ+zc*cell;
      const y=groundY(x,z,2.5);
      if(y===null)continue;
      if(blocked(x,z,y+.9))continue;
      const n={x,z,y,xc,zc,key:xc+','+zc,links:[]};nav.by.set(n.key,n);nav.nodes.push(n);
    }
    const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
    for(const n of nav.nodes){
      for(const [dx,dz] of dirs){
        const q=nav.by.get((n.xc+dx)+','+(n.zc+dz));if(!q)continue;
        if(Math.abs(q.y-n.y)>1.0)continue;
        if(dx&&dz){if(!nav.by.has((n.xc+dx)+','+n.zc)||!nav.by.has(n.xc+','+(n.zc+dz)))continue;}
        if(!clearLine(n,q))continue;
        n.links.push(q);
      }
    }
    navDirty=false;navAt=performance.now();
  }

  function nearest(p){
    let best=null,score=Infinity;
    for(const n of nav.nodes){const dy=Math.abs(n.y-p.y);if(dy>1.6)continue;const d=Math.hypot(n.x-p.x,n.z-p.z)+dy*1.4;if(d<score){score=d;best=n;}}
    return best;
  }
  function path(a,b){
    const s=nearest(a),g=nearest(b);if(!s||!g)return[];
    const open=[s],came=new Map(),gs=new Map([[s.key,0]]),closed=new Set();
    while(open.length){
      let bi=0;
      for(let i=1;i<open.length;i++){
        const fi=(gs.get(open[i].key)||0)+Math.hypot(open[i].x-g.x,open[i].z-g.z);
        const fb=(gs.get(open[bi].key)||0)+Math.hypot(open[bi].x-g.x,open[bi].z-g.z);
        if(fi<fb)bi=i;
      }
      const cur=open.splice(bi,1)[0];if(closed.has(cur.key))continue;closed.add(cur.key);
      if(cur===g){const out=[];let q=cur;while(q){out.push({x:q.x,y:q.y,z:q.z});q=came.get(q.key);}out.reverse();
        // Funnel-like shortcutting: skip intermediate nodes when the segment is clear.
        const slim=[];let anchor=a;
        for(let i=0;i<out.length;i++){let j=out.length-1;for(;j>i;j--)if(clearLine(anchor,out[j]))break;slim.push(out[j]);anchor=out[j];i=j;}
        if(!slim.length||d2(slim[slim.length-1],b)>.8)slim.push({x:b.x,y:b.y,z:b.z});
        return slim;
      }
      for(const q of cur.links){if(closed.has(q.key))continue;const ng=(gs.get(cur.key)||0)+Math.hypot(q.x-cur.x,q.z-cur.z)+Math.abs(q.y-cur.y)*2;if(ng<(gs.get(q.key)??Infinity)){gs.set(q.key,ng);came.set(q.key,cur);if(!open.includes(q))open.push(q);}}
    }
    return[];
  }

  function state(b){
    let s=states.get(b);
    if(!s){s={mode:'SEARCH',target:null,goal:null,path:[],pi:0,repath:0,decision:0,stuck:0,last:b.position.clone(),side:Math.random()<.5?-1:1,aim:0,aimT:.2,role:'ASSAULT'};states.set(b,s);}
    return s;
  }

  function enemies(b){
    const t=team(b),out=[];
    for(const x of bots){if(x===b||!alive(x))continue;const xt=team(x);if(t!=='unknown'&&xt===t)continue;out.push(x);}
    // In Lonewolf / when the opposing squad is absent, the player camera is the target.
    if(camera&&(t==='red'||!out.length))out.push(camera);
    return out;
  }

  function los(a,b){
    const p=new T.Vector3(a.position.x,a.position.y+1.25,a.position.z);
    const q=new T.Vector3(b.position.x,b.position.y+(b===camera?0:1.2),b.position.z);
    const dir=q.clone().sub(p),len=dir.length();if(len<.1)return true;dir.normalize();ray.set(p,dir);ray.near=.04;ray.far=len-.08;
    return !ray.intersectObjects(meshes,true).some(h=>h.point.y>Math.min(p.y,q.y)-.5);
  }

  function visible(a,b){
    const dx=b.position.x-a.position.x,dz=b.position.z-a.position.z,d=Math.hypot(dx,dz);if(d>C.vision)return false;
    const f=new T.Vector3(0,0,-1).applyQuaternion(a.quaternion);f.y=0;f.normalize();
    const to=new T.Vector3(dx,0,dz).normalize();
    if(d>2&&f.dot(to)<C.fov)return false;
    return los(a,b);
  }

  function targetFor(b){
    let best=null,score=-Infinity;
    for(const e of enemies(b)){
      if(!e||!e.position)continue;
      const d=d2(b.position,e.position), seen=visible(b,e)?1:0, remembered=memory.has(e)?1:0;
      const hp=clamp(Number(e.userData?.hp??e.userData?.health??100)/100,0,1);
      const sc=seen*6+remembered*1.5+(1-clamp(d/42,0,1))*2.5+(1-hp)*1.2;
      if(sc>score){score=sc;best=e;}
    }
    return best;
  }

  function coverGoal(b,t){
    let best=null,score=-Infinity;
    for(let i=0;i<20;i++){
      const a=Math.random()*Math.PI*2,d=3.5+Math.random()*8;
      const p={x:b.position.x+Math.cos(a)*d,z:b.position.z+Math.sin(a)*d,y:b.position.y};
      const n=nearest(p);if(!n)continue;
      const q={x:n.x,y:n.y,z:n.z};
      const exposed=t?clearLine(q,t.position):false;
      const s=(exposed?-4:5)-d2(q,b.position)*.05;
      if(s>score){score=s;best=q;}
    }
    return best;
  }

  function flankGoal(b,t){
    if(!t)return null;let best=null,score=-Infinity;
    for(let i=0;i<16;i++){
      const a=(i/16)*Math.PI*2,d=5+Math.random()*7,p={x:t.position.x+Math.cos(a)*d,z:t.position.z+Math.sin(a)*d,y:t.position.y};
      const n=nearest(p);if(!n)continue;const q={x:n.x,y:n.y,z:n.z},pp=path(b.position,q);if(!pp.length)continue;
      const sc=Math.abs(Math.sin(a))*3-d2(q,b.position)*.03;
      if(sc>score){score=sc;best=q;}
    }
    return best;
  }

  function steer(b,desired){
    if(desired.lengthSq()<.001)return desired;
    desired.normalize();
    const o=new T.Vector3(b.position.x,b.position.y+1.0,b.position.z);
    const right=new T.Vector3(-desired.z,0,desired.x),left=right.clone().negate();
    let steer=new T.Vector3();
    [[desired,1],[right,.9],[left,.9]].forEach(([dir,w])=>{ray.set(o,dir);ray.near=.05;ray.far=C.obstacleRay;const h=ray.intersectObjects(meshes,true)[0];if(h){const k=1-h.distance/C.obstacleRay;steer.addScaledVector(new T.Vector3(-dir.z,0,dir.x),k*w);}});
    if(steer.lengthSq()>0.01)desired.add(steer.normalize().multiplyScalar(.95)).normalize();
    return desired;
  }

  function aim(b,t,dt,s){
    if(!t)return;
    const dx=t.position.x-b.position.x,dz=t.position.z-b.position.z;
    let want=Math.atan2(dx,dz)+s.aim;
    let delta=((want-b.rotation.y+Math.PI*3)%(Math.PI*2))-Math.PI;
    b.rotation.y+=delta*(1-Math.exp(-dt*5.2));
    s.aimT-=dt;
    if(s.aimT<=0){s.aimT=.22+Math.random()*.55;s.aim=(Math.random()-.5)*.07;}
    b.userData.aiAimTarget=t;
  }

  function decide(b,s,dt){
    s.decision-=dt;if(s.decision>0)return;
    s.decision=.18+Math.random()*.18;
    s.target=targetFor(b);
    if(s.target&&visible(b,s.target))memory.set(s.target,{x:s.target.position.x,z:s.target.position.z,t:performance.now()});
    const hp=clamp(Number(b.userData?.hp??b.userData?.health??100)/100,0,1);
    const d=s.target?d2(b.position,s.target.position):99;
    const role=s.role=['ASSAULT','FLANKER','SUPPORT','ANCHOR'][[...bots].filter(x=>team(x)===team(b)).indexOf(b)%4]||'ASSAULT';
    if(!s.target)s.mode='SEARCH';
    else if(hp<.28)s.mode='RETREAT';
    else if(role==='FLANKER'&&d<30)s.mode='FLANK';
    else if(visible(b,s.target)&&d<18)s.mode='ATTACK';
    else s.mode='PURSUE';

    let g=null;
    if(s.mode==='ATTACK'){
      const side=new T.Vector3(-(s.target.position.z-b.position.z),0,s.target.position.x-b.position.x).normalize();
      g={x:s.target.position.x+side.x*s.side*(2.8+Math.random()*2.2),y:s.target.position.y,z:s.target.position.z+side.z*s.side*(2.8+Math.random()*2.2)};
    } else if(s.mode==='FLANK')g=flankGoal(b,s.target)||coverGoal(b,s.target);
    else if(s.mode==='RETREAT')g=coverGoal(b,s.target)||{x:b.position.x-s.side*4,y:b.position.y,z:b.position.z-s.side*2};
    else if(s.mode==='PURSUE')g={x:s.target.position.x,y:s.target.position.y,z:s.target.position.z};
    else g=coverGoal(b,null)||{x:b.position.x+(Math.random()-.5)*7,y:b.position.y,z:b.position.z+(Math.random()-.5)*7};
    if(g){s.goal=g;s.path=path(b.position,g);s.pi=0;s.repath=C.repath;}
  }

  function moveBot(b,dt){
    if(!alive(b)||!nav.nodes.length)return;
    const s=state(b);decide(b,s,dt);s.repath-=dt;
    if(s.repath<=0&&s.goal){s.path=path(b.position,s.goal);s.pi=0;s.repath=C.repath;}
    while(s.pi<s.path.length&&d2(b.position,s.path[s.pi])<C.waypoint)s.pi++;
    if(s.pi>=s.path.length){s.side*=-1;s.goal=null;return;}
    const w=s.path[s.pi];let dir=new T.Vector3(w.x-b.position.x,0,w.z-b.position.z);if(dir.lengthSq()<.001)return;
    dir=steer(b,dir);
    const speed=(s.mode==='ATTACK'||s.mode==='FLANK')?C.combatSpeed:C.speed;
    const step=Math.min(speed*dt,.16);b.position.x+=dir.x*step;b.position.z+=dir.z*step;
    botGround(b);pushOut(b);aim(b,s.target,dt,s);
    const moved=Math.hypot(b.position.x-s.last.x,b.position.z-s.last.z);s.stuck=moved<.035?s.stuck+dt:0;s.last.copy(b.position);
    if(s.stuck>C.stuckAfter){s.stuck=0;s.path=[];s.pi=0;s.repath=0;s.side*=-1;}
  }

  // Conservative player anti-float: only correct when the camera is clearly below
  // the expected floor or has been floating for a sustained period. Normal jumps survive.
  let playerStable=0,lastCamY=null;
  function playerGround(){
    if(!camera||!meshes.length)return;
    const gy=groundY(camera.position.x,camera.position.z,camera.position.y-1.7);
    if(gy===null)return;
    const expected=gy+1.75,dy=expected-camera.position.y;
    if(lastCamY!==null&&Math.abs(camera.position.y-lastCamY)<.01)playerStable+=.016;else playerStable=0;
    lastCamY=camera.position.y;
    if(camera.position.y<gy+1.05)camera.position.y=expected;
    else if(Math.abs(dy)>2.2&&playerStable>.45)camera.position.y=expected;
  }

  function tick(now){
    const dt=clamp((now-last)/1000,0,.05);last=now;
    if(!scene||!rendererSeen)return;
    capture();
    if(navDirty||now-navAt>2200){rebuildWorld();buildNav();}
    for(const b of bots)moveBot(b,dt);
    playerGround();
  }

  function loop(now){tick(now);requestAnimationFrame(loop);}
  window.HAMU_BOT_AI={config:C,nav,memory,rebuild:()=>{navDirty=true;rebuildWorld();buildNav();},getBots:()=>[...bots],getState:b=>states.get(b)||null};
  setTimeout(()=>{capture();rebuildWorld();buildNav();requestAnimationFrame(loop);},700);
})();
