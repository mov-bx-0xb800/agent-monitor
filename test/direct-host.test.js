'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { createController } = require('../src/extension'),
  { record } = require('../src/collector'),
  { sessionKey } = require('../src/classify'),
  steering = require('../src/steering'),
  ipc = require('../src/codex-ipc');
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-direct-host-')),
    native = crypto.randomUUID();
  const event = { session_id: native, cwd: root, hook_event_name: 'Stop' };
  record(event, 'codex', root);
  const sid = sessionKey('codex', event),
    messages = [],
    d = () => ({ dispose() {} });
  let receive;
  const original = { endpoint: ipc.endpoint, connect: ipc.connect };
  t.after(() => {
    Object.assign(ipc, original);
    fs.rmSync(root, { recursive: true, force: true });
  });
  ipc.endpoint = () => '/synthetic/socket';
  const vs = {
    version: '1.106.0',
    env: { appName: 'Code' },
    Uri: { file: (p) => p },
    extensions: { getExtension: () => ({ packageJSON: { version: ipc.VERSION } }) },
    commands: { executeCommand: async () => {}, registerCommand: d },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: root } }],
      getConfiguration: () => ({ get: (_k, f) => f }),
      onDidChangeWorkspaceFolders: d,
    },
    window: { registerWebviewViewProvider: d },
  };
  const c = await createController(
    vs,
    { subscriptions: [] },
    { cache: root, codex: path.join(root, 'hooks.json'), claude: path.join(root, 'none') },
  );
  t.after(() => c.dispose());
  c.provider.resolveWebviewView({
    visible: true,
    onDidDispose: d,
    onDidChangeVisibility: d,
    webview: {
      cspSource: 'http://test.invalid',
      asWebviewUri: (p) => p,
      onDidReceiveMessage: (fn) => {
        receive = fn;
        return d();
      },
      postMessage: async (m) => messages.push(m),
    },
  });
  await receive({ action: 'ready' });
  return { root, native, sid, messages, c, vs, receive };
}
test('host routes only selected native chat, strips routing metadata, confirms receipt', async (t) => {
  const f = await fixture(t);
  let starts = 0,
    closed = 0;
  ipc.connect = async () => ({
    owner: async (id) => {
      assert.equal(id, f.native);
      return 'owner';
    },
    start: async (id, owner, text) => {
      assert.equal(id, f.native);
      assert.equal(owner, 'owner');
      assert.match(text, /Security/);
      starts++;
    },
    close: () => closed++,
  });
  assert(!JSON.stringify(f.messages).includes(f.native));
  assert.equal(f.messages.find((m) => m.type === 'data').data.sessions[0].focusDelivery, 'direct');
  await f.receive({ action: 'focus', sid: f.sid, area: 'security' });
  assert.equal(starts, 1);
  assert.equal(closed, 1);
  assert.equal(steering.read(f.root)[0].status, 'accepted');
});
test('post-claim failure records unknown without hook fallback', async (t) => {
  const f = await fixture(t);
  let starts = 0;
  ipc.connect = async () => ({
    owner: async () => 'owner',
    start: async () => {
      starts++;
      throw Error('Disconnected');
    },
    close() {},
  });
  await f.receive({ action: 'focus', sid: f.sid, area: 'security' });
  assert.equal(starts, 1);
  assert.equal(steering.read(f.root)[0].status, 'unknown');
  assert.equal(
    steering.deliver(f.root, { session_id: f.native, hook_event_name: 'Stop' }, 'codex'),
    null,
  );
});
test('deactivation aborts an in-flight connection before submission', async (t) => {
  const f = await fixture(t);
  let signal;
  ipc.connect = async (_file, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(Error('Cancelled')), { once: true }),
    );
  };
  const pending = f.receive({ action: 'focus', sid: f.sid, area: 'security' });
  await new Promise((r) => setImmediate(r));
  f.c.dispose();
  await pending;
  assert(signal.aborted);
  assert.equal(steering.read(f.root).length, 0);
});
test('unsupported idle providers require explicit queue fallback and never imply submission', async (t) => {
  const f = await fixture(t);
  f.vs.extensions.getExtension = () => undefined;
  let offers = 0;
  f.vs.window.showInformationMessage = async () => {
    offers++;
    return undefined;
  };
  for (const agent of ['codex', 'claude', 'cursor']) {
    const e = { session_id: crypto.randomUUID(), cwd: f.root, hook_event_name: 'Stop' };
    record(
      agent === 'cursor'
        ? { ...e, conversation_id: e.session_id, hook_event_name: 'stop', status: 'completed' }
        : e,
      agent,
      f.root,
    );
    const sid = sessionKey(agent, e);
    await f.receive({ action: 'focus', sid, area: 'performance' });
    assert.equal(
      steering.read(f.root).some((r) => r.sid === sid),
      false,
    );
    await f.receive({ action: 'focus', sid, area: 'performance', delivery: 'queue' });
    assert.equal(steering.read(f.root).find((r) => r.sid === sid).status, 'queued');
  }
  assert.equal(offers, 3);
});
