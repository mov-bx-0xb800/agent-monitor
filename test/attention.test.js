'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const A = require('../src/attention'),
  areas = require('../src/focus-areas.json');
const { evidence, sessionKey } = require('../src/classify'),
  { record } = require('../src/collector'),
  { consolidate } = require('../src/chats');
const { categories } = require('../media/model'),
  store = require('../src/store');
const { event } = require('./fixtures');
const now = 1_800_000_000,
  HOUR = 3600,
  DAY = 86400;
// Observations exactly as the collector makes them from a real classified event.
function observe(tool = 'Edit', file = 'server/auth/session.ts', at = now, input) {
  const e = evidence({
    ...event(tool, input || { file_path: file }),
    cwd: '/work/example',
  });
  return e.signals.map((p) => A.observation({ ...p, id: p.key }, areas, at));
}
// One observation per minute, as sustained work arrives.
function minutes(n, file = 'server/auth/session.ts', start = now - n * 60, tool = 'Edit') {
  return Array.from({ length: n }, (_, i) => observe(tool, file, start + i * 60));
}
function build(list, at = now) {
  return A.observe(A.state({}, areas, at), list.flat(), at);
}
function score(list, area = 'security', at = now) {
  return A.score(build(list, at), area, at);
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-score-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const first = (root) => Object.values(store.state(root).sessions)[0];

test('score format covers exactly the known areas and rejects malformed or future input', () => {
  assert.deepEqual(
    A.IDS,
    areas.map((a) => a.id),
  );
  const good = observe()[0];
  const st = build([
    good,
    null,
    { ...good, subject: 'bad' },
    { ...good, at: now + 60 },
    { ...good, kind: 'invented' },
    { ...good, at: -5 },
  ]);
  assert.equal(st.version, 3);
  assert.equal(st.open[1], 2, 'only the valid change counts');
  // Stored state is validated before use; malformed entries are dropped.
  const tidy = A.state(
    {
      attention: {
        version: 3,
        work: 4,
        areas: [[0, 1.8, 2, now], [99, 1, 1, now], ['x:Bad', 1, 1, now], [1, -1, 1, now], 'x'],
        open: [Math.floor(now / 60), -1, 0, []],
        subjects: [st.subjects[0], ['zz', now, 1], [st.subjects[0][0], now, 0]],
      },
    },
    areas,
    now,
  );
  assert.deepEqual(
    tidy.areas.map((e) => e[0]),
    [0],
  );
  assert.equal(tidy.open, null);
  assert.equal(tidy.subjects.length, 1);
});

test('evidence builds gradually: one change is small, sustained work is high, nothing jumps to 100', () => {
  const read = score([observe('Read')]).score,
    one = score(minutes(1)).score;
  const levels = [5, 10, 20, 40].map((n) => score(minutes(n)).score);
  assert(read > 0 && read < one && one <= 10, `one read ${read}, one change ${one}`);
  assert.deepEqual(
    levels.slice().sort((a, b) => a - b),
    levels,
    'more sustained work never scores lower',
  );
  assert(levels[0] < 45 && levels[1] < 70 && levels[3] > 90, levels.join(' '));
  assert(score(minutes(400)).score < 100, 'a score estimates focus; it never claims completion');
});

test('time alone never lowers a score: an idle or older chat keeps its focus', () => {
  const st = build(minutes(20));
  const fresh = A.score(st, 'security', now).score;
  for (const later of [HOUR, DAY, 30 * DAY])
    assert.equal(A.score(st, 'security', now + later).score, fresh);
  // The colour shows recency, so it does fade.
  assert(A.score(st, 'security', now + DAY).heat < A.score(st, 'security', now).heat);
});

test('work in other areas lowers a score only slightly and gradually', () => {
  const base = minutes(40, 'server/auth/session.ts', now - 40 * DAY);
  const after = (m) =>
    score([...base, ...minutes(m, 'docs/guide-a.md', now - 39 * DAY)], 'security', now).score;
  const series = [0, 30, 60, 180, 480].map(after);
  for (let i = 1; i < series.length; i++) assert(series[i] <= series[i - 1], series.join(' → '));
  assert(series[0] - series[2] <= 10, `an hour elsewhere costs at most 10 points: ${series}`);
  assert(series[4] >= 70, `a full day elsewhere keeps most of it: ${series}`);
  // The new focus overtakes as it builds.
  assert(
    score([...base, ...minutes(480, 'docs/guide-a.md', now - 39 * DAY)], 'docs').score >= series[4],
  );
});

test('a side topic stays well below the main focus', () => {
  const mix = [
    ...minutes(60, 'src/ui/Button.tsx', now - 2 * HOUR),
    ...minutes(5, 'server/auth/session.ts', now - HOUR),
  ];
  const main = score(mix, 'ux').score,
    side = score(mix, 'security').score;
  assert(main > 90 && side < 40, `main ${main}, side ${side}`);
});

test('work nothing recognises barely dilutes recognised work', () => {
  const focused = minutes(20);
  const unknown = Array.from({ length: 60 }, (_, i) =>
    observe('Bash', null, now - 20 * 60 + i * 20, { command: 'curl -s example.test' }),
  );
  const alone = score(focused).score,
    diluted = score([...focused, ...unknown]).score;
  assert(diluted >= alone * 0.9, `alone ${alone}, with unrecognised commands ${diluted}`);
});

test('clear signals count more than ambiguous names; recognised checks count most', () => {
  const clear = score(minutes(1, 'server/auth/session.ts')).score,
    compound = score(minutes(1, 'src/hooks/useAuth.ts')).score,
    ambiguous = score(minutes(1, 'src/lib/session.ts')).score;
  assert(
    clear > compound && compound > ambiguous && ambiguous > 0,
    `${clear} ${compound} ${ambiguous}`,
  );
  // A chat session is not an authentication session.
  assert.equal(score(minutes(1, 'src/chat/session.ts')).score, 0);
  const check = score([observe('Bash', null, now, { command: 'npm audit' })]).score;
  assert(check > clear, 'a recognised security scan is direct evidence');
});

test('duplicate/retry storms and file volume in a minute cannot inflate focus', () => {
  const one = score([observe()]);
  assert.equal(score(Array.from({ length: 500 }, () => observe())).score, one.score);
  const flood = score(
    Array.from({ length: 500 }, (_, i) => observe('Edit', `server/security/file-${i}.ts`, now)),
  );
  assert.equal(flood.score, one.score);
  assert(flood.breadth <= 8);
});

test('failed checks show attention with their outcome; failed tools earn nothing', () => {
  const failedRun = evidence({
    ...event('Bash', { command: 'npm test' }),
    tool_response: { exit_code: 1 },
  });
  assert.equal(failedRun.stage, 'Check failed');
  const testing = A.score(
    build(failedRun.signals.map((p) => A.observation({ ...p, id: p.key }, areas, now))),
    'testing',
    now,
  );
  assert(testing.score > 0);
  assert.deepEqual(testing.modes, ['check', 'fail']);
  const failedEdit = evidence({
    ...event('Edit', { file_path: 'server/auth/session.ts' }, 'PostToolUseFailure'),
  });
  const st = build(failedEdit.signals.map((p) => A.observation({ ...p, id: p.key }, areas, now)));
  for (const id of A.IDS) assert.equal(A.score(st, id, now).score, 0);
});

test('breadth is subjects, not files in a feature, and all chats never sum agent scores', () => {
  const list = [
    observe('Edit', 'features/security/Login.ts'),
    observe('Edit', 'features/security/Token.ts'),
  ];
  assert.equal(score(list).breadth, 1);
  // A module and its test are one subject.
  assert.equal(
    score([
      observe('Edit', 'server/auth/session.ts'),
      observe('Edit', 'tests/auth/session.test.ts'),
    ]).breadth,
    1,
  );
  const s = { id: 'a', points: [], attention: build(list) };
  const value = categories(areas, [s], { now }).find((c) => c.id === 'security').score;
  assert.equal(
    categories(areas, [s, { ...s, id: 'b' }], { now }).find((c) => c.id === 'security').score,
    value,
  );
});

test('subagent work adds to its parent chat', () => {
  const base = { cwd: '/work/example', updated: now, points: [] };
  const parent = {
    ...base,
    id: 'parent',
    routing: { agent: 'codex', sessionId: 's', agentId: '' },
    attention: build(minutes(5, 'server/auth/a.ts')),
  };
  const child = {
    ...base,
    id: 'child',
    isSubagent: true,
    routing: { agent: 'codex', sessionId: 's', agentId: 'w' },
    attention: build(minutes(5, 'src/security/csrf.ts')),
  };
  const [merged] = consolidate([parent, child]).sessions;
  const together = A.score(A.state(merged, areas, now), 'security', now);
  assert(together.score > A.score(parent.attention, 'security', now).score);
  assert(together.score <= score(minutes(10)).score + 1, 'no more than the same work in one chat');
  assert.equal(together.breadth, 2);
  assert.equal(A.merge([undefined, { version: 9 }]), null);
});

test('earlier formats migrate and keep their progress, however old', () => {
  // Version-1 samples and version-2 minute buckets from a day ago still count.
  const at = now - DAY,
    hashA = 'a'.repeat(16);
  const v1 = {
    version: 1,
    samples: [
      [at, hashA, 'change', 1, 0],
      [at + 60, hashA, 'read', 1, 0],
    ],
  };
  const v1score = A.score(A.state({ attention: v1 }, areas, now), 'security', now);
  assert(v1score.score > 0 && v1score.modes.includes('change'));
  const minute = Math.floor(at / 60);
  const v2 = {
    version: 2,
    minutes: [[minute, 2, 10, [[0, 1.8, 2]]]],
    subjects: [[hashA, at, 1]],
  };
  const v2score = A.score(A.state({ attention: v2 }, areas, now), 'security', now);
  assert.equal(v2score.score, score(minutes(1)).score, 'the same change scores the same');
  assert.equal(v2score.breadth, 1);
});

test('planned work, failures and bare command keywords never earn focus credit', (t) => {
  const root = temporary(t);
  record(
    event('update_plan', { plan: [{ step: 'Security and performance' }] }),
    'codex',
    root,
    now,
  );
  record(
    event('Edit', { file_path: 'server/auth/session.ts' }, 'PostToolUseFailure'),
    'codex',
    root,
    now + 1,
  );
  record(event('Bash', { command: 'echo security performance' }), 'codex', root, now + 2);
  record(event('Bash', { command: 'echo server/auth/session.ts' }), 'codex', root, now + 2);
  record(event('Task', { prompt: 'Review security' }), 'claude', root, now + 3);
  const cards = categories(areas, [first(root)], { now: now + 3 });
  assert(cards.every((c) => c.score === 0));
});

test('real collector keeps read/change/check progress and deduplicates provider call IDs', (t) => {
  const root = temporary(t),
    e = { ...event('Edit'), tool_use_id: 'synthetic-call-one' };
  record(e, 'codex', root, now - 180);
  record(e, 'codex', root, now - 120);
  const a = first(root).attention;
  assert.equal(a.version, 3);
  assert.equal(a.open[1], 2, 'the repeated call counts once');
  record(event('Read'), 'codex', root, now - 60);
  record(event('Bash', { command: 'npm test -- tests/auth.test.ts' }), 'codex', root, now);
  const result = A.score(first(root).attention, 'security', now);
  assert.deepEqual(new Set(result.modes), new Set(['read', 'change', 'check']));
  const before = result.score;
  record(event('Read', {}, 'Stop'), 'codex', root, now + 1);
  assert.equal(A.score(first(root).attention, 'security', now + DAY).score, before);
  assert.equal(first(root).lastActiveAt, now);
  assert(!fs.readFileSync(path.join(root, 'state.json'), 'utf8').includes('synthetic-call-one'));
});

test('collector upgrades older caches: version-1 samples and evidence without confidences', (t) => {
  const root = temporary(t),
    e = event('Read', { file_path: 'README.md' }),
    sid = sessionKey('codex', e);
  const legacyPoint = {
    id: 'c'.repeat(16),
    title: 'Authentication',
    context: 'application',
    concerns: ['security'],
    stage: 'Changed',
    detail: 'server/auth/session.ts',
    tool: 'Edit',
    basis: 'Path signal',
    at: now - 3 * HOUR,
  };
  store.save(root, {
    version: 1,
    images: [],
    sessions: {
      [sid]: {
        id: sid,
        agent: 'Codex',
        cwd: e.cwd,
        updated: now - 60,
        points: [legacyPoint],
        attention: { version: 1, samples: [[now - 3 * HOUR, 'c'.repeat(16), 'change', 1, 0]] },
      },
    },
  });
  assert(record(e, 'codex', root, now));
  const s = store.state(root).sessions[sid];
  assert.equal(s.attention.version, 3);
  assert(A.score(s.attention, 'security', now).score > 0, 'three-hour-old progress is kept');
  const upgraded = s.points.find((p) => p.id === legacyPoint.id);
  assert(upgraded.areas.some(([id]) => id === 'security'));
});

test('multi-file tools classify each target without attaching unrelated concerns to another path', (t) => {
  const root = temporary(t);
  record(
    event('apply_patch', {
      patch:
        '*** Update File: server/auth/session.ts\n+private code\n*** Update File: server/cache/benchmark.ts\n+private code',
    }),
    'codex',
    root,
    now,
  );
  const s = first(root);
  assert.equal(s.points.length, 2);
  const securityPoint = s.points.find((p) => p.concerns.includes('security'));
  assert.equal(securityPoint.detail, 'server/auth/session.ts');
  assert(!securityPoint.concerns.includes('performance'));
  const cards = categories(areas, [s], { now });
  for (const id of ['security', 'performance']) {
    const c = cards.find((c) => c.id === id);
    assert(c.score > 0 && c.active.length === 1);
  }
});

test('progress stays small and bounded alongside full retained chat metadata', (t) => {
  const root = temporary(t);
  for (let chat = 0; chat < 12; chat++) {
    for (let i = 0; i < 75; i++) {
      const at = now - 3000 + i * 40;
      assert(
        record(
          event(
            'Edit',
            { file_path: `server/security/area-${i % 16}.ts` },
            'PostToolUse',
            'chat-' + chat,
          ),
          'codex',
          root,
          at,
        ),
      );
    }
  }
  const sessions = Object.values(store.state(root).sessions);
  assert.equal(sessions.length, 12);
  for (const s of sessions) {
    assert(s.attention.areas.length <= A.IDS.length + 8);
    assert(s.attention.subjects.length <= A.SUBJECTS);
    assert(Buffer.byteLength(JSON.stringify(s.attention)) < 4096);
  }
  assert(fs.statSync(path.join(root, 'state.json')).size < store.LIMITS.metadata);
});

test('an oversized cache is compacted to fit the metadata budget, oldest chats first', (t) => {
  const root = temporary(t);
  const point = {
    id: 'a'.repeat(16),
    title: 'T'.repeat(80),
    context: 'application',
    concerns: Array.from({ length: 16 }, () => 'maintainability'),
    stage: 'Check failed',
    check: 'accessibility',
    areas: A.IDS.slice(0, 6).map((id) => [id, 0.123, 'x'.repeat(48)]),
    sensitive: 'authentication or access control',
    detail: 'd'.repeat(140),
    tool: 't'.repeat(100),
    basis: 'Recognised check',
    at: now,
  };
  const attention = build(minutes(30));
  const session = (id, updated) => ({
    id,
    agent: 'Codex',
    cwd: '/work/' + 'w'.repeat(2000),
    title: 'x'.repeat(90),
    created: now,
    updated,
    points: Array.from({ length: 16 }, () => ({ ...point })),
    attention,
    focusCalls: Array.from({ length: 32 }, () => 'f'.repeat(16)),
    planned: ['security', 'privacy'],
  });
  const data = {
    version: 1,
    sessions: Object.fromEntries(
      Array.from({ length: store.LIMITS.threads }, (_, i) => [
        String(i).padStart(20, '0'),
        session(String(i), now - i),
      ]),
    ),
    images: Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      file: 'f'.repeat(24) + '.png',
      cwd: '/work/' + 'w'.repeat(2000),
      viewers: [],
    })),
  };
  assert(
    Buffer.byteLength(JSON.stringify(data)) > store.LIMITS.metadata,
    'the fixture is oversized',
  );
  store.save(root, data);
  assert(fs.statSync(path.join(root, 'state.json')).size <= store.LIMITS.metadata);
  const saved = store.state(root).sessions;
  assert.equal(saved['0'.padStart(20, '0')].points.length, 16, 'newest chat intact');
  assert(saved[String(11).padStart(20, '0')].points.length < 16, 'oldest shed first');
  for (const s of Object.values(saved))
    assert.equal(
      A.score(s.attention, 'security', now).score,
      A.score(attention, 'security', now).score,
      'progress itself is never shed',
    );
});

test('chat tint fades after tool activity even when a stop event arrives later', () => {
  const s = { lastActiveAt: now, lastToolAt: now, updated: now + 600, status: 'waiting' };
  assert.equal(A.chatHeat(s, now), 1);
  assert.equal(A.chatHeat(s, now + 600), 0.5);
  assert.equal(A.chatHeat(s, now + 3600), 0);
  assert.equal(A.chatHeat({ status: 'idle', updated: now }, now), 0);
});
