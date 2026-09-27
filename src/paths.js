'use strict';
const os = require('node:os');
const path = require('node:path');
function locations(platform = process.platform, home = os.homedir(), env = process.env) {
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
        : env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const root = path.join(base, 'agent-monitor');
  return {
    root,
    runtime: path.join(root, 'runtime'),
    cache: path.join(root, 'cache'),
    codex: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'hooks.json'),
    cursor: path.join(home, '.cursor', 'hooks.json'),
    claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'),
  };
}
module.exports = { locations };
