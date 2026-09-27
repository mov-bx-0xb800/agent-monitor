'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { candidate, captureMany } = require('../src/images');
const { record } = require('../src/collector');
const store = require('../src/store');
const { event, png } = require('./fixtures');

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-privacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const output = () => ({ type: 'image', mimeType: 'image/png', data: png().toString('base64') });

test('image path fields never cause source reads, except the file a Codex view_image showed', (t) => {
  const root = temp(t),
    cwd = path.join(root, 'workspace'),
    file = path.join(root, 'private.png');
  fs.mkdirSync(cwd);
  fs.writeFileSync(file, png());
  fs.symlinkSync(file, path.join(cwd, 'linked.png'));
  const open = t.mock.method(fs, 'openSync', () => {
    throw Error('Unexpected image source open');
  });
  const read = t.mock.method(fs, 'readFileSync', () => {
    throw Error('Unexpected image source read');
  });
  for (const value of [file, '../private.png', 'linked.png']) {
    for (const key of [
      'path',
      'file_path',
      'filename',
      'image_path',
      'referenced_image_paths',
      'image_paths',
    ]) {
      const input = { [key]: key.endsWith('paths') ? [value] : value };
      for (const tool of ['view_image', 'Read', 'mcp__untrusted__screenshot', 'functions.exec']) {
        if (tool === 'view_image' && key === 'path') continue;
        const e = {
          ...event(tool, input),
          cwd,
          tool_response: { content: [{ text: JSON.stringify(input) }] },
        };
        assert.equal(candidate(e), null);
      }
    }
  }
  // Codex's view_image before it ran, or when it failed, opens nothing either.
  for (const e of [
    { ...event('view_image', { path: file }, 'PreToolUse'), cwd },
    { ...event('view_image', { path: file }, 'PostToolUseFailure'), cwd },
    { ...event('view_image', { path: file }), cwd, tool_response: { isError: true } },
  ])
    assert.equal(candidate(e), null);
  assert.equal(open.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
});

test('a Codex view_image file is read only when it is a real, bounded image file', (t) => {
  const root = temp(t),
    cwd = path.join(root, 'workspace'),
    viewed = (target, response = '<image data URL omitted: 900 bytes>') =>
      candidate({ ...event('view_image', { path: target }), cwd, tool_response: response });
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(root, 'shot.png'), png(64, 48, 3));
  // Codex omits the bytes from hooks, so the viewed file is the image, wherever it is.
  assert.deepEqual(viewed(path.join(root, 'shot.png')).data, png(64, 48, 3));
  assert.deepEqual(viewed('../shot.png').data, png(64, 48, 3));
  // Bytes in the response always win over the file.
  const inline = { type: 'image', mimeType: 'image/png', data: png(32, 32, 9).toString('base64') };
  assert.deepEqual(viewed(path.join(root, 'shot.png'), inline).data, png(32, 32, 9));
  // Links, folders, pipes, missing, oversized and non-image names are never read.
  fs.symlinkSync(path.join(root, 'shot.png'), path.join(cwd, 'linked.png'));
  fs.mkdirSync(path.join(cwd, 'folder.png'));
  fs.writeFileSync(path.join(cwd, 'notes.txt'), png());
  const big = path.join(cwd, 'huge.png');
  fs.closeSync(fs.openSync(big, 'w'));
  fs.truncateSync(big, store.LIMITS.imageBytes + 1);
  const cases = ['linked.png', 'folder.png', 'missing.png', 'notes.txt', 'huge.png', '', 'a\0.png'];
  if (process.platform !== 'win32') {
    spawnSync('mkfifo', [path.join(cwd, 'pipe.png')]);
    cases.push('pipe.png');
  }
  const started = Date.now();
  for (const target of cases) assert.equal(viewed(target), null, target);
  assert(Date.now() - started < 1000, 'a pipe never blocks the hook');
  // A file with an image name but other contents is read, then rejected and never cached.
  fs.writeFileSync(path.join(cwd, 'fake.png'), 'not an image at all, just text');
  const e = { ...event('view_image', { path: 'fake.png' }), cwd, tool_response: '' };
  assert.deepEqual(captureMany(root, { images: [] }, e, 's', 100, 'viewed'), []);
  assert.deepEqual(
    fs.readdirSync(root).filter((f) => /^[a-f0-9]{24}\./.test(f)),
    [],
  );
});

