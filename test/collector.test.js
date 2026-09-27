'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const { record } = require('../src/collector'),
  store = require('../src/store'),
  { evidence } = require('../src/classify'),
  { dimensions, display } = require('../src/images'),
  { png, chunk, event } = require('./fixtures');
function temp(t) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-test-'));
  t.after(() => fs.rmSync(r, { recursive: true, force: true }));
  return r;
}
function first(root) {
  return Object.values(store.state(root).sessions)[0];
}
test('classifies paths and patches without retaining code, outputs or full prompts', (t) => {
  const root = temp(t),
    e = event('apply_patch', {
      patch: '*** Update File: app/api/auth/route.ts\n+secret=do-not-store',
    });
  e.tool_response = 'private-output';
  record(e, 'codex', root, 100);
  const s = first(root);
  assert(s.points[0].concerns.includes('security'));
  assert.equal(s.points[0].context, 'application');
  assert.equal(s.points[0].stage, 'Changed');
  record(
    {
      ...event('Read'),
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Review the account settings flow\nprivate prompt body',
    },
    'codex',
    root,
    110,
  );
  const raw = fs.readFileSync(path.join(root, 'state.json'), 'utf8');
  for (const text of ['do-not-store', 'private-output', 'private prompt body'])
    assert(!raw.includes(text));
  assert.equal(first(root).title, 'Review the account settings flow');
});
test('plans, reads, checks, failed tools and ended turns are distinct', (t) => {
  const root = temp(t);
  record(
    event('update_plan', { plan: [{ step: 'Review security and privacy' }] }),
    'codex',
    root,
    100,
  );
  assert(first(root).planned.includes('security'));
  assert.equal(first(root).currentPoint, null);
  record(event(), 'codex', root, 110);
  assert.equal(first(root).points[0].stage, 'Inspected');
  record(event('Bash', { command: 'npm test -- tests/auth.test.ts' }), 'codex', root, 120);
  assert.equal(first(root).points[0].stage, 'Check run');
  record(
    event('Read', { file_path: 'lib/auth/session.ts' }, 'PostToolUseFailure'),
    'codex',
    root,
    125,
  );
  assert.equal(first(root).points[0].stage, 'Tool failed');
  record(event('Read', {}, 'Stop'), 'codex', root, 130);
  assert.equal(first(root).status, 'waiting');
  assert.equal(first(root).currentPoint, null);
});
test('quoted inline code is not evidence; Windows paths are normalised', () => {
  assert.equal(
    evidence(event('Bash', { command: `python -c 'print("/private/secret.py")'` })).detail,
    'Bash',
  );
  assert(
    evidence({
      ...event('Read', { file_path: 'C:\\work\\components\\button.tsx' }),
      cwd: 'C:\\work',
    }).context === 'experience',
  );
});
test('thread TTL and count limits, pause, missing session and lock contention', (t) => {
  const root = temp(t);
  for (let i = 0; i < 20; i++)
    record(event('Read', undefined, 'PostToolUse', String(i)), 'codex', root, 100 + i);
  assert.equal(Object.keys(store.state(root).sessions).length, 12);
  record(event(), 'codex', root, 100000);
  assert.equal(Object.keys(store.state(root).sessions).length, 1);
  fs.writeFileSync(path.join(root, 'paused'), '');
  assert.equal(record(event(), 'codex', root, 100010), false);
  fs.unlinkSync(path.join(root, 'paused'));
  assert.equal(record({ ...event(), session_id: '' }, 'codex', root), false);
  fs.mkdirSync(path.join(root, '.lock'));
  assert.equal(record(event(), 'codex', root), false);
});
test('viewed image identity links to its thread, clears after a new tool or stopped turn', (t) => {
  const root = temp(t),
    file = path.join(root, 'screen.png');
  fs.writeFileSync(file, png());
  record(event('view_image', { path: file }, 'PreToolUse'), 'codex', root, 100);
  let s = first(root);
  assert.equal(s.image, null);
  assert.equal(store.state(root).images.length, 0);
  const completed = {
    ...event('view_image', { path: file }),
    tool_response: { mimeType: 'image/png', data: png().toString('base64') },
  };
  record(completed, 'codex', root, 101);
  const id = first(root).image.id;
  assert.equal(first(root).image.phase, 'viewed');
  assert.equal(first(root).image.id, id);
  assert.equal(store.state(root).images.length, 1);
  record(event('Read', { file_path: 'server/route.ts' }), 'codex', root, 103);
  assert.equal(first(root).image, null);
  assert.equal(store.state(root).images.length, 1);
  record(completed, 'claude', root, 105);
  assert.equal(store.state(root).images[0].viewers.length, 2);
});
test('real agent image shapes: Claude Code Read results and Codex view_image files', (t) => {
  const root = temp(t),
    file = path.join(root, 'screen.png');
  fs.writeFileSync(file, png(200, 120, 7));
  // Claude Code's Read returns the image as file.base64 with its type.
  const claude = {
    ...event('Read', { file_path: 'docs/diagram.png' }, 'PostToolUse', 'claude-chat'),
    tool_response: {
      type: 'image',
      file: {
        base64: png(320, 180, 4).toString('base64'),
        type: 'image/png',
        originalSize: 4096,
        dimensions: {
          originalWidth: 320,
          originalHeight: 180,
          displayWidth: 320,
          displayHeight: 180,
        },
      },
    },
  };
  assert(record(claude, 'claude', root, 100));
  let images = store.state(root).images;
  assert.equal(images.length, 1);
  assert.deepEqual([images[0].width, images[0].height], [320, 180]);
  // Codex hooks replace image data URLs with a placeholder; the viewed file is used instead.
  const codex = {
    ...event('view_image', { path: file }, 'PostToolUse', 'codex-chat'),
    tool_response: [{ type: 'input_image', image_url: '<image data URL omitted: 2048 bytes>' }],
  };
  assert(record(codex, 'codex', root, 101));
  images = store.state(root).images;
  assert.equal(images.length, 2);
  assert.deepEqual([images[0].width, images[0].height], [200, 120]);
  assert.deepEqual(fs.readFileSync(path.join(root, images[0].file)), png(200, 120, 7));
  const codexChat = Object.values(store.state(root).sessions).find((s) => s.agent === 'Codex');
  assert.equal(codexChat.image.id, images[0].id);
  assert.equal(codexChat.image.phase, 'viewed');
});

