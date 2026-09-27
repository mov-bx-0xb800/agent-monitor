'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  { relativeTime } = require('../media/model');
test('relative times stay coarse', () => {
  assert.equal(relativeTime(1000, 1000), 'just now');
  assert.equal(relativeTime(0, 59000), 'just now');
  assert.equal(relativeTime(0, 60000), '1 min ago');
  assert.equal(relativeTime(0, 300000), '5 min ago');
  assert.equal(relativeTime(0, 3600000), '1 hour ago');
  assert.equal(relativeTime(0, 7200000), '2 hours ago');
  assert.equal(relativeTime(0, 172800000), '2 days ago');
});

test('area layouts preserve order and move between groups without duplicates', () => {
  const { visibleCategories, moveArea } = require('../media/model');
  const areas = require('../src/focus-areas.json');
  let layout = moveArea(areas, undefined, undefined, 'performance', 'primary', 'security');
  assert.deepEqual(layout.primary.slice(0, 2), ['performance', 'security']);
  layout = moveArea(areas, undefined, layout, 'performance', 'extra', 'reliability');
  assert(!layout.primary.includes('performance'));
  assert.equal(layout.extra[0], 'performance');
  const cards = visibleCategories(areas, undefined, layout);
  assert.equal(cards.extra[0].id, 'performance');
  assert.equal(new Set([...layout.primary, ...layout.extra]).size, areas.length);
  assert.equal(moveArea(areas, undefined, layout, 'unknown', 'extra'), null);
  assert.equal(moveArea(areas, undefined, layout, 'security', 'unknown'), null);
});
