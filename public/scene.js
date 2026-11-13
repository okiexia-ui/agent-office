import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {MODELS} from './data.js';
import {DESKS,assignSeats} from './layout.js';

export class OfficeScene {
 constructor(container,labels,onSelect,onZoom,onDesk,onActivity){
  this.onDesk=onDesk;this.onActivity=onActivity;this.workstations=new Map();this.hotspots=[];this.effects={};this.container=container;this.labels=labels;this.onSelect=onSelect;this.onZoom=onZoom;this.characters=new Map();this.clock=new THREE.Clock();this.reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;this.isPaused=false;this.night=false;this.labelAnchor=new THREE.Vector3();
  this.scene=new THREE.Scene();
  this.camera=new THREE.OrthographicCamera(-10,10,8,-8,.1,150);this.camera.position.set(14,14,17);
  this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});this.renderer.setClearColor(0x000000,0);this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.7));this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.28;container.appendChild(this.renderer.domElement);
  this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.target.set(0,.4,0);this.controls.enableDamping=true;this.controls.dampingFactor=.075;this.controls.enablePan=true;this.controls.minPolarAngle=.15;this.controls.maxPolarAngle=Math.PI/2.3;this.controls.minZoom=.55;this.controls.maxZoom=2.5;this.controls.maxDistance=45;this.controls.touches={ONE:THREE.TOUCH.ROTATE,TWO:THREE.TOUCH.DOLLY_PAN};this.controls.update();
  this.controls.addEventListener('change',()=>this.onZoom?.(Math.round(this.camera.zoom*100)));
  this.hemi=new THREE.HemisphereLight(0xfff9e6,0xb4c49d,3.1);this.scene.add(this.hemi);
  this.sun=new THREE.DirectionalLight(0xfff5dd,4.4);this.sun.position.set(-5,20,12);this.sun.castShadow=true;this.sun.shadow.mapSize.set(2048,2048);Object.assign(this.sun.shadow.camera,{left:-19,right:19,top:19,bottom:-19,near:1,far:60});this.sun.shadow.normalBias=.045;this.sun.shadow.bias=-.0003;this.sun.shadow.radius=4;this.scene.add(this.sun);
  this.fill=new THREE.DirectionalLight(0xe2eeff,1.2);this.fill.position.set(8,7,-7);this.scene.add(this.fill);
  this.materialCache=new Map();this.meshes=[];
  this.buildOffice();this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(container);this.resize();
  this.pointerStart=null;container.addEventListener('pointerdown',e=>{this.pointerStart={x:e.clientX,y:e.clientY};this.cameraAnimation=null;});container.addEventListener('pointerup',e=>{if(this.pointerStart&&Math.hypot(e.clientX-this.pointerStart.x,e.clientY-this.pointerStart.y)<5)this.pick(e);});
  this.animate=this.animate.bind(this);this.renderer.setAnimationLoop(this.animate);
 }
 mat(color,roughness=.75){const key=color+':'+roughness;if(!this.materialCache.has(key))this.materialCache.set(key,new THREE.MeshStandardMaterial({color,roughness}));return this.materialCache.get(key);}
 box(w,h,d,color,x,y,z,parent=this.scene,round=0){let geo;if(round){const shape=new THREE.Shape();const r=Math.min(round,w/2,h/2);const a=-w/2,b=-h/2;shape.moveTo(a+r,b);shape.lineTo(a+w-r,b);shape.quadraticCurveTo(a+w,b,a+w,b+r);shape.lineTo(a+w,b+h-r);shape.quadraticCurveTo(a+w,b+h,a+w-r,b+h);shape.lineTo(a+r,b+h);shape.quadraticCurveTo(a,b+h,a,b+h-r);shape.lineTo(a,b+r);shape.quadraticCurveTo(a,b,a+r,b);geo=new THREE.ExtrudeGeometry(shape,{depth:d,bevelEnabled:true,bevelThickness:r*.4,bevelSize:r*.4,bevelSegments:2,steps:1,curveSegments:3});geo.translate(0,0,-d/2);}else geo=new THREE.BoxGeometry(w,h,d);const m=new THREE.Mesh(geo,this.mat(color));m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
 sphere(r,color,x,y,z,parent=this.scene,sx=1,sy=1,sz=1){const m=new THREE.Mesh(new THREE.SphereGeometry(r,20,14),this.mat(color,.8));m.position.set(x,y,z);m.scale.set(sx,sy,sz);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
 cylinder(rt,rb,h,color,x,y,z,parent=this.scene,segments=24){const m=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,segments),this.mat(color));m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
 text(text,w=256,h=80,size=28,color='#7d836d',background=null){const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');if(background){ctx.fillStyle=background;ctx.fillRect(0,0,w,h);}ctx.fillStyle=color;ctx.font=`500 ${size}px Arial, sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,w/2,h/2);const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace;return new THREE.MeshBasicMaterial({map:tex,transparent:!background,side:THREE.DoubleSide});}
 buildOffice(){
  const s=this.scene;
  // The page shows through the canvas; this plane only catches shadows.
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.ShadowMaterial({opacity:.13}));ground.rotation.x=-Math.PI/2;ground.position.y=-.38;ground.receiveShadow=true;s.add(ground);this.ground=ground;
  this.box(22.4,.32,13.6,'#c5b58f',0,-.15,0,s,.07);
  this.box(22.25,.12,13.45,'#e4cda2',0,.055,0);
  for(let i=0;i<36;i++)for(let j=0;j<4;j++)this.box(.61,.027,3.34,['#e2c99c','#e5cda2','#e8d2a9','#dfc398'][(i+j)%4],-10.82+i*.62,.125,-5.02+j*3.35);
  this.box(14.85,.035,12.25,'#f4e7d0',-3.3,.17,0,s,.04);
  this.box(14.6,.04,12.0,'#dfa87d',-3.3,.19,0,s,.04);
  this.box(14.12,.042,11.52,'#edb58b',-3.3,.213,0,s,.03);
  const glass=new THREE.MeshPhysicalMaterial({color:'#eff5e7',transparent:true,opacity:.19,roughness:.12,depthWrite:false,side:THREE.DoubleSide});
  for(let i=0;i<12;i++){
   const x=-11+i*2;this.box(.055,3.1,.055,'#e7e9d9',x,1.7,-6.6);
   if(i<11){const pane=new THREE.Mesh(new THREE.PlaneGeometry(1.94,3),glass);pane.position.set(x+1,1.72,-6.6);s.add(pane);}
  }
  this.box(22.1,.06,.065,'#f6f5e8',0,3.26,-6.6);this.box(22.1,.07,.07,'#e9e7d4',0,.25,-6.6);this.box(22.1,.045,.05,'#eff0df',0,1.2,-6.6);
  for(let i=0;i<6;i++)this.box(.065,3.1,.065,'#e9e9dc',-11,1.7,-6.6+i*2.2);
  this.box(.065,.06,11,'#f4f3e6',-11,3.26,-1.1);
  this.box(22.1,.055,.055,'#f0ebd9',0,.38,6.6);for(let x=-11;x<=11;x+=2.75)this.box(.06,.5,.06,'#f3efdf',x,.5,6.6);
  for(const pos of [[-12,-5,1.1],[-7,-8,1.1],[0,-8.3,1],[8,-8,1.2],[12,-4,1.1],[-12,5,1],[12,6,.9]])this.tree(...pos);
  this.plant(-10.5,-6,.85);this.plant(10.2,-5.8,.85);this.plant(-10.5,5.9,.8);this.plant(10.2,5.8,.9);
  this.wallClock(2.8,2.6,-6.54);
  DESKS.forEach((desk,i)=>this.desk(desk.x,desk.z,i));
  this.box(5.9,.035,12,'#c7d1b5',7.55,.19,0,s,.05);
  this.box(5.6,.01,11.7,'#d1d9be',7.55,.215,0,s,.03);
  this.sofa(7.05,-4.7);this.coffeeTable(6.95,-2.7);
  this.stool(5.65,-1.55,'#dcb688');this.stool(8.25,-1.55,'#a6b8a2');
  this.roundTable(6.7,3.65);this.stool(5.6,4.0,'#d4b47e');this.stool(7.85,4.0,'#c6c7ab');
  this.bookcase(10,-4.4);
  // Coffee station, a sleeping cat and a miniature celebration corner.
  const coffee=new THREE.Group();coffee.position.set(9.65,0,-.6);s.add(coffee);
  this.box(1.1,1.2,.8,'#d4bfa0',0,.8,0,coffee,.04);this.box(1.2,.08,.9,'#f5edda',0,1.45,0,coffee);
  this.box(.65,.6,.5,'#728d7e',0,1.79,0,coffee,.04);this.box(.45,.3,.03,'#354c40',0,1.82,.27,coffee,.01);
  this.cylinder(.035,.035,.14,'#c6bfac',0,1.56,.31,coffee);this.cup(9.65,1.49,-.2,'#e4c58b');
  this.steam=new THREE.Group();this.steam.position.set(9.65,1.8,-.2);s.add(this.steam);
  for(let i=0;i<5;i++){const puff=new THREE.Mesh(new THREE.SphereGeometry(.085,8,6),new THREE.MeshBasicMaterial({color:'#fff6dc',transparent:true,opacity:0,depthWrite:false}));puff.userData.phase=i/5;this.steam.add(puff);}
  this.addHotspot(coffee,'coffee','来杯咖啡',[9.65,2.7,-.6]);
  this.cat=new THREE.Group();this.cat.position.set(8.85,.26,2.1);s.add(this.cat);
  this.sphere(.46,'#dcad78',0,.25,0,this.cat,1.2,.65,.8);this.sphere(.27,'#e9bb86',.38,.43,.15,this.cat,1,.9,.85);
  for(const x of [.23,.53]){const ear=new THREE.Mesh(new THREE.ConeGeometry(.115,.23,3),this.mat('#d7a16a'));ear.position.set(x,.68,.15);this.cat.add(ear);this.box(.08,.018,.015,'#6e6249',x,.44,.37,this.cat);}
  this.sphere(.035,'#bd846d',.38,.37,.39,this.cat);const tail=new THREE.Mesh(new THREE.TorusGeometry(.29,.085,8,16,Math.PI*1.4),this.mat('#cf9e68'));tail.rotation.x=Math.PI/2;tail.position.set(-.4,.27,.2);this.cat.add(tail);
  this.addHotspot(this.cat,'cat','摸摸小猫',[8.9,1.6,2.1]);
  const board=new THREE.Group();board.position.set(6.1,0,.5);s.add(board);
  this.box(1.7,1.1,.09,'#f6efd8',0,1.65,0,board,.06);this.box(.07,1.5,.07,'#bdac86',-.6,.95,0,board);this.box(.07,1.5,.07,'#bdac86',.6,.95,0,board);
  const note=new THREE.Mesh(new THREE.PlaneGeometry(1.45,.7),this.text('SMALL WINS',512,180,40,'#9b815c','#f6efd8'));note.position.set(0,1.65,.06);board.add(note);
  this.addHotspot(board,'celebrate','庆祝一下',[6.1,2.6,.5]);
  this.confetti=new THREE.Group();s.add(this.confetti);this.confetti.visible=false;
  for(let i=0;i<56;i++){const piece=new THREE.Mesh(new THREE.PlaneGeometry(.12,.18),new THREE.MeshBasicMaterial({color:['#e8ad75','#a9be98','#e6cf8b','#93b8bc'][i%4],side:THREE.DoubleSide}));piece.userData={x:(i%8-3.5)*1.1,z:(Math.floor(i/8)-3)*.7,phase:i*.43};this.confetti.add(piece);}
  const sign=new THREE.Mesh(new THREE.PlaneGeometry(3.6,.65),this.text('ROOM FOR GOOD IDEAS.',768,128,33,'#839075','#e5e9d8'));sign.position.set(7,2.5,-6.54);s.add(sign);
  const zone=new THREE.Mesh(new THREE.PlaneGeometry(4,.45),this.text('FOCUS & FLOW  /  16 SEATS',768,96,27,'#a78363'));zone.rotation.x=-Math.PI/2;zone.position.set(-3.5,.24,6.05);s.add(zone);
 }
 addHotspot(group,id,label,position){
  group.traverse(o=>{if(o.isMesh)o.userData.hotspot=id;});
  const button=document.createElement('button');button.className='agent-label hotspot-label';button.innerHTML=`<svg aria-hidden="true"><use href="#i-${{coffee:'coffee',cat:'cat',celebrate:'spark'}[id]}"/></svg><span>${label}</span>`;button.setAttribute('aria-label',label);button.onclick=e=>{e.stopPropagation();this.onActivity?.(id);};this.labels.appendChild(button);
  this.hotspots.push({group,id,label:button,position:new THREE.Vector3(...position)});
 }
 playActivity(kind){
  this.effects[kind]=this.clock.getElapsedTime();
  if(kind==='celebrate')this.confetti.visible=true;
 }

 tree(x,z,scale){const g=new THREE.Group();g.position.set(x,-.2,z);g.scale.setScalar(scale);this.scene.add(g);this.cylinder(.12,.17,1.65,'#baa483',0,.8,0,g);this.sphere(.85,'#afc496',0,2,0,g,.9,1.1,.85);this.sphere(.64,'#b8cfa1',-.4,2.3,.1,g);this.sphere(.6,'#a7be91',.4,1.9,-.05,g);}
 plant(x,z,scale){const g=new THREE.Group();g.position.set(x,.15,z);g.scale.setScalar(scale);this.scene.add(g);this.cylinder(.32,.24,.53,'#e9d8b9',0,.27,0,g);this.cylinder(.29,.28,.03,'#8e846b',0,.54,0,g);this.cylinder(.045,.06,.85,'#9eae80',0,.9,0,g);for(let i=0;i<7;i++){const a=i*2.4;const leaf=this.sphere(.3,i%2?'#90ae7e':'#a1bc88',Math.cos(a)*.22,1.12+(i%3)*.16,Math.sin(a)*.22,g,.7,1.35,.5);leaf.rotation.z=Math.cos(a)*.6;}}
 bookcase(x,z){const g=new THREE.Group();g.position.set(x,0,z);g.rotation.y=Math.PI/2;this.scene.add(g);this.box(1.6,2.45,.15,'#c8af88',0,1.4,-.25,g);this.box(.09,2.5,.6,'#d4ba91',-.8,1.4,0,g);this.box(.09,2.5,.6,'#d4ba91',.8,1.4,0,g);for(let i=0;i<4;i++){const y=.25+i*.8;this.box(1.7,.1,.65,'#d6bd94',0,y,0,g);if(i<3)for(let j=0;j<8;j++){const colors=['#93afa3','#d59d7c','#d7c18b','#9da2b2','#b1bd93'];this.box(.11,.4+(j%3)*.07,.3,colors[(i+j)%5],-.66+j*.18,y+.29,.04,g,.01);}}}
 wallClock(x,y,z){const rim=this.cylinder(.28,.28,.055,'#d6d8c8',x,y,z);rim.rotation.x=Math.PI/2;const face=this.cylinder(.25,.25,.061,'#fcf9ed',x,y,z+.01);face.rotation.x=Math.PI/2;this.box(.014,.16,.01,'#819077',x,y+.055,z+.05);const hand=this.box(.13,.014,.01,'#819077',x+.04,y,z+.05);hand.rotation.z=-.45;}
 desk(x,z,i){const g=new THREE.Group();g.position.set(x,0,z);this.scene.add(g);this.box(2.13,.13,1.03,'#f7f3e7',0,1.2,0,g,.03);this.box(.5,1.02,.76,'#c3ac88',-.68,.65,0,g,.02);this.box(.5,.03,.75,'#b3a07f',-.68,.65,0,g);this.box(.08,1.03,.08,'#c6c7b6',.84,.64,-.36,g);this.box(.08,1.03,.08,'#c6c7b6',.84,.64,.36,g);this.box(.19,.04,.33,'#8e9992',-.15,1.3,-.24,g,.01);this.box(.055,.25,.055,'#77867d',-.15,1.44,-.31,g);this.box(.82,.53,.07,'#5a6962',-.15,1.76,-.31,g,.02);
  const screen=new THREE.Mesh(new THREE.PlaneGeometry(.74,.43),this.screenMaterial(i));screen.position.set(-.15,1.76,-.266);g.add(screen);this.box(.58,.035,.22,'#e5e5da',-.12,1.29,.2,g,.02);for(let row=0;row<3;row++)for(let c=0;c<8;c++)this.box(.048,.004,.035,'#c4cbbd',-.35+c*.065,1.311,.135+row*.055,g);this.sphere(.07,'#e0e3d7',.34,1.3,.2,g,.7,.4,1);this.cup(x+.76,1.28,z-.12,['#98b5a0','#d9b279','#8dacc8','#c6adca','#b7bc8e','#c6a086'][i%6]);this.box(.26,.015,.3,'#e5ddbd',.68,1.28,.3,g);this.chair(x+.1,z+.84);
  const desk=DESKS[i];g.traverse(o=>{if(o.isMesh)o.userData.deskId=desk.id;});
  const plate=new THREE.Mesh(new THREE.PlaneGeometry(1.5,.27),this.text(desk.label,384,72,24,'#947c5c','#f7f1df'));plate.position.set(0,1.15,.535);g.add(plate);plate.userData.deskId=desk.id;
  this.workstations.set(desk.id,{group:g,plate,screen,owner:null});
 }
 screenMaterial(i){const canvas=document.createElement('canvas');canvas.width=256;canvas.height=160;const c=canvas.getContext('2d');c.fillStyle='#243f3a';c.fillRect(0,0,256,160);c.fillStyle='#35534a';c.fillRect(0,0,256,14);c.fillStyle='#7d9a83';[8,17,26].forEach(x=>{c.beginPath();c.arc(x,7,2,0,Math.PI*2);c.fill()});c.fillStyle='#2b4941';c.fillRect(0,14,37,146);for(let r=0;r<10;r++){const y=27+r*12;c.fillStyle=r%3===0?'#c3b381':r%3===1?'#87ae9b':'#7d9a93';c.fillRect(49+(r%3)*7,y,35+((r*17+i*11)%105),3);if(r%2)c.fillRect(65,y+5,60+(r%3)*20,2);}const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace;return new THREE.MeshBasicMaterial({map:tex});}
 chair(x,z){const g=new THREE.Group();g.position.set(x,0,z);this.scene.add(g);this.cylinder(.06,.07,.45,'#7c8980',0,.49,0,g);this.cylinder(.31,.31,.05,'#839088',0,.26,0,g);this.box(.62,.13,.61,'#6d7e73',0,.78,0,g,.05);const back=this.box(.6,.58,.12,'#75867b',0,1.13,.27,g,.06);back.rotation.x=-.08;this.box(.05,.33,.05,'#7e8980',-.32,.91,.06,g);this.box(.05,.33,.05,'#7e8980',.32,.91,.06,g);this.box(.07,.055,.3,'#63766b',-.32,1.08,.04,g,.02);this.box(.07,.055,.3,'#63766b',.32,1.08,.04,g,.02);for(let i=0;i<5;i++){const a=i*Math.PI*2/5;this.sphere(.07,'#78857c',Math.cos(a)*.3,.23,Math.sin(a)*.3,g,1,.6,1);}}
 cup(x,y,z,color){this.cylinder(.075,.062,.15,color,x,y+.075,z);this.cylinder(.059,.059,.006,'#947d5d',x,y+.153,z);const handle=new THREE.Mesh(new THREE.TorusGeometry(.042,.013,5,12),this.mat(color));handle.position.set(x+.075,y+.08,z);this.scene.add(handle);}
 sofa(x,z){const g=new THREE.Group();g.position.set(x,0,z);this.scene.add(g);this.box(2.65,.4,.96,'#99b2a0',0,.52,0,g,.12);this.box(2.65,.85,.23,'#a2b9a6',0,.93,-.44,g,.1);this.box(.25,.6,1.1,'#a6bda8',-1.34,.76,0,g,.08);this.box(.25,.6,1.1,'#a6bda8',1.34,.76,0,g,.08);for(let i=0;i<3;i++)this.box(.79,.17,.83,'#b2c4af',-.84+i*.84,.8,.05,g,.07);for(const px of [-1.1,1.1])for(const pz of [-.3,.3])this.cylinder(.05,.065,.25,'#b4a283',px,.27,pz,g);const pillow=this.box(.46,.46,.19,'#e9dbb6',-.9,1.08,-.17,g,.09);pillow.rotation.z=.2;const pillow2=this.box(.46,.46,.19,'#d8a78a',.95,1.08,-.16,g,.09);pillow2.rotation.z=-.16;}
 coffeeTable(x,z){this.cylinder(.73,.73,.11,'#ead5b0',x,.68,z);this.cylinder(.12,.2,.42,'#c7b28b',x,.42,z);this.box(.3,.035,.4,'#a1b8a4',x+.12,.76,z+.06);this.cup(x-.25,.75,z-.1,'#f2eee0');}
 roundTable(x,z){this.cylinder(.82,.82,.12,'#dfc995',x,.98,z);this.cylinder(.13,.2,.75,'#c6b07e',x,.55,z);this.cylinder(.4,.4,.07,'#c9b280',x,.2,z);this.cup(x+.26,1.05,z-.2,'#faf5e5');this.box(.37,.035,.27,'#d3debd',x-.2,1.06,z+.05);}
 stool(x,z,color){this.cylinder(.36,.36,.16,color,x,.64,z);for(let i=0;i<3;i++){const a=i*Math.PI*2/3;this.cylinder(.035,.05,.45,'#c5b289',x+Math.cos(a)*.21,.36,z+Math.sin(a)*.21);}}
 createCharacter(agent,index){const group=new THREE.Group();const body=new THREE.Group();group.add(body);this.scene.add(group);const color=MODELS[agent.model].color;
  // Soft, toy-like robots, each with an individual color and a tiny antenna.
  this.sphere(.29,color,0,.45,0,body,.95,1.2,.8);this.sphere(.31,'#f8f5e9',0,.96,0,body,1,1.02,.93);this.sphere(.095,color,-.3,.95,0,body,.65,.85,.9);this.sphere(.095,color,.3,.95,0,body,.65,.85,.9);
  this.sphere(.024,'#46584d',-.105,.99,.276,body,1,1.3,.6);this.sphere(.024,'#46584d',.105,.99,.276,body,1,1.3,.6);this.sphere(.029,'#e7b6a2',-.18,.91,.23,body,1,.45,.35);this.sphere(.029,'#e7b6a2',.18,.91,.23,body,1,.45,.35);this.box(.055,.012,.01,'#b8b9a5',0,.9,.291,body,.005);
  const cap=this.sphere(.29,color,0,1.13,-.012,body,1,.43,.95);this.cylinder(.023,.023,.14,color,0,1.32,-.03,body);this.sphere(.05,'#e8d6a0',0,1.41,-.03,body);
  const leftArm=this.sphere(.09,color,-.29,.45,.08,body,.8,1.8,1);leftArm.rotation.z=-.28;const rightArm=this.sphere(.09,color,.29,.45,.08,body,.8,1.8,1);rightArm.rotation.z=.25;this.sphere(.075,'#f7f2e7',-.32,.29,.1,body);this.sphere(.075,'#f7f2e7',.32,.29,.1,body);
  this.sphere(.1,color,-.13,.18,.07,body,.8,1.5,.85);this.sphere(.1,color,.13,.18,.07,body,.8,1.5,.85);this.sphere(.09,'#f4efe1',-.13,.06,.13,body,1,.6,1.4);this.sphere(.09,'#f4efe1',.13,.06,.13,body,1,.6,1.4);
  this.sphere(.055,'#e6d9b6',0,.52,.23,body,1,1,.35);
  const ring=new THREE.Mesh(new THREE.RingGeometry(.47,.51,40),new THREE.MeshBasicMaterial({color:'#dbad6e',transparent:true,opacity:.8,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=.01;ring.visible=false;group.add(ring);
  const label=document.createElement('button');label.className='agent-label';label.dataset.agentId=agent.id;label.setAttribute('aria-label',`查看 ${agent.name}`);label.addEventListener('click',e=>{e.stopPropagation();this.select(agent.id);this.onSelect(agent.id);});this.labels.appendChild(label);
  group.traverse(o=>{if(o.isMesh)o.userData.agentId=agent.id;});
  const obj={id:agent.id,group,body,ring,label,phase:index*1.7,arm:rightArm,head:cap,position:new THREE.Vector3(),status:agent.status};this.characters.set(agent.id,obj);return obj;
 }
 updateAgents(agents){
  this.agents=assignSeats(agents);let restIndex=0;
  const rests=[[7.05,.81,-4.6],[5.65,.7,-1.55],[8.25,.7,-1.55],[5.6,.72,4],[7.85,.72,4],[7.9,.81,-4.6]];
  const ids=new Set(agents.map(a=>a.id));
  for(const [id,obj]of this.characters){if(!ids.has(id)){obj.label.remove();this.scene.remove(obj.group);obj.group.traverse(o=>{if(o.isMesh)o.geometry.dispose();});this.characters.delete(id);}}
  for(const desk of DESKS){
   const station=this.workstations.get(desk.id),owner=this.agents.find(a=>a.seatId===desk.id);
   const signature=owner?owner.id+owner.name:'empty';
   if(station.owner!==signature){station.plate.material.map?.dispose();station.plate.material.dispose();station.plate.material=this.text(`${desk.id.slice(-2)}  ${owner?.name||'空位'}`,384,72,25,owner?'#68795a':'#ac9879','#f7f1df');station.owner=signature;}
  }
  this.agents.forEach((a,i)=>{
   const obj=this.characters.get(a.id)||this.createCharacter(a,i),desk=DESKS.find(d=>d.id===a.seatId);
   const atLounge=a.status==='resting'&&restIndex<rests.length;
   const pos=atLounge?rests[restIndex++]:[desk.x+.1,.82,desk.z+.84];
   obj.position.set(...pos);obj.group.position.copy(obj.position);obj.group.rotation.y=atLounge?.12:Math.PI;obj.status=a.status;
   const offline=('lastSeen' in a)&&(!a.lastSeen||Date.now()-a.lastSeen>300000);
   const dot=document.createElement('span');dot.className='label-color';dot.style.background=MODELS[a.model].color;
   const name=document.createElement('span');name.textContent=a.name;
   const suffix=document.createElement('span');suffix.className=a.status==='working'&&!offline?'label-busy':'label-sleep';
   if(a.status==='working'&&!offline){for(let j=0;j<3;j++)suffix.appendChild(document.createElement('i'));}
   else suffix.textContent=offline?(!a.lastSeen?'待连':'离线'):a.status==='thinking'?'···':'zᶻ';
   obj.label.replaceChildren(dot,name,suffix);obj.label.labelWidth=0;obj.label.setAttribute('aria-label',`与 ${a.name} 聊天`);
  });
 }

 resize(){const w=this.container.clientWidth,h=this.container.clientHeight;if(!w||!h)return;for(const label of this.labels.children)label.labelWidth=0;this.renderer.setSize(w,h,false);const aspect=w/h;const worldWidth=aspect<1?29:31;const height=Math.max(21,worldWidth/aspect);this.camera.left=-height*aspect/2;this.camera.right=height*aspect/2;this.camera.top=height/2;this.camera.bottom=-height/2;this.camera.updateProjectionMatrix();}
 setView(view){const presets={overview:{pos:[14,14,17],target:[0,.4,0],zoom:1},work:{pos:[10,14,14],target:[-3.5,.65,0],zoom:1.45},lounge:{pos:[13,10,14],target:[7.4,.6,-.5],zoom:2.1},top:{pos:[.01,22,1],target:[0,0,0],zoom:1.03}};const p=presets[view]||presets.overview;this.cameraAnimation={from:this.camera.position.clone(),to:new THREE.Vector3(...p.pos),targetFrom:this.controls.target.clone(),targetTo:new THREE.Vector3(...p.target),zoomFrom:this.camera.zoom,zoomTo:p.zoom,start:performance.now()};}
 zoom(delta){this.cameraAnimation=null;this.camera.zoom=THREE.MathUtils.clamp(this.camera.zoom+delta,.55,2.5);this.camera.updateProjectionMatrix();this.onZoom?.(Math.round(this.camera.zoom*100));}
 select(id){for(const [key,o]of this.characters){o.ring.visible=key===id;o.label.classList.toggle('selected',key===id);}}
 setNight(night){this.night=night;this.ground.material.opacity=night?.34:.13;this.hemi.intensity=night?1.4:3.1;this.sun.intensity=night?1.4:4.4;this.sun.color.set(night?'#e8d6ba':'#fff5dd');this.fill.intensity=night?2:1.2;this.fill.color.set(night?'#94a4e4':'#e2eeff');}
 setPaused(paused){this.isPaused=paused;this.labels.classList.toggle('paused',paused);this.labels.querySelectorAll('.label-busy i').forEach(e=>e.style.animationPlayState=paused?'paused':'running');}
 pick(event){
  const bounds=this.container.getBoundingClientRect();const mouse=new THREE.Vector2((event.clientX-bounds.left)/bounds.width*2-1,-(event.clientY-bounds.top)/bounds.height*2+1);const ray=new THREE.Raycaster();ray.setFromCamera(mouse,this.camera);
  const targets=[...this.characters.values()].map(o=>o.group).concat([...this.workstations.values()].map(o=>o.group),this.hotspots.map(o=>o.group));
  const hit=ray.intersectObjects(targets,true).find(h=>h.object.userData.agentId||h.object.userData.deskId||h.object.userData.hotspot);
  if(!hit)return;const data=hit.object.userData;
  if(data.agentId){this.select(data.agentId);this.onSelect(data.agentId);}else if(data.deskId)this.onDesk?.(data.deskId);else this.onActivity?.(data.hotspot);
 }
 // Project every label, then let the ones further back step upward until nothing overlaps.
 layoutLabels(){
  const w=this.container.clientWidth,h=this.container.clientHeight,items=[];
  const add=(label,x3,y3,z3)=>{const p=this.labelAnchor.set(x3,y3,z3).project(this.camera),x=(p.x*.5+.5)*w,y=(-p.y*.5+.5)*h,visible=!(p.z>1||p.z< -1||x<10||x>w-10||y<64||y>h-58);label.style.visibility=visible?'visible':'hidden';if(!visible)return;if(!label.labelWidth){label.labelWidth=label.offsetWidth||60;label.labelHeight=label.offsetHeight||26;}items.push({label,x,y,z:p.z,width:label.labelWidth,height:label.labelHeight});};
  for(const obj of this.characters.values())add(obj.label,obj.group.position.x,obj.group.position.y+1.72,obj.group.position.z);
  for(const spot of this.hotspots)add(spot.label,spot.position.x,spot.position.y,spot.position.z);
  items.sort((a,b)=>b.y-a.y);
  const placed=[];
  for(const item of items){
   for(let pass=0;pass<5;pass++){const step=item.height+2,hit=placed.find(o=>Math.abs(o.x-item.x)<(o.width+item.width)/2+4&&Math.abs(o.y-item.y)<step);if(!hit)break;item.y=hit.y-step;}
   placed.push(item);
   item.label.style.transform=`translate3d(${item.x.toFixed(1)}px,${item.y.toFixed(1)}px,0) translate(-50%,-100%)`;item.label.style.zIndex=String(Math.round(100-item.z*50));
  }
 }

 animate(){if(document.hidden||this.container.clientWidth===0)return;const t=this.clock.getElapsedTime();if(this.cameraAnimation){const a=this.cameraAnimation;const p=Math.min(1,(performance.now()-a.start)/(this.reducedMotion?1:700));const ease=1-Math.pow(1-p,3);this.camera.position.lerpVectors(a.from,a.to,ease);this.controls.target.lerpVectors(a.targetFrom,a.targetTo,ease);this.camera.zoom=THREE.MathUtils.lerp(a.zoomFrom,a.zoomTo,ease);this.camera.updateProjectionMatrix();if(p===1)this.cameraAnimation=null;}
  for(const obj of this.characters.values()){if(!this.isPaused&&!this.reducedMotion){const bob=Math.sin(t*1.8+obj.phase)*.018;obj.body.position.y=bob;obj.body.rotation.z=Math.sin(t*.8+obj.phase)*.025;if(obj.status==='working')obj.arm.rotation.x=Math.sin(t*5+obj.phase)*.15;else obj.arm.rotation.x=0;}
  }
  this.layoutLabels();
  const coffeeAge=t-(this.effects.coffee??-100),catAge=t-(this.effects.cat??-100),partyAge=t-(this.effects.celebrate??-100);
  this.steam.children.forEach(p=>{const q=this.reducedMotion?p.userData.phase:(t*.5+p.userData.phase)%1;p.position.set(Math.sin(q*5)*.12,q*.85,0);p.material.opacity=coffeeAge<6?(1-q)*.6:0;});
  this.cat.scale.y=catAge<3&&!this.reducedMotion?1+Math.sin(catAge*Math.PI)*.12:1;
  if(partyAge<4){this.confetti.children.forEach(piece=>{const d=piece.userData;piece.position.set(6.5+d.x,Math.max(.3,5-(((this.reducedMotion?0:partyAge)+d.phase)*1.7)%5),d.z);if(!this.reducedMotion)piece.rotation.set(t+d.phase,t*.8,d.phase);});}else this.confetti.visible=false;
  this.controls.update();this.renderer.render(this.scene,this.camera);
 }
}
