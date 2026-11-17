import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorker,callTool,seedState} from '../worker/index.js';
import {visualBody,markdown,isolatedDocument} from '../public/visual-renderer.js';
class MemoryBucket {
  value=null;etag=null;generation=0;
  async get(){if(!this.value)return null;const value=this.value,etag=this.etag;return {etag,json:async()=>JSON.parse(value)};}
  async put(key,value,options){await Promise.resolve();const c=options?.onlyIf;if(c?.etagMatches&&c.etagMatches!==this.etag)return null;if(c?.etagDoesNotMatch==='*'&&this.value!==null)return null;this.value=value;this.etag=String(++this.generation);return {etag:this.etag};}
}
const environment=()=>({BUCKET:new MemoryBucket()});
const worker=createWorker(),origin='https://office.test';
const request=(path,body,method=body?'POST':'GET',headers={})=>new Request(origin+path,{method,headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
const call=(e,name,args={})=>callTool(name,args,e);
const publish=(e,extra={})=>call(e,'office_publish_visual',{agent_id:'hermes',request_id:'visual_1',title:'真实结果',kind:'chart',content:JSON.stringify({labels:['A','B'],values:[-2,5],unit:'个'}),...extra});
const step=(e,extra={})=>call(e,'office_report_step',{agent_id:'hermes',request_id:'step_1',title:'已读取输入',status:'completed',...extra});

test('Browser message → MCP step and visual → browser result stays linked and persistent',async()=>{
  const e=environment();const sent=await(await worker.fetch(request('/api/chat',{agentId:'hermes',requestId:'question_1',content:'请画出结果。'}),e)).json();
  const m=sent.message.id;
  await step(e,{message_id:m,tool_name:'source_read'});const result=await publish(e,{message_id:m});
  const list=await(await worker.fetch(request('/api/visuals?agentId=hermes&messageId='+m),e)).json();assert.equal(list.visuals.length,1);assert.equal(list.visuals[0].id,result.visual.id);assert.equal(list.visuals[0].content,undefined);assert.equal(list.visuals[0].requestShape,undefined);
  const detail=await(await worker.fetch(request('/api/visuals/'+result.visual.id),e)).json();assert.deepEqual(JSON.parse(detail.visual.content).values,[-2,5]);
  const timeline=await(await worker.fetch(request('/api/steps?agentId=hermes'),e)).json();assert.equal(timeline.steps[0].messageId,m);assert.equal(timeline.steps[0].toolName,'source_read');
  assert.equal((await call(e,'office_get_state')).visuals,undefined);assert.equal((await call(e,'office_get_state')).steps,undefined);
});

test('Concurrent retries deduplicate and conflicting retry content or authors is rejected',async()=>{
  const e=environment();const [a,b]=await Promise.all([publish(e),publish(e)]);assert.equal(a.visual.id,b.visual.id);
  await assert.rejects(publish(e,{title:'变更'}),/different content/);
  await call(e,'office_register_agent',{agent_id:'other'});await assert.rejects(publish(e,{agent_id:'other'}),/different content/);
  const [x,y]=await Promise.all([step(e),step(e)]);assert.equal(x.step.sequence,y.step.sequence);await assert.rejects(step(e,{status:'failed'}),/different content/);
  assert.equal((await call(e,'office_list_visuals')).visuals.length,1);assert.equal((await call(e,'office_get_steps')).steps.length,1);
});

test('Private links and task ownership cannot be forged; public channel links allow collaboration',async()=>{
  const e=environment();await call(e,'office_register_agent',{agent_id:'other'});
  const {message}=await(await worker.fetch(request('/api/chat',{agentId:'other',requestId:'private',content:'Private'}),e)).json();
  await assert.rejects(publish(e,{message_id:message.id}),/another Agent/);await assert.rejects(step(e,{message_id:message.id}),/another Agent/);
  const {task}=await call(e,'office_create_task',{agent_id:'other',request_id:'task_one',title:'Task'});
  await assert.rejects(publish(e,{task_id:task.id}),/another Agent/);
  await assert.rejects(step(e,{message_id:'missing'}),/not found/);
  const channel=await(await worker.fetch(request('/api/channel',{requestId:'group',content:'Shared',mentions:['hermes']}),e)).json();
  assert.ok((await publish(e,{message_id:channel.message.id})).visual.id);
});

test('Visual schemas reject malformed, excessive and non-scalar data before persistence',async()=>{
  const e=environment();
  for(const content of ['null','[]','bad',JSON.stringify({labels:['A'],values:[null]}),JSON.stringify({labels:['A'],values:[1,2]}),JSON.stringify({labels:['A'],values:[1],url:'unexpected'}),' {"labels":["A"],"values":[1e309]}'])await assert.rejects(publish(e,{content}));
  for(const content of [JSON.stringify({columns:['A'],rows:[['one','two']]}),JSON.stringify({columns:['A'],rows:[[{html:'x'}]]}),JSON.stringify({columns:[],rows:[]})])await assert.rejects(publish(e,{kind:'table',content}));
  await assert.rejects(publish(e,{content:'x'.repeat(32001)}));await assert.rejects(step(e,{status:'invented'}));
  assert.equal((await call(e,'office_list_visuals')).visuals.length,0);
  await publish(e,{kind:'table',content:JSON.stringify({columns:['A','B'],rows:[[true,null],['<script>unsafe</script>',2]]})});
});

test('Browser state saves preserve new workspace data and cannot inject results',async()=>{
  const e=environment();await Promise.all([publish(e),step(e),call(e,'office_heartbeat',{agent_id:'hermes'})]);
  const s=await call(e,'office_get_state');s.visuals=[{id:'forged'}];s.steps=[];s.stepSequence=0;s.agents[0].seatId='desk-16';
  const response=await worker.fetch(request('/api/state',s,'PUT'),e);assert.equal(response.status,200);
  assert.equal((await call(e,'office_list_visuals')).visuals[0].title,'真实结果');assert.equal((await call(e,'office_get_steps')).steps.length,1);
  const old=environment();await old.BUCKET.put('state',JSON.stringify(seedState()));assert.deepEqual((await call(old,'office_list_visuals')).visuals,[]);assert.deepEqual((await call(old,'office_get_steps')).steps,[]);
});

test('Retention has monotonic cursors, clear truncation and bounded visual history',async()=>{
  const e=environment();let first;
  for(let i=0;i<42;i++){const v=await publish(e,{request_id:'v_'+i});if(i===0)first=v.visual.id;}
  assert.equal((await call(e,'office_list_visuals')).visuals.length,40);await assert.rejects(call(e,'office_get_visual',{visual_id:first}),/no longer retained/);
  for(let i=0;i<202;i++)await step(e,{request_id:'s_'+i});
  const all=await call(e,'office_get_steps');assert.equal(all.steps.length,200);assert.equal(all.latest_sequence,202);assert.equal(all.history_truncated,true);
  const tail=await call(e,'office_get_steps',{after_sequence:200});assert.equal(tail.steps.length,2);assert.equal(tail.history_truncated,false);
});

test('HTTP workspace reads do not allow browser writes or cross-origin access',async()=>{
  const e=environment();assert.equal((await worker.fetch(request('/api/visuals',{title:'forged'}),e)).status,405);
  assert.equal((await worker.fetch(request('/api/steps?after=NaN'),e)).status,400);
  assert.equal((await worker.fetch(request('/api/visuals',null,'GET',{Origin:'https://elsewhere.test'}),e)).status,403);
  assert.equal((await worker.fetch(request('/api/visuals/bad%2Fpath'),e)).status,400);
  const rpc=await(await worker.fetch(request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'office_publish_visual',arguments:{agent_id:'hermes'}}}),e)).json();assert.equal(rpc.result.isError,true);assert.equal(rpc.result.resultType,'complete');
});

test('Renderers escape data, preserve signed chart values and isolate HTML capabilities',()=>{
  assert.doesNotMatch(markdown('# <img src=x onerror=alert(1)>\n**<script>**'),/<img|<script/);
  assert.doesNotMatch(visualBody({kind:'table',content:JSON.stringify({columns:['<script>'],rows:[['<img>']]})}),/<script|<img/);
  const chart=visualBody({kind:'chart',content:JSON.stringify({labels:['<b>A</b>','B'],values:[-Number.MAX_VALUE,Number.MAX_VALUE]})});assert.doesNotMatch(chart,/NaN|Infinity|<b>/);assert.match(chart,/width:50%/);
  const isolated=isolatedDocument('<script>document.body.dataset.ready="yes"</script>');assert.ok(isolated.indexOf('Content-Security-Policy')<isolated.indexOf('<script>'));assert.match(isolated,/connect-src 'none'/);assert.match(isolated,/form-action 'none'/);
});
