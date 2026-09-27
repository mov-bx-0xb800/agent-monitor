'use strict';
// Subagents do their parent chat's work, so their observations belong to that chat. Fold each
// identified child into the retained parent with the same agent and native session id; its
// samples, evidence, activity and image use then count towards the parent's focus. A child
// whose parent is not retained stays listed as a subtask so its evidence is not lost.
const attention = require('./attention');
const { upgradePoint } = require('./classify');
const POINTS = 32;
const isChild = (s) => !!(s.isSubagent || s.routing?.agentId);
const family = (s) =>
  s.routing?.sessionId ? (s.routing.agent || s.agent) + '\0' + s.routing.sessionId : null;
function fold(parent, children) {
  const all = [parent, ...children],
    latest = (key) => Math.max(0, ...all.map((s) => s[key] || 0)) || undefined;
  const uses = new Map();
  for (const use of all.flatMap((s) => (Array.isArray(s.images) ? s.images : [])))
    if (use?.id && (!uses.has(use.id) || use.at > uses.get(use.id).at)) uses.set(use.id, use);
  const current = all
    .filter((s) => s.image)
    .sort((a, b) => (b.image.at || 0) - (a.image.at || 0))[0];
  return {
    ...parent,
    updated: latest('updated'),
    lastToolAt: latest('lastToolAt'),
    lastActiveAt: latest('lastActiveAt'),
    created: Math.min(...all.map((s) => s.created || Infinity)) || parent.created,
    // A working subagent means the chat is working, even after the parent's turn ends.
    status: all.some((s) => s.status === 'active') ? 'active' : parent.status,
    points: all
      .flatMap((s) => s.points || [])
      .sort((a, b) => b.at - a.at)
      .slice(0, POINTS)
      .map(upgradePoint),
    currentPoints: [
      ...new Set(all.flatMap((s) => [s.currentPoint, ...(s.currentPoints || [])]).filter(Boolean)),
    ],
    // Coinciding minutes are summed before the per-minute cap, so parallel agents cannot
    // multiply a minute's weight.
    attention: attention.merge(all.map((s) => s.attention)) || parent.attention,
    image: current?.image || parent.image,
    images: [...uses.values()],
    imageIssue: all.some((s) => s.imageIssue) || undefined,
    subtasks: children.length,
  };
}
function consolidate(sessions) {
  const parents = new Map();
  for (const s of sessions) if (!isChild(s) && family(s)) parents.set(family(s), s);
  const children = new Map(),
    aliases = new Map();
  for (const s of sessions) {
    const parent = isChild(s) && parents.get(family(s));
    if (!parent) continue;
    if (!children.has(parent.id)) children.set(parent.id, []);
    children.get(parent.id).push(s);
    aliases.set(s.id, parent.id);
  }
  return {
    sessions: sessions
      .filter((s) => !aliases.has(s.id))
      .map((s) => (children.has(s.id) ? fold(s, children.get(s.id)) : s))
      .sort((a, b) => (b.updated || 0) - (a.updated || 0)),
    aliases,
  };
}
// Image viewers and requests recorded against a child are shown on its parent chat.
function alias(aliases, sid) {
  return aliases.get(sid) || sid;
}
function foldViewers(viewers, aliases) {
  const seen = new Set();
  return (viewers || [])
    .map((v) => ({ ...v, sid: alias(aliases, v.sid) }))
    .filter((v) => !seen.has(v.sid) && seen.add(v.sid));
}
module.exports = { consolidate, foldViewers, alias };
