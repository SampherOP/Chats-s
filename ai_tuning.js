/* HAMU STRIKE - OPTIMIZED HUMAN-LIKE BOT AI v4
 * External AI layer: the original game keeps squad/collision functions private,
 * so this helper observes the live Three.js scene and adds a lightweight,
 * collision-aware navigation layer on top of the existing combat AI.
 */
(() => {
    'use strict';
    const nativeRandom = Math.random.bind(Math);

    // High combat reliability without making every shot laser-perfect. The
    // existing AI decides when to shoot; this makes that decision dependable,
    // while unitShoot keeps a small natural aim wobble.
    Math.random = function () {
        const stack = new Error().stack || '';
        if (stack.includes('updateUnitClash') || stack.includes('updateUnitLone')) return 0.28;
        if (stack.includes('unitShoot')) return .35 + nativeRandom() * .30;
        return nativeRandom();
    };

    let gameScene = null, gameCamera = null;
    const botState = new WeakMap();
    const tracked = new Set();
    const boxCache = [];
    let cacheT = 0, navT = 0;

    // Capture the private game scene/camera through the renderer. This works
    // even though game.js wraps its variables inside an IIFE.
    const nativeRender = THREE.WebGLRenderer.prototype.render;
    THREE.WebGLRenderer.prototype.render = function (scene, camera) {
        if (scene && scene.isScene) gameScene = scene;
        if (camera && camera.isCamera) gameCamera = camera;
        return nativeRender.apply(this, arguments);
    };

    function isBot(o) { return !!(o && o.isObject3D && o.userData && o.userData.parts && o.position); }
    function collectBots() { if (gameScene) gameScene.traverse(o => { if (isBot(o)) tracked.add(o); }); }

    function isUnderCamera(o) {
        let p = o; while (p) { if (p === gameCamera) return true; p = p.parent; } return false;
    }

    function rebuildObstacles() {
        if (!gameScene) return;
        boxCache.length = 0; gameScene.updateMatrixWorld(true);
        gameScene.traverse(o => {
            if (!o.isMesh || isUnderCamera(o) || isBot(o)) return;
            if (!o.visible && !o.parent?.name?.startsWith('CSMAP_COLLIDERS')) return;
            const b = new THREE.Box3().setFromObject(o); if (b.isEmpty()) return;
            const w=b.max.x-b.min.x,h=b.max.y-b.min.y,d=b.max.z-b.min.z;
            if(w<.05||d<.05||h<.02)return;
            boxCache.push({minX:b.min.x,maxX:b.max.x,minY:b.min.y,maxY:b.max.y,minZ:b.min.z,maxZ:b.max.z});
        });
    }

    function blocked(x,z,y,radius=.48) {
        for(const b of boxCache){
            if(y+2.05<b.minY||y>b.maxY+.18)continue;
            if(x>b.minX-radius&&x<b.maxX+radius&&z>b.minZ-radius&&z<b.maxZ+radius)return true;
        }
        return false;
    }

    function clearSegment(a,b,y){
        const dx=b.x-a.x,dz=b.z-a.z,len=Math.hypot(dx,dz),steps=Math.max(2,Math.ceil(len/.55));
        for(let i=1;i<steps;i++){const t=i/steps;if(blocked(a.x+dx*t,a.z+dz*t,y,.48))return false;}
        return true;
    }

    // Bounded A*: enough room to route around houses/crates without creating a
    // heavy full-map navmesh every frame.
    function findPath(start,goal,y){
        if(!gameScene)return [];
        if(clearSegment(start,goal,y))return [{x:goal.x,z:goal.z}];
        const cell=1.15,minX=Math.min(start.x,goal.x)-9,maxX=Math.max(start.x,goal.x)+9,minZ=Math.min(start.z,goal.z)-9,maxZ=Math.max(start.z,goal.z)+9;
        const cols=Math.min(31,Math.max(7,Math.ceil((maxX-minX)/cell)+1)),rows=Math.min(31,Math.max(7,Math.ceil((maxZ-minZ)/cell)+1));
        const ox=minX,oz=minZ,key=(x,z)=>x+','+z,nodeAt=(x,z)=>({x,z,px:ox+x*cell,pz:oz+z*cell});
        const sx=Math.max(0,Math.min(cols-1,Math.round((start.x-ox)/cell))),sz=Math.max(0,Math.min(rows-1,Math.round((start.z-oz)/cell)));
        const gx=Math.max(0,Math.min(cols-1,Math.round((goal.x-ox)/cell))),gz=Math.max(0,Math.min(rows-1,Math.round((goal.z-oz)/cell)));
        const startK=key(sx,sz),goalK=key(gx,gz),open=[{x:sx,z:sz,g:0,f:Math.hypot(gx-sx,gz-sz)}],came=new Map(),cost=new Map([[startK,0]]),closed=new Set();
        const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
        while(open.length){
            let bi=0;for(let i=1;i<open.length;i++)if(open[i].f<open[bi].f)bi=i;
            const cur=open.splice(bi,1)[0],ck=key(cur.x,cur.z);if(closed.has(ck))continue;closed.add(ck);
            if(ck===goalK){const path=[];let k=ck;while(k!==startK){const [x,z]=k.split(',').map(Number),n=nodeAt(x,z);path.push({x:n.px,z:n.pz});k=came.get(k);if(!k)break;}path.reverse();return path;}
            for(const [dx,dz] of dirs){
                const nx=cur.x+dx,nz=cur.z+dz;if(nx<0||nz<0||nx>=cols||nz>=rows)continue;
                const n=nodeAt(nx,nz),nk=key(nx,nz);if(closed.has(nk)||blocked(n.px,n.pz,y,.52))continue;
                if(dx&&dz&&(blocked(ox+(cur.x+dx)*cell,oz+cur.z*cell,y,.52)||blocked(ox+cur.x*cell,oz+(cur.z+dz)*cell,y,.52)))continue;
                const ng=cur.g+(dx&&dz?1.414:1);if(ng<(cost.get(nk)??Infinity)){cost.set(nk,ng);came.set(nk,ck);open.push({x:nx,z:nz,g:ng,f:ng+Math.hypot(gx-nx,gz-nz)*1.05});}
            }
        }
        return [];
    }

    function botTeam(bot){
        const torso=bot.userData.parts?.torso,c=torso?.material?.color;if(!c)return'unknown';
        const hex=c.getHex();return(hex&0x0000ff)>((hex>>16)&255)?'blue':'red';
    }

    function chooseTarget(bot){
        const team=botTeam(bot),candidates=[];
        if(gameCamera&&team==='red')candidates.push({pos:gameCamera.position,priority:0});
        for(const other of tracked){if(other===bot||!other.visible)continue;const ot=botTeam(other);if(ot==='unknown'||ot===team)continue;candidates.push({pos:other.position,priority:1});}
        let best=null,score=Infinity;for(const c of candidates){const d=Math.hypot(c.pos.x-bot.position.x,c.pos.z-bot.position.z),s=d+c.priority*1.5;if(s<score){score=s;best=c.pos;}}return best;
    }

    function escapePoint(bot){
        const p=bot.position;let best=null;
        for(let i=0;i<12;i++){const a=i*Math.PI/6;for(const dist of [1.2,2.1,3.2]){const x=p.x+Math.cos(a)*dist,z=p.z+Math.sin(a)*dist;if(!blocked(x,z,p.y,.48)){const score=clearSegment(p,{x,z},p.y)?0:1;if(!best||score<best.score)best={x,z,score};}}}
        return best;
    }

    function steerBot(bot,dt){
        if(!bot.parent||!bot.visible)return;
        let s=botState.get(bot);if(!s){s={lastX:bot.position.x,lastZ:bot.position.z,stuck:0,repath:0,path:[],target:null};botState.set(bot,s);}
        const p=bot.position,target=chooseTarget(bot);if(!target)return;s.repath-=dt;
        const moved=Math.hypot(p.x-s.lastX,p.z-s.lastZ);if(moved<.025)s.stuck+=dt;else{s.stuck=0;s.lastX=p.x;s.lastZ=p.z;}
        if(s.repath<=0||!s.target||Math.hypot(target.x-s.target.x,target.z-s.target.z)>2||s.stuck>.55){
            s.target={x:target.x,z:target.z};s.path=findPath(p,target,p.y);s.repath=.45+nativeRandom()*.25;
            if(s.stuck>.55&&!s.path.length){const e=escapePoint(bot);if(e)s.path=[e];}s.stuck=0;
        }
        while(s.path.length&&Math.hypot(s.path[0].x-p.x,s.path[0].z-p.z)<.7)s.path.shift();if(!s.path.length)return;
        const w=s.path[0],dx=w.x-p.x,dz=w.z-p.z,len=Math.hypot(dx,dz)||1,speed=Math.min(1.25,3.7*dt),nx=p.x+dx/len*speed,nz=p.z+dz/len*speed;
        if(!blocked(nx,nz,p.y,.48)){p.x=nx;p.z=nz;}else{s.repath=0;const e=escapePoint(bot);if(e){p.x=e.x;p.z=e.z;}}
        const fx=target.x-p.x,fz=target.z-p.z;if(Math.hypot(fx,fz)>.1){const want=Math.atan2(-fx,-fz);let d=want-bot.rotation.y;while(d>Math.PI)d-=Math.PI*2;while(d<-Math.PI)d+=Math.PI*2;bot.rotation.y+=d*Math.min(1,dt*7);}
    }

    function navigationTick(now){
        requestAnimationFrame(navigationTick);if(!gameScene)return;
        const dt=Math.min(.1,(now-(navigationTick.last||now))/1000);navigationTick.last=now;collectBots();cacheT-=dt;navT-=dt;
        if(cacheT<=0){rebuildObstacles();cacheT=.8;}if(navT>0)return;navT=.045;
        for(const bot of [...tracked]){if(!bot.parent){tracked.delete(bot);botState.delete(bot);continue;}steerBot(bot,dt);}
    }
    requestAnimationFrame(navigationTick);
})();
