import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {MODELS} from './data.js';
import {DESKS,assignSeats,seatOf} from './layout.js';
import {CAMERA_LIMITS,CAMERA_PRESETS,cameraFrame,boundedZoom,orbitPosition} from './camera.js';

// People, the cat and the vacuum move along these floor lanes so nobody walks through a desk.
const FLOOR_Y=.17, AISLE_X=3, WALK_SPEED=2.4;
const CORRIDOR={front:5.45,middle:.05,back:-5.4};
const PODS=[[-7.4,2.85,'#efc7a1'],[-1.6,2.85,'#cbd8b9'],[-7.4,-2.75,'#c9d5d9'],[-1.6,-2.75,'#ead6ad']];
// Lounge spots in the order resting agents take them. Each approach point is reached in a
// straight line from the aisle; the first two are the ping-pong table.
const REST_SPOTS=[
 {key:'pp-l',kind:'pingpong',x:5.55,y:FLOOR_Y,z:1,yaw:Math.PI/2,approach:[5.55,1]},
 {key:'pp-r',kind:'pingpong',x:9.05,y:FLOOR_Y,z:1,yaw:-Math.PI/2,approach:[9.05,2.3]},
 {key:'sofa-l',kind:'sofa',x:6.3,y:.81,z:-4.35,yaw:0,approach:[6.3,-3.45]},
 {key:'sofa-r',kind:'sofa',x:7.7,y:.81,z:-4.35,yaw:0,approach:[7.7,-3.45]},
 {key:'stool-l',kind:'stool',x:5.95,y:.72,z:4.3,yaw:Math.PI/2,approach:[5.95,4.3]},
 {key:'stool-r',kind:'stool',x:8.05,y:.72,z:4.3,yaw:-Math.PI/2,approach:[8.05,5.45]},
];
const PING_PONG={x:7.3,z:1,top:.81,paddleX:[5.93,8.67]};
// The cat strolls this loop; the third value is how long it lingers there, in seconds.
const CAT_ROUTE=[[9.9,3.3,10],[9.3,2.3,0],[3,2.3,0],[3,.05,0],[-1.6,.05,4],[-7.4,.05,5],[-10.1,.05,1],[-4.5,.05,0],[3,.05,0],[3,-3.45,0],[4.6,-3.45,4],[3,-3.45,0],[3,2.3,0],[9.3,2.3,0]];
const VACUUM_ROUTE=[[2.2,5.45],[-10.2,5.45],[-10.2,.05],[2.2,.05],[2.2,-5.4],[-10.2,-5.4]];

const vec=(x,y,z)=>new THREE.Vector3(x,y,z);
const turn=(from,to)=>{let d=(to-from)%(Math.PI*2);if(d>Math.PI)d-=Math.PI*2;if(d<-Math.PI)d+=Math.PI*2;return d;};
const hash=n=>{let x=Math.imul(n|0,2654435761)>>>0;x^=x>>>15;x=Math.imul(x,2246822519)>>>0;return (x^x>>>13)>>>0;};
const smooth=(a,b,v)=>{const k=Math.min(1,Math.max(0,(v-a)/(b-a)));return k*k*(3-2*k);};
const bounce=v=>1-Math.abs((v%2+2)%2-1);

function deskSpot(desk){
 const seat=seatOf(desk),out=desk.dir;
 const corridor=out>0?(desk.z>0?CORRIDOR.front:CORRIDOR.middle):(desk.z>0?CORRIDOR.middle:CORRIDOR.back);
 return {key:desk.id,kind:'desk',x:seat.x,y:.82,z:seat.z,yaw:seat.yaw,corridor,exit:[[seat.x,seat.z+.45*out],[seat.x,corridor],[AISLE_X,corridor]]};
}
const restSpot=spot=>({...spot,exit:[spot.approach,[AISLE_X,spot.approach[1]]]});
// Walk out of one spot to the aisle and into the next; desks on the same corridor skip the aisle.
function route(from,to){
 const out=from.exit.map(([x,z])=>vec(x,FLOOR_Y,z)),back=to.exit.map(([x,z])=>vec(x,FLOOR_Y,z)).reverse();
 if(from.corridor!==undefined&&from.corridor===to.corridor){out.pop();back.shift();}
 return [...out,...back,vec(to.x,to.y,to.z)];
}

