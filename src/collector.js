#!/usr/bin/env node
'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { locations } = require('./paths');
const store = require('./store');
const crypto = require('node:crypto');
const attention = require('./attention');
const areas = require('./focus-areas.json');
const { sessionKey, evidence, clean, upgradePoint } = require('./classify');
const { captureMany } = require('./images');
const { AGENTS, normalize, failed: toolFailed } = require('./adapters');
const { deliver } = require('./steering');
const { profileFor } = require('./profile');
const EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'Interrupt',
  'SubagentStart',
  'SubagentStop',
]);
function taskLabel(prompt) {
  if (typeof prompt !== 'string') return '';
  let fenced = false;
  for (const raw of prompt.slice(0, 4096).split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = raw
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*]\s+/, '');
    if (
      line.length < 7 ||
      /^[<`]/.test(line) ||
      /^(AGENTS\.md instructions|environment_context|INSTRUCTIONS|Current date:)/i.test(line)
    )
      continue;
    return clean(line, 90);
  }
  return '';
}
function record(event, agent, root, now = Date.now() / 1000) {
  event = normalize(event, agent);
  if (!event) return false;
  const sid = sessionKey(agent, event),
    kind = event.hook_event_name || 'PostToolUse';
  if (!sid || !EVENTS.has(kind) || fs.existsSync(path.join(root, 'paused'))) return false;
  let written = false;
  // Classification is pure, so it runs before taking the lock: parallel hooks wait less. The
  // profile holds the project's stakes and enabled custom areas, as approved in the editor.
  const tool = ![
    'UserPromptSubmit',
    'SessionStart',
    'SubagentStart',
    'Stop',
    'SessionEnd',
    'Interrupt',
    'SubagentStop',
    'PreToolUse',
  ].includes(kind);
  const classified = tool ? evidence(event, profileFor(root, event.cwd)) : null;
  const locked = store.withLock(root, () => {
    const data = store.state(root);
    if (data.issue) return;
    store.prune(data, now);
    store.pruneLegacyImages(root, data);
    const label = AGENTS[agent];
    const s = data.sessions[sid] || {
      id: sid,
      agent: label,
      cwd: event.cwd,
      title: 'Untitled chat',
      created: now,
      isSubagent: typeof event.agent_id === 'string' && !!event.agent_id,
      planned: [],
      points: [],
      status: 'idle',
    };
    // Native identities stay in the private cache; the renderer only receives the hashed ID.
    if (typeof event.session_id === 'string' && event.session_id.length <= 128)
      s.routing = {
        agent,
        sessionId: event.session_id,
        agentId: typeof event.agent_id === 'string' ? event.agent_id.slice(0, 128) : '',
      };
    s.attention = attention.state(s, areas, now);
    s.points = (s.points || [])
      .filter((p) => p && now - p.at < store.LIMITS.ttl)
      .slice(0, 16)
      .map(upgradePoint);
    if (kind === 'UserPromptSubmit' && !s.named) {
      const title = taskLabel(event.prompt);
      if (title) {
        s.title = title;
        s.named = true;
        s.titleSource = 'prompt';
      }
    }
    if (kind === 'UserPromptSubmit' || kind === 'SessionStart' || kind === 'SubagentStart') {
      s.currentPoint = null;
      s.currentPoints = [];
      s.image = null;
      s.images = [];
      s.status = kind === 'SessionStart' ? 'idle' : 'active';
      if (kind !== 'SessionStart') s.lastActiveAt = now;
    } else if (['Stop', 'SessionEnd', 'Interrupt', 'SubagentStop'].includes(kind)) {
      s.status = kind === 'SessionEnd' ? 'ended' : 'waiting';
      s.currentPoint = null;
      s.currentPoints = [];
      s.image = null;
      s.images = [];
    } else {
      s.status = 'active';
      s.lastActiveAt = now;
      const pre = kind === 'PreToolUse',
        failed = toolFailed(event);
      const tool = String(event.tool_name || '');
      // A completed tool is the evidence for focus; pre-hooks never collect images.
      if (!pre) {
        s.lastToolAt = now;
        s.lastTool = clean(tool, 100);
        const e = classified || evidence(event, profileFor(root, event.cwd));
        s.lastActivity = e.stage;
        if (e.stage === 'Planned') {
          s.planned = e.plannedConcerns;
          s.currentPoint = null;
          s.currentPoints = [];
        } else if (!e.meta) {
          // Coordination tools (subagent launch, questions, output polling) are not work of their own.
          const signals = e.signals || [e];
          s.currentPoint = e.key;
          s.currentPoints = signals.map((p) => p.key);
          const points = signals.map((p) => ({
            id: p.key,
            title: p.subject,
            context: p.context,
            concerns: p.concerns,
            stage: p.stage,
            check: p.check,
            areas: p.areas,
            ...(p.sensitive ? { sensitive: p.sensitive, risk: p.risk } : {}),
            detail: p.detail,
            tool: p.tool,
            basis: p.basis,
            at: now,
          }));
          s.points = [...points, ...s.points.filter((p) => !s.currentPoints.includes(p.id))]
            .filter((p, i, list) => list.findIndex((other) => other.id === p.id) === i)
            .slice(0, 16);
          const call =
            typeof event.tool_use_id === 'string'
              ? crypto
                  .createHash('sha256')
                  .update(event.tool_use_id.slice(0, 256))
                  .digest('hex')
                  .slice(0, 16)
              : null;
          s.focusCalls = (s.focusCalls || []).slice(0, 32);
          if (!call || !s.focusCalls.includes(call)) {
            s.attention = attention.observe(
              s.attention,
              points.map((p) => attention.observation(p, areas, now)),
              now,
            );
            if (call) s.focusCalls = [call, ...s.focusCalls].slice(0, 32);
          }
        }
      }
      s.images = [];
      s.image = null;
      if (!failed && kind === 'PostToolUse') {
        const phase = /imagegen|edit_image/i.test(tool) ? 'referenced' : 'viewed';
        const ids = captureMany(root, data, event, sid, now, phase);
        s.images = ids.map((id) => ({ id, at: now, phase }));
        s.image = s.images[0] || null;
        if (/image|screenshot|snapshot/i.test(tool) && !ids.length)
          s.imageIssue = 'No supported image payload';
        else delete s.imageIssue;
      }
    }
    s.cwd = event.cwd;
    s.lastHook = kind;
    s.updated = now;
    data.sessions[sid] = s;
    store.prune(data, now);
    store.save(root, data);
    written = true;
  });
  if (agent === 'claude' && kind === 'SessionEnd') require('./claude-wake').cancel(root, sid);
  return locked && written;
}
function health(root, agent, status, event) {
  if (!Object.hasOwn(AGENTS, agent) || fs.existsSync(path.join(root, 'paused'))) return;
  try {
    store.ensure(root);
    const file = path.join(root, 'health-' + agent + '.json'),
      old = store.readJSON(file, {}, 2048),
      at = Date.now() / 1000;
    const value = {
      version: 1,
      at,
      status,
      cwd: typeof event?.cwd === 'string' ? event.cwd.slice(0, 256) : undefined,
    };
    if (status === 'received') {
      if (old?.version === 1 && old.cwd === value.cwd) value.lastFailure = old.lastFailure;
    } else if (status !== 'paused') value.lastFailure = { at, status };
    // One fixed, bounded diagnostic file per adapter; no transcripts or event spool.
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  } catch {}
}
async function run() {
  const agent = process.argv[2],
    root = process.argv[3] || locations().cache;
  let normalized,
    raw,
    size = 0;
  const chunks = [];
  const deadline = setTimeout(() => {
    health(root, agent, 'timeout', normalized);
    process.exit(0);
  }, 2500);
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 24 * 1024 * 1024) {
        health(root, agent, 'input-limit');
        return;
      }
      chunks.push(chunk);
    }
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    normalized = normalize(raw, agent);
    if (!normalized || !sessionKey(agent, normalized) || !EVENTS.has(normalized.hook_event_name)) {
      health(root, agent, 'unsupported-event', normalized);
      return;
    }
    if (fs.existsSync(path.join(root, 'paused'))) return;
    let recorded = false;
    for (const delay of [0, 10, 25, 50, 100, 150, 200]) {
      if (delay)
        await new Promise((resolve) => setTimeout(resolve, delay + Math.floor(Math.random() * 15)));
      recorded = record(raw, agent, root);
      if (recorded || store.state(root).issue || fs.existsSync(path.join(root, 'paused'))) break;
    }
    health(
      root,
      agent,
      recorded
        ? 'received'
        : store.state(root).issue
          ? 'cache-error'
          : fs.existsSync(path.join(root, 'paused'))
            ? 'paused'
            : 'busy',
      normalized,
    );
    const output = recorded ? deliver(root, normalized, agent) : null;
    if (output) process.stdout.write(JSON.stringify(output) + '\n');
  } catch {
    health(root, agent, 'collector-error', normalized);
  } finally {
    clearTimeout(deadline);
    // Cursor permission hooks require a response even when collection is paused.
    if (agent === 'cursor' && ['preToolUse', 'subagentStart'].includes(raw?.hook_event_name))
      process.stdout.write('{"permission":"allow"}\n');
  }
}
if (require.main === module) run();
module.exports = { record, taskLabel };
