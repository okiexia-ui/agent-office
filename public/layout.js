// Stable desk IDs are shared by the scene, browser and Worker.
export const DESKS = Array.from({length:16}, (_, index) => ({
  id: `desk-${String(index + 1).padStart(2, '0')}`,
  label: `${String(index + 1).padStart(2, '0')} 号工位`,
  x: -8.5 + (index % 4) * 3.25,
  z: -4.8 + Math.floor(index / 4) * 3,
}));

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
