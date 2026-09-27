'use strict';
/* Adversarial and privacy tests for collection. Inputs are synthetic; the goal is that any hook
   payload an agent or a hostile repository could produce is recorded safely or ignored, never
   crashes collection, never escapes the cache folder and never stores private content. */
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const { record } = require('../src/collector'),
  store = require('../src/store'),
  A = require('../src/attention'),
  areas = require('../src/focus-areas.json');
const { clean, evidence, normalise } = require('../src/classify'),
  { match } = require('../src/lexicon'),
  { parse } = require('../src/shell');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function prng(seed) {
  return () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

test('collection survives hostile and malformed payloads without crashing or escaping', (t) => {
  const root = temporary(t),
    cwd = path.join(root, 'workspace'),
    random = prng(20260927);
  fs.mkdirSync(cwd);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const words = [
    'constructor',
    '__proto__',
    'prototype',
    'toString',
    'hasOwnProperty',
    'valueOf',
    '../../../etc/passwd',
    '/etc/shadow',
    'C:\\Windows\\System32\\config',
    '~/.ssh/id_rsa',
    'src/auth/session.ts',
    '"; rm -rf / #',
    '$(touch pwned)',
    '`id`',
    '\u0000\u0007\u001b[31m',
    '\u202etxt.exe',
    'a'.repeat(5000),
    'file:///etc/hosts',
    ['https://user', 'pass@example.test/x'].join(':'),
    'node_modules/x/y.js',
    '',
  ];
  const tools = [
    'Bash',
    'Read',
    'Edit',
    'Write',
    'apply_patch',
    'shell',
    'exec_command',
    'mcp__x__write_file',
    'constructor',
    '__proto__',
    'TodoWrite',
    'Task',
    '',
    'x'.repeat(400),
    null,
    42,
  ];
  const hooks = [
    'PostToolUse',
    'PostToolUseFailure',
    'PreToolUse',
    'UserPromptSubmit',
    'Stop',
    'SessionStart',
    'SubagentStart',
    'constructor',
    '__proto__',
    undefined,
  ];
  const value = (depth = 0) => {
    const r = random();
    if (depth > 2 || r < 0.35) return pick(words);
    if (r < 0.45) return Math.floor(random() * 1e9) - 5e8;
    if (r < 0.5) return null;
    if (r < 0.7) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
    const o = {};
    for (let i = 0; i < 3; i++)
      o[
        pick([
          'file_path',
          'path',
          'command',
          'cmd',
          'patch',
          'edits',
          'paths',
          'todos',
          'plan',
          '__proto__',
          'constructor',
          'workdir',
          'pattern',
        ])
      ] = value(depth + 1);
    return o;
  };
  for (let i = 0; i < 400; i++) {
    const event = {
      session_id: pick(['s1', 's2', 'x'.repeat(300), '', 7, null]),
      cwd: pick([cwd, cwd + '/', '/', 'relative/path', '', null]),
      hook_event_name: pick(hooks),
      tool_name: pick(tools),
      tool_input: value(),
      tool_response: pick([
        { exit_code: 1 },
        { isError: true },
        'output',
        null,
        { content: [{ type: 'text', text: 'x' }] },
        JSON.stringify({ exitCode: 2 }),
      ]),
      tool_use_id: pick(['a', 'b', undefined, 5]),
      agent_id: pick([undefined, 'child', '']),
      prompt: pick(words),
    };
    for (const agent of ['codex', 'claude', 'cursor'])
      assert.doesNotThrow(() => record(event, agent, root, 100000 + i), `event ${i}`);
  }
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.toString.call({}), '[object Object]');
  const raw = fs.readFileSync(path.join(root, 'state.json'), 'utf8');
  assert(Buffer.byteLength(raw) <= store.LIMITS.metadata);
  const data = JSON.parse(raw);
  for (const s of Object.values(data.sessions)) {
    const tidy = A.state(s, areas, 100400);
    assert.deepEqual(tidy.areas, s.attention.areas, 'stored progress is valid');
    for (const p of s.points) {
      assert(typeof p.detail === 'string' && p.detail.length <= 141, 'bounded detail');
      assert(typeof p.title === 'string' && p.title.length <= 80, 'bounded title');
      assert(!/[\x00-\x1f\x7f]/.test(p.detail + p.title + p.tool), 'no control characters');
      assert(Array.isArray(p.areas) && p.areas.length <= 6);
    }
  }
  // Nothing outside the cache folder, and nothing unexpected inside it.
  assert.deepEqual(
    fs.readdirSync(root).filter((f) => !['state.json', 'workspace'].includes(f)),
    [],
  );
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('secrets in prompts, commands, outputs, file contents and URLs are never stored', (t) => {
  const root = temporary(t),
    cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  const canaries = [
    // Credential-shaped canaries are assembled at run time so repository secret scanning
    // keeps treating any such literal in source as a finding.
    ['sk', 'live-CANARY0001abcdefghijklmnop'].join('-'),
    'AK' + 'IAIOSFODNN7CANARY2',
    'gh' + 'p_CANARY0003abcdefghijklmnopqrstuvwxyz',
    'xo' + 'xb-000000000000-CANARY0004abc',
    'eyJhbGciOiJIUzI1NiJ9.eyJDQU5BUlkwMDA1IjoxfQ.CANARY0005signature',
    'hunter2-CANARY0006',
    'CANARY0007-in-file-body',
    'CANARY0008-in-output',
    'CANARY0009-in-prompt-body',
    'CANARY0010-in-mcp-input',
    'CANARY0011pass',
    // A plain word: only the rule that labels keep recognised names can keep it out.
    'canaryzebra',
  ];
  const base = { session_id: 'privacy', cwd };
  const events = [
    {
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: `Deploy with ${canaries[0]} and ${canaries[1]}\nthen ${canaries[8]}`,
    },
    {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: `curl -H "Authorization: Bearer ${canaries[2]}" https://api.example.test/x && export SLACK=${canaries[3]} && npm test -- --token=${canaries[4]}`,
      },
      tool_response: { stdout: canaries[7], exit_code: 0 },
    },
    {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: `mysql -u root -p${canaries[5]} app < migrations/001.sql` },
    },
    {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: path.join(cwd, 'src/config.ts'), content: canaries[6] },
    },
    {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/a.ts', old_string: canaries[6], new_string: canaries[6] },
    },
    {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__db__query',
      tool_input: { sql: `select '${canaries[9]}'`, password: canaries[5] },
    },
    {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: 'git clone https://user' + ':' + canaries[10] + '@example.test/repo.git',
      },
    },
    {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: `pnpm ${canaries[0]}` },
    },
    {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: `pnpm ${canaries[11]} && make ${canaries[11]} && cargo ${canaries[11]}`,
      },
    },
  ];
  for (const e of events)
    for (const agent of ['codex', 'claude']) assert(record(e, agent, root, 1000));
  const stored = fs
    .readdirSync(root)
    .filter((f) => f.endsWith('.json'))
    .map((f) => fs.readFileSync(path.join(root, f), 'utf8'))
    .join('\n');
  for (const canary of canaries) assert(!stored.includes(canary), `${canary} was stored`);
  for (const fragment of ['CANARY', 'canary', 'hunter2', 'Bearer', 'user:'])
    assert(!stored.includes(fragment), `${fragment} was stored`);
});

