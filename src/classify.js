'use strict';
/* Turns one hook event into bounded evidence: what the tool did (inspect, change, run a check),
   which workspace paths it touched, and which focus areas that work relates to, each with a
   confidence and a short reason. It reads tool names, paths and recognised commands only: never
   code bodies, tool output, prompts or transcripts. */
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const lexicon = require('./lexicon');
const shell = require('./shell');
const { subject } = require('./topics');
const { failed } = require('./adapters');
const areas = require('./focus-areas.json');
const taxonomy = lexicon.taxonomy;
// A context names the kind of work, so it must be reasonably clear before it counts. Concerns
// describe qualities that can apply to any work, so a weaker signal may contribute a little.
const CONTEXT_FLOOR = 0.5,
  CONCERN_FLOOR = 0.4,
  // Tool and script names are less specific than a file path.
  TOOL_FACTOR = 0.8,
  SCRIPT_FACTOR = 0.8,
  MAX_SIGNALS = 20,
  MAX_AREAS = 6,
  MAX_CUSTOM = 3,
  // A sensitive change needs strong, whole-word path evidence (a compound word such as useAuth is not enough).
  SENSITIVE_FLOOR = 0.8,
  CUSTOM_FLOOR = 0.5;
const SENSITIVE = new Map((taxonomy.sensitive || []).map((r) => [r.id, r]));
const LEVEL = lexicon.LEVELS;
const ORDER = taxonomy.contexts.map((c) => c.id);
const CHECK_REASON = {
  test: 'recognised test run',
  static: 'recognised static check',
  benchmark: 'recognised benchmark',
  security: 'recognised security scan',
  build: 'recognised build',
  accessibility: 'recognised accessibility check',
  docs: 'recognised documentation build',
};
const set = (s) => new Set(s.split(' '));
const TOOLS = {
  read: set(
    'read read_file readfile read_text_file read_media_file read_multiple_files notebookread view view_file view_image open_file get_file_contents fs_read file_read readmcpresourcetool read_resource',
  ),
  search: set(
    'grep glob ls list_dir list_directory list_files directory_tree codebase_search grep_search grep_files file_search glob_file_search search_files find_files semantic_search read_lints',
  ),
  change: set(
    'edit write multiedit notebookedit edit_notebook apply_patch edit_file write_file create_file delete_file delete move_file rename_file search_replace str_replace create_directory patch',
  ),
  shell: set(
    'bash shell exec_command shell_command run_terminal_cmd local_shell run_shell_command execute_command run_command terminal powershell',
  ),
  plan: set('update_plan todowrite todo_write write_todos'),
  // Coordination tools record no work of their own; subagents report their own tool events.
  meta: set(
    'task agent askuserquestion exitplanmode enterplanmode toolsearch skill slashcommand bashoutput taskoutput killshell killbash taskstop listmcpresourcestool request_user_input fetch_rules update_memory schedulewakeup croncreate crondelete cronlist sendmessage pushnotification monitor',
  ),
  web: set('websearch webfetch web_search web_fetch fetch browse search_web web_search_preview'),
  editor: set('str_replace_editor str_replace_based_edit_tool text_editor'),
};
const CHANGE_WORDS = set(
  'write edit create update delete remove move rename replace insert patch append save',
);
const READ_WORDS = set('read view get open show list search find grep glob cat tree stat');
const PATH_KEYS = [
  'file_path',
  'path',
  'filename',
  'image_path',
  'notebook_path',
  'target_file',
  'target_notebook',
  'target_directory',
  'relative_workspace_path',
  'dir_path',
  'directory',
  'file',
  'source_path',
  'destination_path',
  'old_path',
  'new_path',
  'uri',
];
const LIST_KEYS = ['paths', 'files', 'file_paths', 'target_files'];
// Generated, vendored and dependency folders are not the project's own work.
const EXCLUDED = set(
  'node_modules .git dist .next .nuxt .svelte-kit .output coverage __pycache__ .venv venv .tox .turbo .cache .pytest_cache .mypy_cache .ruff_cache DerivedData Pods bower_components vendor .gradle .parcel-cache .yarn',
);

