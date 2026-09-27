'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { ZipFile } = require('yazl');
const { checkRepository, verifyArchive } = require('./check-repository.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const version = require('../package.json').version;
  const files = checkRepository(root);
  const name = `agent-monitor-${version}`;
  const file = path.join(root, 'dist', name + '-source.zip');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const zip = new ZipFile();
    // Fixed timestamps and mode avoid carrying machine-specific filesystem metadata.
    for (const source of files)
      zip.addBuffer(fs.readFileSync(path.join(root, source)), name + '/' + source, {
        mtime: new Date('2000-01-01T00:00:00Z'),
        mode: 0o100644,
      });
    const written = pipeline(zip.outputStream, fs.createWriteStream(file));
    zip.end();
    await written;
    const result = await verifyArchive(file, 'source', root);
    console.log(`Verified ${path.basename(file)}: ${result.files} files.`);
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
