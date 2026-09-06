/* HAMU STRIKE // ADVANCED BOT AI v5
 *
 * No external dependency: the game is a small Three.js client and keeps its
 * gameplay state private inside game.js. This layer therefore builds a tactical
 * AI from the rendered scene instead of replacing the game's combat engine.
 *
 * Systems:
 *  - Behavior Tree style state machine (combat / seek / flank / retreat / recover)
 *  - Utility scoring for target, cover, retreat and flank choices
 *  - Bounded tactical NavMesh/A* over walkable map space
 *  - Raycast-cone perception + line-of-sight memory
 *  - LERP/spring aiming (no instant snap)
 *  - Influence map for threat, recent shots and teammate casualties
 *  - Dynamic obstacle avoidance + separation between friendly bots
 *  - Stuck detection, recovery and automatic re-pathing
 */
(() => {
    'use strict';
    if (!window.THREE) return;

    const T = THREE;
    const nativeRandom = Math.random.bind(Math);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const now = () => performance.now() * 0.001;
    const dist2 = (a,b) => Math.hypot(a.x-b.x, a.z-b.z);

    let gameScene = null;
    let gameCamera = null;
    const bots = new Set();
    const states = new WeakMap();
    const ray = new T.Raycaster();
    const rayHits = [];

    // ---------------------------------------------------------------------
    // Scene capture. game.js keeps scene/camera private, so observe renderer.
    // ---------------------------------------------------------------------
    const originalRender = T.WebGLRenderer.prototype.render;
    T.WebGLRenderer.prototype.render = function(scene, camera) {
        if (scene && scene.isScene) gameScene = scene;
        if (camera && camera.isCamera) gameCamera = camera;
        return originalRender.apply(this, arguments);
    };

    function isBot(o) {
        return !!(o && o.isObject3D && o.userData && o.userData.parts && o.position);
    }

    function collectBots() {
        if (!gameScene) return;
        gameScene.traverse(o => { if (isBot(o)) bots.add(o); });
        for (const b of [...bots]) if (!b.parent) { bots.delete(b); states.delete(b); }
    }

    function teamOf(bot) {
        // Prefer explicit fields when the game has them.
        const explicit = bot.userData.team || bot.userData.teamName || bot.userData.side;
        if (typeof explicit === 'string') {
            const s = explicit.toLowerCase();
            if (s.includes('blue')) return 'blue';
            if (s.includes('red')) return 'red';
        }
        const torso = bot.userData.parts?.torso;
        const material = torso?.material;
        const color = Array.isArray(material) ? material[0]?.color : material?.color;
        if (color) {
            const r=color.r, b=color.b;
            if (b > r * 1.18) return 'blue';
            if (r > b * 1.18) return 'red';
        }
        return 'unknown';
    }

    function alive(bot) {
        if (!bot || !bot.parent || !bot.visible) return false;
        const u=bot.userData;
        if (u.dead || u.eliminated || u.alive === false) return false;
        const hp = u.hp ?? u.health;
        return hp === undefined || hp > 0;
    }

    // ---------------------------------------------------------------------
    // Obstacle representation + tactical navigation grid.
    // ---------------------------------------------------------------------
    const obstacles = [];
    let obstacleTimer = 0;
    const GRID_CELL = 1.0;
    const GRID_RADIUS = 24;
    const BOT_RADIUS = .52;
    const BODY_HEIGHT = 2.05;

    function underCamera(o) {
        let p=o;
        while(p){ if(p===gameCamera) return true; p=p.parent; }
        return false;
    }

    function rebuildObstacles() {
        if (!gameScene) return;
        obstacles.length=0;
        gameScene.updateMatrixWorld(true);
        gameScene.traverse(o=>{
            if(!o.isMesh || isBot(o) || underCamera(o)) return;
            // Do not treat helper/label geometry as walls.
            const name=(o.name||'').toLowerCase();
            if(name.includes('crosshair') || name.includes('weapon') || name.includes('label')) return;
            if(!o.visible && !name.includes('collider') && !name.includes('collision')) return;
            const b=new T.Box3().setFromObject(o);
            if(b.isEmpty()) return;
            const w=b.max.x-b.min.x, h=b.max.y-b.min.y, d=b.max.z-b.min.z;
            if(w<.08 || d<.08 || h<.02) return;
            // Floors are not horizontal navigation blockers; roofs above the bot
            // are ignored by the vertical test in blocked().
            obstacles.push({minX:b.min.x,maxX:b.max.x,minY:b.min.y,maxY:b.max.y,minZ:b.min.z,maxZ:b.max.z});
        });
    }

    function blocked(x,z,y=1.0,r=BOT_RADIUS) {
        for(const b of obstacles){
            if(y + BODY_HEIGHT < b.minY - .08 || y > b.maxY + .18) continue;
            if(x > b.minX-r && x < b.maxX+r && z > b.minZ-r && z < b.maxZ+r) return true;
        }
        return false;
    }

    function segmentClear(a,b,y,r=BOT_RADIUS) {
        const dx=b.x-a.x,dz=b.z-a.z;
        const n=Math.max(2,Math.ceil(Math.hypot(dx,dz)/.42));
        for(let i=1;i<n;i++){
            const t=i/n;
            if(blocked(a.x+dx*t,a.z+dz*t,y,r)) return false;
        }
        return true;
    }

    function safePoint(x,z,y) {
        return !blocked(x,z,y,BOT_RADIUS);
    }

    // A tactical local navmesh: nodes are generated only around the current
    // squad fight, then A* selects a route. This is much cheaper than a full
    // 3-D navmesh and is stable for this map size.
    function buildPath(start, goal, y) {
        if(!gameScene || !Number.isFinite(goal.x) || !Number.isFinite(goal.z)) return [];
        if(segmentClear(start,goal,y)) return [{x:goal.x,z:goal.z}];

        const minX=Math.min(start.x,goal.x)-GRID_RADIUS, maxX=Math.max(start.x,goal.x)+GRID_RADIUS;
        const minZ=Math.min(start.z,goal.z)-GRID_RADIUS, maxZ=Math.max(start.z,goal.z)+GRID_RADIUS;
        const cols=clamp(Math.ceil((maxX-minX)/GRID_CELL)+1,9,53);
        const rows=clamp(Math.ceil((maxZ-minZ)/GRID_CELL)+1,9,53);
        const ox=minX,oz=minZ;
        const key=(x,z)=>x+','+z;
        const px=x=>ox+x*GRID_CELL, pz=z=>oz+z*GRID_CELL;
        const sx=clamp(Math.round((start.x-ox)/GRID_CELL),0,cols-1);
        const sz=clamp(Math.round((start.z-oz)/GRID_CELL),0,rows-1);
        const gx=clamp(Math.round((goal.x-ox)/GRID_CELL),0,cols-1);
        const gz=clamp(Math.round((goal.z-oz)/GRID_CELL),0,rows-1);
        const startK=key(sx,sz),goalK=key(gx,gz);
        const open=[{x:sx,z:sz,g:0,f:Math.hypot(gx-sx,gz-sz)}];
        const came=new Map(), cost=new Map([[startK,0]]), closed=new Set();
        const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];

        while(open.length){
            let best=0;
            for(let i=1;i<open.length;i++) if(open[i].f<open[best].f) best=i;
            const cur=open.splice(best,1)[0], ck=key(cur.x,cur.z);
            if(closed.has(ck)) continue;
            closed.add(ck);
            if(ck===goalK){
                const out=[]; let k=ck;
                while(k!==startK){
                    const [x,z]=k.split(',').map(Number);
                    out.push({x:px(x),z:pz(z)});
                    k=came.get(k); if(!k) break;
                }
                out.reverse();
                // String together long clear sections; this prevents robotic
                // one-metre zig-zag movement.
                const smooth=[]; let anchor={x:start.x,z:start.z};
                for(const p of out){
                    if(!segmentClear(anchor,p,y)) { smooth.push(p); anchor=p; }
                }
                const last=out[out.length-1];
                if(last && (!smooth.length || dist2(smooth[smooth.length-1],last)>.2)) smooth.push(last);
                return smooth;
            }
            for(const [dx,dz] of dirs){
                const nx=cur.x+dx,nz=cur.z+dz;
                if(nx<0||nz<0||nx>=cols||nz>=rows) continue;
                const x=px(nx),z=pz(nz),nk=key(nx,nz);
                if(closed.has(nk) || !safePoint(x,z,y)) continue;
                if(dx&&dz){
                    if(!safePoint(px(cur.x+dx),pz(cur.z),y) || !safePoint(px(cur.x),pz(cur.z+dz),y)) continue;
                }
                const ng=cur.g+(dx&&dz?1.414:1);
                if(ng < (cost.get(nk) ?? Infinity)){
                    cost.set(nk,ng); came.set(nk,ck);
                    open.push({x:nx,z:nz,g:ng,f:ng+Math.hypot(gx-nx,gz-nz)*1.08});
                }
            }
        }
        return [];
    }

    function randomFreeNear(p,y,min=2,max=6){
        for(let i=0;i<20;i++){
            const a=nativeRandom()*Math.PI*2;
            const d=min+nativeRandom()*(max-min);
            const q={x:p.x+Math.cos(a)*d,z:p.z+Math.sin(a)*d};
            if(safePoint(q.x,q.z,y)) return q;
        }
        return null;
    }

    // ---------------------------------------------------------------------
    // Influence map / tactical memory.
    // ---------------------------------------------------------------------
    const influence = [];
    let influenceTimer=0;
    const memory={enemyShots:[],deaths:[],enemySightings:[]};

    function remember(list,power,life=5){
        if(!p) return;
    }

    function addMemory(list,p,power=1,life=5){
        list.push({x:p.x,z:p.z,power,ttl:life});
        if(list.length>80) list.splice(0,list.length-80);
    }

    function decayMemory(dt){
        for(const list of [memory.enemyShots,memory.deaths,memory.enemySightings]){
            for(const m of list) m.ttl-=dt;
            for(let i=list.length-1;i>=0;i--) if(list[i].ttl<=0) list.splice(i,1);
        }
    }

    function threatAt(x,z){
        let s=0;
        for(const m of memory.enemyShots){const d=Math.hypot(x-m.x,z-m.z);if(d<11)s+=m.power*(1-d/11);}
        for(const m of memory.deaths){const d=Math.hypot(x-m.x,z-m.z);if(d<13)s+=m.power*1.5*(1-d/13);}
        for(const m of memory.enemySightings){const d=Math.hypot(x-m.x,z-m.z);if(d<15)s+=m.power*(1-d/15);}
        return s;
    }

    function updateInfluence(){
        // Influence is sampled lazily when decisions are made. The memory lists
        // are the sparse influence map, avoiding a large per-frame grid.
        influence.length=0;
        for(const m of [...memory.enemyShots,...memory.deaths,...memory.enemySightings]) influence.push(m);
    }

    // ---------------------------------------------------------------------
    // Perception: cone + raycast LoS + short-term enemy memory.
    // ---------------------------------------------------------------------
    function worldPoint(bot,offsetY=1.55){
        const p=bot.position;
        return new T.Vector3(p.x,p.y+offsetY,p.z);
    }

    function hasLOS(bot,target){
        if(!gameScene || !target) return false;
        const a=worldPoint(bot), b=worldPoint(target,1.35);
        const dir=b.clone().sub(a), len=dir.length();
        if(len<.1) return true;
        dir.normalize();
        ray.set(a,dir); ray.far=Math.max(.1,len-.12);
        rayHits.length=0;
        const objects=[];
        gameScene.traverse(o=>{
            if(o.isMesh && o.visible && !isBot(o) && !underCamera(o)) objects.push(o);
        });
        const hits=ray.intersectObjects(objects,true);
        return hits.length===0;
    }

    function canSee(bot,target){
        if(!target || !alive(target)) return false;
        const dx=target.position.x-bot.position.x,dz=target.position.z-bot.position.z;
        const d=Math.hypot(dx,dz); if(d>34) return false;
        const forward=new T.Vector3(0,0,-1).applyQuaternion(bot.quaternion); forward.y=0; forward.normalize();
        const to=new T.Vector3(dx,0,dz).normalize();
        // 115 degree vision cone; close targets can be noticed almost anywhere.
        const cone=forward.dot(to);
        if(d>3 && cone<Math.cos(1.0)) return false;
        return hasLOS(bot,target);
    }

    function allEnemies(bot){
        const team=teamOf(bot), out=[];
        for(const other of bots){
            if(other===bot || !alive(other)) continue;
            const ot=teamOf(other);
            if(team!=='unknown' && ot===team) continue;
            if(ot==='unknown' && team==='unknown') continue;
            out.push(other);
        }
        if(team==='blue' && gameCamera) out.push(gameCamera);
        return out;
    }

    function perceivedEnemies(bot,s){
        const enemies=allEnemies(bot), visible=[];
        for(const e of enemies){
            if(canSee(bot,e)){
                const d=dist2(bot.position,e.position);
                visible.push({entity:e,distance:d});
                s.memoryTarget=e; s.memoryX=e.position.x; s.memoryZ=e.position.z; s.memoryTTL=3.2;
                addMemory(memory.enemySightings,e.position,.75,3.2);
            }
        }
        return visible;
    }

    // ---------------------------------------------------------------------
    // Utility AI: target, cover, flank, retreat and movement choices.
    // ---------------------------------------------------------------------
    function healthOf(bot){
        const h=bot.userData.hp ?? bot.userData.health;
        return Number.isFinite(h) ? clamp(h/100,0,1) : 1;
    }
    function ammoOf(bot){
        const u=bot.userData;
        const a=u.ammo ?? u.mag ?? u.clip;
        return Number.isFinite(a) ? clamp(a/30,0,1) : .7;
    }

    function targetScore(bot,e,s){
        const d=dist2(bot.position,e.position);
        const los=canSee(bot,e)?1:0;
        const hp=healthOf(e);
        const remembered=(s.memoryTarget===e && s.memoryTTL>0)?1:0;
        return (1-Math.min(d,35)/35)*2.1 + los*3.5 + remembered*1.3 + (1-hp)*.7 + threatAt(e.position.x,e.position.z)*.18;
    }

    function chooseTarget(bot,s,visible){
        let best=null,bestScore=-Infinity;
        for(const v of visible){
            const score=targetScore(bot,v.entity,s);
            if(score>bestScore){bestScore=score;best=v.entity;}
        }
        if(!best && s.memoryTTL>0 && s.memoryTarget && alive(s.memoryTarget)) best=s.memoryTarget;
        return best;
    }

    function coverScore(bot,p,enemy){
        if(!safePoint(p.x,p.z,bot.position.y)) return -100;
        const threat=threatAt(p.x,p.z);
        let score=2.5-threat*.9;
        if(enemy){
            const d=Math.hypot(p.x-enemy.position.x,p.z-enemy.position.z);
            score+=clamp(d/14,0,2);
            if(!segmentClear(p,enemy.position,bot.position.y)) score+=3.2; // actual cover
        }
        return score;
    }

    function findTacticalPoint(bot,enemy,kind){
        const p=bot.position;
        let best=null,bestScore=-Infinity;
        for(let i=0;i<22;i++){
            const a=(i/22)*Math.PI*2;
            const d=kind==='retreat'?3.5+nativeRandom()*5:2.5+nativeRandom()*8;
            const q={x:p.x+Math.cos(a)*d,z:p.z+Math.sin(a)*d};
            const score=coverScore(bot,q,enemy) + (kind==='flank' && enemy ?
                (Math.abs(Math.sin(a))+.25)*2 : 0);
            if(score>bestScore){bestScore=score;best=q;}
        }
        return best;
    }

    // ---------------------------------------------------------------------
    // Aim: smooth interpolation, micro-corrections and strafe bias.
    // ---------------------------------------------------------------------
    function aimAt(bot,target,dt,s){
        if(!target) return;
        const dx=target.position.x-bot.position.x,dz=target.position.z-bot.position.z;
        if(Math.hypot(dx,dz)<.05)return;
        const desired=Math.atan2(-dx,-dz);
        let delta=desired-bot.rotation.y;
        while(delta>Math.PI)delta-=Math.PI*2;
        while(delta<-Math.PI)delta+=Math.PI*2;
        // Small human-like reaction delay + aim error. The error changes slowly
        // instead of teleporting the crosshair onto the target.
        s.aimNoiseT-=dt;
        if(s.aimNoiseT<=0){s.aimNoiseT=.18+nativeRandom()*.22;s.aimNoise=(nativeRandom()-.5)*.055;}
        const wanted=delta+s.aimNoise;
        const gain=5.5 + (1-healthOf(bot))*1.8;
        bot.rotation.y += wanted*(1-Math.exp(-gain*dt));
    }

    // ---------------------------------------------------------------------
    // Behavior Tree style controller.
    // ---------------------------------------------------------------------
    function stateFor(bot){
        let s=states.get(bot);
        if(s)return s;
        s={
            state:'SEARCH', path:[], pathIndex:0, goal:null,
            target:null,memoryTarget:null,memoryX:0,memoryZ:0,memoryTTL:0,
            repath:0, stuck:0,lastX:bot.position.x,lastZ:bot.position.z,
            decision:0, aimNoiseT:0, aimNoise:0, strafeDir:nativeRandom()<.5?-1:1,
            attackT:0, searchT:0, coverT:0, lastSeen:0
        };
        states.set(bot,s); return s;
    }

    function chooseState(bot,s,visible){
        const hp=healthOf(bot), ammo=ammoOf(bot);
        const target=chooseTarget(bot,s,visible);
        s.target=target;
        if(!target){ s.state='SEARCH'; return; }
        const d=dist2(bot.position,target.position);
        const los=canSee(bot,target);
        if(hp<.25){s.state='RETREAT';return;}
        if(ammo<.12){s.state='REPOSITION';return;}
        if(los && d<20){
            const flank=2.0 + (1-hp)*2.2 + threatAt(bot.position.x,bot.position.z)*.3;
            const attack=2.7 + (los?2:0) + clamp((18-d)/18,0,1);
            s.state=flank>attack ? 'FLANK' : 'ATTACK';
            return;
        }
        if(s.memoryTTL>0){s.state='PURSUE';return;}
        s.state='SEARCH';
    }

    function setGoal(bot,s,goal){
        if(!goal)return;
        s.goal={x:goal.x,z:goal.z};
        s.path=buildPath(bot.position,goal,bot.position.y);
        s.pathIndex=0;
        s.repath=.65+nativeRandom()*.35;
    }

    function followPath(bot,s,dt){
        if(!s.path.length)return false;
        while(s.pathIndex<s.path.length && dist2(bot.position,s.path[s.pathIndex])<.65) s.pathIndex++;
        if(s.pathIndex>=s.path.length)return false;
        const w=s.path[s.pathIndex], dx=w.x-bot.position.x,dz=w.z-bot.position.z,len=Math.hypot(dx,dz)||1;
        // Soft local avoidance: don't pile all squadmates onto one doorway.
        let ax=0,az=0;
        for(const other of bots){
            if(other===bot || !alive(other) || teamOf(other)!==teamOf(bot))continue;
            const d=dist2(bot.position,other.position);
            if(d<1.15 && d>.01){ax+=(bot.position.x-other.position.x)/d*(1.15-d);az+=(bot.position.z-other.position.z)/d*(1.15-d);}
        }
        const vx=dx/len+ax*.7,vz=dz/len+az*.7,vlen=Math.hypot(vx,vz)||1;
        const speed=(s.state==='RETREAT'?4.4:3.55)*dt;
        const nx=bot.position.x+vx/vlen*speed,nz=bot.position.z+vz/vlen*speed;
        if(!blocked(nx,nz,bot.position.y,.5)){bot.position.x=nx;bot.position.z=nz;}
        else {s.repath=0;s.stuck+=dt;}
        return true;
    }

    function behaviorTick(bot,dt){
        if(!alive(bot))return;
        const s=stateFor(bot);
        s.repath-=dt;s.decision-=dt;s.memoryTTL-=dt;
        if(s.memoryTTL<0)s.memoryTTL=0;

        const moved=dist2(bot.position,{x:s.lastX,z:s.lastZ});
        if(moved<.018)s.stuck+=dt;else{s.stuck=0;s.lastX=bot.position.x;s.lastZ=bot.position.z;}
        if(s.stuck>.7){
            const escape=randomFreeNear(bot.position,bot.position.y,1.4,4.2);
            if(escape)setGoal(bot,s,escape);
            s.stuck=0;s.repath=0;
        }

        // Behavior-tree decision node: perception -> utility -> action.
        if(s.decision<=0){
            const visible=perceivedEnemies(bot,s);
            chooseState(bot,s,visible);
            s.decision=.16+nativeRandom()*.12;
        }

        const target=s.target;
        if(target) aimAt(bot,target,dt,s);

        if(s.state==='ATTACK'){
            // Maintain combat distance and make the existing game AI's weapon
            // direction useful. Strafe instead of standing at the target point.
            const d=target?dist2(bot.position,target.position):99;
            if(target && d<4.2){
                const dx=target.position.x-bot.position.x,dz=target.position.z-bot.position.z,len=Math.hypot(dx,dz)||1;
                const sx=-dz/len*s.strafeDir,sz=dx/len*s.strafeDir;
                const nx=bot.position.x+sx*2.1*dt,nz=bot.position.z+sz*2.1*dt;
                if(!blocked(nx,nz,bot.position.y,.5)){bot.position.x=nx;bot.position.z=nz;}
            } else if(target && d>15){
                if(s.repath<=0||!s.path.length)setGoal(bot,s,target.position);
                followPath(bot,s,dt);
            }
        } else if(s.state==='FLANK'){
            if(s.repath<=0||!s.path.length){const q=findTacticalPoint(bot,target,'flank');setGoal(bot,s,q);}
            followPath(bot,s,dt);
        } else if(s.state==='RETREAT'){
            if(s.repath<=0||!s.path.length){const q=findTacticalPoint(bot,target,'retreat');setGoal(bot,s,q);}
            followPath(bot,s,dt);
        } else if(s.state==='PURSUE'){
            const goal={x:s.memoryX,z:s.memoryZ};
            if(s.repath<=0||!s.path.length||!s.goal||dist2(s.goal,goal)>2.5)setGoal(bot,s,goal);
            followPath(bot,s,dt);
        } else if(s.state==='REPOSITION'){
            if(s.repath<=0||!s.path.length){const q=findTacticalPoint(bot,target,'retreat')||randomFreeNear(bot.position,bot.position.y);setGoal(bot,s,q);}
            followPath(bot,s,dt);
        } else {
            // SEARCH: use last known position, then choose a safe tactical point.
            if(s.repath<=0||!s.path.length){
                const q=s.memoryTTL>0?{x:s.memoryX,z:s.memoryZ}:randomFreeNear(bot.position,bot.position.y,4,9);
                if(q)setGoal(bot,s,q);
            }
            followPath(bot,s,dt);
        }

        // Lightly record suspicious/stuck positions as danger, giving squadmates
        // a shared tactical memory rather than repeatedly taking the same route.
        if(s.stuck>.35)addMemory(memory.enemyShots,bot.position,.12,1.5);
    }

    // ---------------------------------------------------------------------
    // Main loop. Navigation/AI runs at a bounded rate for stable FPS.
    // ---------------------------------------------------------------------
    let aiAccumulator=0, last=performance.now();
    function tick(t){
        requestAnimationFrame(tick);
        if(!gameScene)return;
        const dt=clamp((t-last)/1000,0,.08);last=t;
        aiAccumulator+=dt; obstacleTimer-=dt; influenceTimer-=dt;
        if(obstacleTimer<=0){rebuildObstacles();obstacleTimer=1.0;}
        decayMemory(dt);
        if(influenceTimer<=0){updateInfluence();influenceTimer=.25;}
        if(aiAccumulator<.045)return;
        const step=aiAccumulator; aiAccumulator=0;
        collectBots();
        for(const bot of bots) behaviorTick(bot,step);
    }
    requestAnimationFrame(tick);
})();