test('pattern matching scales linearly on adversarial text', () => {
  const makers = [
    (n) => 'a'.repeat(n),
    (n) => 'aA'.repeat(n / 2),
    (n) => 'x/'.repeat(n / 2),
    (n) => 'a1-'.repeat(Math.ceil(n / 3)).slice(0, n),
    (n) => ('_' + 'a1'.repeat(40)).repeat(Math.ceil(n / 81)).slice(0, n),
    (n) => '.'.repeat(n - 7) + 'test.ts',
    (n) => 'rate '.repeat(n / 5),
    (n) => '(('.repeat(n / 2),
    (n) => 'eyJ' + 'a'.repeat(n - 3),
  ];
  const checks = {
    'path match': (s) => match(s, 'path'),
    'tool match': (s) => match(s, 'tool'),
    redaction: (s) => clean(s, 512),
    'command reader': (s) => parse(s),
    'command target': (s) => parse('cat ' + s),
    'path resolution': (s) => normalise(s, '/work'),
  };
  // The best of several warm trials is stable on a busy machine; single wall-clock samples are not.
  const cost = (f, s) => {
    let best = Infinity;
    for (let trial = 0; trial < 5; trial++) {
      const start = process.hrtime.bigint();
      for (let i = 0; i < 10; i++) f(s);
      best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e7);
    }
    return best;
  };
  for (const [name, f] of Object.entries(checks))
    for (const make of makers) {
      const small = cost(f, make(2048)),
        large = cost(f, make(8192)),
        sample = JSON.stringify(make(24));
      assert(large < 250, `${name}: ${large.toFixed(2)} ms for ${sample}…`);
      // Four times the input costs about four times as much when linear, sixteen when quadratic.
      assert(
        large < 1 || large / Math.max(small, 0.05) < 8,
        `${name} grows ${(large / small).toFixed(1)}x for 4x input: ${sample}…`,
      );
    }
});