export class OfficeScene {
 constructor(container,labels,onSelect,onZoom,onDesk,onActivity,onViewChange){
  this.onViewChange=onViewChange;this.dragMode='rotate';
  this.onDesk=onDesk;this.onActivity=onActivity;this.workstations=new Map();this.hotspots=[];this.effects={};this.container=container;this.labels=labels;this.onSelect=onSelect;this.onZoom=onZoom;this.characters=new Map();this.clock=new THREE.Clock();this.reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;this.isPaused=false;this.night=false;this.labelAnchor=new THREE.Vector3();this.dragging=false;this.lastCameraMove=0;this.lastFrame=0;this.agentSignature='';
  this.trees=[];this.bursts=[];this.spriteMaterials=new Map();this.podLights=[];this.step=new THREE.Vector3();this.lastTime=0;this.rallyTime=0;this.players=[undefined,undefined];
  this.scene=new THREE.Scene();
  this.camera=new THREE.OrthographicCamera(-10,10,8,-8,.1,150);this.camera.position.set(...CAMERA_PRESETS.overview.pos);
  this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});this.renderer.setClearColor(0x000000,0);this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1;container.appendChild(this.renderer.domElement);
  this.controls=new OrbitControls(this.camera,this.renderer.domElement);
  this.controls.target.set(...CAMERA_PRESETS.overview.target);this.controls.enableDamping=true;this.controls.dampingFactor=.09;
  this.controls.enablePan=true;this.controls.rotateSpeed=.65;this.controls.zoomSpeed=.8;this.controls.panSpeed=.8;
  Object.assign(this.controls,{minPolarAngle:CAMERA_LIMITS.minPolar,maxPolarAngle:CAMERA_LIMITS.maxPolar,minZoom:CAMERA_LIMITS.minZoom,maxZoom:CAMERA_LIMITS.maxZoom});
  this.controls.touches={ONE:THREE.TOUCH.ROTATE,TWO:THREE.TOUCH.DOLLY_PAN};this.controls.update();
  this.controls.addEventListener('start',()=>{this.cameraAnimation=null;this.dragging=true;this.onViewChange?.(null);});
  this.controls.addEventListener('end',()=>{this.dragging=false;});
  this.renderer.domElement.tabIndex=0;
  this.renderer.domElement.setAttribute('aria-label','旋转和平移办公室');
  this.renderer.domElement.setAttribute('aria-describedby','camera-help');
  this.renderer.domElement.addEventListener('keydown',event=>{
   if(event.altKey||event.ctrlKey||event.metaKey)return;
   const steps={ArrowLeft:[-.2,0],ArrowRight:[.2,0],ArrowUp:[0,-.15],ArrowDown:[0,.15]};
   if(steps[event.key])this.orbit(...steps[event.key]);
   else if(event.key==='+'||event.key==='=')this.zoom(.15);
   else if(event.key==='-')this.zoom(-.15);
   else if(event.key==='0')this.setView('overview');
   else return;
   event.preventDefault();event.stopPropagation();
  });
  this.controls.addEventListener('change',()=>{this.lastCameraMove=performance.now();this.onZoom?.(Math.round(this.camera.zoom*100));});
  this.hemi=new THREE.HemisphereLight(0xfff9e6,0xb4c49d,2.2);this.scene.add(this.hemi);
  this.sun=new THREE.DirectionalLight(0xfff5dd,3.1);this.sun.position.set(-5,20,12);this.sun.castShadow=true;this.sun.shadow.mapSize.set(2048,2048);Object.assign(this.sun.shadow.camera,{left:-19,right:19,top:19,bottom:-19,near:1,far:60});this.sun.shadow.normalBias=.045;this.sun.shadow.bias=-.0003;this.sun.shadow.radius=4;this.scene.add(this.sun);
  this.fill=new THREE.DirectionalLight(0xe2eeff,.9);this.fill.position.set(8,7,-7);this.scene.add(this.fill);
  this.materialCache=new Map();this.meshes=[];
  this.buildOffice();this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(container);this.resize();
  this.pointerStart=null;
  container.addEventListener('pointerdown',event=>{
   this.cameraAnimation=null;
   this.pointerStart=event.isPrimary&&event.button===0?{id:event.pointerId,x:event.clientX,y:event.clientY,moved:false}:null;
  });
  container.addEventListener('pointermove',event=>{const p=this.pointerStart;if(p&&p.id===event.pointerId&&Math.hypot(event.clientX-p.x,event.clientY-p.y)>5)p.moved=true;});
  container.addEventListener('pointerup',event=>{const p=this.pointerStart;this.pointerStart=null;if(p&&p.id===event.pointerId&&!p.moved&&Math.hypot(event.clientX-p.x,event.clientY-p.y)<5)this.pick(event);});
  container.addEventListener('pointercancel',()=>{this.pointerStart=null;});
  for(const type of ['pointerup','pointercancel','blur'])window.addEventListener(type,()=>{this.dragging=false;this.pointerStart=null;});
  this.animate=this.animate.bind(this);this.renderer.setAnimationLoop(this.animate);
 }
 mat(color,roughness=.75){const key=color+':'+roughness;if(!this.materialCache.has(key)){const m=new THREE.MeshStandardMaterial({color,roughness});m.userData.bake=true;this.materialCache.set(key,m);}return this.materialCache.get(key);}
 bakedMaterial(roughness){const key='baked:'+roughness;if(!this.materialCache.has(key))this.materialCache.set(key,new THREE.MeshStandardMaterial({vertexColors:true,roughness}));return this.materialCache.get(key);}
 // Draw calls, not triangles, are what made this scene heavy: every plank, key and cushion
 // was its own mesh. bake() folds the meshes under `root` into one vertex-coloured mesh per
 // roughness and shadow setting. Subtrees marked `userData.dynamic` are left alone so they
 // can keep moving. The originals stay in the graph, hidden, because clicks are still
 // resolved against them (Raycaster ignores `visible`).
 bake(root){
  root.updateWorldMatrix(true,true);
  const inverse=new THREE.Matrix4().copy(root.matrixWorld).invert(),buckets=new Map();
  const collect=o=>{
   if(o!==root&&o.userData.dynamic)return;
   if(o.isMesh&&o.visible){const m=o.material,kind=m.userData.bake?'c:'+m.roughness:m.userData.merge?'m:'+m.uuid:null;if(kind){const key=`${kind}:${+o.castShadow}:${+o.receiveShadow}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(o);}}
   for(const child of o.children)collect(child);
  };
  collect(root);
  const local=new THREE.Matrix4(),normalMatrix=new THREE.Matrix3(),v=new THREE.Vector3();
  for(const meshes of buckets.values()){
   if(meshes.length<2)continue;
   const first=meshes[0],colored=!!first.material.userData.bake;let vertexCount=0,indexCount=0;
   for(const mesh of meshes){const g=mesh.geometry;vertexCount+=g.attributes.position.count;indexCount+=g.index?g.index.count:g.attributes.position.count;}
   const position=new Float32Array(vertexCount*3),normal=new Float32Array(vertexCount*3),color=colored?new Float32Array(vertexCount*3):null,index=new Uint32Array(indexCount);
   let vertexOffset=0,indexOffset=0;
   for(const mesh of meshes){
    const g=mesh.geometry,p=g.attributes.position,n=g.attributes.normal,c=mesh.material.color;
    local.multiplyMatrices(inverse,mesh.matrixWorld);normalMatrix.getNormalMatrix(local);
    for(let i=0;i<p.count;i++){
     const at=(vertexOffset+i)*3;
     v.fromBufferAttribute(p,i).applyMatrix4(local);position[at]=v.x;position[at+1]=v.y;position[at+2]=v.z;
     v.fromBufferAttribute(n,i).applyMatrix3(normalMatrix).normalize();normal[at]=v.x;normal[at+1]=v.y;normal[at+2]=v.z;
     if(color){color[at]=c.r;color[at+1]=c.g;color[at+2]=c.b;}
    }
    if(g.index)for(let i=0;i<g.index.count;i++)index[indexOffset++]=g.index.getX(i)+vertexOffset;
    else for(let i=0;i<p.count;i++)index[indexOffset++]=vertexOffset+i;
    vertexOffset+=p.count;mesh.visible=false;
   }
   const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(position,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normal,3));if(color)geometry.setAttribute('color',new THREE.BufferAttribute(color,3));geometry.setIndex(new THREE.BufferAttribute(index,1));
   const merged=new THREE.Mesh(geometry,colored?this.bakedMaterial(first.material.roughness):first.material);merged.castShadow=first.castShadow;merged.receiveShadow=first.receiveShadow;merged.raycast=()=>{};root.add(merged);
  }
 }
 group(x,y,z,parent=this.scene){const g=new THREE.Group();g.position.set(x,y,z);parent.add(g);return g;}
 box(w,h,d,color,x,y,z,parent=this.scene,round=0){let geo;if(round){const shape=new THREE.Shape();const r=Math.min(round,w/2,h/2);const a=-w/2,b=-h/2;shape.moveTo(a+r,b);shape.lineTo(a+w-r,b);shape.quadraticCurveTo(a+w,b,a+w,b+r);shape.lineTo(a+w,b+h-r);shape.quadraticCurveTo(a+w,b+h,a+w-r,b+h);shape.lineTo(a+r,b+h);shape.quadraticCurveTo(a,b+h,a,b+h-r);shape.lineTo(a,b+r);shape.quadraticCurveTo(a,b,a+r,b);geo=new THREE.ExtrudeGeometry(shape,{depth:d,bevelEnabled:true,bevelThickness:r*.4,bevelSize:r*.4,bevelSegments:2,steps:1,curveSegments:3});geo.translate(0,0,-d/2);}else geo=new THREE.BoxGeometry(w,h,d);const m=new THREE.Mesh(geo,this.mat(color));m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
 sphere(r,color,x,y,z,parent=this.scene,sx=1,sy=1,sz=1){const m=new THREE.Mesh(new THREE.SphereGeometry(r,20,14),this.mat(color,.8));m.position.set(x,y,z);m.scale.set(sx,sy,sz);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
 cylinder(rt,rb,h,color,x,y,z,parent=this.scene,segments=24){const m=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,segments),this.mat(color));m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
 text(text,w=256,h=80,size=28,color='#7d836d',background=null){const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');if(background){ctx.fillStyle=background;ctx.fillRect(0,0,w,h);}ctx.fillStyle=color;ctx.font=`500 ${size}px Arial, sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,w/2,h/2);const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace;return new THREE.MeshBasicMaterial({map:tex,transparent:!background,side:THREE.DoubleSide});}
 floorText(text,w,x,z,color){const m=new THREE.Mesh(new THREE.PlaneGeometry(w,w*96/768),this.text(text,768,96,27,color));m.rotation.x=-Math.PI/2;m.position.set(x,.24,z);this.scene.add(m);}

 buildOffice(){
  const s=this.scene;
  // The page shows through the canvas; this plane only catches shadows.
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.ShadowMaterial({opacity:.13}));ground.rotation.x=-Math.PI/2;ground.position.y=-.38;ground.receiveShadow=true;s.add(ground);this.ground=ground;
  this.box(22.4,.32,13.6,'#c5b58f',0,-.15,0,s,.07);
  this.box(22.25,.12,13.45,'#e4cda2',0,.055,0);
  for(let i=0;i<36;i++)for(let j=0;j<4;j++)this.box(.61,.027,3.34,['#e2c99c','#e5cda2','#e8d2a9','#dfc398'][(i+j)%4],-10.82+i*.62,.125,-5.02+j*3.35);
  // One rug per pod gives each team its own little territory.
  for(const [x,z,color] of PODS){this.box(4.9,.035,4.2,'#f4e7d0',x,.17,z,s,.04);this.box(4.7,.04,4,color,x,.19,z,s,.04);}
  this.box(6.1,.035,12.2,'#c7d1b5',7.4,.19,0,s,.05);this.box(5.8,.01,11.9,'#d1d9be',7.4,.215,0,s,.03);
  const glass=new THREE.MeshPhysicalMaterial({color:'#eff5e7',transparent:true,opacity:.19,roughness:.12,depthWrite:false,side:THREE.DoubleSide});glass.userData.merge=true;
  for(let i=0;i<12;i++){
   const x=-11+i*2;this.box(.055,3.1,.055,'#e7e9d9',x,1.7,-6.6);
   if(i<11){const pane=new THREE.Mesh(new THREE.PlaneGeometry(1.94,3),glass);pane.position.set(x+1,1.72,-6.6);s.add(pane);}
  }
  this.box(22.1,.06,.065,'#f6f5e8',0,3.26,-6.6);this.box(22.1,.07,.07,'#e9e7d4',0,.25,-6.6);this.box(22.1,.045,.05,'#eff0df',0,1.2,-6.6);
  for(let i=0;i<6;i++)this.box(.065,3.1,.065,'#e9e9dc',-11,1.7,-6.6+i*2.2);
  this.box(.065,.06,11,'#f4f3e6',-11,3.26,-1.1);
  this.box(22.1,.055,.055,'#f0ebd9',0,.38,6.6);for(let x=-11;x<=11;x+=2.75)this.box(.06,.5,.06,'#f3efdf',x,.5,6.6);
  for(const pos of [[-12,-5,1.1],[-7,-8,1.1],[0,-8.3,1],[8,-8,1.2],[12,-4,1.1],[-12,5,1],[12,6,.9]])this.tree(...pos);
  this.plant(-10.55,-6.1,.8);this.plant(-10.55,6.15,.8);this.plant(1.6,-6.15,.75);this.plant(10.5,-.9,.85);this.plant(10.5,5.9,.9);
  this.wallClock(2.8,2.6,-6.54);
  DESKS.forEach((desk,i)=>this.desk(desk,i));
  for(const [x,z] of PODS){const light=new THREE.PointLight('#ffcf8f',0,8.5,1.4);light.visible=false;light.position.set(x,2.3,z);s.add(light);this.podLights.push({light,x,z});}
  this.loungeLight=new THREE.PointLight('#ffd6a0',0,9,1.4);this.loungeLight.visible=false;this.loungeLight.position.set(7.4,2.4,-.5);s.add(this.loungeLight);
  this.buildLounge();
  this.buildCat();
  this.buildVacuum();
  this.confetti=new THREE.Group();s.add(this.confetti);this.confetti.visible=false;
  for(let i=0;i<96;i++){const piece=new THREE.Mesh(new THREE.PlaneGeometry(.13,.19),new THREE.MeshBasicMaterial({color:['#e8ad75','#a9be98','#e6cf8b','#93b8bc','#d9a0b4'][i%5],side:THREE.DoubleSide}));const h=hash(i+7);piece.userData={x:-10+(h%2000)/100,z:-5.6+((h>>>11)%1120)/100,phase:(h>>>4)%500/100};this.confetti.add(piece);}
  const sign=new THREE.Mesh(new THREE.PlaneGeometry(3.6,.65),this.text('ROOM FOR GOOD IDEAS.',768,128,33,'#839075','#e5e9d8'));sign.position.set(7,2.5,-6.54);s.add(sign);
  this.floorText('FOCUS & FLOW  /  4 PODS · 16 SEATS',4.6,-4.5,6.1,'#a78363');
  this.floorText('LOUNGE & PLAY',3,7.4,-1.2,'#7f8f6d');
  this.bake(s);
 }
 buildLounge(){
  const s=this.scene;
  this.sofa(7,-4.45);this.coffeeTable(7,-2.45);this.beanBag(9.15,-3,'#e3b68b');
  this.pingPongTable();
  this.roundTable(7,4.3);this.stool(5.95,4.3,'#d4b47e');this.stool(8.05,4.3,'#c6c7ab');
  this.bookcase(10.4,-2.6);
  // Coffee bar against the back wall.
  const coffee=this.group(9.75,0,-5.75);
  this.box(1.9,1.02,.72,'#d4bfa0',0,.7,0,coffee,.04);this.box(2,.08,.84,'#f5edda',0,1.24,0,coffee);
  this.box(.65,.6,.5,'#728d7e',-.35,1.58,-.05,coffee,.04);this.box(.45,.3,.03,'#354c40',-.35,1.6,.21,coffee,.01);
  this.cylinder(.035,.035,.14,'#c6bfac',-.35,1.38,.23,coffee);this.cup(-.35,1.28,.24,'#e4c58b',coffee);
  this.cup(.3,1.28,.12,'#a9be98',coffee);this.cup(.52,1.28,.02,'#f2eee0',coffee);this.cylinder(.11,.11,.26,'#c99f72',.62,1.41,-.2,coffee,16);
  this.steam=this.group(9.4,1.48,-5.51);
  for(let i=0;i<5;i++){const puff=new THREE.Mesh(new THREE.SphereGeometry(.085,8,6),new THREE.MeshBasicMaterial({color:'#fff6dc',transparent:true,opacity:0,depthWrite:false}));puff.userData.phase=i/5;this.steam.add(puff);}
  this.addHotspot(coffee,'coffee','来杯咖啡',[9.75,2.6,-5.75]);
  // The small-wins board doubles as the celebration button.
  const board=this.group(4.45,0,-5.75);
  this.box(1.7,1.1,.09,'#f6efd8',0,1.65,0,board,.06);this.box(.07,1.5,.07,'#bdac86',-.6,.95,0,board);this.box(.07,1.5,.07,'#bdac86',.6,.95,0,board);
  const note=new THREE.Mesh(new THREE.PlaneGeometry(1.45,.7),this.text('SMALL WINS',512,180,40,'#9b815c','#f6efd8'));note.position.set(0,1.65,.06);board.add(note);
  for(const [x,y,c] of [[-.55,2.05,'#e6cf8b'],[.5,1.3,'#a9be98'],[.58,2.02,'#e8ad75']])this.box(.18,.18,.012,c,x,y,.055,board);
  this.addHotspot(board,'celebrate','庆祝一下',[4.45,2.6,-5.75]);
 }
 buildCat(){
  const bed=this.group(9.9,.21,3.3);this.cylinder(.48,.5,.08,'#e7d2ad',0,.04,0,bed,28);const rim=new THREE.Mesh(new THREE.TorusGeometry(.46,.1,8,28),this.mat('#d9b17e'));rim.rotation.x=Math.PI/2;rim.position.y=.1;rim.castShadow=true;bed.add(rim);
  this.cat=this.group(9.9,.2,3.3);this.cat.userData.dynamic=true;this.catBody=this.group(0,0,0,this.cat);const c=this.catBody;
  this.sphere(.46,'#dcad78',0,.25,0,c,1.2,.65,.8);this.sphere(.27,'#e9bb86',.38,.43,.15,c,1,.9,.85);
  for(const x of [.23,.53]){const ear=new THREE.Mesh(new THREE.ConeGeometry(.115,.23,3),this.mat('#d7a16a'));ear.position.set(x,.68,.15);c.add(ear);this.box(.08,.018,.015,'#6e6249',x,.44,.37,c);}
  this.sphere(.035,'#bd846d',.38,.37,.39,c);
  this.catTail=this.group(-.4,.27,.2,c);this.catTail.userData.dynamic=true;const tail=new THREE.Mesh(new THREE.TorusGeometry(.29,.085,8,16,Math.PI*1.4),this.mat('#cf9e68'));tail.rotation.x=Math.PI/2;this.catTail.add(tail);this.bake(c);
  this.catState={index:0,waitUntil:6,yaw:0};
  this.addHotspot(this.cat,'cat','摸摸小猫',[9.9,1.45,3.3],this.cat);
 }
 buildVacuum(){
  const [x,z]=VACUUM_ROUTE[0];this.vacuum=this.group(x,.12,z);this.vacuum.userData.dynamic=true;
  this.cylinder(.3,.3,.09,'#f1eee4',0,.05,0,this.vacuum,28);this.cylinder(.22,.22,.02,'#8f9a92',0,.105,0,this.vacuum,28);this.box(.36,.05,.07,'#6f7b74',0,.05,.27,this.vacuum,.02);
  this.vacuumLed=new THREE.Mesh(new THREE.SphereGeometry(.03,10,8),new THREE.MeshBasicMaterial({color:'#7fd39b'}));this.vacuumLed.position.set(0,.12,.16);this.vacuum.add(this.vacuumLed);
  this.vacuum.traverse(o=>{if(o.isMesh)o.userData.hotspot='vacuum';});
  this.vacuumState={index:0,step:1,spinAt:-9};
 }
 addHotspot(group,id,label,position,follow=null){
  group.traverse(o=>{if(o.isMesh)o.userData.hotspot=id;});
  const button=document.createElement('button');button.className='agent-label hotspot-label';button.innerHTML=`<svg aria-hidden="true"><use href="#i-${{coffee:'coffee',cat:'cat',celebrate:'spark'}[id]}"/></svg><span>${label}</span>`;button.setAttribute('aria-label',label);button.onclick=e=>{e.stopPropagation();this.onActivity?.(id);};this.labels.appendChild(button);
  this.hotspots.push({group,id,label:button,position:new THREE.Vector3(...position),follow});
 }
 playActivity(kind){
  const t=this.clock.getElapsedTime();this.effects[kind]=t;
  if(kind==='celebrate'){this.confetti.visible=true;[...this.characters.values()].forEach((o,i)=>o.hopAt=t+.2+i*.09);}
  if(kind==='cat'){this.catState.waitUntil=Math.max(this.catState.waitUntil,t+3.5);this.burst(this.cat.position.clone().setY(.9),'heart');}
  if(kind==='vacuum')this.vacuumState.spinAt=t;
 }

 tree(x,z,scale){const g=this.group(x,-.2,z);g.userData.dynamic=true;g.scale.setScalar(scale);this.trees.push(g);this.cylinder(.12,.17,1.65,'#baa483',0,.8,0,g);this.sphere(.85,'#afc496',0,2,0,g,.9,1.1,.85);this.sphere(.64,'#b8cfa1',-.4,2.3,.1,g);this.sphere(.6,'#a7be91',.4,1.9,-.05,g);this.bake(g);}
 plant(x,z,scale){const g=this.group(x,.15,z);g.scale.setScalar(scale);this.cylinder(.32,.24,.53,'#e9d8b9',0,.27,0,g);this.cylinder(.29,.28,.03,'#8e846b',0,.54,0,g);this.cylinder(.045,.06,.85,'#9eae80',0,.9,0,g);for(let i=0;i<7;i++){const a=i*2.4;const leaf=this.sphere(.3,i%2?'#90ae7e':'#a1bc88',Math.cos(a)*.22,1.12+(i%3)*.16,Math.sin(a)*.22,g,.7,1.35,.5);leaf.rotation.z=Math.cos(a)*.6;}}
 bookcase(x,z){const g=this.group(x,0,z);g.rotation.y=Math.PI/2;this.box(1.6,2.45,.15,'#c8af88',0,1.4,-.25,g);this.box(.09,2.5,.6,'#d4ba91',-.8,1.4,0,g);this.box(.09,2.5,.6,'#d4ba91',.8,1.4,0,g);for(let i=0;i<4;i++){const y=.25+i*.8;this.box(1.7,.1,.65,'#d6bd94',0,y,0,g);if(i<3)for(let j=0;j<8;j++){const colors=['#93afa3','#d59d7c','#d7c18b','#9da2b2','#b1bd93'];this.box(.11,.4+(j%3)*.07,.3,colors[(i+j)%5],-.66+j*.18,y+.29,.04,g,.01);}}}
 // A real clock: the hands show the viewer's local time.
 wallClock(x,y,z){const rim=this.cylinder(.28,.28,.055,'#d6d8c8',x,y,z);rim.rotation.x=Math.PI/2;const face=this.cylinder(.25,.25,.061,'#fcf9ed',x,y,z+.01);face.rotation.x=Math.PI/2;
  const hand=(length,width,color,depth)=>{const pivot=this.group(x,y,z+depth);pivot.userData.dynamic=true;this.box(width,length,.008,color,0,length/2-.02,0,pivot);return pivot;};
  this.clockHands={hour:hand(.13,.022,'#6f7d66',.048),minute:hand(.19,.016,'#819077',.054),second:hand(.21,.006,'#d48a63',.06)};}
 desk(desk,i){const g=this.group(desk.x,0,desk.z);g.rotation.y=desk.dir>0?0:Math.PI;
  this.box(2.13,.13,1.03,'#f7f3e7',0,1.2,0,g,.03);this.box(.5,1.02,.76,'#c3ac88',-.68,.65,0,g,.02);this.box(.5,.03,.75,'#b3a07f',-.68,.65,0,g);this.box(.08,1.03,.08,'#c6c7b6',.84,.64,-.36,g);this.box(.08,1.03,.08,'#c6c7b6',.84,.64,.36,g);this.box(.19,.04,.33,'#8e9992',-.15,1.3,-.24,g,.01);this.box(.055,.25,.055,'#77867d',-.15,1.44,-.31,g);this.box(.82,.53,.07,'#5a6962',-.15,1.76,-.31,g,.02);
  const screen=this.screen(i);screen.mesh.position.set(-.15,1.76,-.266);g.add(screen.mesh);
  this.box(.58,.035,.22,'#e5e5da',-.12,1.29,.2,g,.02);for(let row=0;row<3;row++)for(let c=0;c<8;c++)this.box(.048,.004,.035,'#c4cbbd',-.35+c*.065,1.311,.135+row*.055,g);this.sphere(.07,'#e0e3d7',.34,1.3,.2,g,.7,.4,1);
  this.cup(.6,1.28,-.02,['#98b5a0','#d9b279','#8dacc8','#c6adca','#b7bc8e','#c6a086'][i%6],g);this.box(.26,.015,.3,'#e5ddbd',.68,1.28,.3,g);
  // Desk lamp: its bulb lights up at night while someone owns the desk.
  const lamp=this.group(.82,1.27,-.32,g);this.cylinder(.08,.09,.03,'#d8d2bf',0,.015,0,lamp,16);this.cylinder(.014,.014,.44,'#c9c2ab',0,.24,0,lamp,8);this.box(.27,.022,.022,'#c9c2ab',-.12,.46,0,lamp);
  const shade=new THREE.Mesh(new THREE.ConeGeometry(.11,.13,16,1,true),new THREE.MeshStandardMaterial({color:'#e8dcc0',roughness:.6,side:THREE.DoubleSide}));shade.position.set(-.25,.43,0);shade.castShadow=true;lamp.add(shade);
  const bulb=new THREE.Mesh(new THREE.SphereGeometry(.045,12,8),new THREE.MeshStandardMaterial({color:'#fff4dc',emissive:'#ffc77a',emissiveIntensity:0,roughness:.4}));bulb.position.set(-.25,.38,0);lamp.add(bulb);
  const chair=this.chair(.1,.84,g);
  g.traverse(o=>{if(o.isMesh)o.userData.deskId=desk.id;});
  const plate=new THREE.Mesh(new THREE.PlaneGeometry(1.5,.27),this.plateMaterial(desk.label,false));plate.position.set(0,1.15,.535);g.add(plate);plate.userData.deskId=desk.id;
  this.workstations.set(desk.id,{group:g,plate,screen,chair,bulb,owner:null,desk});
 }
 plateMaterial(text,owned){const m=this.text(text,384,72,owned?25:24,owned?'#68795a':'#ac9879','#f7f1df');m.side=THREE.FrontSide;return m;}
 screen(i){const canvas=document.createElement('canvas');canvas.width=256;canvas.height=160;const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;const mesh=new THREE.Mesh(new THREE.PlaneGeometry(.74,.43),new THREE.MeshBasicMaterial({map:texture}));const screen={mesh,canvas,ctx:canvas.getContext('2d'),texture,seed:i*37+5,mode:'',drawnAt:-9,every:.16+(i%8)*.011};this.drawScreen(screen,0);return screen;}
 // Screens tell you what is going on at a glance: code scrolling while working, ideas
 // orbiting while thinking, a bouncing logo while the owner is away, and dark when empty.
 drawScreen(screen,t){
  const c=screen.ctx,W=256,H=160,mode=screen.mode||'off';screen.drawnAt=t;
  if(mode==='off'){c.fillStyle='#1c2725';c.fillRect(0,0,W,H);c.fillStyle='rgba(255,255,255,.05)';c.beginPath();c.moveTo(60,0);c.lineTo(120,0);c.lineTo(50,H);c.lineTo(-10,H);c.fill();screen.texture.needsUpdate=true;return;}
  if(mode==='away'){c.fillStyle='#18221f';c.fillRect(0,0,W,H);c.font='bold 34px Arial, sans-serif';c.textAlign='center';c.textBaseline='middle';c.fillStyle=screen.color;c.fillText(screen.mark,24+bounce(t*.21+screen.seed*.13)*(W-48),22+bounce(t*.29+screen.seed*.07)*(H-44));screen.texture.needsUpdate=true;return;}
  c.fillStyle='#243f3a';c.fillRect(0,0,W,H);c.fillStyle='#35534a';c.fillRect(0,0,W,14);c.fillStyle='#7d9a83';for(const x of [8,17,26]){c.beginPath();c.arc(x,7,2,0,Math.PI*2);c.fill();}c.fillStyle='#2b4941';c.fillRect(0,14,37,H-14);
  if(mode==='thinking'){
   const cx=148,cy=88,pulse=Math.sin(t*3)*2;c.strokeStyle='rgba(195,179,129,.55)';c.lineWidth=2;
   const nodes=[0,1,2,3].map(k=>{const a=t*.45+k*Math.PI/2+screen.seed;return [cx+Math.cos(a)*48,cy+Math.sin(a)*30];});
   for(const [x,y] of nodes){c.beginPath();c.moveTo(cx,cy);c.lineTo(x,y);c.stroke();}
   nodes.forEach(([x,y],k)=>{c.fillStyle=['#87ae9b','#c3b381','#7d9a93','#d39a7c'][k];c.beginPath();c.arc(x,y,6,0,Math.PI*2);c.fill();});
   c.fillStyle=screen.color;c.beginPath();c.arc(cx,cy,11+pulse,0,Math.PI*2);c.fill();
  }else{
   const scroll=t*2.4+screen.seed,first=Math.floor(scroll),shift=(scroll-first)*12;
   c.save();c.beginPath();c.rect(37,14,W-37,H-14);c.clip();
   for(let r=0;r<13;r++){const h=hash(first+r+screen.seed*31),y=24+r*12-shift,indent=(h%4)*8,w=22+(h>>>3)%100;c.fillStyle=['#c3b381','#87ae9b','#7d9a93','#d39a7c'][(h>>>2)%4];c.fillRect(49+indent,y,w,3);if(h%3===0)c.fillRect(55+indent+w,y,16+(h>>>5)%40,3);c.fillStyle='#3f5d54';c.fillRect(10,y,14,3);}
   c.restore();if(Math.floor(t*2.2)%2){c.fillStyle='#e9e2c5';c.fillRect(50,H-14,7,10);}
  }
  screen.texture.needsUpdate=true;
 }
 chair(x,z,parent=this.scene){const g=this.group(x,0,z,parent);g.userData.dynamic=true;this.cylinder(.06,.07,.45,'#7c8980',0,.49,0,g);this.cylinder(.31,.31,.05,'#839088',0,.26,0,g);this.box(.62,.13,.61,'#6d7e73',0,.78,0,g,.05);const back=this.box(.6,.58,.12,'#75867b',0,1.13,.27,g,.06);back.rotation.x=-.08;this.box(.05,.33,.05,'#7e8980',-.32,.91,.06,g);this.box(.05,.33,.05,'#7e8980',.32,.91,.06,g);this.box(.07,.055,.3,'#63766b',-.32,1.08,.04,g,.02);this.box(.07,.055,.3,'#63766b',.32,1.08,.04,g,.02);for(let i=0;i<5;i++){const a=i*Math.PI*2/5;this.sphere(.07,'#78857c',Math.cos(a)*.3,.23,Math.sin(a)*.3,g,1,.6,1);}this.bake(g);return g;}
 cup(x,y,z,color,parent=this.scene){this.cylinder(.075,.062,.15,color,x,y+.075,z,parent);this.cylinder(.059,.059,.006,'#947d5d',x,y+.153,z,parent);const handle=new THREE.Mesh(new THREE.TorusGeometry(.042,.013,5,12),this.mat(color));handle.position.set(x+.075,y+.08,z);parent.add(handle);}
 sofa(x,z){const g=this.group(x,0,z);this.box(2.65,.4,.96,'#99b2a0',0,.52,0,g,.12);this.box(2.65,.85,.23,'#a2b9a6',0,.93,-.44,g,.1);this.box(.25,.6,1.1,'#a6bda8',-1.34,.76,0,g,.08);this.box(.25,.6,1.1,'#a6bda8',1.34,.76,0,g,.08);for(let i=0;i<3;i++)this.box(.79,.17,.83,'#b2c4af',-.84+i*.84,.8,.05,g,.07);for(const px of [-1.1,1.1])for(const pz of [-.3,.3])this.cylinder(.05,.065,.25,'#b4a283',px,.27,pz,g);const pillow=this.box(.46,.46,.19,'#e9dbb6',-.9,1.08,-.17,g,.09);pillow.rotation.z=.2;const pillow2=this.box(.46,.46,.19,'#d8a78a',.95,1.08,-.16,g,.09);pillow2.rotation.z=-.16;}
 coffeeTable(x,z){this.cylinder(.6,.6,.1,'#ead5b0',x,.62,z);this.cylinder(.11,.18,.38,'#c7b28b',x,.38,z);this.box(.3,.035,.4,'#a1b8a4',x+.12,.69,z+.06);this.cup(x-.22,.67,z-.1,'#f2eee0');}
 beanBag(x,z,color){this.sphere(.5,color,x,.45,z,this.scene,1,.62,1);this.sphere(.32,color,x-.05,.68,z-.18,this.scene,1,.6,.8);}
 roundTable(x,z){this.cylinder(.82,.82,.12,'#dfc995',x,.98,z);this.cylinder(.13,.2,.75,'#c6b07e',x,.55,z);this.cylinder(.4,.4,.07,'#c9b280',x,.2,z);this.cup(x+.26,1.05,z-.2,'#faf5e5');this.box(.37,.035,.27,'#d3debd',x-.2,1.06,z+.05);}
 stool(x,z,color){this.cylinder(.36,.36,.16,color,x,.64,z);for(let i=0;i<3;i++){const a=i*Math.PI*2/3;this.cylinder(.035,.05,.45,'#c5b289',x+Math.cos(a)*.21,.36,z+Math.sin(a)*.21);}}
 pingPongTable(){
  const {x,z,top}=PING_PONG,g=this.group(x,0,z);
  this.box(2.4,.06,1.35,'#6f9f8e',0,top-.03,0,g);this.box(2.4,.008,.02,'#f5f1e4',0,top+.002,0,g);for(const ex of [-1.19,1.19])this.box(.02,.008,1.35,'#f5f1e4',ex,top+.002,0,g);for(const ez of [-.665,.665])this.box(2.4,.008,.02,'#f5f1e4',0,top+.002,ez,g);
  this.box(.025,.15,1.48,'#f5f1e4',0,top+.075,0,g);for(const ez of [-.74,.74])this.cylinder(.018,.018,.18,'#8a8f86',0,top+.07,ez,g,8);
  for(const ex of [-1,1])for(const ez of [-.55,.55])this.box(.06,top-.2,.06,"#7b857d",ex,(top-.2)/2+.13,ez,g);
  this.ball=new THREE.Mesh(new THREE.SphereGeometry(.045,12,10),this.mat('#f4a35c',.5));this.ball.castShadow=true;this.ball.userData.dynamic=true;this.ball.position.set(x-.45,top+.045,z+.35);this.scene.add(this.ball);
  this.paddles=[0,1].map(()=>{const p=this.group(0,0,0);p.userData.dynamic=true;const blade=this.cylinder(.1,.1,.02,'#d9645a',0,0,0,p,18);blade.rotation.z=Math.PI/2;this.box(.03,.12,.035,'#c9a77c',0,-.14,0,p);return p;});
  g.traverse(o=>{if(o.isMesh)o.userData.hotspot="pingpong";});this.pingPong=g;
 }

 createCharacter(agent,index){const group=new THREE.Group();const body=new THREE.Group();group.add(body);this.scene.add(group);const color=MODELS[agent.model].color;
  // Soft, toy-like robots, each with an individual color and a tiny antenna.
  this.sphere(.29,color,0,.45,0,body,.95,1.2,.8);this.sphere(.31,'#f8f5e9',0,.96,0,body,1,1.02,.93);this.sphere(.095,color,-.3,.95,0,body,.65,.85,.9);this.sphere(.095,color,.3,.95,0,body,.65,.85,.9);
  this.sphere(.024,'#46584d',-.105,.99,.276,body,1,1.3,.6);this.sphere(.024,'#46584d',.105,.99,.276,body,1,1.3,.6);this.sphere(.029,'#e7b6a2',-.18,.91,.23,body,1,.45,.35);this.sphere(.029,'#e7b6a2',.18,.91,.23,body,1,.45,.35);this.box(.055,.012,.01,'#b8b9a5',0,.9,.291,body,.005);
  this.sphere(.29,color,0,1.13,-.012,body,1,.43,.95);this.cylinder(.023,.023,.14,color,0,1.32,-.03,body);this.sphere(.05,'#e8d6a0',0,1.41,-.03,body);
  const leftArm=this.sphere(.09,color,-.29,.45,.08,body,.8,1.8,1);leftArm.rotation.z=-.28;const rightArm=this.sphere(.09,color,.29,.45,.08,body,.8,1.8,1);rightArm.rotation.z=.25;leftArm.userData.dynamic=rightArm.userData.dynamic=true;this.sphere(.075,'#f7f2e7',-.32,.29,.1,body);this.sphere(.075,'#f7f2e7',.32,.29,.1,body);
  this.sphere(.1,color,-.13,.18,.07,body,.8,1.5,.85);this.sphere(.1,color,.13,.18,.07,body,.8,1.5,.85);this.sphere(.09,'#f4efe1',-.13,.06,.13,body,1,.6,1.4);this.sphere(.09,'#f4efe1',.13,.06,.13,body,1,.6,1.4);
  this.sphere(.055,'#e6d9b6',0,.52,.23,body,1,1,.35);
  const ring=new THREE.Mesh(new THREE.RingGeometry(.47,.51,40),new THREE.MeshBasicMaterial({color:'#dbad6e',transparent:true,opacity:.8,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=.01;ring.visible=false;group.add(ring);
  const label=document.createElement('button');label.className='agent-label';label.dataset.agentId=agent.id;label.setAttribute('aria-label',`查看 ${agent.name}`);label.addEventListener('click',e=>{e.stopPropagation();this.hop(agent.id);this.select(agent.id);this.onSelect(agent.id);});this.labels.appendChild(label);
  group.traverse(o=>{if(o.isMesh)o.userData.agentId=agent.id;});this.bake(body);
  const obj={id:agent.id,group,body,ring,label,phase:index*1.7,leftArm,rightArm,pos:new THREE.Vector3(),yaw:0,targetYaw:0,path:[],spot:null,walkPhase:0,hopAt:-9,completed:agent.completed||0,status:agent.status};this.characters.set(agent.id,obj);return obj;
 }
 updateAgents(agents){
  this.agents=assignSeats(agents);
  const isOffline=a=>('lastSeen' in a)&&(!a.lastSeen||Date.now()-a.lastSeen>300000);
  const signature=JSON.stringify(this.agents.map(a=>[a.id,a.name,a.model,a.status,a.seatId,a.completed||0,isOffline(a),!a.lastSeen]));
  if(signature===this.agentSignature)return;this.agentSignature=signature;
  const ids=new Set(agents.map(a=>a.id));
  for(const [id,obj]of this.characters){if(!ids.has(id)){obj.label.remove();this.scene.remove(obj.group);obj.group.traverse(o=>{if(o.isMesh)o.geometry.dispose();});this.characters.delete(id);}}
  // Desks follow their owners: name plate, chair pulled out, screen and lamp.
  for(const desk of DESKS){
   const station=this.workstations.get(desk.id),owner=this.agents.find(a=>a.seatId===desk.id),offline=owner&&isOffline(owner);
   const signature=owner?owner.id+owner.name:'empty';
   if(station.owner!==signature){station.plate.material.map?.dispose();station.plate.material.dispose();station.plate.material=this.plateMaterial(`${desk.id.slice(-2)}  ${owner?.name||'空位'}`,!!owner);station.owner=signature;}
   station.chair.position.z=owner?.84:.6;station.chair.rotation.y=owner?0:.2;station.present=!!owner&&!offline;
   const mode=!owner||offline?'off':owner.status==='resting'?'away':owner.status==='thinking'?'thinking':'working';
   if(owner){station.screen.color=MODELS[owner.model].color;station.screen.mark=MODELS[owner.model].mark;}
   if(station.screen.mode!==mode){station.screen.mode=mode;this.drawScreen(station.screen,this.clock.getElapsedTime());}
  }
  // Resting agents keep their lounge spot; newcomers take the first free one.
  const taken=new Set();
  for(const a of this.agents){const obj=this.characters.get(a.id);if(a.status==='resting'&&obj?.spot&&obj.spot.kind!=='desk')taken.add(obj.spot.key);}
  const t=this.clock.getElapsedTime();
  this.agents.forEach((a,i)=>{
   const fresh=!this.characters.has(a.id),obj=this.characters.get(a.id)||this.createCharacter(a,i),desk=DESKS.find(d=>d.id===a.seatId);
   let spot=null;
   if(a.status==='resting'){const keep=!fresh&&obj.spot&&obj.spot.kind!=='desk'?REST_SPOTS.find(s=>s.key===obj.spot.key):null;const free=keep||REST_SPOTS.find(s=>!taken.has(s.key));if(free){taken.add(free.key);spot=restSpot(free);}}
   if(!spot&&desk)spot=deskSpot(desk);
   if(spot)this.moveTo(obj,spot,fresh);
   if(!fresh&&(a.completed||0)>obj.completed){obj.hopAt=t;this.burst(obj.pos.clone().setY(obj.pos.y+1.1),'star');}
   obj.completed=a.completed||0;obj.status=a.status;
   const offline=isOffline(a);
   const dot=document.createElement('span');dot.className='label-color';dot.style.background=MODELS[a.model].color;
   const name=document.createElement('span');name.className='label-name';name.textContent=a.name;
   const suffix=document.createElement('span');suffix.className=a.status==='working'&&!offline?'label-busy':'label-sleep';
   if(a.status==='working'&&!offline){for(let j=0;j<3;j++)suffix.appendChild(document.createElement('i'));}
   else suffix.textContent=offline?(!a.lastSeen?'待连':'离线'):a.status==='thinking'?'···':'zᶻ';
   obj.label.replaceChildren(dot,name,suffix);obj.label.labelWidth=0;obj.label.setAttribute('aria-label',`与 ${a.name} 聊天`);
  });
  this.refreshLights();
 }
 moveTo(obj,spot,instant){
  if(obj.spot?.key===spot.key)return;
  if(instant||!obj.spot||this.reducedMotion){obj.path=[];obj.pos.set(spot.x,spot.y,spot.z);obj.yaw=obj.targetYaw=spot.yaw;}
  else obj.path=obj.path.concat(route(obj.spot,spot));
  obj.spot=spot;
 }
 hop(id){const obj=this.characters.get(id);if(obj)obj.hopAt=this.clock.getElapsedTime();}
 refreshLights(){
  for(const station of this.workstations.values())station.bulb.material.emissiveIntensity=this.night&&station.present?2.6:0;
  for(const pod of this.podLights){const lit=[...this.workstations.values()].some(s=>s.present&&Math.abs(s.desk.x-pod.x)<2.5&&Math.abs(s.desk.z-pod.z)<2);pod.light.intensity=this.night&&lit?26:0;pod.light.visible=this.night;}
  this.loungeLight.intensity=this.night?18:0;this.loungeLight.visible=this.night;
 }

 resize(){
  const w=this.container.clientWidth,h=this.container.clientHeight;if(!w||!h)return;
  for(const label of this.labels.children)label.labelWidth=0;
  this.renderer.setSize(w,h,false);Object.assign(this.camera,cameraFrame(w,h,document.body.classList.contains('embedded-office')));this.camera.updateProjectionMatrix();
 }
 settleCamera(){const damping=this.controls.enableDamping;this.controls.enableDamping=false;this.controls.update();this.controls.enableDamping=damping;this.cameraAnimation=null;}
 setView(view){
  this.settleCamera();const p=CAMERA_PRESETS[view]||CAMERA_PRESETS.overview;
  this.cameraAnimation={from:this.camera.position.clone(),to:new THREE.Vector3(...p.pos),targetFrom:this.controls.target.clone(),targetTo:new THREE.Vector3(...p.target),zoomFrom:this.camera.zoom,zoomTo:p.zoom,start:performance.now()};
  this.onViewChange?.(view);
 }
 setZoom(value){this.settleCamera();this.camera.zoom=boundedZoom(value);this.camera.updateProjectionMatrix();this.controls.update();this.onZoom?.(Math.round(this.camera.zoom*100));this.onViewChange?.(null);}
 zoom(delta){this.setZoom(this.camera.zoom+delta);}
 orbit(horizontal,vertical){this.settleCamera();this.camera.position.copy(orbitPosition(this.camera.position,this.controls.target,horizontal,vertical));this.controls.update();this.onViewChange?.(null);}
 setDragMode(mode){
  this.dragMode=mode;const pan=mode==='pan';this.container.dataset.dragMode=mode;
  this.controls.mouseButtons.LEFT=pan?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE;
  this.controls.touches.ONE=pan?THREE.TOUCH.PAN:THREE.TOUCH.ROTATE;
 }
 select(id){for(const [key,o]of this.characters){o.ring.visible=key===id;o.label.classList.toggle('selected',key===id);}}
 setNight(night){this.night=night;this.ground.material.opacity=night?.34:.13;this.hemi.intensity=night?1.4:2.2;this.sun.intensity=night?1.4:3.1;this.sun.color.set(night?'#e8d6ba':'#fff5dd');this.fill.intensity=night?2:.9;this.fill.color.set(night?'#94a4e4':'#e2eeff');this.refreshLights();}
 setPaused(paused){this.isPaused=paused;this.labels.classList.toggle('paused',paused);this.labels.querySelectorAll('.label-busy i').forEach(e=>e.style.animationPlayState=paused?'paused':'running');}
 pick(event){
  const bounds=this.container.getBoundingClientRect();const mouse=new THREE.Vector2((event.clientX-bounds.left)/bounds.width*2-1,-(event.clientY-bounds.top)/bounds.height*2+1);const ray=new THREE.Raycaster();ray.setFromCamera(mouse,this.camera);
  const targets=[...this.characters.values()].map(o=>o.group).concat([...this.workstations.values()].map(o=>o.group),this.hotspots.map(o=>o.group),[this.vacuum,this.pingPong]);
  const hit=ray.intersectObjects(targets,true).find(h=>h.object.userData.agentId||h.object.userData.deskId||h.object.userData.hotspot);
  if(!hit)return;const data=hit.object.userData;
  if(data.agentId){this.hop(data.agentId);this.select(data.agentId);this.onSelect(data.agentId);}else if(data.deskId)this.onDesk?.(data.deskId);else this.onActivity?.(data.hotspot);
 }
 // Project every label, then let the ones further back step upward until nothing overlaps.
 layoutLabels(){
  const w=this.container.clientWidth,h=this.container.clientHeight,items=[];
  const setVisible=(label,visible)=>{if(label.labelVisible!==visible){label.labelVisible=visible;label.style.visibility=visible?'visible':'hidden';}};
  const add=(label,x3,y3,z3)=>{const p=this.labelAnchor.set(x3,y3,z3).project(this.camera),x=(p.x*.5+.5)*w,y=(-p.y*.5+.5)*h,visible=!(p.z>1||p.z< -1||x<10||x>w-10||y<76||y>h-12);if(!visible){setVisible(label,false);return;}if(!label.labelWidth){label.labelWidth=label.offsetWidth||60;label.labelHeight=label.offsetHeight||26;}items.push({label,x,y,z:p.z,width:label.labelWidth,height:label.labelHeight});};
  for(const obj of this.characters.values())add(obj.label,obj.group.position.x,obj.group.position.y+1.72,obj.group.position.z);
  for(const spot of this.hotspots){if(spot.follow)spot.position.set(spot.follow.position.x,1.45,spot.follow.position.z);add(spot.label,spot.position.x,spot.position.y,spot.position.z);}
  items.sort((a,b)=>b.y-a.y);
  const placed=[];
  for(const item of items){
   item.x=THREE.MathUtils.clamp(item.x,item.width/2+8,w-item.width/2-8);
   for(let pass=0;pass<5;pass++){const step=item.height+2,hit=placed.find(o=>Math.abs(o.x-item.x)<(o.width+item.width)/2+4&&Math.abs(o.y-item.y)<step);if(!hit)break;item.y=hit.y-step;}
   if(item.y-item.height<62){setVisible(item.label,false);continue;}
   setVisible(item.label,true);placed.push(item);
   const label=item.label,transform=`translate3d(${item.x.toFixed(1)}px,${item.y.toFixed(1)}px,0) translate(-50%,-100%)`,depth=Math.round(100-item.z*50);
   if(label.labelTransform!==transform){label.labelTransform=transform;label.style.transform=transform;}
   if(label.labelDepth!==depth){label.labelDepth=depth;label.style.zIndex=String(depth);}
  }
 }

 walk(obj,dt){
  let budget=WALK_SPEED*dt;
  while(budget>0&&obj.path.length){
   const d=this.step.copy(obj.path[0]).sub(obj.pos),dist=d.length();
   if(Math.hypot(d.x,d.z)>.02)obj.targetYaw=Math.atan2(d.x,d.z);
   if(dist<=budget){obj.pos.copy(obj.path.shift());budget-=dist;}else{obj.pos.addScaledVector(d,budget/dist);budget=0;}
  }
  if(!obj.path.length)obj.targetYaw=obj.spot.yaw;
 }
 animateCharacter(obj,t,dt,idle){
  if(obj.path.length)this.walk(obj,dt);
  obj.yaw+=turn(obj.yaw,obj.targetYaw)*Math.min(1,dt*9);
  obj.group.position.copy(obj.pos);obj.group.rotation.y=obj.yaw;
  const walking=obj.path.length>0,kind=obj.spot?.kind;let y=0,rz=0,ry=0,armL=0,armR=0,breathe=1;
  if(walking){obj.walkPhase+=dt*11;y=Math.abs(Math.sin(obj.walkPhase))*.07;armL=Math.sin(obj.walkPhase)*.7;armR=-armL;rz=Math.sin(obj.walkPhase)*.04;}
  else if(idle){
   y=Math.sin(t*1.8+obj.phase)*.018;rz=Math.sin(t*.8+obj.phase)*.025;
   if(kind==='desk'&&obj.status==='working')armR=Math.sin(t*5+obj.phase)*.15;
   if(obj.status==='thinking')ry=Math.sin(t*.7+obj.phase)*.3;
   if(kind==='sofa'){y=0;rz=.07*Math.sign(obj.spot.x-7);breathe=1+Math.sin(t*1.3+obj.phase)*.02;}
   if(kind==='stool')ry=Math.sin(t*1.1+obj.phase)*.18;
  }
  const hop=t-obj.hopAt;let wave=0;if(hop>=0&&hop<.55&&!this.reducedMotion){const k=Math.sin(Math.PI*hop/.55);y+=k*.32;wave=k;}
  obj.body.position.y=y;obj.body.rotation.z=rz;obj.body.rotation.y=ry;obj.body.scale.y=breathe;obj.leftArm.rotation.x=armL;obj.rightArm.rotation.x=armR;obj.rightArm.rotation.z=.25+wave*2.1;
 }
 // Two resting agents at the table play a rally; otherwise the ball and paddles wait on it.
 animatePingPong(dt,idle){
  const {x,z,top,paddleX}=PING_PONG,players=this.players;players[0]=players[1]=undefined;
  for(const o of this.characters.values()){if(o.path.length)continue;if(o.spot?.key===REST_SPOTS[0].key)players[0]=o;else if(o.spot?.key===REST_SPOTS[1].key)players[1]=o;}
  if(!players[0]||!players[1]||this.reducedMotion){
   this.ball.position.set(x-.45,top+.045,z+.35);
   this.paddles.forEach((p,i)=>{const hand=players[i];if(hand){p.position.set(paddleX[i],.95,z);p.rotation.set(0,0,0);}else{p.position.set(x+(i?.6:-.6),top+.015,z+(i?-.35:.35));p.rotation.set(0,i?-.5:.5,Math.PI/2);}});
   return;
  }
  if(idle)this.rallyTime+=dt;
  const T=1.05,n=Math.floor(this.rallyTime/T),u=this.rallyTime/T-n,fromSide=n%2,toSide=1-fromSide;
  const lane=k=>z+Math.sin(k*2.3)*.32,zFrom=lane(n),zTo=lane(n+1);
  const bx=paddleX[fromSide]+(paddleX[toSide]-paddleX[fromSide])*u,land=.72;
  const by=u<land?1+(top+.045-1)*(u/land)+.34*Math.sin(Math.PI*u/land):top+.045+(1-top-.045)*((u-land)/(1-land))+.2*Math.sin(Math.PI*(u-land)/(1-land));
  this.ball.position.set(bx,by,zFrom+(zTo-zFrom)*u);
  players.forEach((obj,i)=>{
   const receiving=i===toSide,swing=receiving?smooth(.78,1,u):1-smooth(0,.22,u),pz=receiving?lane(n-1)+(zTo-lane(n-1))*smooth(0,.7,u):zFrom;
   this.paddles[i].position.set(paddleX[i],.95,pz);this.paddles[i].rotation.set(0,(i?1:-1)*swing*.7,0);
   obj.group.position.z=pz;obj.rightArm.rotation.x=-swing*.9;
  });
 }
 animateCat(t,dt){
  const cat=this.cat,state=this.catState;
  if(this.reducedMotion)return;
  const petAge=t-(this.effects.cat??-100),resting=t<state.waitUntil,sleeping=resting&&state.index===0;
  if(!resting){
   const [tx,tz]=CAT_ROUTE[(state.index+1)%CAT_ROUTE.length],dx=tx-cat.position.x,dz=tz-cat.position.z,dist=Math.hypot(dx,dz),stride=.8*dt;
   if(dist>.001)state.yaw=Math.atan2(-dz,dx);
   if(dist<=stride){cat.position.x=tx;cat.position.z=tz;state.index=(state.index+1)%CAT_ROUTE.length;const linger=CAT_ROUTE[state.index][2];if(linger)state.waitUntil=t+linger*(.6+Math.random()*.8);}
   else{cat.position.x+=dx/dist*stride;cat.position.z+=dz/dist*stride;}
  }
  cat.rotation.y+=turn(cat.rotation.y,state.yaw)*Math.min(1,dt*6);
  this.catBody.position.y=!resting?Math.abs(Math.sin(t*9))*.035:0;
  this.catBody.scale.y=petAge<3?1+Math.sin(petAge*Math.PI)*.12:sleeping?.86+Math.sin(t*1.6)*.025:1;
  this.catTail.rotation.y=Math.sin(t*(resting?1.6:4))*(sleeping?.08:.35);
 }
 animateVacuum(t,dt){
  if(this.reducedMotion)return;
  const v=this.vacuum,state=this.vacuumState,[tx,tz]=VACUUM_ROUTE[state.index+state.step]??VACUUM_ROUTE[state.index],dx=tx-v.position.x,dz=tz-v.position.z,dist=Math.hypot(dx,dz),stride=.9*dt;
  if(dist<=stride){v.position.x=tx;v.position.z=tz;state.index+=state.step;if(state.index<=0||state.index>=VACUUM_ROUTE.length-1)state.step*=-1;}
  else{v.position.x+=dx/dist*stride;v.position.z+=dz/dist*stride;}
  const spin=t-state.spinAt,heading=Math.atan2(dx,dz);
  v.rotation.y=spin<1.2?heading+smooth(0,1.2,spin)*Math.PI*4:v.rotation.y+turn(v.rotation.y,heading)*Math.min(1,dt*5);
  this.vacuumLed.material.color.set(Math.floor(t*1.5)%2?'#7fd39b':'#4f8d67');
 }
 // Stars when someone finishes a task, hearts when the cat is petted.
 burst(origin,kind){
  const glyph=kind==='heart'?'♥':'★',colors=kind==='heart'?['#e58a8f','#f0a3a0']:['#e6c46a','#f0a868','#a9c99a','#93b8bc'];
  const pieces=Array.from({length:kind==='heart'?6:10},(_,i)=>{const color=colors[i%colors.length],key=glyph+color;if(!this.spriteMaterials.has(key)){const c=document.createElement('canvas');c.width=c.height=64;const g=c.getContext('2d');g.fillStyle=color;g.font='bold 52px Arial, sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillText(glyph,32,35);const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;this.spriteMaterials.set(key,new THREE.SpriteMaterial({map:tex,depthWrite:false}));}
   const sprite=new THREE.Sprite(this.spriteMaterials.get(key));sprite.position.copy(origin);this.scene.add(sprite);const a=i/(kind==='heart'?6:10)*Math.PI*2+Math.random()*.4;
   return {sprite,velocity:kind==='heart'?vec(Math.cos(a)*.25,.8+Math.random()*.4,Math.sin(a)*.25):vec(Math.cos(a)*1.3,1.5+Math.random()*.8,Math.sin(a)*1.3)};});
  this.bursts.push({pieces,born:this.clock.getElapsedTime(),origin:origin.clone(),gravity:kind==='heart'?0:2.2,life:kind==='heart'?1.8:1.3});
 }
 animateBursts(t){
  this.bursts=this.bursts.filter(b=>{const age=t-b.born;if(age>b.life){b.pieces.forEach(p=>this.scene.remove(p.sprite));return false;}
   const size=.3*Math.sin(Math.PI*Math.min(1,age/b.life))+.05;b.pieces.forEach(p=>{p.sprite.position.copy(b.origin).addScaledVector(p.velocity,age);p.sprite.position.y-=b.gravity*age*age/2;p.sprite.scale.setScalar(size);});return true;});
 }

 animate(){if(document.hidden||this.container.clientWidth===0)return;
  // The office is meant to stay open all day. Idle motion is gentle, so half the display's
  // frames are plenty; every frame is drawn again while the camera is dragged or flying.
  const stamp=performance.now(),busy=this.dragging||this.cameraAnimation||stamp-this.lastCameraMove<400;
  if(!busy&&stamp-this.lastFrame<30)return;this.lastFrame=stamp;
  const t=this.clock.getElapsedTime(),dt=Math.min(.5,t-this.lastTime);this.lastTime=t;
  if(this.cameraAnimation){const a=this.cameraAnimation;const p=Math.min(1,(performance.now()-a.start)/(this.reducedMotion?1:700));const ease=1-Math.pow(1-p,3);this.camera.position.lerpVectors(a.from,a.to,ease);this.controls.target.lerpVectors(a.targetFrom,a.targetTo,ease);this.camera.zoom=THREE.MathUtils.lerp(a.zoomFrom,a.zoomTo,ease);this.camera.updateProjectionMatrix();this.onZoom?.(Math.round(this.camera.zoom*100));if(p===1)this.cameraAnimation=null;}
  const idle=!this.isPaused&&!this.reducedMotion;
  for(const obj of this.characters.values())this.animateCharacter(obj,t,dt,idle);
  this.animatePingPong(dt,idle);this.animateCat(t,dt);this.animateVacuum(t,dt);this.animateBursts(t);
  if(idle)for(const station of this.workstations.values())if(station.screen.mode!=='off'&&t-station.screen.drawnAt>station.screen.every)this.drawScreen(station.screen,t);
  if(!this.reducedMotion)this.trees.forEach((tree,i)=>tree.rotation.z=Math.sin(t*.6+i*1.3)*.02);
  const now=new Date(),minutes=now.getMinutes()+now.getSeconds()/60;this.clockHands.hour.rotation.z=-((now.getHours()%12)+minutes/60)/12*Math.PI*2;this.clockHands.minute.rotation.z=-minutes/60*Math.PI*2;this.clockHands.second.rotation.z=-(now.getSeconds()+now.getMilliseconds()/1000)/60*Math.PI*2;
  this.controls.update();this.layoutLabels();
  const coffeeAge=t-(this.effects.coffee??-100),partyAge=t-(this.effects.celebrate??-100);
  this.steam.children.forEach(p=>{const q=this.reducedMotion?p.userData.phase:(t*.5+p.userData.phase)%1;p.position.set(Math.sin(q*5)*.12,q*.85,0);p.material.opacity=coffeeAge<6?(1-q)*.6:0;});
  if(partyAge<4.5){this.confetti.children.forEach(piece=>{const d=piece.userData;piece.position.set(d.x,Math.max(.3,6-(((this.reducedMotion?0:partyAge)+d.phase)*1.9)%6),d.z);if(!this.reducedMotion)piece.rotation.set(t*2+d.phase,t*1.4,d.phase);});}else this.confetti.visible=false;
  this.renderer.render(this.scene,this.camera);
 }
}
