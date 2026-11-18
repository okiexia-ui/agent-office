// Stable desk IDs are shared by the scene, browser and Worker.
// Sixteen desks form four face-to-face pods of four. Rows run from the front of the
// room (nearest the default camera) to the back, so the first seats filled are the
// ones you see best. `dir` is the side the chair is on: 1 = +z (front), -1 = -z (back).
const POD_X = [-7.4, -1.6];
const POD_Z = [2.85, -2.75];

export const DESKS = Array.from({length: 16}, (_, index) => {
  const row = Math.floor(index / 4),
    col = index % 4,
    dir = row % 2 === 0 ? 1 : -1;
  return {
    id: `desk-${String(index + 1).padStart(2, '0')}`,
    label: `${String(index + 1).padStart(2, '0')} 号工位`,
    x: POD_X[col >> 1] + (col % 2 ? 1.12 : -1.12),
    z: POD_Z[row >> 1] + 0.52 * dir,
    dir
  };
});

// Where the person at a desk sits, and which way they face (toward the monitor).
export function seatOf(desk) {
  return {x: desk.x + 0.1 * desk.dir, z: desk.z + 0.84 * desk.dir, yaw: desk.dir > 0 ? Math.PI : 0};
}

export function assignSeats(agents) {
  const used = new Set();
  const result = agents.map(agent => {
    const seatId = DESKS.some(desk => desk.id === agent.seatId) && !used.has(agent.seatId) ? agent.seatId : null;
    if (seatId) used.add(seatId);
    return {...agent, seatId};
  });
  for (const agent of result) {
    if (!agent.seatId) {
      agent.seatId = DESKS.find(desk => !used.has(desk.id))?.id ?? null;
      if (agent.seatId) used.add(agent.seatId);
    }
  }
  return result;
}