test('base64 tool response, image cap, small images and corrupt input', (t) => {
  const root = temp(t);
  for (let i = 0; i < 25; i++) {
    const e = event('mcp__browser__screenshot', {}, 'PostToolUse', String(i));
    e.tool_response = {
      content: [
        { type: 'image', mimeType: 'image/png', data: png(320, 180, i).toString('base64') },
      ],
    };
    record(e, 'claude', root, 100 + i);
  }
  assert.equal(store.state(root).images.length, 20);
  assert.equal(fs.readdirSync(root).filter((f) => store.IMAGE_NAME.test(f)).length, 20);
  // Small images, such as icons the agent looked at, are kept too.
  record(
    {
      ...event('view_image'),
      tool_response: { mimeType: 'image/png', data: png(32, 32).toString('base64') },
    },
    'codex',
    root,
    140,
  );
  assert.equal(store.state(root).images.find((i) => i.id === first(root).image.id).width, 32);
  assert.equal(dimensions(Buffer.from('not a real image')), null);
});
test('animated and very large images are kept and shown as reduced previews', (t) => {
  const root = temp(t),
    b = png();
  const animated = Buffer.concat([
    b.subarray(0, 33),
    chunk('acTL', Buffer.alloc(8)),
    b.subarray(33),
  ]);
  assert.deepEqual(dimensions(animated), { width: 320, height: 180, ext: 'png', animated: true });
  const huge = Buffer.from(b);
  huge.writeUInt32BE(100000, 16);
  const absurd = Buffer.from(b);
  absurd.writeUInt32BE(90000, 16);
  absurd.writeUInt32BE(90000, 20);
  for (const [i, data] of [animated, huge, absurd].entries())
    record(
      {
        ...event('view_image', {}, 'PostToolUse', 'large-' + i),
        tool_response: { mimeType: 'image/png', data: data.toString('base64') },
      },
      'codex',
      root,
      100 + i,
    );
  const images = store.state(root).images;
  assert.equal(images.length, 3);
  const by = (w, h) => images.find((i) => i.width === w && i.height === h);
  assert.equal(by(320, 180).animated, true);
  assert.equal(display(by(320, 180)), 'reduced');
  assert.equal(display(by(100000, 180)), 'reduced');
  assert.equal(display(by(90000, 90000)), 'unavailable', 'kept, but not decoded in the sidebar');
  assert.equal(display({ width: 800, height: 480, bytes: 1000 }), 'direct');
  // Header values beyond any real image are rejected as corrupt.
  const corrupt = Buffer.from(b);
  corrupt.writeUInt32BE(5_000_000, 16);
  assert.equal(dimensions(corrupt), null);
});
test('GIF, BMP, AVIF and animated WebP headers are read without decoding pixels', () => {
  const gif = (frames) => {
    const frame = Buffer.from([0x2c, 0, 0, 0, 0, 2, 0, 3, 0, 0, 2, 1, 0, 0]);
    return Buffer.concat([
      Buffer.from('GIF89a'),
      Buffer.from([2, 0, 3, 0, 0, 0, 0]),
      ...Array.from({ length: frames }, () => frame),
      Buffer.from([0x3b]),
    ]);
  };
  assert.deepEqual(dimensions(gif(1)), { width: 2, height: 3, ext: 'gif', animated: false });
  assert.deepEqual(dimensions(gif(3)), { width: 2, height: 3, ext: 'gif', animated: true });
  const bmp = Buffer.alloc(54);
  bmp.write('BM', 0, 'ascii');
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(640, 18);
  bmp.writeInt32LE(-480, 22);
  assert.deepEqual(dimensions(bmp), { width: 640, height: 480, ext: 'bmp', animated: false });
  const avif = Buffer.alloc(64);
  avif.writeUInt32BE(20, 0);
  avif.write('ftypavif', 4, 'ascii');
  avif.write('ispe', 32, 'ascii');
  avif.writeUInt32BE(1920, 40);
  avif.writeUInt32BE(1080, 44);
  assert.deepEqual(dimensions(avif), { width: 1920, height: 1080, ext: 'avif', animated: false });
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBPVP8X', 8, 'ascii');
  webp[20] = 2;
  webp.writeUIntLE(1279, 24, 3);
  webp.writeUIntLE(719, 27, 3);
  assert.deepEqual(dimensions(webp), { width: 1280, height: 720, ext: 'webp', animated: true });
  for (const name of ['a'.repeat(24) + '.gif', 'b'.repeat(24) + '.bmp', 'c'.repeat(24) + '.avif'])
    assert(store.IMAGE_NAME.test(name));
  assert(
    !store.IMAGE_NAME.test('d'.repeat(24) + '.svg'),
    'vector and script-capable formats stay out',
  );
});
test('real hook subprocess accepts stdin and exits silently; cache traversal cannot remove source', (t) => {
  const root = temp(t);
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, '../src/collector.js'), 'codex', root],
    { input: JSON.stringify(event()), encoding: 'utf8', timeout: 3500 },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert(first(root));
  const keep = path.join(root, 'keep.txt');
  fs.writeFileSync(keep, 'keep');
  store.removeImage(root, { file: '../keep.txt' });
  assert(fs.existsSync(keep));
});

