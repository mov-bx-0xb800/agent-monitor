/* Bounded observation scoring shared by the collector, webview and tests. No I/O.

   Version 3 keeps each chat's progress per area. Evidence accumulates with every observed action,
   weighted by its kind and confidence, and fades only as the chat does other work: never with
   time. An idle or older chat therefore keeps its focus, and a long session moves gradually
   from one area to the next. Earlier formats (version-1 samples, version-2 minute buckets) are
   migrated on read. */
(function (root) {
  // Append only: these bit positions are part of the stored cache format.
  const IDS = [
    'security',
    'performance',
    'ux',
    'backend',
    'data',
    'testing',
    'reliability',
    'architecture',
    'delivery',
    'analytics',
    'privacy',
    'product',
    'docs',
  ];
  const LIMIT = 64,
    WINDOW = 3600,
    HALF_LIFE = 600,
    VERSION = 3,
    // Kept evidence halves only after about 1,600 work units elsewhere (a change is 2): roughly an
    // hour of full-time work in other areas costs an area about 7 points of 96. Time alone costs nothing.
    HALF_WORK = 1600,
    // Evidence builds gradually: one change scores about 8, forty sustained changes about 95.
    SATURATION = 20,
    // Being a side topic rather than the chat's main focus lowers a score by at most 20%.
    FLOOR = 0.8,
    // Work that no area recognises counts a quarter towards the whole, so recognition gaps barely dilute.
    UNKNOWN = 0.25,
    MINUTES = 60,
    SUBJECTS = 32,
    NEW_SUBJECTS = 8,
    SEEN = 24,
    // Total weight one minute can contribute; a burst of files cannot outweigh one change.
    CAP = 2,
    // Confidence given to a path or tool match recorded by version 1, which kept no confidence.
    LEGACY = 0.75;
  const WEIGHTS = { read: 1, change: 2, check: 2, other: 0.5, failed: 0.5 };
  const MODES = { read: 1, change: 2, check: 4, other: 8, fail: 16 },
    MODE_ORDER = ['read', 'change', 'check', 'fail', 'other'];
  const KINDS = {
    Inspected: 'read',
    Changed: 'change',
    'Check run': 'check',
    'Check failed': 'check',
    'Tool failed': 'failed',
  };
  const r3 = (n) => Math.round(n * 1000) / 1000;
  // Custom areas are stored by name ("x:ledger-integrity"); built-in areas by bit position.
  const CUSTOM = /^x:[a-z][a-z0-9-]{1,31}$/,
    MAX_CUSTOM = 8;
  const okKey = (k) =>
    (Number.isInteger(k) && k >= 0 && k < IDS.length) || (typeof k === 'string' && CUSTOM.test(k));
  function keyOf(areaId) {
    const bit = IDS.indexOf(areaId);
    return bit >= 0 ? bit : typeof areaId === 'string' && CUSTOM.test(areaId) ? areaId : null;
  }
  // Built-in bits first, then custom names, so stored order is stable.
  const order = (x, y) =>
    typeof x[0] === typeof y[0]
      ? x[0] < y[0]
        ? -1
        : x[0] > y[0]
          ? 1
          : 0
      : typeof x[0] === 'number'
        ? -1
        : 1;
  function fingerprint(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
  }
  function decay(at, now) {
    if (!Number.isFinite(at) || at <= 0 || at > now + 5 || now - at >= WINDOW) return 0;
    return Math.pow(2, -Math.max(0, now - at) / HALF_LIFE);
  }
  const patterns = new Map();
  function regex(source) {
    if (!patterns.has(source)) patterns.set(source, new RegExp(source, 'i'));
    return patterns.get(source);
  }
  // Evidence recorded before area confidences existed matches through its context and concerns.
  function legacyMatch(area, p) {
    return (
      (area.contexts || []).includes(p.context) ||
      (p.concerns || []).some((c) => (area.concerns || []).includes(c)) ||
      (area.checks || []).includes(p.check) ||
      (area.terms || []).some((t) =>
        String(p.detail || '')
          .toLowerCase()
          .split(/[^a-z0-9-]+/)
          .includes(t),
      ) ||
      (area.patterns || []).some((r) => regex(r).test(String(p.detail || '')))
    );
  }
  /** Confidence (0–1) that evidence p relates to an area. Recognised checks are direct evidence. */
  function confidence(area, p) {
    if (!p || p.stage === 'Tool failed') return 0;
    if (Array.isArray(p.areas)) {
      const hit = p.areas.find((a) => Array.isArray(a) && a[0] === area.id);
      return hit && Number.isFinite(hit[1]) ? Math.max(0, Math.min(1, hit[1])) : 0;
    }
    if (!legacyMatch(area, p)) return 0;
    return (area.checks || []).includes(p.check) ? 1 : LEGACY;
  }
  function matches(area, p) {
    return Array.isArray(p?.areas) ? confidence(area, p) > 0 : legacyMatch(area, p);
  }
  function kindOf(stage) {
    return Object.hasOwn(KINDS, stage) ? KINDS[stage] : 'other';
  }

  // ------------------------------------------------------------------------------------------
  // Version 1: compact samples [timestamp, subjectHash, actionKind, categoryMask, directMask].

  function sample(p, areas, at) {
    const kind = kindOf(p.stage);
    let mask = 0,
      direct = 0;
    if (kind !== 'failed')
      for (const area of areas) {
        const bit = 1 << IDS.indexOf(area.id);
        if (!IDS.includes(area.id) || !matches(area, p)) continue;
        mask |= bit;
        if ((area.checks || []).includes(p.check)) direct |= bit;
      }
    return [at, p.id || p.key, kind, mask, direct];
  }
  function shape(s) {
    return (
      Array.isArray(s) &&
      s.length === 5 &&
      Number.isFinite(s[0]) &&
      typeof s[1] === 'string' &&
      /^[a-f0-9]{16}$/.test(s[1]) &&
      Object.hasOwn(WEIGHTS, s[2]) &&
      Number.isInteger(s[3]) &&
      s[3] >= 0 &&
      s[3] < 1 << IDS.length &&
      Number.isInteger(s[4]) &&
      s[4] >= 0 &&
      (s[4] & s[3]) === s[4]
    );
  }
  function valid(s, now) {
    return shape(s) && decay(s[0], now) > 0;
  }
  function retain(samples, now) {
    // A flood within one minute cannot consume the history or increase its score.
    const buckets = new Map();
    for (const s of samples.filter((s) => valid(s, now)).sort((a, b) => b[0] - a[0])) {
      const minute = Math.floor(s[0] / 60),
        list = buckets.get(minute) || [];
      if (list.some((p) => p[1] === s[1] && p[2] === s[2] && p[3] === s[3] && p[4] === s[4]))
        continue;
      if (list.length >= 8) continue;
      list.push(s);
      buckets.set(minute, list);
    }
    return [...buckets.values()].flat().slice(0, LIMIT);
  }
  function history(thread, areas, now) {
    return retain(
      thread.attention?.version === 1 && Array.isArray(thread.attention.samples)
        ? thread.attention.samples
        : (thread.points || [])
            .filter((p) => p.stage !== 'Planned')
            .map((p) => sample(p, areas, p.at)),
      now,
    );
  }

  // ------------------------------------------------------------------------------------------
  // Version 2: { version: 2, minutes: [[minute, total, lastSecond, [[bit, weight, modes]…]]…],
  //              subjects: [[subjectHash, lastAt, areaMask]…], recent: [minute, seenKeys, newSubjects] }

  function empty() {
    return { version: VERSION, minutes: [], subjects: [], recent: null };
  }
  const lastAt = (b) => b[0] * 60 + b[2];
  function okBucket(b) {
    return (
      Array.isArray(b) &&
      b.length === 4 &&
      Number.isInteger(b[0]) &&
      b[0] > 0 &&
      Number.isFinite(b[1]) &&
      b[1] > 0 &&
      b[1] < 1e6 &&
      Number.isInteger(b[2]) &&
      b[2] >= 0 &&
      b[2] < 60 &&
      Array.isArray(b[3]) &&
      b[3].length <= IDS.length + MAX_CUSTOM &&
      b[3].every(
        (e) =>
          Array.isArray(e) &&
          e.length === 3 &&
          okKey(e[0]) &&
          Number.isFinite(e[1]) &&
          e[1] >= 0 &&
          e[1] <= b[1] + 1e-6 &&
          Number.isInteger(e[2]) &&
          e[2] >= 0 &&
          e[2] < 32,
      )
    );
  }
  // A subject is [hash, lastSeen, builtInAreaBits] plus, when it relates to custom areas, their names.
  function okSubject(s) {
    const custom = s?.[3];
    return (
      Array.isArray(s) &&
      (s.length === 3 || s.length === 4) &&
      typeof s[0] === 'string' &&
      /^[a-f0-9]{16}$/.test(s[0]) &&
      Number.isFinite(s[1]) &&
      Number.isInteger(s[2]) &&
      s[2] >= 0 &&
      s[2] < 1 << IDS.length &&
      (s.length === 3 ||
        (Array.isArray(custom) &&
          custom.length <= MAX_CUSTOM &&
          custom.every((k) => typeof k === 'string' && CUSTOM.test(k)))) &&
      (s[2] > 0 || custom?.length > 0)
    );
  }
  function bound(st, now) {
    st.minutes = st.minutes
      .filter((b) => decay(lastAt(b), now) > 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, MINUTES);
    st.subjects = st.subjects
      .filter((s) => decay(s[1], now) > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SUBJECTS);
    return st;
  }
  /** A validated, time-bounded copy of stored version-2 state. Invalid parts are dropped. */
  function tidy(stored, now) {
    const minutes = new Map();
    for (const b of Array.isArray(stored.minutes) ? stored.minutes : [])
      if (okBucket(b) && !minutes.has(b[0]))
        minutes.set(b[0], [b[0], b[1], b[2], b[3].map((e) => [...e]).sort(order)]);
    const r = stored.recent;
    return bound(
      {
        version: VERSION,
        minutes: [...minutes.values()],
        subjects: (Array.isArray(stored.subjects) ? stored.subjects : [])
          .filter(okSubject)
          .map((s) => (s.length === 4 ? [s[0], s[1], s[2], [...s[3]]] : [...s])),
        recent:
          Array.isArray(r) && Number.isInteger(r[0]) && Array.isArray(r[1])
            ? [
                r[0],
                r[1].filter((k) => typeof k === 'string' && k.length <= 24).slice(0, SEEN),
                Number.isInteger(r[2]) ? r[2] : 0,
              ]
            : null,
      },
      now,
    );
  }
  function bucket(st, minute) {
    let b = st.minutes.find((x) => x[0] === minute);
    if (!b) st.minutes.push((b = [minute, 0, 0, []]));
    return b;
  }
  function credit(b, key, weight, modes) {
    let e = b[3].find((x) => x[0] === key);
    if (!e) {
      b[3].push((e = [key, 0, 0]));
      b[3].sort(order);
    }
    e[1] = r3(Math.min(b[1], e[1] + weight));
    e[2] |= modes;
  }
  function same(s, subject, mask, custom) {
    return s[0] === subject && s[2] === mask && (s[3] || []).join(',') === custom.join(',');
  }
  function remember(st, subject, at, mask, custom = []) {
    const known = st.subjects.find((s) => same(s, subject, mask, custom));
    if (known) known[1] = Math.max(known[1], at);
    else st.subjects.push(custom.length ? [subject, at, mask, [...custom]] : [subject, at, mask]);
  }
  /** Converts version-1 samples. Scores from the result equal version-1 scores for the same samples. */
  function migrate(samples) {
    const st = empty();
    for (const s of Array.isArray(samples) ? samples : []) {
      if (!shape(s)) continue;
      const at = Math.floor(s[0]),
        minute = Math.floor(at / 60),
        w = WEIGHTS[s[2]],
        b = bucket(st, minute);
      b[1] = r3(b[1] + w);
      b[2] = Math.max(b[2], at - minute * 60);
      if (s[2] !== 'failed')
        for (let bit = 0; bit < IDS.length; bit++)
          if (s[3] & (1 << bit)) credit(b, bit, w * (s[4] & (1 << bit) ? 1 : LEGACY), MODES[s[2]]);
      if (s[3] && s[2] !== 'failed') remember(st, s[1], at, s[3]);
    }
    st.minutes.sort((a, b) => b[0] - a[0]);
    return st;
  }
  // ------------------------------------------------------------------------------------------
  // Version 3: progress that is kept. Evidence accumulates per area and fades only as the chat does
  // other work, never with time, so an idle or older chat keeps its focus.
  //   { version: 3, work, areas: [[key, mass, actionBits, lastAt]…], open: minute bucket | null,
  //     subjects: [[subjectHash, lastSeen, areaBits, customNames?]…], recent }

  function empty3() {
    return { version: 3, work: 0, areas: [], open: null, subjects: [], recent: null };
  }
  function okArea(e) {
    return (
      Array.isArray(e) &&
      e.length === 4 &&
      okKey(e[0]) &&
      Number.isFinite(e[1]) &&
      e[1] >= 0 &&
      e[1] < 1e7 &&
      Number.isInteger(e[2]) &&
      e[2] >= 0 &&
      e[2] < 32 &&
      Number.isFinite(e[3])
    );
  }
  function bound3(st) {
    st.areas = st.areas.filter((e) => e[1] >= 1e-3).sort(order);
    st.subjects = st.subjects.sort((a, b) => b[1] - a[1]).slice(0, SUBJECTS);
    return st;
  }
  /** A validated copy of stored version-3 state. Invalid parts are dropped. */
  function tidy3(stored) {
    const areas = new Map();
    for (const e of Array.isArray(stored.areas) ? stored.areas : [])
      if (okArea(e) && !areas.has(e[0])) areas.set(e[0], [...e]);
    const r = stored.recent;
    return bound3({
      version: 3,
      work: Number.isFinite(stored.work) && stored.work >= 0 && stored.work < 1e7 ? stored.work : 0,
      areas: [...areas.values()].slice(0, IDS.length + MAX_CUSTOM),
      open: okBucket(stored.open)
        ? [
            stored.open[0],
            stored.open[1],
            stored.open[2],
            stored.open[3].map((e) => [...e]).sort(order),
          ]
        : null,
      subjects: (Array.isArray(stored.subjects) ? stored.subjects : [])
        .filter(okSubject)
        .map((x) => (x.length === 4 ? [x[0], x[1], x[2], [...x[3]]] : [...x])),
      recent:
        Array.isArray(r) && Number.isInteger(r[0]) && Array.isArray(r[1])
          ? [
              r[0],
              r[1].filter((k) => typeof k === 'string' && k.length <= 24).slice(0, SEEN),
              Number.isInteger(r[2]) ? r[2] : 0,
            ]
          : null,
    });
  }
  /**
   * Folds a finished minute into the accumulators. The minute is capped (a burst of files cannot
   * outweigh one change), then all earlier evidence fades in proportion to this minute's work.
   */
  function close(st) {
    const b = st.open;
    st.open = null;
    if (!b || !(b[1] > 0)) return st;
    const cap = Math.min(1, CAP / b[1]),
      work = b[1] * cap,
      fade = Math.pow(2, -work / HALF_WORK),
      at = b[0] * 60 + b[2];
    st.work = r3(st.work * fade + work);
    for (const e of st.areas) e[1] = e[1] * fade;
    for (const [key, weight, modes] of b[3]) {
      let e = st.areas.find((x) => x[0] === key);
      if (!e) st.areas.push((e = [key, 0, 0, 0]));
      e[1] += weight * cap;
      e[2] |= modes;
      e[3] = Math.max(e[3], at);
    }
    for (const e of st.areas) e[1] = r3(e[1]);
    return bound3(st);
  }
  function copy3(st) {
    return tidy3(JSON.parse(JSON.stringify(st)));
  }
  /**
   * Adds observations { at, subject, kind, fail, areas: [[areaId, confidence]…] } to state.
   * Repeats of the same subject, action and areas within the newest minute count once, and a
   * minute can add at most eight new subjects to breadth. Work no area recognises counts a
   * quarter towards the whole, so gaps in recognition barely dilute recognised work.
   */
  function observe(st, list, now) {
    for (const o of list || []) {
      if (!o || typeof o.subject !== 'string' || !/^[a-f0-9]{16}$/.test(o.subject)) continue;
      if (!Object.hasOwn(WEIGHTS, o.kind)) continue;
      const at = Math.floor(o.at);
      if (!Number.isFinite(at) || at <= 0 || at > now + 5) continue;
      const minute = Math.floor(at / 60),
        gains = [],
        custom = [];
      let mask = 0;
      if (o.kind !== 'failed')
        for (const [id, c] of Array.isArray(o.areas) ? o.areas : []) {
          const k = keyOf(id),
            conf = Math.min(1, Number(c));
          if (k === null || !(conf > 0) || gains.some((g) => g[0] === k)) continue;
          if (typeof k === 'number') mask |= 1 << k;
          else if (custom.length < MAX_CUSTOM) custom.push(k);
          else continue;
          gains.push([k, conf]);
        }
      custom.sort();
      const key =
        o.subject.slice(0, 8) +
        o.kind.charAt(0) +
        (o.fail ? '!' : '') +
        mask.toString(36) +
        (custom.length ? '+' + fingerprint(custom.join(',')) : '');
      if (!st.recent || st.recent[0] < minute) st.recent = [minute, [], 0];
      const current = st.recent[0] === minute;
      if (current) {
        if (st.recent[1].includes(key)) continue;
        if (st.recent[1].length < SEEN) st.recent[1].push(key);
      }
      // A late observation from an earlier minute is folded on its own.
      const late = st.open && minute < st.open[0] ? st.open : null;
      if (late) st.open = null;
      if (st.open && minute > st.open[0]) close(st);
      if (!st.open) st.open = [minute, 0, 0, []];
      const b = st.open,
        w = WEIGHTS[o.kind];
      b[1] = r3(b[1] + (gains.length ? w : w * UNKNOWN));
      b[2] = Math.max(b[2], at - minute * 60);
      for (const [k, conf] of gains)
        credit(b, k, w * conf, MODES[o.kind] | (o.fail ? MODES.fail : 0));
      if (mask || custom.length) {
        const known = st.subjects.some((x) => same(x, o.subject, mask, custom));
        if (known || !current || st.recent[2] < NEW_SUBJECTS) {
          remember(st, o.subject, at, mask, custom);
          if (!known && current) st.recent[2]++;
        }
      }
      if (late) {
        close(st);
        st.open = late;
      }
    }
    return bound3(st);
  }
  function observation(p, areas, at) {
    const kind = kindOf(p.stage);
    return {
      at,
      subject: p.id || p.key,
      kind,
      fail: p.stage === 'Check failed',
      // Recorded evidence carries its own areas, including custom ones; older evidence is matched.
      areas:
        kind === 'failed'
          ? []
          : Array.isArray(p.areas)
            ? p.areas
                .filter((a) => Array.isArray(a) && keyOf(a[0]) !== null && Number.isFinite(a[1]))
                .map((a) => [a[0], Math.max(0, Math.min(1, a[1]))])
                .filter(([, c]) => c > 0)
            : areas.map((a) => [a.id, confidence(a, p)]).filter(([, c]) => c > 0),
    };
  }
  /** Replays version-2 minute buckets, oldest first, into version-3 progress. */
  function fromMinutes(stored) {
    const st = empty3();
    const minutes = (Array.isArray(stored.minutes) ? stored.minutes : [])
      .filter(okBucket)
      .sort((a, b) => a[0] - b[0]);
    for (const b of minutes) {
      st.open = [b[0], b[1], b[2], b[3].map((e) => [...e])];
      close(st);
    }
    st.subjects = (Array.isArray(stored.subjects) ? stored.subjects : [])
      .filter(okSubject)
      .map((x) => (x.length === 4 ? [x[0], x[1], x[2], [...x[3]]] : [...x]));
    return bound3(st);
  }
  function toV3(a) {
    if (a?.version === 3) return tidy3(a);
    if (a?.version === 2) return fromMinutes(a);
    if (a?.version === 1 && Array.isArray(a.samples)) return fromMinutes(migrate(a.samples));
    return null;
  }
  /** Current progress for a chat, migrating earlier versions or bare evidence points. */
  function state(thread, areas, now) {
    const migrated = toV3(thread?.attention);
    if (migrated && (migrated.areas.length || migrated.open || !thread?.points?.length))
      return migrated;
    // Older caches may have expired their history but kept latest-per-subject evidence: count
    // each piece once, and do not invent repeated work.
    return observe(
      empty3(),
      (thread?.points || [])
        .filter((p) => p && p.stage !== 'Planned' && (p.id || p.key))
        .sort((a, b) => a.at - b.at)
        .map((p) => observation(p, areas, p.at)),
      now,
    );
  }
  /**
   * Combines stored progress from a chat and its subagents: their work and evidence add up.
   * Returns null when none of them stored any.
   */
  function merge(list) {
    const out = empty3();
    let any = false;
    for (const a of list || []) {
      const st = toV3(a);
      if (!st) continue;
      any = true;
      close(st);
      out.work = r3(out.work + st.work);
      for (const [key, mass, modes, at] of st.areas) {
        let e = out.areas.find((x) => x[0] === key);
        if (!e) out.areas.push((e = [key, 0, 0, 0]));
        e[1] = r3(e[1] + mass);
        e[2] |= modes;
        e[3] = Math.max(e[3], at);
      }
      for (const x of st.subjects) remember(out, x[0], x[1], x[2], x[3] || []);
    }
    return any ? bound3(out) : null;
  }
  /**
   * Score = 100 × (1 − e^(−M / 20)) × (0.8 + 0.2 × √S): M is the area's kept evidence and S its
   * share of the chat's work. Evidence builds gradually; being a side topic lowers it by at most 20%.
   */
  function score(input, areaId, now) {
    const st = Array.isArray(input)
      ? fromMinutes(migrate(input.filter(shape)))
      : input?.version === 3
        ? input
        : toV3(input) || empty3();
    const view = st.open ? close(copy3(st)) : st,
      key = keyOf(areaId),
      e = key === null ? null : view.areas.find((x) => x[0] === key);
    const mass = e ? e[1] : 0,
      share = view.work > 0 ? Math.min(1, mass / view.work) : 0;
    const value =
      mass > 0
        ? Math.round(
            100 * (1 - Math.exp(-mass / SATURATION)) * (FLOOR + (1 - FLOOR) * Math.sqrt(share)),
          )
        : 0;
    const relates = (x) =>
      typeof key === 'number' ? x[2] & (1 << key) : (x[3] || []).includes(key);
    const at = e ? e[3] : 0;
    return {
      score: value,
      share: Math.round(share * 100),
      breadth: key === null ? 0 : new Set(view.subjects.filter(relates).map((x) => x[0])).size,
      modes: e ? MODE_ORDER.filter((m) => e[2] & MODES[m]) : [],
      at,
      // Colour shows how recent the evidence is; the score itself does not fade with time.
      heat: decay(at, now) * (0.65 + (0.35 * value) / 100),
    };
  }
  function chatHeat(thread, now = Date.now() / 1000) {
    return decay(
      thread.lastActiveAt || thread.lastToolAt || (thread.status === 'active' ? thread.updated : 0),
      now,
    );
  }
  const api = {
    IDS,
    LIMIT,
    WINDOW,
    HALF_LIFE,
    VERSION,
    MINUTES,
    SUBJECTS,
    CAP,
    HALF_WORK,
    SATURATION,
    FLOOR,
    UNKNOWN,
    WEIGHTS,
    decay,
    confidence,
    matches,
    kindOf,
    sample,
    retain,
    history,
    migrate,
    observe,
    observation,
    state,
    merge,
    score,
    chatHeat,
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Attention = api;
})(typeof window === 'undefined' ? globalThis : window);
