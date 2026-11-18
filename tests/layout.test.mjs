import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DESKS, assignSeats, seatOf} from '../public/layout.js';

test('Old browser saves migrate without losing reserved seats or moving with status', () => {
  const agents = [
    {id: 'old', status: 'working'},
    {id: 'reserved', seatId: 'desk-01', status: 'resting'},
    {id: 'duplicate', seatId: 'desk-01'},
    {id: 'invalid', seatId: 'not-a-seat'}
  ];
  const result = assignSeats(agents);
  assert.equal(result[1].seatId, 'desk-01');
  assert.equal(new Set(result.map(a => a.seatId)).size, 4);
  assert.equal(agents[0].seatId, undefined);
  const changed = result.map(a => ({...a, status: 'resting'})).reverse();
  const remapped = assignSeats(changed);
  for (const agent of result) assert.equal(remapped.find(a => a.id === agent.id).seatId, agent.seatId);
});

test('Every full-capacity desk has a distinct non-overlapping position', () => {
  assert.equal(DESKS.length, 16);
  assert.equal(new Set(DESKS.map(d => d.id)).size, 16);
  // A desk plus its pulled-out chair: 2.14 wide, from the monitor edge (.52) to behind the chair (1.25).
  const footprint = d => ({
    x0: d.x - 1.07,
    x1: d.x + 1.07,
    z0: Math.min(d.z - 0.52 * d.dir, d.z + 1.25 * d.dir),
    z1: Math.max(d.z - 0.52 * d.dir, d.z + 1.25 * d.dir)
  });
  for (const a of DESKS)
    for (const b of DESKS) {
      if (a === b) continue;
      const p = footprint(a),
        q = footprint(b);
      assert.ok(
        p.x1 <= q.x0 + 1e-9 || q.x1 <= p.x0 + 1e-9 || p.z1 <= q.z0 + 1e-9 || q.z1 <= p.z0 + 1e-9,
        `${a.id} overlaps ${b.id}`
      );
    }
  for (const d of DESKS) {
    assert.ok(d.dir === 1 || d.dir === -1);
    const s = seatOf(d);
    assert.ok(s.x > -10.5 && s.x < 1 && Math.abs(s.z) < 5, `${d.id} seat stays inside the work area`);
  }
  const seats = DESKS.map(seatOf);
  for (const a of seats) for (const b of seats) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 1.5);
  const agents = assignSeats(Array.from({length: 16}, (_, i) => ({id: String(i)})));
  assert.equal(new Set(agents.map(a => a.seatId)).size, 16);
  assert.ok(agents.every(a => a.seatId));
});