test('malformed activity stays distinct from an empty cache and is not overwritten by collection', (t) => {
  const root = temp(t),
    file = path.join(root, 'state.json');
  assert.equal(store.state(root).issue, null);
  fs.writeFileSync(file, '{broken');
  assert(store.state(root).issue);
  record(event(), 'codex', root);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.writeFileSync(file, 'null');
  assert(store.state(root).issue);
});

test('chat labels use bounded prompt headings, retain first identity and record first observation', (t) => {
  const { taskLabel } = require('../src/collector');
  assert.equal(
    taskLabel('# Interface review and enhancements'),
    'Interface review and enhancements',
  );
  assert.equal(
    taskLabel('```js\nconst hidden = true;\n```\n# Review caching behaviour'),
    'Review caching behaviour',
  );
  assert.equal(
    taskLabel('# AGENTS.md instructions for example\n<environment>\n# Improve sign-in recovery'),
    'Improve sign-in recovery',
  );
  assert(taskLabel('Investigate token=example-value in the test').includes('[redacted]'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-chat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { record } = require('../src/collector'),
    { event } = require('./fixtures');
  const first = {
    ...event(),
    hook_event_name: 'UserPromptSubmit',
    prompt: '# Interface review and enhancements',
  };
  record(first, 'codex', root, 100);
  record({ ...first, prompt: 'Something different later' }, 'codex', root, 110);
  const session = Object.values(
    JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).sessions,
  )[0];
  assert.equal(session.title, 'Interface review and enhancements');
  assert.equal(session.created, 100);
  assert.equal(session.titleSource, 'prompt');
});
