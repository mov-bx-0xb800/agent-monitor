/* Shared by the webview and deterministic tests. No timers or I/O. */
(function (root) {
  const attention = typeof module !== 'undefined' ? require('../src/attention') : root.Attention;
  // Coarse on purpose: a sidebar that is always open should not tick every second.
  function relativeTime(timestamp, now = Date.now()) {
    const s = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    const [n, u] = s < 86400 ? [Math.floor(s / 3600), 'hour'] : [Math.floor(s / 86400), 'day'];
    return `${n} ${u}${n === 1 ? '' : 's'} ago`;
  }
  // Why a piece of evidence relates to an area, as recorded when it was observed.
  function reason(area, p) {
    const hit = Array.isArray(p.areas) && p.areas.find((a) => a[0] === area.id);
    if (hit && hit[2]) return String(hit[2]);
    return (area.checks || []).includes(p.check) ? 'recognised check' : '';
  }
  function categories(areas, sessions, { now = Date.now() / 1000 } = {}) {
    const states = new Map(sessions.map((s) => [s.id, attention.state(s, areas, now)]));
    return areas.map((area) => {
      const observed = [],
        active = [],
        scores = [];
      let sensitive = 0;
      for (const thread of sessions) {
        const result = attention.score(states.get(thread.id), area.id, now);
        scores.push({ thread, ...result });
        const matches = (thread.points || [])
          .filter(
            (p) => now - p.at < 86400 && p.stage !== 'Tool failed' && attention.matches(area, p),
          )
          .sort((a, b) => b.at - a.at);
        // The most recent distinct subjects, each with the reason it relates to this area.
        const recent = [];
        for (const p of matches) {
          if (recent.length >= 3) break;
          if (!recent.some((e) => e.id === p.id)) recent.push({ ...p, reason: reason(area, p) });
        }
        if (recent.length) observed.push({ thread, evidence: recent[0], recent });
        // A sensitive change shows on the areas it concerns, not on every area the file touches.
        sensitive += matches.filter(
          (p) => p.sensitive && p.stage === 'Changed' && (p.risk || []).includes(area.id),
        ).length;
        const current = matches.find(
          (p) => p.id === thread.currentPoint || thread.currentPoints?.includes(p.id),
        );
        if (
          current &&
          thread.status === 'active' &&
          now - thread.updated < 120 &&
          now - current.at < 120
        )
          active.push({ thread, evidence: current });
      }
      scores.sort((a, b) => b.score - a.score || b.at - a.at);
      const strongest = scores[0] || { score: 0, breadth: 0, share: 0, modes: [], heat: 0 };
      const at = Math.max(
        0,
        ...observed.map((o) => o.evidence.at),
        ...scores.map((s) => s.at || 0),
      );
      return {
        ...area,
        observed,
        active,
        at,
        scores,
        score: strongest.score,
        breadth: strongest.breadth,
        heat: Math.max(0, ...scores.map((s) => s.heat)),
        // Changes to files of a risky kind, as marked for the project's stakes.
        sensitive,
        tone: active.length ? 'active' : attention.decay(at, now) > 0 ? 'recent' : 'quiet',
      };
    });
  }
  // Whether a chat's folder is inside a workspace folder, by path segments rather than prefix.
  function within(root, cwd) {
    if (typeof root !== 'string' || typeof cwd !== 'string') return false;
    const r = root.replace(/[\\/]+$/, '');
    return cwd === r || cwd.startsWith(r + '/') || cwd.startsWith(r + '\\');
  }
  /** The workspace profile for a chat: the deepest folder containing its working directory. */
  function profileFor(profiles, thread) {
    return (profiles || [])
      .filter((p) => within(p.root, thread?.cwd))
      .sort((a, b) => b.root.length - a.root.length)[0];
  }
  /** Built-in areas plus the custom areas enabled for the chat's folder. */
  function areasFor(builtins, profiles, thread) {
    const p = profileFor(profiles, thread);
    return p?.areas?.length ? [...builtins, ...p.areas] : builtins;
  }
  function visibleCategories(areas, selection, layout) {
    const ids = areas.map((a) => a.id);
    const unique = (values) => [
      ...new Set((Array.isArray(values) ? values : []).filter((id) => ids.includes(id))),
    ];
    const chosen = unique(
      layout?.primary ?? selection ?? areas.filter((a) => a.core).map((a) => a.id),
    );
    const extra = unique([...(layout?.extra || []), ...ids]).filter((id) => !chosen.includes(id));
    return {
      primary: chosen.map((id) => areas.find((a) => a.id === id)),
      extra: extra.map((id) => areas.find((a) => a.id === id)),
    };
  }
  function moveArea(areas, selection, layout, id, zone, before) {
    if (!areas.some((a) => a.id === id) || !['primary', 'extra'].includes(zone)) return null;
    const current = visibleCategories(areas, selection, layout);
    const next = Object.fromEntries(
      Object.entries(current).map(([key, list]) => [
        key,
        list.map((a) => a.id).filter((value) => value !== id),
      ]),
    );
    const index = next[zone].indexOf(before);
    next[zone].splice(index < 0 ? next[zone].length : index, 0, id);
    return next;
  }
  const api = {
    relativeTime,
    categories,
    visibleCategories,
    moveArea,
    within,
    profileFor,
    areasFor,
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.FocusModel = api;
})(typeof window === 'undefined' ? globalThis : window);
