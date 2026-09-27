'use strict';
// Native chat titles from each agent's own local metadata, so chats read as they do in the agent.
// Reads are bounded and cached by file size and modification time. Only title records are
// parsed; nothing else from these files is kept, and titles stay in memory in the editor host.
const fs = require('node:fs'),
  path = require('node:path');
const { clean } = require('./classify');
const INDEX_LIMIT = 4 * 1024 * 1024,
  WINDOW = 1024 * 1024,
  RECHECK = 15,
  CACHED = 64,
  PROJECT_DIRS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function stat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}
function read(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length),
      count = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, count).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
function createTitles({ codexHome, claudeHome, now = () => Date.now() / 1000 }) {
  let codex = { key: '', titles: new Map() };
  const claude = new Map();
  // Codex appends { id, thread_name } rows to session_index.jsonl; the latest row wins.
  function codexTitle(id) {
    if (!codexHome) return '';
    const file = path.join(codexHome, 'session_index.jsonl'),
      info = stat(file);
    if (!info) return '';
    const key = info.size + ':' + info.mtimeMs;
    if (codex.key !== key) {
      const start = Math.max(0, info.size - INDEX_LIMIT);
      let text = read(file, start, info.size - start);
      if (start) text = text.slice(text.indexOf('\n') + 1);
      const titles = new Map();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (typeof row.id === 'string' && typeof row.thread_name === 'string')
            titles.set(row.id, row.thread_name);
        } catch {
          // A partially written row is skipped; the next change re-reads the index.
        }
      }
      codex = { key, titles };
    }
    return codex.titles.get(id) || '';
  }
  function claudeFile(id) {
    if (!claudeHome) return null;
    const projects = path.join(claudeHome, 'projects');
    let dirs;
    try {
      dirs = fs
        .readdirSync(projects, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .slice(0, PROJECT_DIRS);
    } catch {
      return null;
    }
    for (const dir of dirs) {
      const file = path.join(projects, dir.name, id + '.jsonl');
      if (stat(file)) return file;
    }
    return null;
  }
  // Claude Code records its chat-list title as `ai-title` rows (and `custom-title` after a
  // rename) inside the session file. Only those rows are parsed, from the end and the start.
  function titleIn(text, id) {
    let ai = '',
      custom = '';
    for (const line of text.split('\n')) {
      if (!line.includes('"ai-title"') && !line.includes('"custom-title"')) continue;
      try {
        const row = JSON.parse(line);
        if (row.sessionId && row.sessionId !== id) continue;
        if (row.type === 'custom-title' && typeof row.customTitle === 'string')
          custom = row.customTitle;
        else if (row.type === 'ai-title' && typeof row.aiTitle === 'string') ai = row.aiTitle;
      } catch {
        // Skip rows cut by the read window.
      }
    }
    return custom || ai;
  }
  function claudeTitle(id) {
    let entry = claude.get(id);
    const time = now();
    if (entry && time - entry.checked < RECHECK) return entry.title;
    if (!entry) {
      entry = { file: null, key: '', title: '', checked: 0 };
      claude.set(id, entry);
      if (claude.size > CACHED) claude.delete(claude.keys().next().value);
    }
    entry.checked = time;
    if (!entry.file || !stat(entry.file)) entry.file = claudeFile(id);
    const info = entry.file && stat(entry.file);
    if (!info) return entry.title;
    const key = info.size + ':' + info.mtimeMs;
    if (key === entry.key) return entry.title;
    entry.key = key;
    const start = Math.max(0, info.size - WINDOW);
    let found = titleIn(read(entry.file, start, info.size - start), id);
    if (!found && start > 0 && !entry.title)
      found = titleIn(read(entry.file, 0, Math.min(WINDOW, start)), id);
    if (found) entry.title = found;
    return entry.title;
  }
  return function title(routing, session = {}) {
    // A subagent shares its parent's session file, so its parent's title would mislabel it.
    if (!routing || session.isSubagent || routing.agentId) return '';
    if (!UUID.test(String(routing.sessionId || ''))) return '';
    try {
      const raw =
        routing.agent === 'codex'
          ? codexTitle(routing.sessionId)
          : routing.agent === 'claude'
            ? claudeTitle(routing.sessionId)
            : '';
      return raw ? clean(raw, 90) : '';
    } catch {
      return '';
    }
  };
}
module.exports = { createTitles };
