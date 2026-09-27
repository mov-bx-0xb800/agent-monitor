'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { editSettings, configured, owned, findNode } = require('../src/setup'),
  { locations } = require('../src/paths');
function temp(t) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-setup-'));
  t.after(() => fs.rmSync(r, { recursive: true, force: true }));
  return r;
}
test('setup preserves unrelated settings, is idempotent and disconnects only owned hooks', (t) => {
  const root = temp(t),
    file = path.join(root, 'settings.json'),
    runtime = path.join(root, 'agent-monitor/runtime');
  const before = {
    theme: 'dark',
    hooks: {
      PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo unrelated' }] }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(before));
  editSettings(file, 'claude', process.execPath, runtime, root);
  assert(configured(file));
  const first = fs.readFileSync(file, 'utf8');
  editSettings(file, 'claude', process.execPath, runtime, root);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  let d = JSON.parse(first);
  assert.equal(d.theme, 'dark');
  assert(d.hooks.PostToolUse[0].hooks.some((h) => h.command === 'echo unrelated'));
  editSettings(file, 'claude', '', runtime, root, 'darwin', true);
  d = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(d, before);
  assert(!configured(file));
  assert(fs.existsSync(file + '.agent-monitor-backup'));
});
test('malformed settings fail without overwrite; quoted paths stay literal', (t) => {
  const root = temp(t),
    file = path.join(root, 'bad.json');
  fs.writeFileSync(file, '{ bad');
  assert.throws(() => editSettings(file, 'codex', process.execPath, root, root));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ bad');
  const good = path.join(root, 'good.json');
  editSettings(good, 'codex', "/tmp/o'neil/node", '/tmp/agent-monitor/runtime', root, 'linux');
  const doc = JSON.parse(fs.readFileSync(good));
  assert(doc.hooks.PostToolUse[0].hooks[0].command.includes("'\\''"));
  assert.equal(doc.hooks.SessionEnd[0].hooks[0].timeout, 3);
});
test('Windows hook command has bounded encoded PowerShell arguments and remains removable', (t) => {
  const root = temp(t),
    file = path.join(root, 'windows.json');
  editSettings(
    file,
    'codex',
    'C:\\Node Folder\\node.exe',
    'C:\\Users\\demo\\agent-monitor\\runtime',
    'C:\\Cache',
    'win32',
  );
  const h = JSON.parse(fs.readFileSync(file)).hooks.PostToolUse[0].hooks[0];
  assert(h.command.startsWith('powershell.exe -NoProfile -NonInteractive -EncodedCommand '));
  assert.equal(h.commandWindows, h.command);
  assert(owned(h));
  editSettings(file, 'codex', '', '', '', 'win32', true);
  assert(!configured(file));
});
test('platform locations and Node discovery do not require macOS utilities', async () => {
  assert(locations('linux', '/home/demo', {}).root.endsWith('.local/share/agent-monitor'));
  assert(locations('darwin', '/home/demo', {}).root.includes('Application Support'));
  assert(locations('win32', '/home/demo', { LOCALAPPDATA: '/local' }).root.startsWith('/local'));
  assert.equal(await findNode(process.execPath), process.execPath);
});

test('setup inspection distinguishes incomplete configuration, disabled Claude hooks and malformed settings', (t) => {
  const root = temp(t),
    file = path.join(root, 'settings.json'),
    { inspect } = require('../src/setup');
  assert.equal(inspect(file, 'claude').configured, false);
  editSettings(file, 'claude', process.execPath, path.join(root, 'agent-monitor/runtime'), root);
  assert(inspect(file, 'claude').configured);
  const doc = JSON.parse(fs.readFileSync(file));
  doc.disableAllHooks = true;
  fs.writeFileSync(file, JSON.stringify(doc));
  assert(inspect(file, 'claude').disabled);
  delete doc.hooks.PostToolUse;
  fs.writeFileSync(file, JSON.stringify(doc));
  assert(inspect(file, 'claude').partial);
  assert.equal(inspect(file, 'claude').configured, false);
  fs.writeFileSync(file, '{broken');
  assert(inspect(file, 'claude').issue);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('an installed helper is refreshed to this version; settings and newer helpers are untouched', (t) => {
  const { refreshRuntime } = require('../src/setup');
  const root = temp(t),
    loc = { runtime: path.join(root, 'runtime'), claude: path.join(root, 'settings.json') };
  // Nothing is installed: refreshing never creates a helper on its own.
  assert.equal(refreshRuntime(loc, '0.14.0'), false);
  assert.equal(fs.existsSync(loc.runtime), false);
  fs.mkdirSync(loc.runtime, { recursive: true });
  fs.writeFileSync(path.join(loc.runtime, 'collector.js'), '// an older helper');
  fs.writeFileSync(loc.claude, '{"hooks":{}}');
  assert.equal(refreshRuntime(loc, '0.14.0'), true);
  for (const file of ['collector.js', 'attention.js', 'shell.js', 'lexicon.js', 'taxonomy.json'])
    assert.deepEqual(
      fs.readFileSync(path.join(loc.runtime, file)),
      fs.readFileSync(path.join(__dirname, '../src', file)),
      file,
    );
  assert.equal(fs.readFileSync(loc.claude, 'utf8'), '{"hooks":{}}', 'settings are not edited');
  assert.equal(refreshRuntime(loc, '0.14.0'), false, 'an identical helper is not rewritten');
  // A newer helper installed by another editor is left alone.
  fs.writeFileSync(path.join(loc.runtime, 'version.json'), '{"version":"0.20.0"}');
  fs.writeFileSync(path.join(loc.runtime, 'collector.js'), '// newer helper');
  assert.equal(refreshRuntime(loc, '0.14.0'), false);
  assert.equal(fs.readFileSync(path.join(loc.runtime, 'collector.js'), 'utf8'), '// newer helper');
  // The same version with different content (a local build) is brought in step.
  fs.writeFileSync(path.join(loc.runtime, 'version.json'), '{"version":"0.14.0"}');
  assert.equal(refreshRuntime(loc, '0.14.0'), true);
  assert.equal(refreshRuntime({ cache: root }), false, 'no runtime location, no refresh');
});

test('every module the collector loads is installed with the helper', () => {
  const setup = fs.readFileSync(path.join(__dirname, '../src/setup.js'), 'utf8');
  const files = new Set(
    [...setup.matchAll(/^\s+'([\w.-]+\.(?:js|json|sh))',$/gm)].map((m) => m[1]),
  );
  const pending = ['collector.js', 'claude-wake.js'],
    seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert(files.has(file), `${file} is copied into the runtime`);
    const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
    for (const m of source.matchAll(/require\('\.\/([\w.-]+)'\)/g))
      pending.push(m[1].includes('.') ? m[1] : m[1] + '.js');
  }
});
