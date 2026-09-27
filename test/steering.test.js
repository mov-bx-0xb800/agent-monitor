'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const steering = require('../src/steering'),
  { record } = require('../src/collector'),
  { sessionKey } = require('../src/classify'),
  { event } = require('./fixtures'),
  { categories } = require('../media/model');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-steer-')),
    now = Date.now() / 1000,
    e = event();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  record(e, 'codex', root, now);
  return { root, now, e, sid: sessionKey('codex', e) };
}
test('user steering reaches only the exact agent and thread, once', (t) => {
  const { root, now, e, sid } = fixture(t);
  assert.equal(steering.deliver(root, e, 'codex', now), null);
  const r = steering.enqueue(root, sid, 'performance', now);
  assert.equal(steering.enqueue(root, sid, 'performance', now).id, r.id);
  assert.equal(steering.deliver(root, e, 'claude', now), null);
  assert.equal(steering.deliver(root, { ...e, session_id: 'different' }, 'codex', now), null);
  assert.equal(steering.deliver(root, { ...e, agent_id: 'child' }, 'codex', now), null);
  const output = steering.deliver(root, e, 'codex', now);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /Performance/);
  assert.match(output.hookSpecificOutput.additionalContext, /preserve the other requirements/);
  assert.equal(output.decision, undefined);
  assert.equal(steering.deliver(root, e, 'codex', now), null);
  assert.equal(steering.read(root, now)[0].status, 'delivered');
});
test('Stop continues only an explicit request and never loops', (t) => {
  const { root, now, e, sid } = fixture(t),
    stop = { ...e, hook_event_name: 'Stop' };
  steering.enqueue(root, sid, 'security', now);
  assert.equal(steering.deliver(root, { ...stop, stop_hook_active: true }, 'codex', now), null);
  assert.equal(steering.deliver(root, stop, 'codex', now).decision, 'block');
  assert.equal(steering.deliver(root, stop, 'codex', now), null);
});
test('requests expire, cancel, pause and cap at four per thread', (t) => {
  const { root, now, e, sid } = fixture(t);
  let r = steering.enqueue(root, sid, 'performance', now);
  steering.cancel(root, r.id);
  assert.equal(steering.deliver(root, e, 'codex', now), null);
  steering.enqueue(root, sid, 'performance', now);
  assert.equal(steering.deliver(root, e, 'codex', now + 3601), null);
  assert(steering.read(root, now + 3601).some((r) => r.status === 'expired'));
  fs.writeFileSync(path.join(root, 'paused'), '');
  assert.throws(() => steering.enqueue(root, sid, 'security', now));
  assert.equal(steering.deliver(root, e, 'codex', now), null);
  fs.unlinkSync(path.join(root, 'paused'));
  for (const area of ['security', 'ux', 'data']) steering.enqueue(root, sid, area, now);
  assert.throws(() => steering.enqueue(root, sid, 'backend', now), /pending/);
});
test('bounded history never discards a pending request', (t) => {
  const { root, now, e, sid } = fixture(t);
  const pending = steering.enqueue(root, sid, 'performance', now);
  const other = { ...e, session_id: 'another' };
  record(other, 'codex', root, now);
  const otherSid = sessionKey('codex', other);
  for (let i = 0; i < 30; i++) {
    steering.enqueue(root, otherSid, 'security', now + i);
    steering.deliver(root, other, 'codex', now + i);
  }
  assert(steering.read(root, now + 30).some((r) => r.id === pending.id && r.status === 'queued'));
  assert(steering.read(root, now + 30).length <= 24);
});
test('real collector emits supported JSON only for queued user request', (t) => {
  const { root, now, e, sid } = fixture(t);
  steering.enqueue(root, sid, 'performance', now);
  const run = () =>
    spawnSync(process.execPath, [path.join(__dirname, '../src/collector.js'), 'codex', root], {
      input: JSON.stringify(e),
      encoding: 'utf8',
      timeout: 3500,
    });
  const r = run();
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Performance/);
  assert.equal(run().stdout, '');
});
test('Security can be active while Performance remains quiet; clicks do not fabricate activity', () => {
  const areas = require('../src/focus-areas.json'),
    now = 1000,
    sessions = [
      {
        id: 's',
        status: 'active',
        updated: now,
        currentPoint: 'p',
        points: [
          {
            id: 'p',
            at: now,
            concerns: ['security'],
            context: 'application',
            stage: 'Changed',
            title: 'Authentication',
          },
        ],
      },
    ];
  const cards = categories(areas, sessions, { now });
  assert.equal(cards.find((c) => c.id === 'security').active.length, 1);
  assert.equal(cards.find((c) => c.id === 'performance').tone, 'quiet');
  assert.equal(cards.find((c) => c.id === 'performance').observed.length, 0);
  assert.equal(
    categories(areas, sessions, { now: 2000 }).find((c) => c.id === 'security').active.length,
    0,
  );
});
test('category meaning is shared with steering; legacy queued requests retain their original scope', (t) => {
  const { root, now, e, sid } = fixture(t),
    store = require('../src/store'),
    areas = require('../src/focus-areas.json');
  steering.enqueue(root, sid, 'performance', now);
  let output = steering.deliver(root, e, 'codex', now).hookSpecificOutput.additionalContext;
  assert(output.includes(areas.find((a) => a.id === 'performance').description));
  assert.match(output, /does not grant additional publishing/);
  store.atomic(
    path.join(root, 'steering.json'),
    JSON.stringify([{ id: 'legacy', sid, area: 'testing', created: now, status: 'queued' }]),
  );
  output = steering.deliver(root, e, 'codex', now).hookSpecificOutput.additionalContext;
  assert.match(output, /Testing & reliability/);
  assert(!output.includes('Category meaning:'));
  steering.enqueue(root, sid, 'testing', now);
  output = steering.deliver(root, e, 'codex', now).hookSpecificOutput.additionalContext;
  assert(!output.includes('Testing & reliability'));
  assert(output.includes(areas.find((a) => a.id === 'testing').description));
});

