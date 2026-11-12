import {MODELS,STATUS,initialState,validState} from './data.js';

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const STORAGE_KEY='agent-office-state-v1';
const DEMO=new URLSearchParams(window.location.search).get('demo')==='1';
let cloudReady=false,saving=false,polling=false;
const MCP_URL='https://your-office.example/api/hermes/mcp';
let state=DEMO?initialState():{version:1,revision:0,night:false,paused:false,agents:[{id:'hermes',name:'Hermes',model:'Hermes',role:'等待 Hermes 连接',status:'resting',completed:0,lastSeen:null}],tasks:[],activities:[]},storageAvailable=true;
try{const saved=JSON.parse(localStorage.getItem(STORAGE_KEY));if(DEMO&&validState(saved))state=saved;else if(!DEMO)state.night=localStorage.getItem('agent-office-night')==='1';}catch{}
let scene=null,view='office',teamFilter='all',memberFilter='all',taskFilter='all',listMode=false,selectedAgent=null,selectedModel='ChatGPT',toastTimer;
let renderSceneNeeded=true;

function persist(){if(!DEMO){try{localStorage.setItem('agent-office-night',state.night?'1':'0');}catch{}return;}try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));}catch{if(storageAvailable){storageAvailable=false;toast('浏览器无法保存数据，本次更改仅在当前页面有效');$('.workspace-footer>span').lastChild.textContent='当前会话模式';}}}
function toast(message){clearTimeout(toastTimer);$('#toast span').textContent=message;$('#toast').classList.add('show');toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3400);}
function avatar(a){const m=MODELS[a.model];return `<span class="avatar ${m.className}" style="--avatar-bg:${m.bg};--avatar-color:${m.color}"><span class="avatar-mark">${m.mark}</span></span>`;}
function taskFor(id){return state.tasks.find(t=>t.agentId===id&&t.status==='active')||state.tasks.find(t=>t.agentId===id&&t.status!=='done');}
function activeTaskFor(id){return state.tasks.find(t=>t.agentId===id&&t.status==='active');}
function relativeTime(time){const n=Math.max(0,Math.floor((Date.now()-time)/60000));return n===0?'刚刚':n<60?`${n} 分钟前`:n<1440?`${Math.floor(n/60)} 小时前`:`${Math.floor(n/1440)} 天前`;}
function activity(name,text){state.activities.unshift({name,text,time:Date.now()});state.activities=state.activities.slice(0,20);}
function displayState(positions=true){render();if(positions&&scene){scene.updateAgents(state.agents);scene.setPaused(state.paused);}if(selectedAgent&&$('#detail-dialog').open)renderDetail(selectedAgent);}
function acceptCloud(data){if(!validState(data)||!Number.isInteger(data.revision))throw new Error('服务器返回了无效数据');state={...data,night:state.night,paused:false};cloudReady=true;displayState();}
async function syncCloud(){if(DEMO||polling||saving)return;polling=true;try{const response=await fetch('/api/state',{headers:{Accept:'application/json'},cache:'no-store'});if(!response.ok)throw new Error('云端暂时不可用');acceptCloud(await response.json());}catch{cloudReady=false;render();}finally{polling=false;}}
function presence(a){return DEMO?STATUS[a.status]:!a.lastSeen?'待连接':Date.now()-a.lastSeen>300000?'离线':STATUS[a.status];}
async function updateState({positions=true,localOnly=false}={}){persist();if(DEMO||localOnly){displayState(positions);return;}if(!cloudReady||saving){toast('云端尚未就绪，请稍后重试');return;}saving=true;const payload=structuredClone(state);displayState(positions);try{const response=await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(response.status===409?'Hermes 更新了办公室，请重试刚才的操作':error.error||'保存失败');}acceptCloud(await response.json());}catch(error){toast(error.message);saving=false;await syncCloud();}finally{saving=false;render();}}