// Well-known credential shapes. Titles, labels and paths pass through clean() before storage.
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk-|sk_|rk_|pk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|npm_|AIza)[\w-]{6,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{6,}/g,
  /\b(?:Bearer|Basic)\s+[\w.~+/-]{8,}=*/gi,
];
function clean(value, max = 120) {
  let s = String(value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    // A bounded scheme keeps this linear: an unbounded one rescans long words from every start.
    .replace(/\b[a-z][a-z0-9+.-]{1,20}:\/\/\S+/gi, '[link]');
  for (const re of SECRETS) s = s.replace(re, '[redacted]');
  return s
    .replace(
      /\b(password|passwd|token|secret|api.?key|access.?key|private.?key|client.?secret)\s*[:=]\s*\S+/gi,
      '$1=[redacted]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
// Long paths keep their start and their file name.
function shorten(value, max = 140) {
  const s = String(value);
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.35);
  return s.slice(0, head) + '…' + s.slice(s.length - (max - head - 1));
}
function sessionKey(agent, event) {
  if (
    typeof event.session_id !== 'string' ||
    !event.session_id ||
    typeof event.cwd !== 'string' ||
    !path.isAbsolute(event.cwd)
  )
    return null;
  // Codex subagents may share a parent session id. Keep explicit agent ids separate when supplied.
  return crypto
    .createHash('sha256')
    .update(
      [
        agent,
        event.session_id.slice(0, 128),
        typeof event.agent_id === 'string' ? event.agent_id.slice(0, 128) : '',
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 20);
}
function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}
/**
 * Resolves a target against the workspace (and an optional command working directory).
 * Returns { rel, inside, value } where value is what classification may read: the relative
 * path inside the workspace, or only the file name outside it, so directory names outside the
 * project never create claims.
 */
function normalise(raw, cwd, prefix = '') {
  let p = String(raw)
    .replace(/^file:\/\//, '')
    .replaceAll('\\', '/')
    .trim();
  if (!p || p.length > 2048) return null;
  const absolute = (s) => /^([A-Za-z]:)?\//.test(s);
  const root = String(cwd || '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '');
  if (!p.startsWith('~') && !absolute(p) && prefix)
    p = String(prefix).replace(/\/+$/, '') + '/' + p;
  let inside = !absolute(p) && !p.startsWith('~');
  if (absolute(p) && root) {
    const fold = (s) => s.replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':');
    if (fold(p) === fold(root)) return null;
    if (fold(p).startsWith(fold(root) + '/')) {
      p = p.slice(root.length + 1);
      inside = true;
    }
  }
  const lead = inside ? '' : p.match(/^(([A-Za-z]:)?\/|~\/?)/)?.[0] || '';
  const parts = [];
  for (const s of p.slice(lead.length).split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop();
      else {
        parts.push('..');
        inside = false;
      }
    } else parts.push(s);
  }
  if (!parts.length) return null;
  const last = parts.at(-1);
  if (parts.some((s) => EXCLUDED.has(s)) || /\.(min\.js|min\.css|map)$/i.test(last)) return null;
  const t = parts.indexOf('target');
  if (t >= 0 && ['debug', 'release'].includes(parts[t + 1])) return null;
  const clear = parts.filter((s) => s !== '..');
  return {
    rel: lead + parts.join('/'),
    inside,
    value: inside ? clear.join('/') : clear.slice(-1).join('/'),
  };
}
// Paths outside the workspace show the home folder as ~, so shared screenshots and reports do
// not carry a user name.
const HOME = (() => {
  try {
    return os.homedir().replaceAll('\\', '/').replace(/\/+$/, '');
  } catch {
    return '';
  }
})();
function display(target) {
  if (target.inside || !HOME || HOME.length < 2) return target.rel;
  const fold = (s) => (/^[A-Za-z]:/.test(s) ? s.toLowerCase() : s);
  return fold(target.rel).startsWith(fold(HOME) + '/')
    ? '~' + target.rel.slice(HOME.length)
    : target.rel;
}
function shortName(tool) {
  return (
    tool
      .split(/__|[.:/]/)
      .filter(Boolean)
      .pop() || ''
  ).toLowerCase();
}
function toolKind(tool, short, inp) {
  if (tool === 'container.exec' || TOOLS.shell.has(short)) return 'shell';
  if (TOOLS.plan.has(short)) return 'plan';
  if (TOOLS.meta.has(short) && !tool.startsWith('mcp__')) return 'meta';
  if (TOOLS.editor.has(short)) return inp.command === 'view' ? 'read' : 'change';
  if (TOOLS.change.has(short)) return 'change';
  if (TOOLS.read.has(short) || TOOLS.search.has(short)) return 'read';
  if (TOOLS.web.has(short)) return 'web';
  const words = short.split(/[^a-z0-9]+/);
  if (/screenshot|snapshot/.test(short) || words.includes('read')) return 'read';
  const targeted =
    PATH_KEYS.some((k) => typeof inp[k] === 'string') ||
    LIST_KEYS.some((k) => Array.isArray(inp[k]));
  if (targeted && words.some((w) => CHANGE_WORDS.has(w))) return 'change';
  if (targeted && words.some((w) => READ_WORDS.has(w))) return 'read';
  return 'other';
}
function inputTargets(inp, tool, short, kind) {
  const out = [];
  const add = (v) => {
    if (typeof v === 'string' && v && v.length <= 2048 && !/^(https?|data|mailto):/i.test(v))
      out.push(v);
  };
  for (const k of PATH_KEYS) add(inp[k]);
  for (const k of LIST_KEYS)
    if (Array.isArray(inp[k]))
      for (const v of inp[k].slice(0, 20)) add(typeof v === 'string' ? v : v?.path || v?.file_path);
  if (Array.isArray(inp.edits))
    for (const e of inp.edits.slice(0, 20)) add(e?.file_path || e?.path);
  // A glob pattern names the files being searched for, such as **/*.test.ts.
  if (kind === 'read' && ['glob', 'glob_file_search', 'file_search'].includes(short))
    add(inp.pattern || inp.glob_pattern);
  if (kind === 'read' && ['grep', 'grep_search', 'search_files'].includes(short)) add(inp.glob);
  const patch = inp.patch || (/patch/i.test(tool) ? inp.input || inp.command : '');
  if (typeof patch === 'string') {
    const text = patch.slice(0, 65536);
    const named = [
      ...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm),
    ];
    const diff = named.length
      ? []
      : [...text.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm)].filter(
          (m) => m[1] !== '/dev/null',
        );
    out.push(...[...named, ...diff].slice(0, 20).map((m) => m[1].trim()));
  }
  return out.slice(0, 40);
}
/** Maps combined signals to focus areas: [[areaId, confidence, reason], …] in area order. */
function areasFor(sig, level = 'standard') {
  const out = [],
    at = LEVEL[level] ?? 0;
  for (const area of areas) {
    let best = [0, ''];
    if (sig.check && (area.checks || []).includes(sig.check))
      best = [1, CHECK_REASON[sig.check] || 'recognised check'];
    // Higher stakes can widen what an area covers, such as safety logic counting as reliability.
    const extra = Object.entries(area.stakes || {})
      .filter(([name]) => (LEVEL[name] ?? 9) <= at)
      .flatMap(([, more]) => more.concerns || []);
    for (const id of area.contexts || []) {
      const v = sig.contexts.get(id);
      if (v && v[0] >= CONTEXT_FLOOR && v[0] > best[0]) best = v;
    }
    for (const id of [...(area.concerns || []), ...extra]) {
      const v = sig.concerns.get(id);
      if (v && v[0] >= CONCERN_FLOOR && v[0] > best[0]) best = v;
    }
    if (best[0] > 0)
      out.push([area.id, Math.round(best[0] * 1000) / 1000, String(best[1]).slice(0, 48)]);
  }
  // Work that seems to touch everything says little about any one area: keep the strongest six.
  const strongest = (list, max) => {
    if (list.length <= max) return list;
    const keep = new Set(
      list
        .slice()
        .sort((a, b) => b[1] - a[1])
        .slice(0, max)
        .map((a) => a[0]),
    );
    return list.filter((a) => keep.has(a[0]));
  };
  // Custom areas are counted separately, so built-in and custom areas never crowd each other out.
  const custom = [...(sig.custom || new Map())]
    .filter(([, [w]]) => w >= CUSTOM_FLOOR)
    .map(([id, [w, why]]) => [id, Math.round(w * 1000) / 1000, String(why).slice(0, 48)]);
  return [...strongest(out, MAX_AREAS), ...strongest(custom, MAX_CUSTOM)];
}
// Reads one value with the built-in vocabulary at the project's stakes, and with its custom areas.
function read(value, source, factor, ctx) {
  const result = lexicon.match(value, source, factor, ctx?.level);
  if (ctx?.custom) result.custom = lexicon.run(ctx.custom.index, value, source, factor).custom;
  return result;
}
// A listed script or task name is direct evidence for a custom area, like a recognised check.
function commandAreas(names, ctx) {
  const out = new Map();
  for (const area of ctx?.custom?.areas || [])
    for (const name of names || [])
      if (area.commands.has(String(name).toLowerCase()))
        out.set(area.id, [1, `“${String(name).slice(0, 30)}” command`]);
  return out;
}
function combine(lex, explicit) {
  const contexts = new Map(),
    concerns = new Map(),
    sensitive = new Map(),
    custom = new Map();
  const add = (map, id, w, why) => {
    const prev = map.get(id);
    // Independent sources combine as a noisy-OR; the strongest one explains the result.
    if (!prev) map.set(id, [w, why, w]);
    else
      map.set(id, [
        1 - (1 - prev[0]) * (1 - w),
        prev[2] >= w ? prev[1] : why,
        Math.max(prev[2], w),
      ]);
  };
  for (const r of lex) {
    for (const [id, [w, why]] of r.contexts) add(contexts, id, w, why);
    for (const [id, [w, why]] of r.concerns) add(concerns, id, w, why);
    for (const [id, [w, why]] of r.sensitive || []) add(sensitive, id, w, why);
    for (const [id, [w, why]] of r.custom || []) add(custom, id, w, why);
  }
  for (const [dim, id, w, why] of explicit || [])
    add(dim === 'contexts' ? contexts : concerns, id, w, why);
  for (const map of [contexts, concerns, sensitive, custom])
    for (const [id, [w, why]] of map)
      map.set(id, [Math.round(Math.min(lexicon.CAP, w) * 1000) / 1000, why]);
  return { contexts, concerns, sensitive, custom };
}
function assemble({
  stage,
  check = null,
  label = '',
  target = null,
  tool,
  lex = [],
  explicit = [],
  names = [],
  ctx = null,
}) {
  const { contexts, concerns, sensitive, custom } = combine(lex, explicit);
  for (const [id, v] of commandAreas(names, ctx)) custom.set(id, v);
  const ranked = [...contexts].sort(
    (a, b) => b[1][0] - a[1][0] || ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]),
  );
  // Plain source files fall back to application work, except test files, which are testing work.
  const isTest = (concerns.get('testing')?.[0] || 0) >= 0.8;
  if (target && !isTest && !ranked.some(([, [w]]) => w >= CONTEXT_FLOOR)) {
    const fb = lexicon.fallbackContext(lex[0]?.ext || '');
    if (fb) ranked.unshift([fb[0], [fb[1], fb[2]]]);
  }
  const sig = {
    contexts: new Map(ranked.filter(([, [w]]) => w >= CONTEXT_FLOOR)),
    concerns: new Map([...concerns].filter(([, [w]]) => w >= CONCERN_FLOOR)),
    custom,
    check,
  };
  // A sensitive change is a change to a workspace file of a risky kind, never a test or document.
  const isDoc =
    (concerns.get('documentation')?.[0] || 0) >= 0.8 ||
    ['md', 'mdx', 'rst', 'txt', 'adoc'].includes(lex[0]?.ext || '');
  const risk =
    stage === 'Changed' && target?.inside && !isTest && !isDoc
      ? [...sensitive]
          .filter(([, [w]]) => w >= SENSITIVE_FLOOR)
          .sort((a, b) => b[1][0] - a[1][0])[0]
      : null;
  const topic = subject(target ? target.rel : '', tool, { check, label });
  const recognised = ranked.length || sig.concerns.size;
  return {
    stage,
    detail: target ? shorten(clean(display(target), 512)) : clean(label || tool, 140),
    check,
    tool: clean(tool, 100),
    context: ranked[0]?.[0] || 'other',
    concerns: [...sig.concerns.keys()],
    areas: areasFor(sig, ctx?.level),
    // The areas a sensitive change concerns, plus any custom area the file belongs to.
    ...(risk
      ? {
          sensitive: SENSITIVE.get(risk[0]).label,
          risk: [
            ...SENSITIVE.get(risk[0]).areas,
            ...[...custom].filter(([, [w]]) => w >= CUSTOM_FLOOR).map(([id]) => id),
          ],
        }
      : {}),
    subject: clean(topic.title, 80),
    key: hash(topic.key),
    basis: target
      ? 'Path signal'
      : check
        ? 'Recognised check'
        : explicit.length
          ? 'Command signal'
          : recognised
            ? 'Tool signal'
            : 'Unclassified tool',
  };
}
const PRIORITY = [
  'Check failed',
  'Check run',
  'Changed',
  'Inspected',
  'Command run',
  'Tool used',
  'Tool failed',
];
const SHELL_STAGE = {
  read: 'Inspected',
  change: 'Changed',
  check: 'Check run',
  run: 'Command run',
};
function shellSignals(inp, tool, cwd, ctx) {
  const command = inp.command ?? inp.cmd;
  const workdir = [inp.workdir, inp.cwd, inp.working_directory].find((v) => typeof v === 'string');
  const out = [];
  for (const seg of shell.parse(command, 0, { prefix: workdir || '' })) {
    const stage = SHELL_STAGE[seg.action] || 'Command run';
    const names = seg.names.map((n) => read(n, 'script', SCRIPT_FACTOR, ctx));
    const common = {
      check: seg.check,
      label: seg.label,
      tool,
      explicit: seg.signals,
      names: seg.names,
      ctx,
    };
    const targets = seg.targets.map((t) => normalise(t, cwd, seg.prefix)).filter(Boolean);
    for (const t of targets)
      out.push(
        assemble({ ...common, stage, target: t, lex: [read(t.value, 'path', 1, ctx), ...names] }),
      );
    if (!targets.length) out.push(assemble({ ...common, stage, lex: names }));
    for (const r of seg.reads.map((t) => normalise(t, cwd, seg.prefix)).filter(Boolean))
      out.push(
        assemble({
          stage: 'Inspected',
          tool,
          target: r,
          lex: [read(r.value, 'path', 1, ctx)],
          ctx,
        }),
      );
  }
  return out;
}
/**
 * Evidence for one hook event. profile is the workspace's focus profile ({ stakes, custom }), or
 * null for standard stakes and no custom areas.
 */
