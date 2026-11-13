import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorker,callTool} from '../worker/index.js';

class MemoryBucket {
  value=null; etag=null; generation=0;
  async get(){if(this.value===null)return null;const value=this.value,etag=this.etag;return {etag,json:async()=>JSON.parse(value)};}
  async put(key,value,options){await Promise.resolve();const c=options.onlyIf;if(c.etagMatches&&c.etagMatches!==this.etag)return null;if(c.etagDoesNotMatch==='*'&&this.value!==null)return null;this.value=value;this.etag=String(++this.generation);return {etag:this.etag};}
}
const origin='https://office.test';
const environment=()=>({BUCKET:new MemoryBucket()});
const worker=createWorker();
const request=(path,body,method=body?'POST':'GET',headers={})=>new Request(origin+path,{method,headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
const send=(env,requestId,agentId='hermes',content='请说说现在的进展')=>worker.fetch(request('/api/chat',{agentId,requestId,content}),env);
const state=env=>callTool('office_get_state',{},env);
const history=(env,agent_id='hermes',pending_only=false)=>callTool('office_get_messages',{agent_id,pending_only},env);
const reply=(env,message,request_id='answer')=>callTool('office_reply_message',{agent_id:message.agentId,message_id:message.id,request_id,content:'这是 Agent 实际提交的回复。'},env);

test('Browser message → MCP inbox → Agent reply → browser history is durable',async()=>{
  const env=environment();const sent=await send(env,'question');assert.equal(sent.status,201);const {message}=await sent.json();
  assert.equal(message.role,'user');assert.equal(message.replyId,null);
  const office=await state(env);assert.equal(office.chatPending.hermes,1);assert.equal('messages' in office,false);assert.equal(office.agents[0].lastSeen,null);
  const heartbeat=await callTool('office_heartbeat',{agent_id:'hermes'},env);assert.equal(heartbeat.pending_messages,1);assert.deepEqual(heartbeat.message_ids,[message.id]);
  const inbox=await history(env,'hermes',true);assert.equal(inbox.messages[0].content,'请说说现在的进展');
  const answered=await reply(env,message);assert.equal(answered.message.replyTo,message.id);
  const response=await worker.fetch(request('/api/chat?agentId=hermes'),env);const log=await response.json();assert.equal(log.messages.length,2);assert.equal(log.messages[0].replyId,log.messages[1].id);assert.equal(log.pending_messages,0);
  assert.equal((await history(env,'hermes',true)).messages.length,0);
});

test('Concurrent send retries and reply retries do not duplicate messages',async()=>{
  const env=environment();const responses=await Promise.all([send(env,'same'),send(env,'same')]);const first=await responses[0].json(),second=await responses[1].json();assert.equal(first.message.id,second.message.id);assert.equal((await history(env)).messages.length,1);
  assert.equal((await send(env,'same','hermes','changed')).status,409);
  const result=await reply(env,first.message);const retry=await reply(env,first.message);assert.equal(result.message.id,retry.message.id);assert.equal((await history(env)).messages.length,2);
  await assert.rejects(reply(env,first.message,'another-answer'),/already has a reply/);
});

test('Conversations are isolated and replies must match the addressed Agent',async()=>{
  const env=environment();await callTool('office_register_agent',{agent_id:'codex',model:'Codex'},env);
  const {message}=await (await send(env,'private')).json();assert.equal((await history(env,'codex')).messages.length,0);
  await assert.rejects(callTool('office_reply_message',{agent_id:'codex',message_id:message.id,request_id:'wrong',content:'no'},env),/another Agent/);
  await assert.rejects(history(env,'missing'),/not found/);
  assert.equal((await send(env,'other-question','missing')).status,404);
});

test('Browser state replacement cannot forge, delete, or overwrite chat replies',async()=>{
  const env=environment();const {message}=await (await send(env,'original')).json();const before=await state(env);
  await reply(env,message);const stale=await worker.fetch(request('/api/state',before,'PUT'),env);assert.equal(stale.status,409);
  const current=await state(env);current.messages=[{role:'agent',content:'forged'}];current.agents[0].seatId='desk-16';
  const saved=await worker.fetch(request('/api/state',current,'PUT'),env);assert.equal(saved.status,200);
  const log=await history(env);assert.equal(log.messages.length,2);assert.equal(log.messages[1].content,'这是 Agent 实际提交的回复。');assert.equal((await state(env)).agents[0].seatId,'desk-16');
});

test('Chat and heartbeat updates preserve each other under concurrent writes',async()=>{
  const env=environment();await Promise.all([send(env,'parallel'),callTool('office_heartbeat',{agent_id:'hermes',status:'thinking'},env)]);
  const office=await state(env);assert.equal(office.agents[0].status,'thinking');assert.equal(office.chatPending.hermes,1);assert.equal((await history(env)).messages.length,1);
});

test('Invalid payloads and cross-origin chat writes are rejected',async()=>{
  const env=environment();assert.equal((await send(env,'empty','hermes','  ')).status,400);assert.equal((await send(env,'long','hermes','x'.repeat(2001))).status,400);
  assert.equal((await worker.fetch(request('/api/chat',{agentId:'hermes',requestId:'fake',content:'x',role:'agent'}),env)).status,400);
  assert.equal((await worker.fetch(request('/api/chat',{agentId:'hermes',requestId:'cross',content:'x'},'POST',{Origin:'https://other.test'}),env)).status,403);
  assert.equal((await worker.fetch(request('/api/chat?agentId=bad/path'),env)).status,400);
  await assert.rejects(callTool('office_get_messages',{agent_id:'hermes',pending_only:'false'},env),/boolean/);
  assert.equal((await history(env)).messages.length,0);
});

test('Pending inbox is bounded and accepted requests remain retryable when full',async()=>{
  const env=environment();for(let i=0;i<10;i++)assert.equal((await send(env,'pending_'+i)).status,201);
  assert.equal((await send(env,'overflow')).status,429);assert.equal((await send(env,'pending_0')).status,201);assert.equal((await history(env,'hermes',true)).messages.length,10);
  await reply(env,(await history(env,'hermes',true)).messages[0]);assert.equal((await send(env,'after_reply')).status,201);
});

test('History retention prunes complete pairs while preserving unanswered messages',async()=>{
  const env=environment();const pending=await (await send(env,'keep_pending')).json();
  for(let i=0;i<55;i++){const {message}=await (await send(env,'round_'+i)).json();await reply(env,message,'reply_'+i);}
  const log=await history(env);assert.ok(log.messages.length<=100);assert.equal(log.messages[0].id,pending.message.id);
  for(const m of log.messages){if(m.role==='agent')assert.ok(log.messages.some(parent=>parent.id===m.replyTo));if(m.replyId)assert.ok(log.messages.some(answer=>answer.id===m.replyId));}
});

test('All sixteen Agents receive unique stable seats, and a seventeenth is rejected',async()=>{
  const env=environment();for(let i=1;i<16;i++)await callTool('office_register_agent',{agent_id:'member_'+i},env);
  const before=await state(env);assert.equal(new Set(before.agents.map(a=>a.seatId)).size,16);
  await callTool('office_register_agent',{agent_id:'member_4'},env);assert.deepEqual((await state(env)).agents.map(a=>a.seatId),before.agents.map(a=>a.seatId));
  await assert.rejects(callTool('office_register_agent',{agent_id:'full'},env),/capacity/);
  const duplicate=structuredClone(before);duplicate.agents[1].seatId=duplicate.agents[0].seatId;duplicate.revision=(await state(env)).revision;
  assert.equal((await worker.fetch(request('/api/state',duplicate,'PUT'),env)).status,400);
  const swap=await state(env);[swap.agents[0].seatId,swap.agents[1].seatId]=[swap.agents[1].seatId,swap.agents[0].seatId];assert.equal((await worker.fetch(request('/api/state',swap,'PUT'),env)).status,200);
  const after=await state(env);assert.equal(after.agents[0].seatId,before.agents[1].seatId);assert.equal(after.agents[1].seatId,before.agents[0].seatId);
});