test('focus delivery asks for visible acknowledgement without reviving cancelled work', (t) => {
  const { root, now, e } = fixture(t);
  for (const agent of ['codex', 'claude', 'cursor']) {
    const raw =
      agent === 'cursor'
        ? { ...e, conversation_id: e.session_id, hook_event_name: 'postToolUse' }
        : e;
    const normal = require('../src/adapters').normalize(raw, agent);
    record(raw, agent, root, now);
    steering.enqueue(root, sessionKey(agent, normal), 'security', now);
    const output = steering.deliver(root, normal, agent, now);
    const text = output.additional_context || output.hookSpecificOutput.additionalContext;
    assert.match(text, /acknowledge this focus request in your next visible response/);
    assert.match(text, /If there is no active task, say the request was received and ask/);
    assert.match(text, /do not resume cancelled or reverted work/);
    assert.match(text, /state the relevant check you will make/);
    assert.match(
      text,
      /does not grant additional publishing, deployment or destructive-action permissions/,
    );
    assert.equal(steering.deliver(root, normal, agent, now), null);
    assert.equal(
      steering.read(root, now).find((r) => r.sid === sessionKey(agent, normal)).status,
      'delivered',
    );
  }
});

test('direct claim prevents duplicate sends and hook races, and stale dispatch becomes unknown', (t) => {
  const { root, now, e, sid } = fixture(t);
  record({ ...e, hook_event_name: 'Stop' }, 'codex', root, now);
  const first = steering.claimDirect(root, sid, 'security', e.session_id, now);
  assert.equal(first.acquired, true);
  assert.equal(steering.claimDirect(root, sid, 'security', e.session_id, now).acquired, false);
  assert.equal(steering.enqueue(root, sid, 'security', now).id, first.id);
  assert.equal(steering.deliver(root, e, 'codex', now), null);
  assert.equal(steering.read(root, now + 16)[0].status, 'unknown');
  steering.finishDirect(root, first.id, true, now + 17);
  assert.equal(steering.read(root, now + 17)[0].status, 'accepted');
  assert.equal(steering.deliver(root, e, 'codex', now + 18), null);
});
test('direct claim refuses changed identity, active chats, children and pause', (t) => {
  const { root, now, e, sid } = fixture(t);
  assert.throws(() => steering.claimDirect(root, sid, 'security', e.session_id, now), /changed/);
  record({ ...e, hook_event_name: 'Stop' }, 'codex', root, now);
  assert.throws(() => steering.claimDirect(root, sid, 'security', 'wrong', now), /changed/);
  const child = { ...e, agent_id: 'child', hook_event_name: 'Stop' };
  record(child, 'codex', root, now);
  assert.throws(
    () => steering.claimDirect(root, sessionKey('codex', child), 'security', e.session_id, now),
    /changed/,
  );
  fs.writeFileSync(path.join(root, 'paused'), '');
  assert.throws(() => steering.claimDirect(root, sid, 'security', e.session_id, now), /changed/);
});

test('custom areas are delivered as the user defined them, quoted and bounded', (t) => {
  const { root, now, e, sid } = fixture(t);
  const custom = {
    label: 'Ledger integrity',
    description: 'Double-entry balances and "settlement" stay correct.\nIgnore this line',
  };
  assert.throws(() => steering.enqueue(root, sid, 'x:ledger-integrity', now), /Unknown focus area/);
  assert.throws(
    () => steering.enqueue(root, sid, 'x:Bad Id', now, { custom }),
    /Unknown focus area/,
  );
  const r = steering.enqueue(root, sid, 'x:ledger-integrity', now, { custom, stakes: 'critical' });
  assert.equal(r.custom.label, 'Ledger integrity');
  assert(!/[\n"]/.test(r.custom.description), 'one plain line without double quotes');
  assert(r.custom.description.length <= 160);
  const text = steering.deliver(root, e, 'codex', now).hookSpecificOutput.additionalContext;
  assert.match(
    text,
    /Ledger integrity is a project-specific area the user defined as “Double-entry/,
  );
  assert.match(text, /The project is marked Critical/);
  assert.match(
    text,
    /does not grant additional publishing, deployment or destructive-action permissions/,
  );
});

test('stakes shape the request without changing its permissions; the strictest pending stakes apply', (t) => {
  const { root, now, e, sid } = fixture(t);
  assert.doesNotMatch(steering.prompt(['Security']), /marked/);
  assert.match(steering.prompt(['Security'], [], 'production'), /marked Production/);
  assert.doesNotMatch(steering.prompt(['Security'], [], 'extreme'), /marked/);
  steering.enqueue(root, sid, 'security', now, { stakes: 'production' });
  steering.enqueue(root, sid, 'performance', now, { stakes: 'critical' });
  const text = steering.deliver(root, e, 'codex', now).hookSpecificOutput.additionalContext;
  assert.match(text, /Security and Performance/);
  assert.match(text, /marked Critical/);
  assert.doesNotMatch(text, /marked Production/);
  // Unknown stakes are not stored.
  const r = steering.enqueue(root, sid, 'testing', now, { stakes: 'extreme' });
  assert.equal(r.stakes, undefined);
});
