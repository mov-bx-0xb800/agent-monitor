'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { consolidate, foldViewers } = require('../src/chats');
const areas = require('../src/focus-areas.json'),
  { categories } = require('../media/model');
const now = 10_000;
const chat = (id, extra = {}) => ({
  id,
  agent: 'Codex',
  cwd: '/work/example',
  title: id,
  created: now - 600,
  updated: now - 300,
  lastToolAt: now - 300,
  status: 'waiting',
  points: [],
  routing: { agent: 'codex', sessionId: 's-1', agentId: '' },
  ...extra,
});
const point = (id, detail, at, extra = {}) => ({
  id,
  key: id,
  stage: 'Changed',
  detail,
  at,
  concerns: [],
  ...extra,
});
test('subagents fold into their parent chat and add to its focus', () => {
  const parent = chat('parent', {
    points: [
      point('a'.repeat(16), 'server/auth/session.ts', now - 300, { concerns: ['security'] }),
    ],
  });
  const child = chat('child', {
    isSubagent: true,
    status: 'active',
    updated: now - 5,
    lastToolAt: now - 5,
    routing: { agent: 'codex', sessionId: 's-1', agentId: 'worker-1' },
    points: [point('b'.repeat(16), 'bench/export.bench.ts', now - 5, { check: 'benchmark' })],
    currentPoint: 'b'.repeat(16),
    image: { id: 'img', at: now - 5, phase: 'viewed' },
  });
  const other = chat('other', { routing: { agent: 'codex', sessionId: 's-2', agentId: '' } });
  const { sessions, aliases } = consolidate([parent, child, other]);
  assert.deepEqual(
    sessions.map((s) => s.id),
    ['parent', 'other'],
  );
  assert.equal(aliases.get('child'), 'parent');
  const merged = sessions[0];
  assert.equal(merged.subtasks, 1);
  assert.equal(merged.status, 'active', 'a working subagent keeps its chat active');
  assert.equal(merged.updated, now - 5);
  assert.equal(merged.created, now - 600);
  assert.equal(merged.points.length, 2);
  assert.equal(merged.image.id, 'img');
  const scored = categories(areas, [merged], { now });
  assert(scored.find((a) => a.id === 'security').score > 0, 'parent work still counts');
  assert(scored.find((a) => a.id === 'performance').score > 0, 'subagent work counts');
  assert(scored.find((a) => a.id === 'performance').active.length, 'subagent activity is current');
});
test('a subagent without a retained parent stays visible', () => {
  const orphan = chat('orphan', {
    isSubagent: true,
    routing: { agent: 'codex', sessionId: 'gone', agentId: 'w' },
  });
  const cursorChild = chat('cursor-child', {
    agent: 'Cursor',
    isSubagent: true,
    routing: { agent: 'cursor', sessionId: 's-1', agentId: 'w' },
  });
  const { sessions, aliases } = consolidate([chat('parent'), orphan, cursorChild]);
  assert.deepEqual(sessions.map((s) => s.id).sort(), ['cursor-child', 'orphan', 'parent']);
  assert.equal(aliases.size, 0, 'agents never merge across providers or sessions');
  const legacy = consolidate([{ ...chat('old'), routing: undefined, isSubagent: true }]);
  assert.equal(legacy.sessions.length, 1);
});
test('image viewers move to the parent without duplicates', () => {
  const aliases = new Map([['child', 'parent']]);
  assert.deepEqual(
    foldViewers(
      [
        { sid: 'child', at: 3 },
        { sid: 'parent', at: 2 },
        { sid: 'other', at: 1 },
      ],
      aliases,
    ),
    [
      { sid: 'parent', at: 3 },
      { sid: 'other', at: 1 },
    ],
  );
});
