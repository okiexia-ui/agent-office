// Places the floating name labels of the 3D office so they never overlap.
//
// Each item has an anchor (x, and y = the label's bottom edge, in pixels), a width and a
// height. Labels nearer the viewer (lower on screen) are placed first. Each one takes the
// closest free spot to its anchor: rows above or below, or a column to either side, always
// inside the free band between `top` and `bottom` (where page controls are not). A label
// with no free spot nearby is hidden rather than drawn on top of another.
const MARGIN = 8,
  GAP = 4,
  ROWS = 3;

// Candidate offsets in label rows (k) and columns (side), nearest first. Stacking reads more
// naturally than sliding sideways, so a column costs a little more than a row; up beats down.
const OFFSETS = [];
for (let k = -ROWS; k <= ROWS; k++) for (const side of [-1, 0, 1]) OFFSETS.push([k, side]);
OFFSETS.sort(
  ([k1, s1], [k2, s2]) => Math.abs(k1) + 1.2 * Math.abs(s1) - (Math.abs(k2) + 1.2 * Math.abs(s2)) || k1 - k2 || s2 - s1
);

export function placeLabels(items, {width, top, bottom}) {
  const placed = [];
  for (const item of [...items].sort((a, b) => b.y - a.y)) {
    const clampX = x => Math.min(Math.max(x, item.width / 2 + MARGIN), width - item.width / 2 - MARGIN);
    const step = item.height + 2,
      column = item.width + GAP,
      baseX = clampX(item.x);
    let spot = null;
    for (const [k, side] of OFFSETS) {
      const x = clampX(baseX + side * column),
        y = item.y + k * step;
      if (y < top || y > bottom) continue;
      const clash = placed.some(o => Math.abs(o.x - x) < (o.width + item.width) / 2 + GAP && Math.abs(o.y - y) < step);
      if (!clash) {
        spot = {x, y};
        break;
      }
    }
    if (spot) {
      Object.assign(item, spot, {hidden: false});
      placed.push(item);
    } else item.hidden = true;
  }
  return items;
}