function render(){
 $('#total-count').textContent=state.agents.length;$('#team-badge').textContent=state.agents.length;$('#member-count').textContent=state.agents.length;
 for(const s of Object.keys(STATUS))$(`#${s==='resting'?'resting':s==='thinking'?'thinking':'working'}-count`).textContent=state.agents.filter(a=>a.status===s).length;
 const members=state.agents.filter(a=>teamFilter==='all'||a.status===teamFilter);
 $('#team-list').innerHTML=members.length?members.map(a=>`<button class="team-member" data-agent="${esc(a.id)}" aria-label="查看 ${esc(a.name)}"><span>${avatar(a)}</span><span><span class="team-name">${esc(a.name)}</span><span class="team-role" style="display:block">${esc(a.role)}</span></span><span class="team-status ${a.status}"><i class="status-dot ${a.status}"></i>${presence(a)}</span></button>`).join(''):'<div class="empty-state">这个区域暂时没有伙伴<br>大家都在别处忙碌着</div>';
 $('#activity-list').innerHTML=state.activities.slice(0,3).map(a=>`<div class="activity-item"><i class="activity-dot"></i><div><div class="activity-copy"><strong>${esc(a.name)}</strong> ${esc(a.text)}</div><div class="activity-time">${relativeTime(a.time)}</div></div></div>`).join('');
 renderMembers();renderTasks();
 $('#simulation-toggle').innerHTML=icon(state.paused?'play':'pause')+`<span>${state.paused?'继续模拟':'暂停模拟'}</span>`;$('#simulation-toggle').setAttribute('aria-pressed',String(state.paused));
 $('#footer-status').textContent=DEMO?(state.paused?'模拟已暂停':'演示模式'):saving?'正在保存':cloudReady?'云端已同步':'连接云端中';$('.live-label').innerHTML=`<i></i>${state.paused?'PAUSED':'LIVE'}`;
 $('.demo-badge').innerHTML=`<span class="pulse-dot"></span>${DEMO?'演示空间':cloudReady?'实时办公室':'正在连接'}`;
 if(!DEMO){$('#simulation-toggle').innerHTML=icon('reset')+'<span>刷新状态</span>';$('.live-label').innerHTML='<i></i>'+ (cloudReady?'LIVE':'CONNECTING');}
 $('#storage-label').textContent=DEMO?'演示数据保存在当前浏览器':'成员与任务保存在云端';
 $('#mode-link').textContent=DEMO?'返回实时办公室':'体验演示';$('#mode-link').href=DEMO?'./':'?demo=1';
 document.body.classList.toggle('night',state.night);$('#theme-btn').innerHTML=icon(state.night?'moon':'sun');$('#theme-btn').setAttribute('aria-label',state.night?'切换到白天模式':'切换到夜晚模式');
 $('#note-title').textContent=state.night?'星光在线，灵感不打烊。':'各自闪光，一起发亮。';
}
function memberCard(a){return `<button class="member-card" data-agent="${esc(a.id)}">${avatar(a)}<h3>${esc(a.name)}</h3><p>${esc(a.role)}</p><span class="member-card-status"><i class="status-dot ${a.status}"></i>${presence(a)}<span style="margin-left:auto">${a.completed||0} 项完成</span></span></button>`;}
function renderMembers(){const q=$('#member-search').value.trim().toLowerCase();const agents=state.agents.filter(a=>(memberFilter==='all'||a.status===memberFilter)&&`${a.name} ${a.role} ${a.model}`.toLowerCase().includes(q));$('#member-grid').innerHTML=agents.length?agents.map(memberCard).join(''):'<div class="empty-state">暂时没有匹配的成员<br>试试其他名字，或者招募一个新伙伴。</div>';$('#member-list-view').innerHTML=state.agents.map(memberCard).join('');}
function renderTasks(){const tasks=state.tasks.filter(t=>taskFilter==='all'||(taskFilter==='done'?t.status==='done':t.status!=='done'));$('#task-count').textContent=state.tasks.length;$('#task-board').innerHTML=tasks.length?tasks.slice().reverse().map(t=>{const a=state.agents.find(a=>a.id===t.agentId);return `<article class="task-card"><div class="task-card-top"><span>${t.status==='done'?'✓ 已完成':t.status==='paused'?'◷ 已暂停':t.status==='queued'?'◷ 待领取':'● 进行中'}</span>${t.priority==='high'?'<span class="task-priority">优先任务</span>':`<span>${relativeTime(t.created)}</span>`}</div><h3>${esc(t.title)}</h3><p>${esc(t.description||'让伙伴专注完成这件小事。')}</p><div class="task-card-bottom"><button class="task-assignee text-button" data-agent="${esc(a.id)}">${avatar(a)}${esc(a.name)}</button><span class="task-percent">${Math.round(t.progress)}%</span></div><div class="progress-track"><div class="progress-bar" style="width:${t.progress}%"></div></div>${t.status!=='done'?`<div class="task-card-actions"><button data-task-action="${t.status==='paused'?'resume':'pause'}" data-task-id="${esc(t.id)}">${t.status==='paused'?'继续任务':'暂停任务'}</button><button data-task-action="complete" data-task-id="${esc(t.id)}" style="margin-left:auto">标记完成 ${'↗'}</button></div>`:''}</article>`;}).join(''):'<div class="empty-state">这里还没有任务<br>给伙伴一个目标，一起开始吧。</div>';}
function changeView(next){view=next;$('#space-panel').hidden=next!=='office';$('#tasks-page').hidden=next!=='tasks';$('#members-page').hidden=next!=='members';$$('.nav-item[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===next);if(b.dataset.view===next)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});const meta={office:['我的 AI 办公室','让每一位 Agent 各展所长，让好想法在这里发生。'],tasks:['小任务，大进展','把每一个好想法，变成正在发生的事。'],members:['认识你的 AI 团队','每一位伙伴都有独特的超能力。']};$('#page-title').innerHTML=meta[next][0]+'<span class="heading-dot">.</span>';$('#page-subtitle').textContent=meta[next][1];if(next==='office')requestAnimationFrame(()=>scene?.resize());}
function setTeamFilter(f){teamFilter=f;$$('.team-filter').forEach(b=>b.classList.toggle('active',b.dataset.teamFilter===f));render();}
function openDialog(id){const d=$('#'+id);if(!d.open)d.showModal();}
function closeDialog(id){$('#'+id).close();}
function showDetail(id){if(!state.agents.some(a=>a.id===id))return;selectedAgent=id;renderDetail(id);scene?.select(id);openDialog('detail-dialog');}
function renderDetail(id){const a=state.agents.find(a=>a.id===id);if(!a)return;const t=taskFor(id),m=MODELS[a.model];$('#detail-content').innerHTML=`<div class="detail-hero">${avatar(a)}<div><h2>${esc(a.name)}</h2><p>${esc(a.role)} · ${esc(a.model)}</p></div></div><div class="detail-meta"><span><i class="status-dot ${a.status}"></i> ${presence(a)}</span><span>已完成 <strong>${a.completed||0}</strong> 项任务</span></div><div class="skill-chips">${m.skills.map(s=>`<span class="skill-chip">${s}</span>`).join('')}</div><div class="detail-task"><div class="detail-task-label"><span>${t?'当前任务':'此刻在做什么'}</span><span>${t?`${Math.round(t.progress)}%`:''}</span></div><h3>${t?esc(t.title):'补充灵感，准备迎接下一个好点子。'}</h3>${t?`<div class="progress-track"><div class="progress-bar" style="width:${t.progress}%"></div></div>`:'<span class="subtle">休息一下，也是一种生产力。</span>'}</div><div class="detail-actions"><button class="button secondary" id="detail-rest">${icon(a.status==='resting'?'bolt':'coffee')}${a.status==='resting'?(t?'继续任务':'安排工作'):'让 TA 休息'}</button><button class="button primary" id="detail-assign">${icon(t?'task':'plus')}${t?'查看任务':'分配任务'}</button></div>`;
 $('#detail-rest').onclick=()=>{if(a.status==='resting'){if(t){t.status='active';a.status='working';activity(a.name,'结束休息，继续任务');updateState();toast(`${a.name} 回到工位啦`);}else{closeDialog('detail-dialog');openTask(id);}}else{a.status='resting';if(t)t.status='paused';activity(a.name,'暂时放下工作，去休息区充充电');updateState();toast(`${a.name} 去休息区啦`);}};
 $('#detail-assign').onclick=()=>{closeDialog('detail-dialog');if(t){taskFilter='all';$$('.task-filter').forEach(b=>b.classList.toggle('active',b.dataset.taskFilter==='all'));renderTasks();changeView('tasks');}else openTask(id);};
}
function renderModelOptions(){const keys=['Hermes','ChatGPT','Claude','Codex','Gemini','Kimi'];$('#model-options').innerHTML=keys.map(model=>`<button type="button" class="model-option ${model===selectedModel?'selected':''}" data-model="${model}" aria-pressed="${model===selectedModel}">${avatar({model})}${model}</button>`).join('');}
function openRecruit(){if(!DEMO&&!cloudReady){toast('请等待云端连接');return;}if(state.agents.length>=16){toast('办公室已满员，最多容纳 16 位伙伴');return;}selectedModel=DEMO?'ChatGPT':'Hermes';renderModelOptions();$('#recruit-form').reset();$('#agent-name').value=suggestedName(selectedModel);openDialog('recruit-dialog');}
function suggestedName(model){const count=state.agents.filter(a=>a.model===model).length;return count?`${model} · ${count+1}`:model;}
function openTask(agentId){if(!DEMO&&!cloudReady){toast('请等待云端连接');return;}if(state.tasks.length>=200){toast('办公室已达到 200 项任务上限');return;}const available=state.agents.filter(a=>!taskFor(a.id));if(!available.length){toast('伙伴们都有待办任务，可以先完成任务或招募新成员');return;}$('#task-form').reset();$('#task-agent').innerHTML=state.agents.map(a=>`<option value="${esc(a.id)}" ${taskFor(a.id)?'disabled':''}>${esc(a.name)} · ${taskFor(a.id)?'已有任务':esc(a.role)}</option>`).join('');$('#task-agent').value=available.some(a=>a.id===agentId)?agentId:available[0].id;openDialog('task-dialog');}
function completeTask(t){t.status='done';t.progress=100;const a=state.agents.find(a=>a.id===t.agentId);if(a){a.status='resting';a.completed=(a.completed||0)+1;activity(a.name,`完成了「${t.title}」`);}}

document.addEventListener('click',e=>{
 const agentButton=e.target.closest('[data-agent]');if(agentButton)showDetail(agentButton.dataset.agent);
 const nav=e.target.closest('[data-view]');if(nav)changeView(nav.dataset.view);
 const close=e.target.closest('[data-close]');if(close)closeDialog(close.dataset.close);
 const team=e.target.closest('[data-team-filter]');if(team)setTeamFilter(team.dataset.teamFilter);
 const stat=e.target.closest('[data-filter]');if(stat){memberFilter=stat.dataset.filter;$$('.member-filter').forEach(b=>b.classList.toggle('active',b.dataset.memberFilter===memberFilter));$('#member-search').value='';renderMembers();changeView('members');}
 const mf=e.target.closest('[data-member-filter]');if(mf){memberFilter=mf.dataset.memberFilter;$$('.member-filter').forEach(b=>b.classList.toggle('active',b===mf));renderMembers();}
 const tf=e.target.closest('[data-task-filter]');if(tf){taskFilter=tf.dataset.taskFilter;$$('.task-filter').forEach(b=>b.classList.toggle('active',b===tf));renderTasks();}
 const model=e.target.closest('[data-model]');if(model){selectedModel=model.dataset.model;renderModelOptions();$('#agent-name').value=suggestedName(selectedModel);const roles={Hermes:'通用助手',ChatGPT:'通用助手',Claude:'内容创作',Codex:'代码开发',Gemini:'设计创意',Kimi:'资料研究',DeepSeek:'数据分析'};$('#agent-role').value=roles[selectedModel];}
 if(e.target.closest('.new-task-trigger'))openTask();
 const action=e.target.closest('[data-task-action]');if(action){const t=state.tasks.find(t=>t.id===action.dataset.taskId);if(!t||t.status==='done')return;const a=state.agents.find(a=>a.id===t.agentId);if(action.dataset.taskAction==='complete'){completeTask(t);toast('任务已完成，辛苦啦！');}else if(action.dataset.taskAction==='pause'){t.status='paused';a.status='resting';activity(a.name,'暂停任务，休息一下');toast('任务已暂停');}else{t.status='active';a.status='working';activity(a.name,'回到工位继续任务');toast('任务已继续');}updateState();}
});

$('#recruit-btn').onclick=openRecruit;
$('#manage-btn').onclick=()=>{memberFilter='all';$$('.member-filter').forEach(b=>b.classList.toggle('active',b.dataset.memberFilter==='all'));$('#member-search').value='';renderMembers();changeView('members');};
$('#help-btn').onclick=()=>openDialog('help-dialog');$('#profile-btn').onclick=()=>openDialog('help-dialog');
$('.brand').onclick=e=>{e.preventDefault();changeView('office');};
$('#member-search').addEventListener('input',renderMembers);
$('#recruit-form').addEventListener('submit',e=>{e.preventDefault();const name=$('#agent-name').value.trim();if(!name){$('#agent-name').setCustomValidity('请为新伙伴起个名字');$('#agent-name').reportValidity();return;}if(state.agents.length>=16)return;const a={id:crypto.randomUUID(),name,model:selectedModel,role:$('#agent-role').value,status:'resting',completed:0};state.agents.push(a);activity(name,'加入办公室，期待和你一起创造');closeDialog('recruit-dialog');updateState();toast(`欢迎 ${name} 加入办公室！`);});
$('#agent-name').addEventListener('input',e=>e.target.setCustomValidity(''));
$('#task-title').addEventListener('input',e=>e.target.setCustomValidity(''));
$('#task-form').addEventListener('submit',e=>{e.preventDefault();const title=$('#task-title').value.trim();if(!title){$('#task-title').setCustomValidity('请填写任务名称');$('#task-title').reportValidity();return;}const a=state.agents.find(a=>a.id===$('#task-agent').value);if(!a||taskFor(a.id)){toast('这位伙伴已有任务，请选择其他成员');return;}state.tasks.push({id:crypto.randomUUID(),title,description:$('#task-description').value.trim(),agentId:a.id,priority:$('#task-priority').value,progress:0,status:DEMO?'active':'queued',created:Date.now()});if(DEMO)a.status='working';activity(a.name,`开始了新任务「${title}」`);closeDialog('task-dialog');updateState();toast(DEMO?`已交给 ${a.name}，开始协作！`:`任务已排队，等待 ${a.name} 领取`);});
function switchList(show){listMode=show;$('#scene-wrap').hidden=show;$('#member-list-view').hidden=!show;$('#space-tab').classList.toggle('active',!show);$('#list-tab').classList.toggle('active',show);$('#space-tab').setAttribute('aria-selected',String(!show));$('#list-tab').setAttribute('aria-selected',String(show));if(!show)requestAnimationFrame(()=>scene?.resize());}
$('#space-tab').onclick=()=>switchList(false);$('#list-tab').onclick=()=>switchList(true);
$('#camera-select').onchange=e=>scene?.setView(e.target.value);
$('#zoom-in').onclick=()=>scene?.zoom(.15);$('#zoom-out').onclick=()=>scene?.zoom(-.15);$('#reset-view').onclick=()=>{$('#camera-select').value='overview';scene?.setView('overview');};
function expand(expanded){$('#space-panel').classList.toggle('expanded',expanded);document.body.classList.toggle('expanded-mode',expanded);$('#expand-btn').setAttribute('aria-label',expanded?'退出展开':'展开办公室');$('#expand-btn').setAttribute('title',expanded?'退出展开':'展开办公室');$('#expand-btn').innerHTML=icon(expanded?'close':'expand');requestAnimationFrame(()=>scene?.resize());}
$('#expand-btn').onclick=()=>expand(!$('#space-panel').classList.contains('expanded'));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$$('dialog[open]').length)expand(false);});
$('#simulation-toggle').onclick=()=>{if(!DEMO){syncCloud();return;}state.paused=!state.paused;scene?.setPaused(state.paused);updateState({positions:false});toast(state.paused?'办公室模拟已暂停':'伙伴们继续忙碌起来啦');};
$('#theme-btn').onclick=()=>{state.night=!state.night;scene?.setNight(state.night);updateState({positions:false,localOnly:true});toast(state.night?'晚安，灵感还在发光':'早安，开启元气满满的一天');};
$$('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
$('#detail-dialog').addEventListener('close',()=>{selectedAgent=null;scene?.select(null);});
setInterval(()=>{if(!DEMO||state.paused||document.hidden)return;let changed=false,positions=false;for(const t of state.tasks){if(t.status!=='active')continue;const a=state.agents.find(a=>a.id===t.agentId);if(!a||a.status==='resting')continue;t.progress=Math.min(100,t.progress+(a.status==='thinking'?1:2));changed=true;if(a.status==='thinking'&&t.progress>=22){a.status='working';activity(a.name,'想清楚了方向，开始动手实现');positions=true;}if(t.progress>=100){completeTask(t);positions=true;}}
 if(changed)updateState({positions});else $('#activity-list').querySelectorAll('.activity-time').forEach((el,i)=>{if(state.activities[i])el.textContent=relativeTime(state.activities[i].time);});
},10000);

render();
if(!DEMO)await syncCloud();
try{
 const {OfficeScene}=await import('./scene.js');
 scene=new OfficeScene($('#canvas-container'),$('#agent-labels'),showDetail,value=>$('#zoom-value').textContent=value+'%');
 scene.updateAgents(state.agents);scene.setNight(state.night);scene.setPaused(state.paused);$('#scene-loading').hidden=true;
}catch(error){
 console.error('Office scene could not start:',error);
 $('#scene-loading').innerHTML=`<div class="scene-error">${icon('office')}<p>当前设备暂时无法打开 3D 空间。</p><button class="button secondary" id="fallback-list">打开成员列表 ${icon('arrow')}</button></div>`;
 $('#fallback-list').onclick=()=>switchList(true);
}

// Agent data is shared through the authenticated MCP service; ?demo=1 stays local.
if(!DEMO)setInterval(()=>{if(!document.hidden)syncCloud();},4000);
$('#connect-btn').onclick=()=>openDialog('connect-dialog');
$('#connect-code').textContent='mcp_servers:\n  agent_office:\n    url: "'+MCP_URL+'"\n    headers:\n      OAI-Sites-Authorization: "Bearer ${AGENT_OFFICE_TOKEN}"\n';
$('#copy-config').onclick=async()=>{try{await navigator.clipboard.writeText($('#connect-code').textContent);toast('Hermes 配置已复制');}catch{toast('请手动选中并复制配置');}};
if(!DEMO){$('.overview-title>span:last-child').firstChild.textContent='团队成员 ';$('#task-dialog .form-note').textContent='任务保存到云端，等待 Hermes 领取和执行。';$('#recruit-dialog .form-note').textContent='添加成员档案后，使用相同的 Agent ID 连接并上报状态。';$('.help-note').textContent='这是实时办公室。Hermes 通过 MCP 上报实际状态，页面每 4 秒同步一次。演示模式可以从顶部进入。';}
document.addEventListener('click',event=>{if(DEMO)return;const mutating=event.target.closest('#recruit-btn,.new-task-trigger,[data-task-action],#detail-rest,#detail-assign,#recruit-form button[type=submit],#task-form button[type=submit]');if(mutating&&(saving||!cloudReady)){event.preventDefault();event.stopImmediatePropagation();toast(saving?'正在保存，请稍候':'请等待云端连接');}},true);

export {state,completeTask,taskFor,activeTaskFor};
