'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { locations } = require('./paths');
const { ensure, atomic, readJSON } = require('./store');
const FILES = [
  'claude-wake.js',
  'claude-wake.sh',
  'attention.js',
  'collector.js',
  'adapters.js',
  'paths.js',
  'store.js',
  'classify.js',
  'images.js',
  'topics.js',
  'lexicon.js',
  'shell.js',
  'profile.js',
  'taxonomy.json',
  'steering.js',
  'focus-areas.json',
];
const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
];
const IMAGE_MATCHER = 'Read|.*image.*|.*screenshot.*|.*snapshot.*|.*cua.*js.*|.*use_figma.*';
function quotePosix(s) {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}
function quotePS(s) {
  return "'" + s.replaceAll("'", "''") + "'";
}
function owned(h) {
  if (typeof h?.command !== 'string') return false;
  let command = h.command;
  const encoded = command.match(
    /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
  );
  if (encoded) command = Buffer.from(encoded[1], 'base64').toString('utf16le');
  command = command.replaceAll('\\', '/');
  return command.includes('/agent-monitor/runtime/');
}
function configured(file) {
  try {
    if (fs.statSync(file).size > 2 * 1024 * 1024) return false;
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.values(d.hooks || {}).some(
      (es) => Array.isArray(es) && es.some((e) => owned(e) || e.hooks?.some(owned)),
    );
  } catch {
    return false;
  }
}
function inspect(file, agent) {
  try {
    if (!file || !fs.existsSync(file)) return { configured: false, disabled: false };
    const stat = fs.statSync(file);
    if (stat.size > 2 * 1024 * 1024) throw Error('Settings file exceeds the read limit.');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc))
      throw Error('Settings must be a JSON object.');
    const events =
      agent === 'cursor'
        ? ['sessionStart', 'postToolUse', 'stop']
        : ['SessionStart', 'PostToolUse', 'Stop'];
    const present = events.filter(
      (name) =>
        Array.isArray(doc.hooks?.[name]) &&
        doc.hooks[name].some((entry) =>
          agent === 'cursor' ? owned(entry) : entry.hooks?.some(owned),
        ),
    );
    return {
      configured: present.length === events.length,
      partial: present.length > 0 && present.length < events.length,
      disabled: agent === 'claude' && doc.disableAllHooks === true,
      changedAt: stat.mtimeMs / 1000,
    };
  } catch {
    return {
      configured: false,
      issue: 'Hook settings could not be read. Open the settings file to check its format.',
    };
  }
}
function editSettings(
  file,
  agent,
  node,
  runtime,
  cache,
  platform = process.platform,
  disconnect = false,
) {
  const exists = fs.existsSync(file),
    original = exists ? fs.readFileSync(file, 'utf8') : null;
  if (original && Buffer.byteLength(original) > 2 * 1024 * 1024)
    throw Error('Agent settings exceed the safe edit limit.');
  const doc = original ? JSON.parse(original) : {};
  if (
    !doc ||
    typeof doc !== 'object' ||
    Array.isArray(doc) ||
    (doc.hooks && (typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)))
  )
    throw Error('Agent settings must contain a hooks object.');
  if (agent === 'cursor' && doc.version !== undefined && doc.version !== 1)
    throw Error('Unsupported Cursor hook version; settings were not changed.');
  const hooks = doc.hooks || {};
  for (const [name, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries))
      throw Error('Unrecognised hook configuration; settings were not changed.');
    hooks[name] =
      agent === 'cursor'
        ? entries.filter((e) => !owned(e))
        : entries
            .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => !owned(h)) }))
            .filter((e) => e.hooks.length);
    if (!hooks[name].length) delete hooks[name];
  }
  if (!disconnect) {
    const args = [node, path.join(runtime, 'collector.js'), agent, cache];
    const command =
      platform === 'win32'
        ? 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' +
          Buffer.from('& ' + args.map(quotePS).join(' '), 'utf16le').toString('base64')
        : args.map(quotePosix).join(' ');
    const handler = { type: 'command', command, timeout: 4 };
    if (platform === 'win32' && agent === 'claude') handler.shell = 'powershell';
    if (platform === 'win32' && agent === 'codex') handler.commandWindows = command;
    if (agent === 'cursor') {
      const { CURSOR_EVENTS } = require('./adapters');
      doc.version = 1;
      for (const event of Object.keys(CURSOR_EVENTS)) {
        const entry = { command, timeout: 4 };
        if (event === 'preToolUse') entry.matcher = IMAGE_MATCHER;
        if (['stop', 'subagentStop'].includes(event)) entry.loop_limit = 1;
        (hooks[event] ||= []).push(entry);
      }
    } else
      for (const event of [
        ...EVENTS,
        'PreToolUse',
        ...(agent === 'claude' ? ['PostToolUseFailure'] : ['Interrupt']),
      ]) {
        const entry = {
          hooks: [
            {
              ...handler,
              timeout: agent === 'codex' && ['SessionEnd', 'Interrupt'].includes(event) ? 3 : 4,
            },
          ],
        };
        if (event === 'PreToolUse') entry.matcher = IMAGE_MATCHER;
        else if (event.startsWith('PostToolUse')) entry.matcher = '.*';
        (hooks[event] ||= []).push(entry);
      }
  }
  if (!disconnect && agent === 'claude' && platform === 'darwin') {
    (hooks.Stop ||= []).push({
      hooks: [
        {
          type: 'command',
          command: ['/bin/bash', path.join(runtime, 'claude-wake.sh'), node, cache]
            .map(quotePosix)
            .join(' '),
          asyncRewake: true,
          timeout: 3610,
        },
      ],
    });
  }
  doc.hooks = hooks;
  const next = JSON.stringify(doc, null, 2) + '\n';
  if (original === next || (disconnect && !exists)) return;
  ensure(path.dirname(file));
  if (original !== null)
    fs.writeFileSync(file + '.agent-monitor-backup', original, { mode: 0o600 });
  // Do not overwrite settings that changed while this edit was being prepared.
  if (exists && fs.readFileSync(file, 'utf8') !== original)
    throw Error('Agent settings changed. Connect again to retry.');
  atomic(file, next);
}
async function findNode(configuredPath = '') {
  const candidates = configuredPath ? [configuredPath] : ['node'];
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(
        candidate,
        ['-p', 'JSON.stringify({version:process.versions.node,path:process.execPath})'],
        { timeout: 2000, windowsHide: true, maxBuffer: 4096 },
      );
      const result = JSON.parse(stdout);
      if (Number(result.version.split('.')[0]) >= 20) return result.path;
    } catch {}
  }
  throw Error('Install Node.js 20 or newer, or set Agent Monitor: Node Path to its executable.');
}
const VERSION_FILE = 'version.json';
function bundledVersion() {
  try {
    return String(require('../package.json').version);
  } catch {
    return '0.0.0';
  }
}
function newer(a, b) {
  const x = String(a).split('.').map(Number),
    y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
// Writes the helper files that differ. The entry point goes last, so a hook that starts during
// the update loads modules that already exist. Returns the number of files replaced.
function writeRuntime(runtime, version = bundledVersion()) {
  let changed = 0;
  for (const file of [...FILES.filter((f) => f !== 'collector.js'), 'collector.js']) {
    const next = fs.readFileSync(path.join(__dirname, file)),
      target = path.join(runtime, file);
    let current = null;
    try {
      current = fs.readFileSync(target);
    } catch {}
    if (current && current.equals(next)) continue;
    atomic(target, next);
    changed++;
  }
  atomic(path.join(runtime, VERSION_FILE), JSON.stringify({ version }));
  return changed;
}
/**
 * Keeps a helper installed by an earlier Connect in step with this extension, so collection
 * improvements apply without reconnecting. Only existing helper files are replaced: agent
 * settings, hook commands and native trust are untouched. A helper written by a newer installed
 * version is left alone, so two editors with different versions do not alternate it.
 */
function refreshRuntime(loc = locations(), version = bundledVersion()) {
  if (!loc.runtime || !fs.existsSync(path.join(loc.runtime, 'collector.js'))) return false;
  const installed = readJSON(path.join(loc.runtime, VERSION_FILE), {}, 1024)?.version;
  if (typeof installed === 'string' && newer(installed, version)) return false;
  return writeRuntime(loc.runtime, version) > 0;
}
function install(agents, node, loc = locations(), platform = process.platform) {
  ensure(loc.runtime);
  ensure(loc.cache);
  writeRuntime(loc.runtime);
  const results = [];
  for (const agent of agents) {
    try {
      editSettings(loc[agent], agent, node, loc.runtime, loc.cache, platform);
      results.push({ agent, ok: true });
    } catch (error) {
      results.push({ agent, ok: false, error: error.message });
    }
  }
  return results;
}
function disconnect(loc = locations()) {
  require('./claude-wake').cancelAll(loc.cache);
  for (const agent of ['codex', 'claude', 'cursor'])
    if (loc[agent] && fs.existsSync(loc[agent]))
      editSettings(loc[agent], agent, '', loc.runtime, loc.cache, process.platform, true);
}
module.exports = {
  findNode,
  inspect,
  install,
  refreshRuntime,
  disconnect,
  editSettings,
  configured,
  owned,
  quotePosix,
  quotePS,
};
