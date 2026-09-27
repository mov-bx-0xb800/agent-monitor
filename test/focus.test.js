'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { evidence } = require('../src/classify'),
  { categories, visibleCategories } = require('../media/model'),
  areas = require('../src/focus-areas.json');
function observed(tool, input, kind = 'PostToolUse') {
  const e = evidence({ cwd: '/demo', tool_name: tool, tool_input: input, hook_event_name: kind });
  const p = { ...e, id: e.key, title: e.subject, at: 1000 },
    s = { id: 'demo', status: 'active', updated: 1000, currentPoint: p.id, points: [p] };
  return categories(areas, [s], { now: 1000 })
    .filter((c) => c.active.length)
    .map((c) => c.id);
}
test('real classifier and cards reject the reviewed false positives', () => {
  const cases = [
    ['src/parser.rs', ['backend'], []],
    ['services/orders/retry.rs', ['backend', 'reliability'], ['testing']],
    ['observability/telemetry.ts', ['delivery'], ['analytics']],
    ['research/literature-review.md', [], ['product', 'docs']],
    ['firmware/interlock/motor_control.c', ['backend'], ['privacy']],
    ['reports/finops-budget.xlsx', ['data'], ['performance']],
    ['product/spec.md', ['product'], ['testing', 'docs']],
    ['docs/getting-started.md', ['docs'], []],
    ['analytics/funnel.ts', ['analytics'], []],
    ['server/auth/session.ts', ['security'], ['performance']],
    ['server/cache/benchmark.go', ['performance'], []],
    ['tests/recovery.spec.ts', ['testing', 'reliability'], []],
    ['src/cart.test.ts', ['testing'], []],
    ['src/test_parser.py', ['testing'], []],
    ['src/parser_test.go', ['testing'], []],
    ['architecture/adr/storage.md', ['architecture'], []],
  ];
  for (const [file, yes, no] of cases) {
    const ids = observed('Read', { file_path: file });
    for (const id of yes) assert(ids.includes(id), `${file} should signal ${id}`);
    for (const id of no) assert(!ids.includes(id), `${file} must not signal ${id}`);
  }
});
test('test execution, static checks and failed tools do not conflate reliability with testing', () => {
  for (const command of ['npm test', 'npm run test:unit', 'pytest', 'cargo test']) {
    const ids = observed('Bash', { command });
    assert(ids.includes('testing'), command);
    assert(!ids.includes('reliability'));
  }
  for (const command of ['rg test src', 'echo test', 'cat lint']) {
    const ids = observed('Bash', { command });
    assert(!ids.includes('testing'));
    assert(!ids.includes('architecture'));
  }
  for (const command of ['npm run bench', 'pnpm benchmark', 'cargo bench']) {
    const ids = observed('Bash', { command });
    assert(ids.includes('performance'), command);
    assert(!ids.includes('security'));
  }
  assert.equal(
    evidence({ tool_name: 'Bash', tool_input: { command: 'echo benchmark' } }).check,
    null,
  );
  // A chained command is read segment by segment: the test run and the read stay separate, so
  // the check is never attributed to the unrelated file and the file is not a test.
  const split = evidence({
    cwd: '/demo',
    tool_name: 'Bash',
    tool_input: { command: 'npm test && cat server/auth/session.ts' },
  });
  const run = split.signals.find((s) => s.check === 'test'),
    read = split.signals.find((s) => s.stage === 'Inspected');
  assert(run && !run.areas.some(([id]) => id === 'security'));
  assert(read && read.check === null && read.detail === 'server/auth/session.ts');
  assert(read.areas.some(([id]) => id === 'security'));
  assert(!read.areas.some(([id]) => id === 'testing'));
  const lint = observed('Bash', { command: 'npm run lint' });
  assert(lint.includes('architecture'));
  assert(!lint.includes('testing'));
  assert(!lint.includes('reliability'));
  assert.deepEqual(
    observed('Read', { file_path: 'server/auth/session.ts' }, 'PostToolUseFailure'),
    [],
  );
});
test('visible areas stay stable when incidental signals or history change; quiet choices remain', () => {
  const all = areas.map((a) => ({ ...a, observed: [{}], active: [{}] }));
  assert.deepEqual(
    visibleCategories(all).primary.map((a) => a.id),
    ['security', 'performance', 'ux', 'backend', 'data', 'testing'],
  );
  assert.deepEqual(
    visibleCategories(all, ['security', 'performance', 'reliability']).primary.map((a) => a.id),
    ['security', 'performance', 'reliability'],
  );
  assert.deepEqual(
    visibleCategories(areas, ['security', 'performance', 'reliability']).primary.map((a) => a.id),
    ['security', 'performance', 'reliability'],
  );
  assert.equal(visibleCategories(all, []).primary.length, 0);
  assert.equal(visibleCategories(all, []).extra.length, 13);
});
