'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createVSIX } = require('@vscode/vsce');
const { checkRepository, verifyArchive } = require('./check-repository.cjs');
const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');

async function main() {
  checkRepository(root);
  const file = path.join(root, 'dist', `agent-monitor-${manifest.version}.vsix`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    await createVSIX({
      cwd: root,
      packagePath: file,
      dependencies: false,
      allowMissingRepository: true,
      rewriteRelativeLinks: false,
    });
    const result = await verifyArchive(file, 'vsix', root);
    console.log(`Verified extension archive: ${result.files} files.`);
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
