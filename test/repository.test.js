'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  sourceFiles,
  sensitiveRules,
  checkFile,
  checkLinks,
  inspectPNG,
} = require('../scripts/check-repository.cjs');
const { png } = require('./fixtures');

test('distribution checks reject private paths and credentials without copying matched values', () => {
  assert(sensitiveRules('/' + 'Users' + '/contributor-name/work').length);
  assert(sensitiveRules('C:' + '\\Users\\' + 'contributor-name\\work').length);
  assert(sensitiveRules('ghp_' + 'a'.repeat(36)).length);
  assert(sensitiveRules(['-----BEGIN', 'PRIVATE KEY-----'].join(' ')).length);
  assert(sensitiveRules('Example customer', ['customer']).length);
  assert.deepEqual(sensitiveRules('/work/example /home/demo C:\\Users\\demo\\work'), []);
  assert.throws(() => checkFile('docs/settings.json', Buffer.from('{}')), /private or generated/);
  assert.throws(() => checkFile('docs/notes.bin', Buffer.from('data')), /unreviewed/);
});

test('source inventory rejects undeclared files and symlinks rather than silently bundling them', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'README.md'), '# Example');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored'), 'dependency');
  assert.deepEqual(sourceFiles(root), ['README.md']);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'local note');
  assert.throws(() => sourceFiles(root), /undeclared/);
  fs.unlinkSync(path.join(root, 'notes.txt'));
  fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'SECURITY.md'));
  assert.throws(() => sourceFiles(root), /symlinks/);
});

test('documentation checks reject broken links and PNG metadata while accepting synthetic screenshots', () => {
  assert.doesNotThrow(() =>
    checkLinks('README.md', '[Guide](docs/README.md)', new Set(['docs/README.md'])),
  );
  assert.throws(() => checkLinks('docs/README.md', '[Missing](missing.md)', new Set()), /broken/);
  assert.doesNotThrow(() => inspectPNG(png(320, 180, 1)));
  const original = png(320, 180, 1),
    chunk = Buffer.alloc(12);
  chunk.write('tEXt', 4);
  const withMetadata = Buffer.concat([original.subarray(0, -12), chunk, original.subarray(-12)]);
  assert.throws(() => inspectPNG(withMetadata), /metadata/);
});

test('archive validation rejects omitted, extra and changed source files', async (t) => {
  const { ZipFile } = require('yazl');
  const { pipeline } = require('node:stream/promises');
  const { verifyArchive } = require('../scripts/check-repository.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'README.md': Buffer.from('# Example'),
    'package.json': Buffer.from(JSON.stringify({ version: '1.0.0', private: true })),
    'package-lock.json': Buffer.from(
      JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' } } }),
    ),
  };
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(root, name), bytes);
  fs.mkdirSync(path.join(root, 'dist'));
  const file = path.join(root, 'dist', 'fixture.zip');
  async function archive(entries) {
    const zip = new ZipFile();
    for (const [name, bytes] of Object.entries(entries))
      zip.addBuffer(bytes, 'agent-monitor-1.0.0/' + name);
    const written = pipeline(zip.outputStream, fs.createWriteStream(file));
    zip.end();
    await written;
  }
  await archive(files);
  assert.equal((await verifyArchive(file, 'source', root, [])).files, 3);
  await archive({ ...files, 'extra.md': Buffer.from('not declared') });
  await assert.rejects(verifyArchive(file, 'source', root, []), /undeclared/);
  await archive({ ...files, 'README.md': Buffer.from('changed') });
  await assert.rejects(verifyArchive(file, 'source', root, []), /differs/);
  const incomplete = { ...files };
  delete incomplete['README.md'];
  await archive(incomplete);
  await assert.rejects(verifyArchive(file, 'source', root, []), /Incomplete/);
});
