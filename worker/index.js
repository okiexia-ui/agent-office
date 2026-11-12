// Authentication is enforced by the owner-private Sites gateway, for both browsers
// and MCP/service callers. No API credential is shipped in browser assets.
const STATE_KEY='office/state-v2.json';
const MODELS=['Hermes','ChatGPT','Claude','Codex','Gemini','Kimi','Grok','豆包','DeepSeek'];
const STATUSES=['working','thinking','resting'];
const TASK_STATUSES=['queued','active','paused','done'];
const MAX_BODY=128000;
class Problem extends Error{constructor(message,status=400){super(message);this.status=status;}}
const json=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}});
const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const textField=(description,maxLength=120)=>({type:'string',description,maxLength});
const idField={type:'string',pattern:'^[A-Za-z0-9_-]{1,64}$'};
const agentId={...idField,description:'Stable Agent ID, for example hermes.'};
export const TOOLS=[
 {name:'office_get_state',description:'Read the shared Agent Office, members, tasks and recent activity.',inputSchema:schema(),annotations:{readOnlyHint:true}},
 {name:'office_register_agent',description:'Register or reconnect an Agent in this office. Call once when connecting; reuse a stable agent_id.',inputSchema:schema({agent_id:agentId,name:textField('Display name',24),model:{type:'string',enum:MODELS},role:textField('Agent specialty',80)},['agent_id']),annotations:{readOnlyHint:false,idempotentHint:true}},
 {name:'office_heartbeat',description:'Report actual Agent presence and work status. Send every 30–60 seconds during long work; never report simulated progress.',inputSchema:schema({agent_id:agentId,status:{type:'string',enum:STATUSES},message:textField('Optional activity summary',180)},['agent_id']),annotations:{readOnlyHint:false,idempotentHint:true}},
 {name:'office_list_tasks',description:'Read assigned tasks. Queued tasks need to be claimed before execution.',inputSchema:schema({agent_id:agentId,status:{type:'string',enum:TASK_STATUSES}}),annotations:{readOnlyHint:true}},
 {name:'office_create_task',description:'Create a queued task in the shared office. Use a stable request_id to make retries safe.',inputSchema:schema({request_id:{...idField,description:'Unique idempotency key for this task.'},agent_id:agentId,title:textField('Task title',80),description:textField('Task details',400),priority:{type:'string',enum:['normal','high']}},['request_id','agent_id','title']),annotations:{readOnlyHint:false,idempotentHint:true}},
 {name:'office_claim_task',description:'Claim the next queued task for an Agent, or resume the specified paused task. Returns the existing active task when already claimed.',inputSchema:schema({agent_id:agentId,task_id:idField},['agent_id']),annotations:{readOnlyHint:false,idempotentHint:true}},
 {name:'office_update_task',description:'Update a task with real progress or completion. agent_id must match the assignee. Add a concise result when marking done.',inputSchema:schema({agent_id:agentId,task_id:idField,status:{type:'string',enum:['active','paused','done']},progress:{type:'number',minimum:0,maximum:100},result:textField('Result summary; do not include secrets',2000)},['agent_id','task_id']),annotations:{readOnlyHint:false,idempotentHint:true}}
];
export function seedState(){return {version:1,revision:0,mode:'live',agents:[{id:'hermes',name:'Hermes',model:'Hermes',role:'等待 Hermes 连接',status:'resting',completed:0,lastSeen:null}],tasks:[],activities:[],updatedAt:0};}
function str(value,label,max,required=true){if(value==null&&!required)return '';if(typeof value!=='string'||(required&&!value.trim())||value.length>max)throw new Problem(`${label} must be a string of 1–${max} characters.`);return value.trim();}
function id(value,label='id'){if(typeof value!=='string'||!/^[-_a-zA-Z0-9]{1,64}$/.test(value))throw new Problem(`Invalid ${label}.`);return value;}
function pick(value,options,label){if(!options.includes(value))throw new Problem(`Invalid ${label}.`);return value;}
function activity(s,name,text){s.activities.unshift({name,text,time:Date.now()});s.activities=s.activities.slice(0,40);}
function member(s,agentId){const a=s.agents.find(a=>a.id===agentId);if(!a)throw new Problem('Agent not found. Register the Agent first.',404);return a;}
function task(s,taskId){const t=s.tasks.find(t=>t.id===taskId);if(!t)throw new Problem('Task not found.',404);return t;}
function present(a){a.lastSeen=Date.now();if(a.role==='等待 Hermes 连接')a.role='自主执行与协作伙伴';}
function checkedArgs(name,args){const definition=TOOLS.find(t=>t.name===name);if(!definition)throw new Problem('Unknown tool.',404);if(!args||typeof args!=='object'||Array.isArray(args))throw new Problem('Arguments must be an object.');for(const key of Object.keys(args))if(!(key in definition.inputSchema.properties))throw new Problem(`Unknown argument: ${key}`);for(const key of definition.inputSchema.required)if(!(key in args))throw new Problem(`Missing argument: ${key}`);return args;}
async function snapshot(env){if(!env.BUCKET)throw new Problem('Cloud storage is not configured.',503);const object=await env.BUCKET.get(STATE_KEY);if(!object)return {state:seedState(),etag:null};return {state:await object.json(),etag:object.etag};}
async function commit(env,previous,state){state.revision=previous.state.revision+1;state.updatedAt=Date.now();const result=await env.BUCKET.put(STATE_KEY,JSON.stringify(state),{onlyIf:previous.etag?{etagMatches:previous.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});return !!result;}
async function mutate(env,fn){for(let attempt=0;attempt<5;attempt++){const previous=await snapshot(env);const s=structuredClone(previous.state);const result=fn(s);if(await commit(env,previous,s))return {result,state:s};}throw new Problem('The office changed concurrently. Read the latest state and retry.',409);}
function outputState(s){return {...s,serverTime:Date.now(),presenceTtlSeconds:300};}
export async function callTool(name,args,env){
 const a=checkedArgs(name,args||{});
 if(name==='office_get_state')return outputState((await snapshot(env)).state);
 if(name==='office_list_tasks'){const s=(await snapshot(env)).state;if(a.agent_id)id(a.agent_id,'agent_id');if(a.status)pick(a.status,TASK_STATUSES,'status');return {tasks:s.tasks.filter(t=>(!a.agent_id||t.agentId===a.agent_id)&&(!a.status||t.status===a.status)),revision:s.revision};}
 if(a.agent_id)id(a.agent_id,'agent_id');if(a.task_id)id(a.task_id,'task_id');
 const result=await mutate(env,s=>{
  if(name==='office_register_agent'){
   const existing=s.agents.find(x=>x.id===a.agent_id);if(!existing&&s.agents.length>=16)throw new Problem('Office capacity is 16 members.',409);
   const displayName=str(a.name??existing?.name??a.agent_id,'name',24);const model=pick(a.model??existing?.model??'Hermes',MODELS,'model');const role=str(a.role??(existing?.role==='等待 Hermes 连接'?'自主执行与协作伙伴':existing?.role)??'自主执行与协作伙伴','role',80);
   const agent=existing||{id:a.agent_id,status:'resting',completed:0,lastSeen:null};const firstConnection=!agent.lastSeen;
   Object.assign(agent,{name:displayName,model,role});present(agent);if(!existing)s.agents.push(agent);if(firstConnection)activity(s,agent.name,'已连接到办公室');return {agent};
  }
  if(name==='office_heartbeat'){
   const agent=member(s,a.agent_id);present(agent);if(a.status)agent.status=pick(a.status,STATUSES,'status');if(a.message){const message=str(a.message,'message',180);const last=s.activities[0];if(!last||last.name!==agent.name||last.text!==message||Date.now()-last.time>60000)activity(s,agent.name,message);}return {agent,heartbeat_interval_seconds:45};
  }
  if(name==='office_create_task'){
   const requestId=id(a.request_id,'request_id');const title=str(a.title,'title',80);const agent=member(s,a.agent_id);const previous=s.tasks.find(t=>t.requestId===requestId);
   if(previous){if(previous.agentId!==a.agent_id||previous.title!==title)throw new Problem('request_id already belongs to another task.',409);return {task:previous};}
   if(s.tasks.length>=200)throw new Problem('Task capacity is 200.',409);
   const t={id:'task_'+requestId.slice(0,59),requestId,title,description:str(a.description??'','description',400,false),agentId:agent.id,progress:0,priority:pick(a.priority??'normal',['normal','high'],'priority'),status:'queued',created:Date.now()};if(s.tasks.some(x=>x.id===t.id))throw new Problem('Task ID already exists.',409);s.tasks.push(t);activity(s,agent.name,`收到新任务「${t.title}」`);return {task:t};
  }
  if(name==='office_claim_task'){
   const agent=member(s,a.agent_id);present(agent);const active=s.tasks.find(t=>t.agentId===agent.id&&t.status==='active');if(active&&(!a.task_id||active.id===a.task_id))return {task:active};if(active)throw new Problem('Finish or pause the current active task first.',409);
   const t=a.task_id?task(s,a.task_id):s.tasks.filter(t=>t.agentId===agent.id&&t.status==='queued').sort((x,y)=>(y.priority==='high')-(x.priority==='high')||x.created-y.created)[0];if(!t)return {task:null};if(t.agentId!==agent.id)throw new Problem('Task belongs to another Agent.',403);if(!['queued','paused'].includes(t.status))throw new Problem('Task is not available to claim.',409);t.status='active';t.startedAt=Date.now();agent.status='working';activity(s,agent.name,`开始执行「${t.title}」`);return {task:t};
  }
  if(name==='office_update_task'){
   const agent=member(s,a.agent_id);const t=task(s,a.task_id);if(t.agentId!==agent.id)throw new Problem('Task belongs to another Agent.',403);if(t.status==='done'){if(a.status==='done')return {task:t};throw new Problem('Completed tasks cannot be reopened.',409);}
   const status=a.status?pick(a.status,['active','paused','done'],'status'):t.status;if(a.progress!==undefined&&(typeof a.progress!=='number'||!Number.isFinite(a.progress)||a.progress<0||a.progress>100))throw new Problem('progress must be between 0 and 100.');
   if(status==='active'&&s.tasks.some(x=>x.id!==t.id&&x.agentId===agent.id&&x.status==='active'))throw new Problem('Another task is already active for this Agent.',409);
   if(a.result!==undefined)t.result=str(a.result,'result',2000,false);if(a.progress!==undefined)t.progress=a.progress;t.status=status;present(agent);
   if(status==='done'){t.progress=100;t.completedAt=Date.now();agent.completed=(agent.completed||0)+1;activity(s,agent.name,`完成了「${t.title}」`);}else if(status==='paused')activity(s,agent.name,`暂停了「${t.title}」`);
   agent.status=s.tasks.some(x=>x.agentId===agent.id&&x.status==='active')?'working':'resting';return {task:t};
  }
 });return {...result.result,revision:result.state.revision};
}
export function validateReplacement(input,current){
 if(!input||!Array.isArray(input.agents)||!Array.isArray(input.tasks)||!Array.isArray(input.activities)||input.agents.length>16||input.tasks.length>200||input.activities.length>40)throw new Problem('Invalid office data.');
 const agents=input.agents.map(a=>({id:id(a.id),name:str(a.name,'name',24),model:pick(a.model,MODELS,'model'),role:str(a.role,'role',80),status:pick(a.status,STATUSES,'status'),completed:0,lastSeen:current.agents.find(old=>old.id===a.id)?.lastSeen??null}));
 if(new Set(agents.map(a=>a.id)).size!==agents.length)throw new Problem('Duplicate Agent IDs.');
 const tasks=input.tasks.map(t=>{if(!agents.some(a=>a.id===t.agentId))throw new Problem('Task assignee is missing.');if(typeof t.progress!=='number'||!Number.isFinite(t.progress)||t.progress<0||t.progress>100)throw new Problem('Invalid task progress.');const previous=current.tasks.find(x=>x.id===t.id);const status=pick(previous?t.status:'queued',TASK_STATUSES,'task status');return {...(previous||{}),id:id(t.id),title:str(t.title,'title',80),description:str(t.description??'','description',400,false),agentId:id(t.agentId),progress:status==='done'?100:previous?t.progress:0,priority:pick(t.priority,['normal','high'],'priority'),status,created:previous?.created??Date.now()};});
 if(new Set(tasks.map(t=>t.id)).size!==tasks.length)throw new Problem('Duplicate task IDs.');
 for(const agent of agents){if(tasks.filter(t=>t.agentId===agent.id&&t.status==='active').length>1)throw new Problem('An Agent can have only one active task.');const baseline=current.agents.find(a=>a.id===agent.id)?.completed||0;agent.completed=baseline+tasks.filter(t=>t.agentId===agent.id&&t.status==='done'&&current.tasks.find(x=>x.id===t.id)?.status!=='done').length;}
 const activities=input.activities.slice(0,40).map(e=>({name:str(e.name,'activity name',24),text:str(e.text,'activity',250),time:typeof e.time==='number'&&Number.isFinite(e.time)?Math.min(Date.now(),e.time):Date.now()}));
 return {...current,agents,tasks,activities};
}
async function bodyJson(request){if(!request.headers.get('content-type')?.includes('application/json'))throw new Problem('Use Content-Type: application/json.',415);const reader=request.body?.getReader();if(!reader)throw new Problem('Request body is required.');let size=0,parts=[];for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY){await reader.cancel();throw new Problem('Request is too large.',413);}parts.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Problem('Invalid JSON.');}}
async function mcp(request,env){
 if(request.method==='GET'||request.method==='HEAD')return json({server:'Agent Office',transport:'streamable-http',message:'Use POST for JSON-RPC requests.'},405,{'Allow':'POST'});
 if(request.method!=='POST')return json({error:'Method not allowed.'},405,{'Allow':'POST'});
 let payload;try{payload=await bodyJson(request);}catch(e){return json({jsonrpc:'2.0',id:null,error:{code:-32700,message:e.message}},e.status||400);}
 if(!payload||Array.isArray(payload)||payload.jsonrpc!=='2.0'||typeof payload.method!=='string')return json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid JSON-RPC request.'}},400);
 if(payload.id===undefined){if(payload.method.startsWith('notifications/'))return new Response(null,{status:202});return json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'An id is required.'}},400);}
 const response=result=>json({jsonrpc:'2.0',id:payload.id,result});
 if(payload.method==='server/discover')return response({supportedVersions:['2026-07-28','2025-11-25','2025-06-18','2025-03-26'],capabilities:{tools:{}},serverInfo:{name:'agent-office',version:'2.0.0'}});
 if(payload.method==='initialize')return response({protocolVersion:['2025-11-25','2025-06-18','2025-03-26'].includes(payload.params?.protocolVersion)?payload.params.protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'agent-office',version:'2.0.0'},instructions:'Register with office_register_agent using a stable ID, then read/claim assigned tasks. Send real heartbeats and progress. Do not report simulated completion.'});
 if(payload.method==='ping')return response({});
 if(payload.method==='tools/list')return response({tools:TOOLS});
 if(payload.method==='tools/call'){try{const result=await callTool(payload.params?.name,payload.params?.arguments,env);return response({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false});}catch(e){return response({content:[{type:'text',text:e instanceof Problem?e.message:'Unable to update office storage.'}],isError:true});}}
 return json({jsonrpc:'2.0',id:payload.id,error:{code:-32601,message:'Method not found.'}});
}
export function createWorker(assets={}){return {async fetch(request,env){
 try{
  const url=new URL(request.url);const origin=request.headers.get('origin');
  if(origin&&origin!==url.origin)return json({error:'Cross-origin requests are not allowed.'},403);
  if(url.pathname==='/mcp'||url.pathname==='/api/hermes/mcp')return await mcp(request,env);
  if(url.pathname==='/api/hermes/credentials'){
   // The Sites owner-private access policy and a browser identity are both required.
   // Service tokens have no identity and cannot retrieve this credential.
   if(request.method!=='GET')return json({error:'Method not allowed.'},405);
   if(!request.headers.get('oai-authenticated-user-id'))return json({error:'Sign in as the Site owner to download the connection credential.'},403);
   if(!env.HERMES_SITE_ACCESS_TOKEN)return json({error:'Connection credential is not configured.'},503);
   return new Response('AGENT_OFFICE_TOKEN='+env.HERMES_SITE_ACCESS_TOKEN+'\n',{headers:{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="agent-office.env"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
  }
  if(url.pathname==='/api/health')return json({ok:!!env.BUCKET,version:'2.0.0',mode:'live',storage:env.BUCKET?'configured':'missing'});
  if(url.pathname==='/api/state'){
   if(request.method==='GET')return json(outputState((await snapshot(env)).state));
   if(request.method==='PUT'){
    const input=await bodyJson(request);const previous=await snapshot(env);if(!Number.isInteger(input.revision)||input.revision!==previous.state.revision)throw new Problem('The office has changed. Reload and retry your change.',409);
    const s=validateReplacement(input,previous.state);if(!await commit(env,previous,s))throw new Problem('Another Agent updated the office. Reload and retry.',409);return json(outputState(s));
   }return json({error:'Method not allowed.'},405);
  }
  const asset=assets[url.pathname==='/'?'/index.html':url.pathname];
  if(asset&&['GET','HEAD'].includes(request.method))return new Response(request.method==='HEAD'?null:asset.body,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});
  return json({error:'Not found.'},404);
 }catch(e){return json({error:e instanceof Problem?e.message:'Unable to access office storage.'},e.status||500);}
}};}
