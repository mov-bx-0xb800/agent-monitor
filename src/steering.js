'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const store = require('./store'),
  areas = require('./focus-areas.json'),
  { sessionKey, clean } = require('./classify');
const TTL = 3600,
  MAX = 24;
function read(root, now = Date.now() / 1000) {
  const rows = store.readJSON(path.join(root, 'steering.json'), [], 65536);
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r.id === 'string' && now - r.created < 86400)
    .slice(-MAX)
    .map((r) =>
      r.status === 'dispatching' && now - r.created > 15
        ? { ...r, status: 'unknown' }
        : r.status === 'queued' && now - r.created > TTL
          ? { ...r, status: 'expired' }
          : r,
    );
}
function write(root, rows) {
  store.atomic(path.join(root, 'steering.json'), JSON.stringify(rows.slice(-MAX)));
}
const CUSTOM_ID = /^x:[a-z][a-z0-9-]{1,31}$/;
const LEGACY = {
  backend: 'Backend & logic',
  testing: 'Testing & reliability',
  architecture: 'Architecture',
};
// Project stakes shape how the agent should approach the area, never what it is allowed to do.
const STAKES = {
  production:
    ' The project is marked Production: real users, money or data depend on it, so keep changes safe to release and verify them.',
  critical:
    ' The project is marked Critical: failures could cause serious harm. Prefer small, reversible changes, name the evidence behind any claim that the area is covered, and state any residual risk.',
};
/**
 * A request's area as the user saw it. Custom areas carry the label and description snapshotted
 * when the user clicked, so delivery never depends on workspace files.
 */