function evidence(event, profile = null) {
  const ctx = { level: profile?.stakes || 'standard', custom: profile?.custom || null };
  const tool = String(event.tool_name || '').slice(0, 180),
    short = shortName(tool);
  const inp =
    typeof event.tool_input === 'string'
      ? { patch: event.tool_input }
      : event.tool_input && typeof event.tool_input === 'object' && !Array.isArray(event.tool_input)
        ? event.tool_input
        : {};
  const cwd = String(event.cwd || ''),
    kind = toolKind(tool, short, inp);
  if (kind === 'plan') {
    const list = inp.plan || inp.todos || [];
    const concerns = new Set();
    for (const item of Array.isArray(list) ? list.slice(0, 20) : [])
      if (item && typeof item === 'object')
        for (const [id, [w]] of lexicon.match(
          String(item.step || item.content || '').slice(0, 200),
          'plan',
          1,
          ctx.level,
        ).concerns)
          if (w >= CONCERN_FLOOR) concerns.add(id);
    return {
      plannedConcerns: [...concerns],
      stage: 'Planned',
      detail: 'Explicit task plan',
      tool: clean(tool, 100),
      signals: [],
    };
  }
  if (kind === 'meta')
    return {
      stage: 'Tool used',
      meta: true,
      detail: clean(tool, 140),
      tool: clean(tool, 100),
      signals: [],
    };
  let signals = [];
  if (kind === 'shell') signals = shellSignals(inp, tool, cwd, ctx);
  else {
    const stage = kind === 'read' ? 'Inspected' : kind === 'change' ? 'Changed' : 'Tool used';
    const seen = new Set(),
      targets = [];
    for (const t of inputTargets(inp, tool, short, kind)) {
      const n = normalise(t, cwd);
      if (n && !seen.has(n.rel) && targets.length < MAX_SIGNALS) {
        seen.add(n.rel);
        targets.push(n);
      }
    }
    // Browser tools show the running interface; their server names ("playwright") are not testing.
    const visual = /browser|screenshot|snapshot|figma|chrome|puppeteer/i.test(tool);
    const explicit = visual
      ? [['contexts', 'experience', 0.75, 'browser or visual tool']]
      : kind === 'web'
        ? [['contexts', 'knowledge', 0.75, 'research tool']]
        : [];
    const builtin = kind !== 'other' || visual;
    const toolText = tool
      .replace(/^mcp__/, '')
      .replace(/^functions\./, '')
      .replace(/__/g, ' ');
    const named = builtin ? [] : [read(toolText, 'tool', TOOL_FACTOR, ctx)];
    for (const t of targets)
      signals.push(
        assemble({
          stage,
          tool,
          target: t,
          lex: [read(t.value, 'path', 1, ctx), ...named],
          explicit,
          ctx,
        }),
      );
    if (!targets.length) signals.push(assemble({ stage, tool, lex: named, explicit, ctx }));
  }
  if (!signals.length) signals.push(assemble({ stage: 'Command run', tool }));
  if (failed(event))
    for (const s of signals) {
      // A check that reports failure still shows attention to what it checks; other failures earn nothing.
      if (s.check) s.stage = 'Check failed';
      else {
        Object.assign(s, { stage: 'Tool failed', areas: [] });
        delete s.sensitive;
        delete s.risk;
      }
    }
  const unique = new Map();
  for (const s of signals) if (!unique.has(s.key + s.stage)) unique.set(s.key + s.stage, s);
  signals = [...unique.values()].slice(0, MAX_SIGNALS);
  const primary = signals
    .slice()
    .sort((a, b) => PRIORITY.indexOf(a.stage) - PRIORITY.indexOf(b.stage))[0];
  return { ...primary, signals: signals.map((s) => ({ ...s })) };
}
/**
 * Adds area confidences to evidence recorded by an earlier version, which stored only a context,
 * concerns and a check. Its displayed path is re-read with the current vocabulary.
 */
function upgradePoint(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p.areas)) return p;
  if (p.stage === 'Tool failed' || p.stage === 'Planned') return { ...p, areas: [] };
  const legacy = {
    contexts: new Map(
      p.context && p.context !== 'other' ? [[p.context, [0.75, 'earlier classification']]] : [],
    ),
    concerns: new Map(
      (Array.isArray(p.concerns) ? p.concerns : []).map((c) => [
        c,
        [0.75, 'earlier classification'],
      ]),
    ),
  };
  const lex = [legacy];
  if (p.basis === 'Path signal' && typeof p.detail === 'string' && !p.detail.includes('…')) {
    const n = normalise(p.detail, '');
    if (n) lex.unshift(lexicon.match(n.value, 'path'));
  }
  const { contexts, concerns } = combine(lex, []);
  return {
    ...p,
    areas: areasFor({
      contexts: new Map([...contexts].filter(([, [w]]) => w >= CONTEXT_FLOOR)),
      concerns: new Map([...concerns].filter(([, [w]]) => w >= CONCERN_FLOOR)),
      check: p.check,
    }),
  };
}
module.exports = {
  taxonomy,
  clean,
  shorten,
  sessionKey,
  evidence,
  areasFor,
  upgradePoint,
  normalise,
};
