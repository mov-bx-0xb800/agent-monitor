'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { spawnSync, spawn } = require('node:child_process');
const { normalize } = require('../src/adapters'),
  { record } = require('../src/collector'),
  { sessionKey } = require('../src/classify'),
  store = require('../src/store'),
  steering = require('../src/steering'),
  setup = require('../src/setup'),
  { png, event } = require('./fixtures');
const temp = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const cursor = (root, kind = 'postToolUse') => ({
  conversation_id: 'conversation',
  generation_id: 'turn-1',
  cwd: root,
  hook_event_name: kind,
  tool_name: 'Shell',
  tool_input: { command: 'npm test' },
  tool_output: JSON.stringify({ exitCode: 0 }),
  user_email: 'private@example.test',
  model: 'demo-model',
});
test('Cursor events retain conversation identity across turns, separate children, and exclude private metadata', (t) => {
  const root = temp(t),
    a = cursor(root);
  record(a, 'cursor', root, 100);
  record({ ...a, generation_id: 'turn-2' }, 'cursor', root, 110);
  const key = sessionKey('cursor', normalize(a, 'cursor'));
  assert.equal(Object.keys(store.state(root).sessions).length, 1);
  assert.equal(store.state(root).sessions[key].points[0].stage, 'Check run');
  record(
    {
      ...cursor(root, 'subagentStart'),
      subagent_id: 'child',
      parent_conversation_id: 'conversation',
    },
    'cursor',
    root,
    120,
  );
  const child = { ...a, subagent_id: 'child', parent_conversation_id: 'conversation' };
  record(child, 'cursor', root, 121);
  assert.equal(Object.keys(store.state(root).sessions).length, 2);
  record({ ...child, hook_event_name: 'subagentStop' }, 'cursor', root, 122);
  assert.equal(
    store.state(root).sessions[sessionKey('cursor', normalize(child, 'cursor'))].status,
    'waiting',
  );
  assert.equal(store.state(root).sessions[key].status, 'active');
  assert.equal(normalize(cursor(root, 'subagentStop'), 'cursor'), null);
  const raw = fs.readFileSync(path.join(root, 'state.json'), 'utf8');
  assert(!raw.includes('private@example'));
  assert(!raw.includes('demo-model'));
});
test('Codex command-form patches and failed shell results produce accurate signals', (t) => {
  const root = temp(t);
  record(
    {
      ...event('apply_patch', {
        command: '*** Update File: src/auth/permissions.ts\n+private code',
      }),
    },
    'codex',
    root,
    100,
  );
  let session = Object.values(store.state(root).sessions)[0];
  assert.equal(session.points[0].stage, 'Changed');
  assert(session.points[0].concerns.includes('security'));
  record(
    { ...event('Bash', { command: 'npm test' }), tool_response: { exit_code: 1 } },
    'codex',
    root,
    110,
  );
  session = Object.values(store.state(root).sessions)[0];
  // A test run that reports failures is still observed test work, labelled as such.
  assert.equal(session.points[0].stage, 'Check failed');
  assert.equal(session.points[0].check, 'test');
  assert.equal(session.lastToolAt, 110);
  record(
    {
      ...event('Bash', { command: 'cat server/auth/session.ts' }),
      tool_response: { exit_code: 1 },
    },
    'codex',
    root,
    120,
  );
  session = Object.values(store.state(root).sessions)[0];
  assert.equal(session.points[0].stage, 'Tool failed');
  assert.deepEqual(session.points[0].areas, []);
});
test('wrapper tool outputs capture all supported images and reject path-only artifacts and failed tools', (t) => {
  const root = temp(t),
    file = path.join(root, 'not-viewed.png');
  fs.writeFileSync(file, png());
  const e = event('functions.exec', { code: 'private script' });
  e.tool_response = {
    content: [
      { type: 'image', mimeType: 'image/png', data: png(320, 180, 1).toString('base64') },
      {
        type: 'image',
        source: { media_type: 'image/png', data: png(320, 180, 2).toString('base64') },
      },
    ],
  };
  record(e, 'codex', root, 100);
  assert.equal(store.state(root).images.length, 2);
  assert.equal(Object.values(store.state(root).sessions)[0].images.length, 2);
  record({ ...e, tool_response: { path: file } }, 'codex', root, 101);
  assert.equal(Object.values(store.state(root).sessions)[0].image, null);
  assert.equal(store.state(root).images.length, 2);
  record({ ...e, tool_response: { isError: true, ...e.tool_response } }, 'codex', root, 102);
  assert.equal(Object.values(store.state(root).sessions)[0].image, null);
  const raw = fs.readFileSync(path.join(root, 'state.json'), 'utf8');
  assert(!raw.includes('private script'));
});
test('image arrays, JSON-wrapped MCP results and nested image URLs are collected within bounds', (t) => {
  const root = temp(t);
  const e = {
    ...cursor(root),
    tool_name: 'mcp__demo__render',
    tool_output: JSON.stringify({
      content: [
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,' + png().toString('base64') },
        },
        { type: 'image', mimeType: 'image/png', data: png(320, 180, 5).toString('base64') },
      ],
    }),
  };
  record(e, 'cursor', root, 100);
  assert.equal(store.state(root).images.length, 2);
  const content = Array.from({ length: 30 }, (_, i) => ({
    type: 'image',
    mimeType: 'image/png',
    data: png(320, 180, i).toString('base64'),
  }));
  record({ ...event('functions.exec'), tool_response: { content } }, 'codex', root, 101);
  assert.equal(store.state(root).images.length, 20);
});
test('subagent lifecycle does not stop its parent or invent work', (t) => {
  const root = temp(t),
    parent = event(),
    child = { ...parent, agent_id: 'child', agent_type: 'reviewer' };
  record(parent, 'claude', root, 100);
  record({ ...child, hook_event_name: 'SubagentStart' }, 'claude', root, 101);
  assert.equal(store.state(root).sessions[sessionKey('claude', child)].points.length, 0);
  record({ ...child, hook_event_name: 'SubagentStop' }, 'claude', root, 102);
  assert.equal(store.state(root).sessions[sessionKey('claude', child)].status, 'waiting');
  assert.equal(store.state(root).sessions[sessionKey('claude', parent)].status, 'active');
});
test('Cursor setup preserves unrelated hooks and settings and disconnects exactly its own entries', (t) => {
  const root = temp(t),
    file = path.join(root, 'hooks.json'),
    runtime = path.join(root, 'agent-monitor/runtime'),
    before = {
      version: 1,
      custom: 'keep',
      hooks: { postToolUse: [{ command: 'echo keep', matcher: 'Read' }] },
    };
  fs.writeFileSync(file, JSON.stringify(before));
  setup.editSettings(file, 'cursor', process.execPath, runtime, root);
  const first = fs.readFileSync(file, 'utf8');
  setup.editSettings(file, 'cursor', process.execPath, runtime, root);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  assert(setup.configured(file));
  const hooks = JSON.parse(first).hooks;
  assert.equal(hooks.stop[0].loop_limit, 1);
  assert(hooks.subagentStop);
  setup.editSettings(file, 'cursor', '', runtime, root, process.platform, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), before);
});
test('Cursor steering uses its output contract, exact recipient and one-stop limit', (t) => {
  const root = temp(t),
    raw = cursor(root),
    e = normalize(raw, 'cursor'),
    sid = sessionKey('cursor', e),
    now = Date.now() / 1000;
  record(raw, 'cursor', root, now);
  steering.enqueue(root, sid, 'performance', now);
  const output = steering.deliver(root, e, 'cursor', now);
  assert(output.additional_context.includes('Performance'));
  assert.equal(steering.deliver(root, e, 'cursor', now), null);
  steering.enqueue(root, sid, 'security', now);
  assert.equal(
    steering.deliver(root, { ...e, hook_event_name: 'Stop', status: 'aborted' }, 'cursor', now),
    null,
  );
  assert.equal(
    steering.deliver(
      root,
      { ...e, hook_event_name: 'Stop', status: 'completed', stop_hook_active: true },
      'cursor',
      now,
    ),
    null,
  );
  assert(
    steering.deliver(root, { ...e, hook_event_name: 'Stop', status: 'completed' }, 'cursor', now)
      .followup_message,
  );
});
test('real collector reports rejected input and returns Cursor permission while paused', (t) => {
  const root = temp(t),
    cli = path.join(__dirname, '../src/collector.js');
  let result = spawnSync(process.execPath, [cli, 'codex', root], {
    input: '{bad',
    encoding: 'utf8',
    timeout: 3500,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(store.readJSON(path.join(root, 'health-codex.json')).status, 'collector-error');
  fs.writeFileSync(path.join(root, 'paused'), '');
  result = spawnSync(process.execPath, [cli, 'cursor', root], {
    input: JSON.stringify(cursor(root, 'preToolUse')),
    encoding: 'utf8',
    timeout: 3500,
  });
  assert.deepEqual(JSON.parse(result.stdout), { permission: 'allow' });
  assert.equal(fs.existsSync(path.join(root, 'health-cursor.json')), false);
});
test('parallel hook processes retain events through short lock contention', async (t) => {
  const root = temp(t),
    cli = path.join(__dirname, '../src/collector.js');
  const run = (i) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'codex', root], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const deadline = setTimeout(() => {
        child.kill();
        reject(Error('collector timeout'));
      }, 3500);
      child.on('error', reject);
      child.on('exit', (code) => {
        clearTimeout(deadline);
        code === 0 ? resolve() : reject(Error('collector failed'));
      });
      child.stdin.end(
        JSON.stringify({
          ...event('Read', { file_path: 'src/module-' + i + '.ts' }),
          session_id: 'thread-' + i,
        }),
      );
    });
  await Promise.all(Array.from({ length: 8 }, (_, i) => run(i)));
  assert.equal(Object.keys(store.state(root).sessions).length, 8);
  assert.equal(store.readJSON(path.join(root, 'health-codex.json')).status, 'received');
});