function describe(r) {
  if (typeof r?.area !== 'string') return null;
  if (CUSTOM_ID.test(r.area)) {
    const c = r.custom;
    if (!c || typeof c.label !== 'string' || typeof c.description !== 'string') return null;
    return {
      label: c.label,
      description: `${c.label} is a project-specific area the user defined as “${c.description}”`,
    };
  }
  const area = areas.find((a) => a.id === r.area);
  if (!area) return null;
  const old = r.revision >= 2 || !Object.hasOwn(LEGACY, r.area) ? null : LEGACY[r.area];
  return { label: old || area.label, description: r.revision >= 2 ? area.description : null };
}
/** Validates an area for a new request and returns the fields to store with it. */
function spec(areaId, extra = {}) {
  const stakes = ['production', 'critical'].includes(extra.stakes) ? { stakes: extra.stakes } : {};
  if (areas.some((a) => a.id === areaId)) return stakes;
  const c = extra.custom;
  if (
    typeof areaId === 'string' &&
    CUSTOM_ID.test(areaId) &&
    c &&
    typeof c.label === 'string' &&
    typeof c.description === 'string'
  )
    return {
      ...stakes,
      custom: {
        label: clean(c.label, 32),
        description: clean(c.description, 160).replace(/[“”"]/g, "'"),
      },
    };
  throw Error('Unknown focus area.');
}
function prompt(labels, descriptions = [], stakes = 'standard') {
  return `The user selected “Focus here” for ${labels.join(' and ')} in Agent Monitor. Briefly acknowledge this focus request in your next visible response. Give ${labels.join(' and ')} more attention within this existing task.${descriptions.length ? ' Category meaning: ' + descriptions.join(' ') : ''}${Object.hasOwn(STAKES, stakes) ? STAKES[stakes] : ''} Use this thread’s context, history, decisions and current changes to determine what matters. If there is no active task, say the request was received and ask what the user wants reviewed; do not resume cancelled or reverted work. Otherwise, state the relevant check you will make, investigate and address relevant gaps within the agreed scope, preserve the other requirements, and verify any changes. If the area is irrelevant or already adequately covered, explain briefly with evidence. Do not create unrelated work just to satisfy a category. This request does not grant additional publishing, deployment or destructive-action permissions.`;
}
function enqueue(root, sid, areaId, now = Date.now() / 1000, extra = {}) {
  const fields = spec(areaId, extra);
  if (fs.existsSync(path.join(root, 'paused')))
    throw Error('Resume collection before sending a focus request.');
  let result;
  if (
    !store.withLock(root, () => {
      const session = store.state(root).sessions[sid];
      if (!session || now - session.updated > 86400)
        throw Error('This thread is no longer available. Start a fresh turn.');
      const rows = read(root, now),
        existing = rows.find(
          (r) => r.sid === sid && r.area === areaId && ['queued', 'dispatching'].includes(r.status),
        );
      if (existing) {
        result = existing;
        return;
      }
      if (
        rows.filter((r) => ['queued', 'dispatching'].includes(r.status)).length >= MAX ||
        rows.filter((r) => r.sid === sid && ['queued', 'dispatching'].includes(r.status)).length >=
          4
      )
        throw Error('This thread already has pending focus requests. Let it receive them first.');
      result = {
        id: crypto.randomBytes(12).toString('hex'),
        sid,
        area: areaId,
        created: now,
        status: 'queued',
        revision: 2,
        ...fields,
      };
      const pending = rows.filter((r) => ['queued', 'dispatching'].includes(r.status)),
        history = rows.filter((r) => !['queued', 'dispatching'].includes(r.status));
      const room = MAX - pending.length - 1;
      write(root, [...(room ? history.slice(-room) : []), ...pending, result]);
    })
  )
    throw Error('An agent is updating. Try again in a moment.');
  return result;
}
function cancel(root, id) {
  return store.withLock(root, () => {
    const rows = read(root);
    const r = rows.find((r) => r.id === id && r.status === 'queued');
    if (r) {
      r.status = 'cancelled';
      write(root, rows);
    }
  });
}
function deliver(root, event, agent, now = Date.now() / 1000) {
  const kind = event.hook_event_name,
    sid = sessionKey(agent, event);
  if (
    !sid ||
    !['PostToolUse', 'UserPromptSubmit', 'Stop'].includes(kind) ||
    fs.existsSync(path.join(root, 'paused'))
  )
    return null;
  // A user's explicit click may continue one closing turn, never create a repeat Stop loop.
  if (
    kind === 'Stop' &&
    (event.stop_hook_active || (agent === 'cursor' && event.status !== 'completed'))
  )
    return null;
  if (agent === 'cursor' && !['PostToolUse', 'Stop'].includes(kind)) return null;
  let output = null;
  store.withLock(root, () => {
    const rows = read(root, now),
      pending = rows.filter((r) => r.sid === sid && r.status === 'queued').slice(0, 4);
    if (!pending.length) return;
    const described = pending.map(describe).filter(Boolean);
    if (!described.length) return;
    const labels = described.map((d) => d.label),
      descriptions = described.map((d) => d.description).filter(Boolean);
    // The strictest stakes among the pending requests applies.
    const stakes = pending.some((r) => r.stakes === 'critical')
      ? 'critical'
      : pending.some((r) => r.stakes === 'production')
        ? 'production'
        : 'standard';
    const text = prompt(labels, descriptions, stakes);
    // Mark before emission: at-most-once delivery. A crashed pipe may lose a request; never auto-repeat it.
    for (const r of pending) {
      r.status = 'delivered';
      r.delivered = now;
      r.event = kind;
    }
    write(root, rows);
    output =
      agent === 'cursor'
        ? kind === 'Stop'
          ? { followup_message: text }
          : { additional_context: text }
        : kind === 'Stop'
          ? { decision: 'block', reason: text }
          : { hookSpecificOutput: { hookEventName: kind, additionalContext: text } };
  });
  return output;
}
function claimDirect(
  root,
  sid,
  area,
  sessionId,
  now = Date.now() / 1000,
  agent = 'codex',
  extra = {},
) {
  const fields = spec(area, extra);
  let result;
  if (
    !store.withLock(root, () => {
      const session = store.state(root).sessions[sid];
      if (
        fs.existsSync(path.join(root, 'paused')) ||
        !session ||
        now - session.updated > 86400 ||
        session.isSubagent ||
        session.routing?.agentId ||
        session.routing?.agent !== agent ||
        session.routing?.sessionId !== sessionId ||
        !['waiting', 'idle'].includes(session.status)
      )
        throw Error('The chat changed before submission. Try again.');
      const rows = read(root, now);
      const existing = rows.find(
        (r) => r.sid === sid && r.area === area && ['queued', 'dispatching'].includes(r.status),
      );
      if (existing) {
        result = { ...existing, acquired: false };
        return;
      }
      if (rows.some((r) => r.sid === sid && r.status === 'dispatching'))
        throw Error('This chat has a focus request being sent.');
      const pending = rows.filter((r) => ['queued', 'dispatching'].includes(r.status));
      if (pending.length >= MAX || pending.filter((r) => r.sid === sid).length >= 4)
        throw Error('This chat has pending requests.');
      const history = rows.filter((r) => !['queued', 'dispatching'].includes(r.status));
      const room = MAX - pending.length - 1;
      result = {
        id: crypto.randomUUID(),
        sid,
        area,
        created: now,
        status: 'dispatching',
        transport: agent === 'claude' ? 'wake' : 'direct',
        revision: 2,
        ...fields,
      };
      write(root, [...(room ? history.slice(-room) : []), ...pending, result]);
      result = { ...result, acquired: true };
    })
  )
    throw Error('An agent is updating. Try again in a moment.');
  return result;
}
function finishDirect(root, id, accepted, now = Date.now() / 1000) {
  return store.withLock(root, () => {
    const rows = read(root, now),
      row = rows.find(
        (r) =>
          r.id === id &&
          ['direct', 'wake'].includes(r.transport) &&
          ['dispatching', 'unknown'].includes(r.status),
      );
    if (row) {
      row.status = accepted ? 'accepted' : 'unknown';
      row.delivered = now;
      write(root, rows);
    }
  });
}
module.exports = {
  describe,
  read,
  prompt,
  enqueue,
  cancel,
  deliver,
  claimDirect,
  finishDirect,
};
