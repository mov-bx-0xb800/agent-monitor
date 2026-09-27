'use strict';
/* Deterministic vocabulary matching for paths, tool names and plan text. Each entry carries a
   strength (0–1). Evidence for one context, concern or area combines as a noisy-OR of distinct
   terms, so corroborating words raise confidence without ever reaching certainty.

   The same compiled index serves the built-in taxonomy and user-defined areas. Entries can be
   limited to higher project stakes (production, critical), so specialised vocabulary is inert in
   ordinary projects. User definitions may use globs but never regular expressions; globs are
   matched without backtracking, so a definition from any repository runs in bounded time. */
const taxonomy = require('./taxonomy.json');
const DEFAULT = 0.75,
  // A word found inside a compound name, such as "Auth" in useAuth, is slightly weaker evidence.
  SUBWORD = 0.85,
  CAP = 0.9,
  PHRASE = 4;
const LEVELS = Object.freeze({ standard: 0, production: 1, critical: 2 });
// Mixed-case names would otherwise split into misleading words (OAuth → o, auth).
const MIXED = [
  [/OAuth/g, 'Oauth'],
  [/GraphQL/g, 'Graphql'],
  [/WebAuthn/g, 'Webauthn'],
  [/PostgreSQL/g, 'Postgresql'],
  [/MySQL/g, 'Mysql'],
  [/NoSQL/g, 'Nosql'],
  [/GitHub/g, 'Github'],
  [/GitLab/g, 'Gitlab'],
  [/DynamoDB/g, 'Dynamodb'],
  [/MongoDB/g, 'Mongodb'],
  [/PostHog/g, 'Posthog'],
  [/OpenID/g, 'Openid'],
  [/OpenTelemetry/g, 'Opentelemetry'],
  [/SwiftUI/g, 'Swiftui'],
  [/PyTorch/g, 'Pytorch'],
  [/TensorFlow/g, 'Tensorflow'],
  [/BigQuery/g, 'Bigquery'],
  [/FreeRTOS/g, 'Freertos'],
  [/SCADA/g, 'Scada'],
  [/iOS/g, 'Ios'],
  [/macOS/g, 'Macos'],
];
function entry(value) {
  const at = value.lastIndexOf(':'),
    weight = at > 0 ? Number(value.slice(at + 1)) : NaN;
  return Number.isFinite(weight) ? [value.slice(0, at), weight] : [value, DEFAULT];
}
function add(map, key, hit) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(hit);
}
/** Wildcard match of one path segment (* and ?), linear in practice and never exponential. */
function wild(pattern, text) {
  let i = 0,
    j = 0,
    star = -1,
    mark = 0;
  while (j < text.length) {
    if (i < pattern.length && (pattern[i] === '?' || pattern[i] === text[j])) {
      i++;
      j++;
    } else if (i < pattern.length && pattern[i] === '*') {
      star = i++;
      mark = j;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (pattern[i] === '*') i++;
  return i === pattern.length;
}
/** Matches a glob ("src/ledger/**", "**\/*reconcil*") against path segments by dynamic programming. */
function globMatch(glob, segments) {
  const n = segments.length;
  let next = new Array(n + 1).fill(false);
  next[n] = true;
  for (let i = glob.length - 1; i >= 0; i--) {
    const cur = new Array(n + 1).fill(false);
    for (let j = n; j >= 0; j--)
      cur[j] =
        glob[i] === '**'
          ? next[j] || (j < n && cur[j + 1])
          : j < n && wild(glob[i], segments[j]) && next[j + 1];
    next = cur;
  }
  return next[0];
}
/**
 * Compiles vocabulary groups: { dim, id, level?, terms, production, critical, files,
 * extensions, fallback, patterns (trusted regexes only), globs, unless }.
 */
function compile(groups) {
  const index = {
    words: new Map(),
    phrases: new Map(),
    files: new Map(),
    extensions: new Map(),
    fallback: new Map(),
    patterns: [],
    globs: [],
  };
  for (const def of groups) {
    const base = LEVELS[def.level] ?? 0,
      unless = def.unless || {};
    const hit = (term, w, kind, level) => ({
      dim: def.dim,
      id: def.id,
      w,
      term,
      kind,
      level: Math.max(base, level),
      unless: Object.hasOwn(unless, term) ? new Set(unless[term]) : null,
    });
    for (const [list, level] of [
      ['terms', 0],
      ['production', 1],
      ['critical', 2],
    ])
      for (const value of def[list] || []) {
        const [term, w] = entry(value);
        add(term.includes(' ') ? index.phrases : index.words, term, hit(term, w, 'term', level));
      }
    for (const [list, map] of [
      ['files', index.files],
      ['extensions', index.extensions],
      ['fallback', index.fallback],
    ])
      for (const value of def[list] || []) {
        const [name, w] = entry(value);
        add(map, name, hit(name, w, list === 'files' ? 'file' : 'extension', 0));
      }
    for (const p of def.patterns || [])
      index.patterns.push({
        dim: def.dim,
        id: def.id,
        level: base,
        w: p.w ?? DEFAULT,
        why: p.why || 'path pattern',
        re: new RegExp(p.re, p.flags ?? 'i'),
      });
    for (const value of def.globs || []) {
      const [glob, w] = entry(value);
      index.globs.push({
        dim: def.dim,
        id: def.id,
        level: base,
        w,
        glob: glob.toLowerCase().split('/'),
        why: `path matches “${glob}”`,
      });
    }
  }
  return index;
}
function words(segment) {
  let s = segment;
  for (const [re, to] of MIXED) s = s.replace(re, to);
  const out = [];
  for (const chunk of s.split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue;
    const parts = chunk
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(' ');
    for (const w of parts) out.push({ w, sub: parts.length > 1 });
    // Keep the joined compound too: "rateLimit" can match both "rate limit" and "ratelimit".
    if (parts.length > 1) out.push({ w: chunk.toLowerCase(), sub: false, whole: true });
  }
  return out;
}
function variants(w) {
  const out = [w];
  if (w.length > 3) {
    if (w.endsWith('ies')) out.push(w.slice(0, -3) + 'y');
    if (w.endsWith('es')) out.push(w.slice(0, -2));
    if (w.endsWith('s') && !w.endsWith('ss')) out.push(w.slice(0, -1));
  }
  if (/^[a-z]+\d+$/.test(w)) out.push(w.replace(/\d+$/, ''));
  return out;
}
function lookup(map, w) {
  for (const v of variants(w)) if (map.has(v)) return map.get(v);
  return null;
}
function describe(hit, source) {
  if (hit.kind === 'file') return `known file “${hit.term}”`;
  if (hit.kind === 'extension') return `.${hit.term} file`;
  return source === 'path'
    ? `“${hit.term}” in path`
    : source === 'tool'
      ? `“${hit.term}” in tool name`
      : source === 'script'
        ? `“${hit.term}” in command`
        : `“${hit.term}” in plan`;
}
/**
 * Matches a workspace-relative path, tool name, script name or plan text against an index at a
 * stakes level. Returns { contexts, concerns, sensitive, custom: Map(id → [weight, why]), tokens, ext }.
 */
function run(index, value, source = 'path', factor = 1, level = 'standard') {
  const raw = String(value || '').slice(0, 2048),
    isPath = source === 'path',
    at = LEVELS[level] ?? 0;
  const segments = isPath ? raw.split('/').filter((s) => s && s !== '.' && s !== '..') : [raw];
  const base = isPath ? (segments.at(-1) || '').toLowerCase() : '';
  const dot = base.lastIndexOf('.');
  // Dotfiles such as .env have no extension; "archive.tar" does.
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const sequence = [],
    tokens = new Set();
  segments.forEach((segment, i) => {
    const text = i === segments.length - 1 && ext ? segment.slice(0, -(ext.length + 1)) : segment;
    for (const t of words(text)) {
      if (sequence.length >= 256) return;
      tokens.add(t.w);
      sequence.push(t.whole ? { ...t, compound: true } : t);
    }
  });
  if (ext) tokens.add(ext);
  const hits = [];
  const take = (list, weight = 1, why) => {
    for (const hit of list || []) {
      if (hit.level > at) continue;
      if (hit.unless && [...hit.unless].some((u) => tokens.has(u))) continue;
      hits.push({ hit, w: hit.w * weight * factor, why: why || describe(hit, source) });
    }
  };
  const plain = sequence.filter((t) => !t.compound);
  for (const t of sequence) take(lookup(index.words, t.w), t.sub ? SUBWORD : 1);
  for (let n = 2; n <= PHRASE; n++)
    for (let i = 0; i + n <= plain.length; i++) {
      const gram = plain.slice(i, i + n),
        head = gram
          .slice(0, -1)
          .map((t) => t.w)
          .join(' ');
      // Only the final word is singularised: "rate limits" is "rate limit".
      for (const last of variants(gram.at(-1).w)) {
        const list = index.phrases.get(head + ' ' + last);
        if (list) {
          take(list, gram.some((t) => t.sub) ? SUBWORD : 1);
          break;
        }
      }
    }
  if (isPath) {
    take(index.files.get(base));
    // A stem only stands for a named file when it is not a dotfile (".env.example" is not ".env").
    if (stem !== base && !base.startsWith('.')) take(index.files.get(stem));
    if (ext) take(index.extensions.get(ext));
    for (const p of index.patterns)
      if (p.level <= at && p.re.test(raw))
        hits.push({ hit: { dim: p.dim, id: p.id, term: p.why }, w: p.w * factor, why: p.why });
    if (index.globs.length) {
      const lower = segments.slice(0, 64).map((s) => s.toLowerCase());
      for (const g of index.globs)
        if (g.level <= at && globMatch(g.glob, lower))
          hits.push({ hit: { dim: g.dim, id: g.id, term: g.why }, w: g.w * factor, why: g.why });
    }
  }
  const result = {
      contexts: new Map(),
      concerns: new Map(),
      sensitive: new Map(),
      custom: new Map(),
      tokens,
      ext,
    },
    seen = new Map();
  for (const { hit, w, why } of hits) {
    const key = hit.dim + '\0' + hit.id + '\0' + hit.term,
      best = seen.get(key);
    // One term counts once, at its strongest occurrence.
    if (!best || best.w < w) seen.set(key, { hit, w, why });
  }
  for (const { hit, w, why } of seen.values()) {
    const map = result[hit.dim],
      prev = map.get(hit.id);
    const combined = prev ? 1 - (1 - prev[0]) * (1 - w) : w;
    map.set(hit.id, [
      Math.min(CAP, combined),
      !prev || w > prev[2] ? why : prev[1],
      Math.max(w, prev?.[2] || 0),
    ]);
  }
  for (const map of [result.contexts, result.concerns, result.sensitive, result.custom])
    for (const [id, [w, why]] of map) map.set(id, [round(w), why]);
  return result;
}
const builtin = compile([
  ...taxonomy.contexts.map((d) => ({ ...d, dim: 'contexts' })),
  ...taxonomy.concerns.map((d) => ({ ...d, dim: 'concerns' })),
  ...(taxonomy.sensitive || []).map((d) => ({ ...d, dim: 'sensitive' })),
]);
/** Matches against the built-in taxonomy. */
function match(value, source = 'path', factor = 1, level = 'standard') {
  return run(builtin, value, source, factor, level);
}
/** Code-extension fallback context, used only when nothing more specific identifies the work. */
function fallbackContext(ext) {
  const hit = builtin.fallback.get(ext)?.[0];
  return hit ? [hit.id, hit.w, `.${ext} file`] : null;
}
function round(n) {
  return Math.round(n * 1000) / 1000;
}
module.exports = {
  match,
  run,
  compile,
  fallbackContext,
  words,
  wild,
  globMatch,
  entry,
  CAP,
  LEVELS,
  taxonomy,
};
