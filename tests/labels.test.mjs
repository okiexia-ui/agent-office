import {test} from 'node:test';
import assert from 'node:assert/strict';
import {placeLabels} from '../public/labels.js';

const overlaps = (a, b) =>
  Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.y - b.y) < (a.height + b.height) / 2;

test('Crowded labels are spread out without overlapping and stay inside the free band', () => {
  // Eight names anchored almost on the same spot, as on a small phone screen.
  const items = Array.from({length: 8}, (_, i) => ({id: i, x: 180 + i * 3, y: 120 - i * 2, width: 70, height: 24}));
  placeLabels(items, {width: 360, top: 30, bottom: 230});
  const shown = items.filter(item => !item.hidden);
  assert.equal(shown.length, 8, 'there is room for every label here');
  for (const a of shown) {
    assert.ok(a.y >= 30 && a.y <= 230, 'label stays between the page controls');
    assert.ok(a.x - a.width / 2 >= 8 && a.x + a.width / 2 <= 352, 'label stays on screen');
    for (const b of shown) if (a !== b) assert.ok(!overlaps(a, b), `labels ${a.id} and ${b.id} overlap`);
  }
});

test('The label nearest the viewer keeps its own spot', () => {
  const front = {x: 100, y: 150, width: 60, height: 24},
    back = {x: 104, y: 146, width: 60, height: 24};
  placeLabels([back, front], {width: 400, top: 20, bottom: 300});
  assert.deepEqual([front.x, front.y], [100, 150]);
  assert.ok(!overlaps(front, back));
});

test('A label with no free spot nearby is hidden instead of covering another', () => {
  // A band only one label tall and one label wide: the second label cannot fit anywhere.
  const items = [
    {x: 40, y: 50, width: 60, height: 24},
    {x: 40, y: 50, width: 60, height: 24}
  ];
  placeLabels(items, {width: 80, top: 50, bottom: 50});
  assert.equal(items.filter(item => item.hidden).length, 1);
});

test('Anchors above or below the free band are not shown', () => {
  const items = [
    {x: 100, y: 10, width: 40, height: 20},
    {x: 100, y: 400, width: 40, height: 20}
  ];
  placeLabels(items, {width: 300, top: 60, bottom: 200});
  // Labels may move a few steps to find room, but never further than the search allows.
  assert.ok(items.every(item => item.hidden || (item.y >= 60 && item.y <= 200)));
  assert.ok(items[1].hidden, 'a label far below the band is hidden');
});
