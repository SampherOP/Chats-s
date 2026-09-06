/* HAMU STRIKE // ADVANCED TACTICAL BOT AI v6
 * Dependency-free Three.js AI layer.
 *
 * Behaviour Tree: SEARCH -> PURSUE -> ATTACK / FLANK / RETREAT / REPOSITION
 * Utility scoring: target priority, health, ammo, distance, LOS, threat
 * Navigation: local tactical NavMesh-style grid + bounded A* + smoothing
 * Perception: 115° vision cone + cached raycast line-of-sight + memory
 * Aim: reaction delay + LERP/spring rotation + micro aim error
 * Influence: sparse danger memory for sightings, shots and casualties
 * Movement: obstacle avoidance, squad separation, stuck recovery
 */
(() => {
    'use strict';
    if (!window.THREE) return;

    const T = THREE;
    const rand = Math.random.bind(Math);
    const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
    const distance = (a,b) => Math.hypot(a.x-b.x,a.z-b.z);

    let scene = null, camera = null;
    const bots = new Set();
    const state = new WeakMap();
    const obstacles = [];
    const rayObjects = [];
    const ray = new T.Raycaster();
    const memory = { sightings: [], shots: [], deaths: [] };

    // Capture the private game scene/camera without changing game.js globals.
    const originalRender = T.WebGLRenderer.prototype.render;
    T.WebGLRenderer.prototype.render = function(s,c) {
        if (s && s.isScene) scene=s;
        if (c && c.isCamera) camera=c;
        return originalRender.apply(this,arguments);
    };

    function isBot(o) {
        return !!(o && o.isObject3D && o.userData && o.userData.parts && o.position);
    }
    function collectBots() {
        if(!scene) return;
        scene.traverse(o=>{ if(isBot(o)) bots.add(o); });
        for(const b of [...bots]) if(!b.parent){ bots.delete(b); state.delete(b); }
    }
    function underCamera(o) {
        let p=o; while(p){ if(p===camera)return true; p=p.parent; }
        return false;
    }
    function teamOf(bot) {
        const explicit=bot.userData.team||bot.userData.teamName||bot.userData.side;
        if(typeof explicit==='string'){
            const s=explicit.toLowerCase();
            if(s.includes('blue'))return'blue'; if(s.includes('red'))return'red';
        }
        const torso=bot.userData.parts?.torso, m=Array.isArray(torso?.material)?torso.material[0]:torso?.material;
        const c=m?.color;
        if(c){ if(c.b>c.r*1.18)return'blue'; if(c.r>c.b*1.18)return'red'; }
        return'unknown';
    }
    function alive(o){
        if(!o||!o.parent||o.visible===false)return false;
        const u=o.userData||{};
        if(u.dead||u.eliminated||u.alive===false)return false;
        const hp=u.hp??u.health;
        return hp===undefined||hp>0;
    }
    function hp01(o){const h=o?.userData?.hp??o?.userData?.health;return Number.isFinite(h)?clamp(h/100,0,1):1;}
    function ammo01(o){const a=o?.userData?.ammo??o?.userData?.mag??o?.userData?.clip;return Number.isFinite(a)?clamp(a/30,0,1):.7;}

    // ---------------------------- perception -----------------------------
    function rebuildWorldCache(){
        if(!scene)return;
        obstacles.length=0; rayObjects.length=0;
        scene.updateMatrixWorld(true);
        scene.traverse(o=>{
            if(!o.isMesh||isBot(o)||underCamera(o))return;
            const n=(o.name||'').toLowerCase();
            if(n.includes('crosshair')||n.includes('weapon')||n.includes('label')||n.includes('ui'))return;
            if(!o.visible&&!n.includes('collider')&&!n.includes('collision'))return;
            const b=new T.Box3().setFromObject(o); if(b.isEmpty())return;
            const w=b.max.x-b.min.x,h=b.max.y-b.min.y,d=b.max.z-b.min.z;
            if(w<.08||d<.08||h<.02)return;
            obstacles.push({minX:b.min.x,maxX:b.max.x,minY:b.min.y,maxY:b.max.y,minZ:b.min.z,maxZ:b.max.z});
            if(o.visible)rayObjects.push(o);
        });
    }
    function blocked(x,z,y,r=.52){
        // Body-height test means floors below the player and roofs above him do
        // not become fake walls, while house walls/crates remain solid.
        for(const b of obstacles){
            if(y+2.05<b.minY-.08||y>b.maxY+.18)continue;
            if(x>b.minX-r&&x<b.maxX+r&&z>b.minZ-r&&z<b.maxZ+r)return true;
        }
        return false;
    }
    function segmentClear(a,b,y,r=.52){
        const dx=b.x-a.x,dz=b.z-a.z,n=Math.max(2,Math.ceil(Math.hypot(dx,dz)/.45));
        for(let i=1;i<n;i++){const t=i/n;if(blocked(a.x+dx*t,a.z+dz*t,y,r))return false;}
        return true;
    }
    function eye(bot){return new T.Vector3(bot.position.x,bot.position.y+1.45,bot.position.z);}
    function targetEye(o){return new T.Vector3(o.position.x,o.position.y+1.3,o.position.z);}
    function hasLOS(bot,target){
        if(!scene||!target)return false;
        const a=eye(bot),b=targetEye(target),dir=b.clone().sub(a),len=dir.length();
        if(len<.1)return true;
        dir.normalize();ray.set(a,dir);ray.near=.03;ray.far=len-.10;
        const hits=ray.intersectObjects(rayObjects,true);
        return hits.length===0;
    }
    function canSee(bot,target){
        if(!target||!alive(target))return false;
        const dx=target.position.x-bot.position.x,dz=target.position.z-bot.position.z,d=Math.hypot(dx,dz);
        if(d>36)return false;
        const forward=new T.Vector3(0,0,-1).applyQuaternion(bot.quaternion);forward.y=0;forward.normalize();
        const to=new T.Vector3(dx,0,dz);if(to.lengthSq()<.001)return true;to.normalize();
        // Wide but not omniscient cone; close enemies can be noticed behind us.
        if(d>2.5&&forward.dot(to)<Math.cos(1.02))return false;
        return hasLOS(bot,target);
    }
    function enemiesOf(bot){
        const team=teamOf(bot),out=[];
        for(const b of bots){
            if(b===bot||!alive(b))continue;
            const t=teamOf(b);
            if(team!=='unknown'&&t===team)continue;
            if(t!=='unknown'||team!=='unknown')out.push(b);
        }
        // Player is blue in Clash Squad, therefore red bots must be able to see
        // the camera/player. In Lonewolf the same rule makes AI opponents engage.
        if(team==='red'&&camera)out.push(camera);
        return out;
    }
    function remember(list,p,power,ttl){
        if(!p)return;list.push({x:p.x,z:p.z,power,ttl});
        if(list.length>70)list.splice(0,list.length-70);
    }
    function decay(dt){
        for(const list of Object.values(memory)){
            for(const m of list)m.ttl-=dt;
            for(let i=list.length-1;i>=0;i--)if(list[i].ttl<=0)list.splice(i,1);
        }
    }
    function threatAt(x,z){
        let v=0;
        for(const m of memory.sightings){const d=Math.hypot(x-m.x,z-m.z);if(d<16)v+=m.power*(1-d/16);}
        for(const m of memory.shots){const d=Math.hypot(x-m.x,z-m.z);if(d<12)v+=m.power*(1-d/12);}
        for(const m of memory.deaths){const d=Math.hypot(x-m.x,z-m.z);if(d<14)v+=m.power*1.5*(1-d/14);}
        return v;
    }

    // ---------------------------- navigation -----------------------------
    const CELL=1.0, SEARCH_RADIUS=22, BOT_RADIUS=.52;
    function pathfind(start,goal,y){
        if(!scene||!Number.isFinite(goal.x)||!Number.isFinite(goal.z))return[];
        if(segmentClear(start,goal,y))return[{x:goal.x,z:goal.z}];
        const minX=Math.min(start.x,goal.x)-SEARCH_RADIUS,maxX=Math.max(start.x,goal.x)+SEARCH_RADIUS;
        const minZ=Math.min(start.z,goal.z)-SEARCH_RADIUS,maxZ=Math.max(start.z,goal.z)+SEARCH_RADIUS;
        const cols=clamp(Math.ceil((maxX-minX)/CELL)+1,9,49),rows=clamp(Math.ceil((maxZ-minZ)/CELL)+1,9,49);
        const ox=minX,oz=minZ,px=i=>ox+i*CELL,pz=i=>oz+i*CELL,key=(x,z)=>x+','+z;
        const sx=clamp(Math.round((start.x-ox)/CELL),0,cols-1),sz=clamp(Math.round((start.z-oz)/CELL),0,rows-1);
        const gx=clamp(Math.round((goal.x-ox)/CELL),0,cols-1),gz=clamp(Math.round((goal.z-oz)/CELL),0,rows-1);
        const open=[{x:sx,z:sz,g:0,f:Math.hypot(gx-sx,gz-sz)}],came=new Map(),cost=new Map([[key(sx,sz),0]]),closed=new Set();
        const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
        let expanded=0;
        while(open.length&&expanded++<1800){
            let bi=0;for(let i=1;i<open.length;i++)if(open[i].f<open[bi].f)bi=i;
            const cur=open.splice(bi,1)[0],ck=key(cur.x,cur.z);if(closed.has(ck))continue;closed.add(ck);
            if(ck===key(gx,gz)){
                const raw=[];let k=ck;
                while(k!==key(sx,sz)){const [x,z]=k.split(',').map(Number);raw.push({x:px(x),z:pz(z)});k=came.get(k);if(!k)break;}
                raw.reverse();
                // Funnel-like smoothing: keep the furthest visible waypoint.
                const smooth=[];let anchor={x:start.x,z:start.z};
                for(let i=0;i<raw.length;i++){
                    let furthest=i;
                    for(let j=raw.length-1;j>i;j--)if(segmentClear(anchor,raw[j],y)){furthest=j;break;}
                    smooth.push(raw[furthest]);anchor=raw[furthest];i=furthest;
                }
                return smooth;
            }
            for(const [dx,dz] of dirs){
                const nx=cur.x+dx,nz=cur.z+dz;if(nx<0||nz<0||nx>=cols||nz>=rows)continue;
                const x=px(nx),z=pz(nz),nk=key(nx,nz);
                if(closed.has(nk)||blocked(x,z,y,BOT_RADIUS))continue;
                if(dx&&dz&&(blocked(px(cur.x+dx),pz(cur.z),y,BOT_RADIUS)||blocked(px(cur.x),pz(cur.z+dz),y,BOT_RADIUS)))continue;
                const g=cur.g+(dx&&dz?1.414:1);if(g<(cost.get(nk)??Infinity)){cost.set(nk,g);came.set(nk,ck);open.push({x:nx,z:nz,g,f:g+Math.hypot(gx-nx,gz-nz)*1.08});}
            }
        }
        return[];
    }
    function randomFree(p,y,min=2,max=7){
        for(let i=0;i<18;i++){const a=rand()*Math.PI*2,d=min+rand()*(max-min),q={x:p.x+Math.cos(a)*d,z:p.z+Math.sin(a)*d};if(!blocked(q.x,q.z,y))return q;}
        return null;
    }
    function tacticalPoint(bot,target,kind){
        let best=null,score=-Infinity,p=bot.position;
        for(let i=0;i<24;i++){
            const a=i/24*Math.PI*2,d=kind==='RETREAT'?4+rand()*6:3+rand()*9,q={x:p.x+Math.cos(a)*d,z:p.z+Math.sin(a)*d};
            if(blocked(q.x,q.z,p.y))continue;
            let s=2.5-threatAt(q.x,q.z)*1.1;
            if(target){
                const td=Math.hypot(q.x-target.position.x,q.z-target.position.z);
                s+=kind==='RETREAT'?clamp(td/14,0,3):clamp((td<7?1:td/12),0,2);
                if(!segmentClear(q,target.position,p.y))s+=3.5;
                if(kind==='FLANK')s+=(Math.abs(Math.sin(a))+.2)*2;
            }
            if(s>score){score=s;best=q;}
        }
        return best;
    }

    // ----------------------------- utility -------------------------------
    function targetUtility(bot,e,s){
        const d=distance(bot.position,e.position),los=canSee(bot,e)?1:0;
        const remembered=s.memoryTarget===e&&s.memoryTTL>0?1:0;
        return (1-clamp(d/36,0,1))*2.2+los*4+remembered*1.25+(1-hp01(e))*.65+threatAt(e.position.x,e.position.z)*.12;
    }
    function chooseTarget(bot,s,visible){
        let best=null,score=-Infinity;
        for(const e of visible){const v=targetUtility(bot,e,s);if(v>score){score=v;best=e;}}
        if(!best&&s.memoryTTL>0&&alive(s.memoryTarget))best=s.memoryTarget;
        return best;
    }

    // ------------------------------- BT ----------------------------------
    function makeState(bot){
        const s={state:'SEARCH',target:null,memoryTarget:null,memoryX:0,memoryZ:0,memoryTTL:0,path:[],pathIndex:0,goal:null,repath:0,decision:0,stuck:0,lastX:bot.position.x,lastZ:bot.position.z,aimNoise:0,aimNoiseT:0,strafe:rand()<.5?-1:1};
        state.set(bot,s);return s;
    }
    function getState(bot){return state.get(bot)||makeState(bot);}
    function decide(bot,s,visible){
        const target=chooseTarget(bot,s,visible);s.target=target;
        if(!target){s.state='SEARCH';return;}
        const d=distance(bot.position,target.position),los=canSee(bot,target),hp=hp01(bot),ammo=ammo01(bot);
        const retreat=(!los&&hp<.38?4.4:0)+(hp<.25?5:0)+threatAt(bot.position.x,bot.position.z)*.35;
        const flank=(los&&d<24?2.2:0)+(1-hp)*2.1+threatAt(bot.position.x,bot.position.z)*.18;
        const attack=(los?4.2:0)+clamp((20-d)/20,0,1)*2.2+ammo*1.0;
        if(retreat>attack&&retreat>flank){s.state='RETREAT';return;}
        if(ammo<.10){s.state='REPOSITION';return;}
        if(flank>attack){s.state='FLANK';return;}
        if(los){s.state='ATTACK';return;}
        s.state=s.memoryTTL>0?'PURSUE':'SEARCH';
    }
    function setGoal(bot,s,q){if(!q)return;s.goal={x:q.x,z:q.z};s.path=pathfind(bot.position,q,bot.position.y);s.pathIndex=0;s.repath=.65+rand()*.35;}
    function follow(bot,s,dt){
        while(s.pathIndex<s.path.length&&distance(bot.position,s.path[s.pathIndex])<.62)s.pathIndex++;
        if(s.pathIndex>=s.path.length)return false;
        const w=s.path[s.pathIndex],dx=w.x-bot.position.x,dz=w.z-bot.position.z,len=Math.hypot(dx,dz)||1;
        let ax=0,az=0;
        for(const other of bots){
            if(other===bot||!alive(other)||teamOf(other)!==teamOf(bot))continue;
            const d=distance(bot.position,other.position);
            if(d<1.25&&d>.01){ax+=(bot.position.x-other.position.x)/d*(1.25-d);az+=(bot.position.z-other.position.z)/d*(1.25-d);}
        }
        const vx=dx/len+ax*.72,vz=dz/len+az*.72,vl=Math.hypot(vx,vz)||1;
        const speed=(s.state==='RETREAT'?4.5:3.65)*dt,nx=bot.position.x+vx/vl*speed,nz=bot.position.z+vz/vl*speed;
        if(!blocked(nx,nz,bot.position.y,.50)){bot.position.x=nx;bot.position.z=nz;return true;}
        s.repath=0;return false;
    }
    function aim(bot,target,dt,s){
        if(!target)return;
        const dx=target.position.x-bot.position.x,dz=target.position.z-bot.position.z;
        if(Math.hypot(dx,dz)<.05)return;
        const desired=Math.atan2(-dx,-dz);let delta=desired-bot.rotation.y;
        while(delta>Math.PI)delta-=Math.PI*2;while(delta<-Math.PI)delta+=Math.PI*2;
        s.aimNoiseT-=dt;if(s.aimNoiseT<=0){s.aimNoiseT=.16+rand()*.25;s.aimNoise=(rand()-.5)*.06;}
        const gain=5.2+(1-hp01(bot))*1.7;bot.rotation.y+=(delta+s.aimNoise)*(1-Math.exp(-gain*dt));
    }
    function think(bot,dt){
        if(!alive(bot))return;
        const s=getState(bot);s.repath-=dt;s.decision-=dt;s.memoryTTL=Math.max(0,s.memoryTTL-dt);
        const moved=distance(bot.position,{x:s.lastX,z:s.lastZ});
        if(moved<.02)s.stuck+=dt;else{s.stuck=0;s.lastX=bot.position.x;s.lastZ=bot.position.z;}
        if(s.stuck>.65){const q=randomFree(bot.position,bot.position.y,1.5,4.5);if(q)setGoal(bot,s,q);s.stuck=0;s.repath=0;}

        const visible=[];
        for(const e of enemiesOf(bot)){
            if(canSee(bot,e)){visible.push(e);s.memoryTarget=e;s.memoryX=e.position.x;s.memoryZ=e.position.z;s.memoryTTL=3.4;remember(memory.sightings,e.position,.8,3.4);}
        }
        if(s.decision<=0){decide(bot,s,visible);s.decision=.16+rand()*.12;}
        if(s.target&&alive(s.target))aim(bot,s.target,dt,s);

        if(s.state==='ATTACK'){
            const t=s.target;if(!t)return;const d=distance(bot.position,t.position);
            if(d>15){if(s.repath<=0||!s.path.length)setGoal(bot,s,t.position);follow(bot,s,dt);}
            else if(d<4.0){
                const dx=t.position.x-bot.position.x,dz=t.position.z-bot.position.z,l=Math.hypot(dx,dz)||1;
                const sx=-dz/l*s.strafe,sz=dx/l*s.strafe,nx=bot.position.x+sx*2.0*dt,nz=bot.position.z+sz*2.0*dt;
                if(!blocked(nx,nz,bot.position.y,.50)){bot.position.x=nx;bot.position.z=nz;}
            }
        } else if(s.state==='FLANK'){
            if(s.repath<=0||!s.path.length)setGoal(bot,s,tacticalPoint(bot,s.target,'FLANK'));follow(bot,s,dt);
        } else if(s.state==='RETREAT'){
            if(s.repath<=0||!s.path.length)setGoal(bot,s,tacticalPoint(bot,s.target,'RETREAT')||randomFree(bot.position,bot.position.y));follow(bot,s,dt);
        } else if(s.state==='REPOSITION'){
            if(s.repath<=0||!s.path.length)setGoal(bot,s,tacticalPoint(bot,s.target,'RETREAT')||randomFree(bot.position,bot.position.y));follow(bot,s,dt);
        } else if(s.state==='PURSUE'){
            const q={x:s.memoryX,z:s.memoryZ};if(s.repath<=0||!s.path.length||!s.goal||distance(s.goal,q)>2.5)setGoal(bot,s,q);follow(bot,s,dt);
        } else {
            if(s.repath<=0||!s.path.length){const q=randomFree(bot.position,bot.position.y,3,9);if(q)setGoal(bot,s,q);}follow(bot,s,dt);
        }
        if(s.stuck>.35)remember(memory.shots,bot.position,.1,1.2);
    }

    let last=performance.now(),acc=0,cacheT=0;
    function loop(t){
        requestAnimationFrame(loop);
        if(!scene)return;
        const dt=clamp((t-last)/1000,0,.08);last=t;acc+=dt;cacheT-=dt;
        if(cacheT<=0){rebuildWorldCache();cacheT=1.0;}
        decay(dt);
        if(acc<.045)return;
        const step=acc;acc=0;collectBots();
        // Shared casualty memory: newly invisible/dead squad members create a
        // temporary danger field without needing access to private game arrays.
        for(const b of bots){const s=getState(b);if(s.wasAlive!==false&&!alive(b)){remember(memory.deaths,b.position,1.3,5);}s.wasAlive=alive(b);}
        for(const b of bots)think(b,step);
    }
    requestAnimationFrame(loop);
})();