test('paths outside the workspace are reduced to a file name and never classified by folders', () => {
  for (const [p, cwd] of [
    ['../../etc/passwd', '/work/app'],
    ['/Users/demo/security/secret-plan.md', '/work/app'],
    ['~/.ssh/id_rsa', '/work/app'],
    ['C:/Users/demo/auth/a.ts', 'C:/work/app'],
  ]) {
    const n = normalise(p, cwd);
    assert.equal(n.inside, false, p);
    assert(!n.value.includes('/'), `${p} → ${n.value}`);
  }
  assert.equal(normalise('/work/app', '/work/app'), null, 'the workspace root is not evidence');
  assert.equal(normalise('C:\\work\\app\\src\\a.ts', 'c:\\work\\app').rel, 'src/a.ts');
  const e = evidence({
    cwd: '/work/app',
    tool_name: 'Read',
    tool_input: { file_path: '/Users/demo/security-audit/notes.md' },
  });
  assert(!e.areas.some(([id]) => id === 'security'));
  // The home folder is shown as ~, so a user name does not appear in stored evidence.
  const home = os.homedir();
  const shown = evidence({
    cwd: '/work/app',
    tool_name: 'Read',
    tool_input: { file_path: path.join(home, 'notes', 'plan.md') },
  }).detail;
  assert.equal(shown, '~/notes/plan.md');
});

test('the hook process stays silent and exits cleanly for every adversarial input', (t) => {
  const root = temporary(t);
  const inputs = [
    '',
    'null',
    '[]',
    '"string"',
    '{"__proto__":{"polluted":true},"session_id":"s","cwd":"/w","hook_event_name":"PostToolUse"}',
    '{"session_id":"s","cwd":"/w","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"' +
      'a && '.repeat(5000) +
      'npm test"}}',
    JSON.stringify({
      session_id: 's',
      cwd: '/w',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'lib/constructor.js' },
    }),
    '{"session_id":',
  ];
  for (const input of inputs)
    for (const agent of ['codex', 'claude', 'bogus']) {
      const r = spawnSync(
        process.execPath,
        [path.join(__dirname, '../src/collector.js'), agent, root],
        {
          input,
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      assert.equal(r.status, 0, input.slice(0, 40));
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
    }
  const state = store.state(root);
  assert.equal(state.issue, null);
  assert(
    Object.values(state.sessions).some((s) => s.points?.some((p) => p.title === 'Constructor')),
  );
});