test('all image APIs require successful post-tool output and preserve returned bytes', (t) => {
  const root = temp(t),
    response = output();
  for (const kind of ['PreToolUse', 'PostToolUseFailure', 'Stop', undefined]) {
    const e = { ...event(), hook_event_name: kind, tool_response: response };
    assert.equal(candidate(e), null);
    assert.deepEqual(captureMany(root, { images: [] }, e, 's', 100, 'viewed'), []);
  }
  const failed = { ...event(), tool_response: { isError: true, content: [response] } };
  assert.equal(candidate(failed), null);
  assert.equal(candidate({ ...failed, tool_response: JSON.stringify(failed.tool_response) }), null);
  assert.equal(candidate({ ...failed, tool_response: { result: failed.tool_response } }), null);
  const e = { ...event('functions.exec'), tool_response: { content: [response] } };
  assert.deepEqual(candidate(e).data, png());
  for (const agent of ['codex', 'claude']) assert.equal(record(e, agent, root, 100), true);
  assert.equal(
    record(
      {
        conversation_id: 'cursor',
        cwd: e.cwd,
        hook_event_name: 'postToolUse',
        tool_name: e.tool_name,
        tool_output: e.tool_response,
      },
      'cursor',
      root,
      100,
    ),
    true,
  );
  const image = store.state(root).images[0];
  assert.equal(image.source, 'tool-output');
  assert.equal(image.viewers.length, 3);
  assert.deepEqual(fs.readFileSync(path.join(root, image.file)), png());
});

test('paused hooks leave diagnostic files unchanged even on malformed input', (t) => {
  const root = temp(t),
    file = path.join(root, 'health-codex.json');
  const original = JSON.stringify({ at: 1, status: 'received', cwd: '/synthetic/previous' });
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(root, 'paused'), '');
  for (const input of ['{bad', JSON.stringify(event())]) {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, '../src/collector.js'), 'codex', root],
      { input, encoding: 'utf8', timeout: 3500 },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(root).sort(), ['health-codex.json', 'paused']);
  }
});

test('next collection removes legacy image cache copies but preserves source files', (t) => {
  const root = temp(t),
    file = 'a'.repeat(24) + '.png';
  fs.writeFileSync(path.join(root, file), png());
  const orphan = 'b'.repeat(24) + '.png';
  fs.writeFileSync(path.join(root, orphan), png());
  fs.writeFileSync(path.join(root, 'source.png'), png());
  store.save(root, { sessions: {}, images: [{ id: 'legacy', file, cwd: root, viewers: [] }] });
  record(event(), 'codex', root, 100);
  assert.equal(store.state(root).images.length, 0);
  assert.equal(fs.existsSync(path.join(root, file)), false);
  assert.equal(fs.existsSync(path.join(root, orphan)), false);
  assert.equal(fs.existsSync(path.join(root, 'source.png')), true);
});

test('diagnostic failures are retained only within the same workspace and current schema', (t) => {
  const root = temp(t),
    file = path.join(root, 'health-codex.json');
  const failure = { at: 100, status: 'collector-error' };
  const run = () =>
    spawnSync(process.execPath, [path.join(__dirname, '../src/collector.js'), 'codex', root], {
      input: JSON.stringify({ ...event(), cwd: '/work/b' }),
      encoding: 'utf8',
      timeout: 3500,
    });
  for (const old of [
    { cwd: '/work/b', status: 'received', lastFailure: failure },
    { version: 1, cwd: '/work/a', status: 'collector-error', lastFailure: failure },
  ]) {
    fs.writeFileSync(file, JSON.stringify(old));
    assert.equal(run().status, 0);
    const next = store.readJSON(file);
    assert.equal(next.version, 1);
    assert.equal(next.lastFailure, undefined);
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, cwd: '/work/b', status: 'collector-error', lastFailure: failure }),
  );
  assert.equal(run().status, 0);
  assert.deepEqual(store.readJSON(file).lastFailure, failure);
});
