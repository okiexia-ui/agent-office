import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DESKS,assignSeats} from '../public/layout.js';

test('Old browser saves migrate without losing reserved seats or moving with status',()=>{
  const agents=[{id:'old',status:'working'},{id:'reserved',seatId:'desk-01',status:'resting'},{id:'duplicate',seatId:'desk-01'},{id:'invalid',seatId:'not-a-seat'}];
  const result=assignSeats(agents);assert.equal(result[1].seatId,'desk-01');assert.equal(new Set(result.map(a=>a.seatId)).size,4);assert.equal(agents[0].seatId,undefined);
  const changed=result.map(a=>({...a,status:'resting'})).reverse();const remapped=assignSeats(changed);
  for(const agent of result)assert.equal(remapped.find(a=>a.id===agent.id).seatId,agent.seatId);
});

test('Every full-capacity desk has a distinct non-overlapping position',()=>{
  assert.equal(DESKS.length,16);assert.equal(new Set(DESKS.map(d=>d.id)).size,16);
  for(const a of DESKS)for(const b of DESKS){if(a===b)continue;assert.ok(Math.abs(a.x-b.x)>2.2||Math.abs(a.z-b.z)>2.2);}
  const agents=assignSeats(Array.from({length:16},(_,i)=>({id:String(i)})));assert.equal(new Set(agents.map(a=>a.seatId)).size,16);assert.ok(agents.every(a=>a.seatId));
});
