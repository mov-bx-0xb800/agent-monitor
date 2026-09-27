'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createTitles } = require('../src/titles');
const ID = '0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  OTHER = '0199aaaa-bbbb-4ccc-8ddd-ffffffffffff';
function homes(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-titles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex'),
    claudeHome = path.join(root, 'claude');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(path.join(claudeHome, 'projects', '-work-example'), { recursive: true });
  return { codexHome, claudeHome };
}
test('Codex titles come from its session index; the latest row wins', (t) => {
  const { codexHome, claudeHome } = homes(t);
  fs.writeFileSync(
    path.join(codexHome, 'session_index.jsonl'),
    [
      JSON.stringify({ id: ID, thread_name: 'First name', updated_at: 'x' }),
      '{"id": "broken',
      JSON.stringify({ id: OTHER, thread_name: 'Another chat' }),
      JSON.stringify({ id: ID, thread_name: 'Renamed in Codex token=abc123' }),
    ].join('\n'),
  );
  const title = createTitles({ codexHome, claudeHome });
  assert.equal(
    title({ agent: 'codex', sessionId: ID, agentId: '' }),
    'Renamed in Codex token=[redacted]',
  );
  assert.equal(
    title({ agent: 'codex', sessionId: ID, agentId: 'worker' }),
    '',
    'not for subagents',
  );
  assert.equal(title({ agent: 'codex', sessionId: ID }, { isSubagent: true }), '');
  assert.equal(title({ agent: 'codex', sessionId: '../../etc/passwd' }), '');
  assert.equal(title({ agent: 'cursor', sessionId: ID }), '');
  assert.equal(title(undefined), '');
});
test('Claude Code titles come only from its title records', (t) => {
  const { codexHome, claudeHome } = homes(t);
  let clock = 1000;
  const file = path.join(claudeHome, 'projects', '-work-example', ID + '.jsonl');
  const rows = [
    { type: 'user', sessionId: ID, message: { content: 'please do not show "ai-title" text' } },
    { type: 'ai-title', sessionId: ID, aiTitle: 'Early title' },
    { type: 'assistant', sessionId: ID, message: { content: 'x'.repeat(2000) } },
    { type: 'ai-title', sessionId: OTHER, aiTitle: 'Wrong session' },
    { type: 'ai-title', sessionId: ID, aiTitle: 'Current title' },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const title = createTitles({ codexHome, claudeHome, now: () => clock });
  const routing = { agent: 'claude', sessionId: ID, agentId: '' };
  assert.equal(title(routing), 'Current title');
  fs.appendFileSync(
    file,
    JSON.stringify({ type: 'custom-title', sessionId: ID, customTitle: 'Mine' }) + '\n',
  );
  assert.equal(title(routing), 'Current title', 'rechecked at most every 15 seconds');
  clock += 16;
  assert.equal(title(routing), 'Mine', 'a rename in Claude Code wins');
  assert.equal(title({ agent: 'claude', sessionId: OTHER, agentId: '' }), '', 'no file, no title');
  assert.equal(createTitles({ codexHome: '', claudeHome: '' })(routing), '', 'no home, no read');
});
test('a long Claude Code session still finds its title within bounded reads', (t) => {
  const { codexHome, claudeHome } = homes(t);
  const file = path.join(claudeHome, 'projects', '-work-example', ID + '.jsonl');
  const filler = JSON.stringify({ type: 'assistant', sessionId: ID, text: 'y'.repeat(4000) });
  fs.writeFileSync(
    file,
    [JSON.stringify({ type: 'ai-title', sessionId: ID, aiTitle: 'Named early' })]
      .concat(Array(600).fill(filler))
      .join('\n') + '\n',
  );
  assert(fs.statSync(file).size > 2 * 1024 * 1024);
  assert.equal(
    createTitles({ codexHome, claudeHome })({ agent: 'claude', sessionId: ID, agentId: '' }),
    'Named early',
  );
});
