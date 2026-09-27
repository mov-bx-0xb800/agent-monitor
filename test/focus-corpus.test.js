'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { evidence } = require('../src/classify'),
  areas = require('../src/focus-areas.json'),
  A = require('../src/attention');
const corpus = require('./focus-corpus');

function observed(c) {
  const e = evidence(
    {
      session_id: 'corpus',
      cwd: '/work/example',
      tool_name: c.tool,
      tool_input: c.input,
      tool_response: c.response,
      hook_event_name: c.kind,
    },
    { stakes: c.stakes },
  );
  const found = new Set();
  for (const s of e.signals.length ? e.signals : [e])
    if (s.stage !== 'Tool failed') for (const a of areas) if (A.matches(a, s)) found.add(a.id);
  return { e, found };
}

test('labelled corpus: stages, checks, expected areas and rejected areas', () => {
  const failures = [];
  let positives = 0,
    missed = 0,
    negatives = 0,
    wrong = 0;
  for (const c of corpus) {
    const { e, found } = observed(c);
    const missing = c.areas.filter((a) => !found.has(a)),
      extra = c.not.filter((a) => found.has(a));
    positives += c.areas.length;
    missed += missing.length;
    negatives += c.not.length;
    wrong += extra.length;
    const marked = e.signals.find((x) => x.sensitive)?.sensitive || null,
      wrongMark = Object.hasOwn(c, 'sensitive') && marked !== c.sensitive;
    if (
      e.stage !== c.stage ||
      (e.check || null) !== c.check ||
      missing.length ||
      extra.length ||
      wrongMark
    )
      failures.push(
        `${c.name}: ${e.stage}/${e.check} want ${c.stage}/${c.check}` +
          (missing.length ? ` missing ${missing}` : '') +
          (extra.length ? ` unexpected ${extra}` : '') +
          (wrongMark ? ` sensitive ${marked} want ${c.sensitive}` : ''),
      );
  }
  assert(corpus.length >= 240, 'the corpus covers many tools, languages and domains');
  assert.deepEqual(failures, []);
  assert.equal(missed, 0, `recall ${positives - missed}/${positives}`);
  assert.equal(wrong, 0, `false areas ${wrong}/${negatives}`);
});

test('every corpus case uses known areas and a supported stage', () => {
  const ids = new Set(areas.map((a) => a.id));
  const stages = new Set([
    'Inspected',
    'Changed',
    'Check run',
    'Check failed',
    'Command run',
    'Tool used',
    'Tool failed',
    'Planned',
  ]);
  for (const c of corpus) {
    for (const id of [...c.areas, ...c.not]) assert(ids.has(id), `${c.name}: ${id}`);
    assert(stages.has(c.stage), c.name);
    assert(!c.areas.some((a) => c.not.includes(a)), `${c.name} contradicts itself`);
  }
  assert.equal(new Set(corpus.map((c) => c.name)).size, corpus.length, 'case names are unique');
});

test('classification stays cheap: a corpus pass costs well under a millisecond per event', () => {
  for (const c of corpus) observed(c);
  const start = process.hrtime.bigint();
  for (let round = 0; round < 5; round++) for (const c of corpus) observed(c);
  const perEvent = Number(process.hrtime.bigint() - start) / 1e6 / (corpus.length * 5);
  assert(perEvent < 1, `${perEvent.toFixed(3)} ms per event`);
});
