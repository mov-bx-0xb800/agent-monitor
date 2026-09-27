'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  { spawn } = require('node:child_process');
const wake = require('../src/claude-wake'),
  steering = require('../src/steering'),
  { sessionKey } = require('../src/classify');
async function listener(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-wake-')),
    e = { session_id: crypto.randomUUID(), cwd: root, hook_event_name: 'Stop' },
    sid = sessionKey('claude', e);
  const p = spawn(
    '/bin/bash',
    [path.join(__dirname, '../src/claude-wake.sh'), process.execPath, root],
    { detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  p.stderr.on('data', (c) => (stderr += c));
  p.stdout.resume();
  const closed = new Promise((resolve) =>
    p.on('close', (code, signal) => resolve({ code, signal })),
  );
  t.after(async () => {
    wake.cancelAll(root);
    try {
      process.kill(-p.pid, 'SIGTERM');
    } catch {}
    const timer = setTimeout(() => {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {}
    }, 1000);
    await closed;
    clearTimeout(timer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  p.stdin.end(JSON.stringify(e));
  const deadline = Date.now() + 3000;
  while (!wake.ready(root, sid) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20));
  assert(wake.ready(root, sid), 'native listener advertises readiness');
  return { root, e, sid, p, closed, stderr: () => stderr };
}
test(
  'sleeping Claude hook wakes exactly the selected chat once and exits',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const f = await listener(t),
      lease = wake.ready(f.root, f.sid);
    const first = steering.claimDirect(
      f.root,
      f.sid,
      'security',
      f.e.session_id,
      undefined,
      'claude',
    );
    assert.equal(first.transport, 'wake');
    assert.equal(first.acquired, true);
    assert.equal(
      steering.claimDirect(f.root, f.sid, 'security', f.e.session_id, undefined, 'claude').acquired,
      false,
    );
    assert.equal(
      steering.deliver(f.root, { ...f.e, hook_event_name: 'PostToolUse' }, 'claude'),
      null,
    );
    wake.writeSignal(f.root, f.sid, lease.token, first.id);
    assert.equal((await f.closed).code, 2);
    assert.match(f.stderr(), /Security/);
    assert.equal(steering.read(f.root)[0].status, 'delivered');
    assert.equal(wake.ready(f.root, f.sid), null);
  },
);
test(
  'pause cancels idle listeners without emitting a focus request',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const f = await listener(t);
    fs.writeFileSync(path.join(f.root, 'paused'), '');
    wake.cancelAll(f.root);
    assert.equal((await f.closed).code, 0);
    assert.equal(f.stderr(), '');
    assert.equal(wake.ready(f.root, f.sid), null);
  },
);
test(
  'listener rejects wrong tokens and unrelated request IDs',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const f = await listener(t),
      lease = wake.ready(f.root, f.sid);
    assert.throws(
      () => wake.writeSignal(f.root, f.sid, crypto.randomUUID(), crypto.randomUUID()),
      /no longer/,
    );
    wake.writeSignal(f.root, f.sid, lease.token, crypto.randomUUID());
    assert.equal((await f.closed).code, 0);
    assert.equal(f.stderr(), '');
  },
);
test(
  'wake preparation caps listeners and never creates subagent listeners',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-wake-cap-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const event = {
      session_id: crypto.randomUUID(),
      cwd: root,
      hook_event_name: 'Stop',
      stop_hook_active: true,
    };
    assert.equal(wake.prepare(root, { ...event, agent_id: 'child' }, process.pid), null);
    const first = wake.prepare(root, event, process.pid);
    assert(first, 'a completed wake may listen for a later explicit click');
    assert.equal(wake.prepare(root, event, process.pid), null, 'one listener per chat');
    for (let i = 1; i < 12; i++)
      assert(wake.prepare(root, { ...event, session_id: crypto.randomUUID() }, process.pid));
    assert.equal(
      wake.prepare(root, { ...event, session_id: crypto.randomUUID() }, process.pid),
      null,
    );
    assert.equal(fs.readdirSync(path.join(root, 'wake')).length, 24);
  },
);
