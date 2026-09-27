'use strict';
/* A workspace's focus profile: the project's stakes and its custom focus areas.

   Custom areas are defined in <workspace>/.agent-monitor/focus.json, usually drafted by the
   developer's own agent from docs/CUSTOM-AREAS.md. A definition is data only (words, phrases,
   file names, globs and script names), never code or regular expressions, and it is bounded.
   It must pass its own examples and a breadth check before it can be enabled, and it takes
   effect only after the developer enables that exact content in the editor. The extension then
   copies the validated profile into the collector's cache; hooks never read workspace files.

   Run `node profile.js check [file]` to validate a definition; the exit code is 0 when every
   area is ready. */
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const lexicon = require('./lexicon');
const builtinAreas = require('./focus-areas.json');
const FILE = '.agent-monitor/focus.json';
const STAKES = ['standard', 'production', 'critical'];
const LIMITS = Object.freeze({
  bytes: 65536,
  areas: 8,
  globs: 32,
  terms: 80,
  files: 16,
  commands: 16,
  unless: 32,
  unlessWords: 12,
  examples: 24,
  minExamples: 3,
  profiles: 12,
  cacheBytes: 262144,
});
// A focus area match needs this confidence; an ignored example must stay below the lower floor.
const MATCH = 0.5,
  IGNORE = 0.4,
  BROAD_WARN = 0.08,
  BROAD_FAIL = 0.2;
// Words that appear in almost every project cannot identify one kind of work on their own.
const GENERIC = new Set(
  (
    'src lib libs app apps main index util utils helper helpers common core shared component ' +
    'components api server client test tests spec specs data model models file files code new ' +
    'old tmp temp misc js ts tsx jsx mjs cjs py go rs java kt rb php cs json md txt yaml yml ' +
    'html css scss docs doc public assets config configs dist build vendor module modules ' +
    'package packages service services page pages view views type types style styles script ' +
    'scripts tool tools handler handlers controller controllers route routes store stores ' +
    'hook hooks context state feature features internal pkg cmd bin env default base item items'
  ).split(' '),
);
// Generic project files across stacks, used to measure how much ordinary work a definition claims.
const REFERENCE = (
  'README.md package.json package-lock.json tsconfig.json .gitignore .eslintrc.json LICENSE ' +
  'CHANGELOG.md Dockerfile docker-compose.yml .github/workflows/ci.yml Makefile ' +
  'src/index.ts src/main.ts src/app.ts src/App.tsx src/index.css src/styles/globals.css ' +
  'src/components/Button.tsx src/components/Header.tsx src/components/Footer.tsx ' +
  'src/components/Modal.tsx src/components/Table.tsx src/components/Form.tsx src/components/Nav.tsx ' +
  'src/components/Card.tsx src/components/List.tsx src/components/Avatar.tsx ' +
  'src/pages/index.tsx src/pages/about.tsx src/pages/settings.tsx src/pages/profile.tsx ' +
  'app/page.tsx app/layout.tsx app/settings/page.tsx app/dashboard/page.tsx app/api/users/route.ts ' +
  'app/(marketing)/pricing/page.tsx src/hooks/useUser.ts src/hooks/useFetch.ts src/hooks/useDebounce.ts ' +
  'src/lib/utils.ts src/lib/format.ts src/lib/dates.ts src/lib/http.ts src/lib/logger.ts ' +
  'src/utils/strings.ts src/utils/array.ts src/utils/math.ts src/types/index.ts src/types/user.ts ' +
  'src/config/index.ts src/constants.ts src/router.ts src/store/index.ts src/store/userSlice.ts ' +
  'src/api/client.ts src/api/users.ts src/api/projects.ts src/services/userService.ts ' +
  'src/services/emailService.ts src/services/notificationService.ts src/services/searchService.ts ' +
  'src/models/user.ts src/models/project.ts src/models/comment.ts src/db/client.ts src/db/queries.ts ' +
  'src/server.ts src/routes/users.ts src/routes/health.ts src/middleware/cors.ts src/middleware/errors.ts ' +
  'src/controllers/userController.ts src/controllers/projectController.ts src/jobs/cleanup.ts ' +
  'src/workers/email.ts src/events/emitter.ts src/i18n/en.json src/assets/logo.svg public/favicon.ico ' +
  'tests/unit/utils.test.ts tests/e2e/home.spec.ts src/components/Button.test.tsx ' +
  'src/__tests__/app.test.ts jest.config.js vitest.config.ts playwright.config.ts ' +
  'docs/getting-started.md docs/api.md docs/architecture.md CONTRIBUTING.md ' +
  'scripts/build.js scripts/release.sh scripts/seed.ts .env.example .prettierrc biome.json ' +
  'main.py app/__init__.py app/main.py app/models.py app/views.py app/routes.py app/schemas.py ' +
  'app/services/users.py app/utils.py app/config.py tests/test_main.py tests/test_models.py ' +
  'requirements.txt pyproject.toml setup.py manage.py project/settings.py project/urls.py ' +
  'cmd/server/main.go internal/handlers/users.go internal/store/postgres.go internal/config/config.go ' +
  'pkg/util/strings.go go.mod main_test.go ' +
  'src/main.rs src/lib.rs src/config.rs src/error.rs src/handlers.rs Cargo.toml tests/integration.rs ' +
  'src/main/java/com/example/Application.java src/main/java/com/example/UserController.java ' +
  'src/main/java/com/example/UserService.java src/main/java/com/example/UserRepository.java ' +
  'src/test/java/com/example/UserServiceTest.java pom.xml build.gradle ' +
  'app/controllers/users_controller.rb app/models/user.rb app/views/users/index.html.erb ' +
  'config/routes.rb Gemfile spec/models/user_spec.rb ' +
  'src/Controller/UserController.php composer.json ' +
  'Program.cs Controllers/UsersController.cs Models/User.cs Services/UserService.cs ' +
  'Sources/App/ContentView.swift Sources/App/Models/User.swift Package.swift ' +
  'app/src/main/java/com/example/MainActivity.kt app/src/main/res/layout/activity_main.xml ' +
  'lib/main.dart lib/screens/home_screen.dart pubspec.yaml ' +
  'infra/main.tf k8s/deployment.yaml migrations/001_init.sql prisma/schema.prisma ' +
  'notebooks/exploration.ipynb data/sample.csv models/train.py ' +
  'src/utils/validation.ts src/components/SearchBar.tsx src/components/Sidebar.tsx ' +
  'src/features/profile/ProfileCard.tsx src/features/settings/SettingsForm.tsx ' +
  'src/features/search/results.ts src/features/comments/CommentList.tsx ' +
  'src/lib/cache.ts src/lib/queue.ts src/lib/retry.ts src/lib/auth.ts src/lib/analytics.ts'
).split(' ');

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}
function plain(value, min, max) {
  return (
    typeof value === 'string' &&
    value.trim().length >= min &&
    value.length <= max &&
    !/[\x00-\x1f\x7f<>`]/.test(value)
  );
}
function list(value, max) {
  return Array.isArray(value) && value.length <= max && value.every((v) => typeof v === 'string');
}
function weighted(value) {
  const at = value.lastIndexOf(':'),
    weight = at > 0 ? Number(value.slice(at + 1)) : NaN;
  return Number.isFinite(weight) && /^[\d.]+$/.test(value.slice(at + 1))
    ? [value.slice(0, at), weight]
    : [value, null];
}
/** Checks one glob. Returns an error message or null. */
function globProblem(glob) {
  if (glob.length > 128 || !/^[A-Za-z0-9._\-*?/()[\]@+~ ]+$/.test(glob))
    return 'use letters, digits and . _ - * ? / ( ) [ ] only, at most 128 characters';
  if (glob.startsWith('/') || glob.split('/').some((s) => s === '..' || s === '' || s === '.'))
    return 'use a path relative to the workspace, without leading /, empty segments or ..';
  if ((glob.match(/\*/g) || []).length > 8) return 'use at most eight wildcards';
  if (glob.split('/').some((s) => s.length > 64)) return 'keep each segment under 64 characters';
  const segments = glob.split('/');
  const literal = segments.some((s) => /[A-Za-z0-9]{3,}/.test(s.replace(/\.[a-z0-9]{1,6}$/i, '')));
  if (!literal)
    return 'name a folder or file word; a glob of wildcards and an extension matches everything';
  return null;
}
function termProblem(term) {
  if (!/^[a-z0-9]+( [a-z0-9]+){0,3}$/.test(term))
    return 'use one to four lower-case words of letters and digits';
  if (!term.includes(' ') && term.length < 3) return 'use words of at least three letters';
  if (!term.includes(' ') && GENERIC.has(term))
    return 'is found in almost every project; use a phrase or a more specific word';
  return null;
}
/**
 * Validates the structure of a parsed definition. Returns { errors, warnings, areas } where each
 * area has its own errors. Does not run examples; see check().
 */
function validate(doc) {
  const errors = [],
    warnings = [],
    areas = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    return { errors: ['The file must contain one JSON object.'], warnings, areas };
  if (doc.version !== 1) errors.push('Set "version": 1.');
  if (doc.stakes !== undefined && !STAKES.includes(doc.stakes))
    errors.push(`"stakes" must be one of ${STAKES.join(', ')}.`);
  for (const key of Object.keys(doc))
    if (!['$schema', 'version', 'stakes', 'areas'].includes(key))
      warnings.push(`Unknown field "${key}" is ignored.`);
  if (doc.areas === undefined) doc = { ...doc, areas: [] };
  if (!Array.isArray(doc.areas)) {
    errors.push('"areas" must be a list.');
    return { errors, warnings, areas };
  }
  if (doc.areas.length > LIMITS.areas) errors.push(`Define at most ${LIMITS.areas} areas.`);
  const ids = new Set(),
    builtins = new Set(builtinAreas.map((a) => a.id)),
    labels = new Set(builtinAreas.map((a) => a.label.toLowerCase()));
  for (const [n, area] of doc.areas.slice(0, LIMITS.areas).entries()) {
    const problems = [],
      notes = [],
      a = area && typeof area === 'object' && !Array.isArray(area) ? area : {};
    const id = typeof a.id === 'string' ? a.id : `area ${n + 1}`;
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(a.id || ''))
      problems.push(
        '"id" must be 2–32 lower-case letters, digits and hyphens, starting with a letter.',
      );
    else if (builtins.has(a.id)) problems.push(`"id" "${a.id}" is a built-in area.`);
    else if (ids.has(a.id)) problems.push(`"id" "${a.id}" is used twice.`);
    ids.add(a.id);
    if (!plain(a.label, 2, 32)) problems.push('"label" must be 2–32 characters of plain text.');
    else if (labels.has(a.label.trim().toLowerCase()))
      problems.push(
        `"label" "${a.label}" duplicates a built-in area; describe what is specific to this project.`,
      );
    if (!plain(a.description, 10, 160))
      problems.push('"description" must be one plain sentence of 10–160 characters.');
    else if (/\n|ignore (all|previous)|system prompt|you are |<|>/i.test(a.description))
      problems.push('"description" must describe the work, not instruct an agent.');
    if (a.colour !== undefined && !/^#[0-9a-f]{6}$/i.test(a.colour))
      problems.push('"colour" must be a hex colour such as "#5fb3a1".');
    const s =
      a.signals && typeof a.signals === 'object' && !Array.isArray(a.signals) ? a.signals : null;
    if (!s) problems.push('"signals" must be an object.');
    const paths = s?.paths ?? [],
      terms = s?.terms ?? [],
      files = s?.files ?? [],
      commands = s?.commands ?? [],
      unless = s?.unless ?? {};
    if (s && !list(paths, LIMITS.globs))
      problems.push(`"signals.paths" must be at most ${LIMITS.globs} globs.`);
    if (s && !list(terms, LIMITS.terms))
      problems.push(`"signals.terms" must be at most ${LIMITS.terms} terms.`);
    if (s && !list(files, LIMITS.files))
      problems.push(`"signals.files" must be at most ${LIMITS.files} file names.`);
    if (s && !list(commands, LIMITS.commands))
      problems.push(`"signals.commands" must be at most ${LIMITS.commands} script or task names.`);
    if (s && !paths.length && !terms.length && !files.length)
      problems.push('Give at least one path glob, term or file name.');
    const termNames = new Set();
    for (const value of list(paths, LIMITS.globs) ? paths : []) {
      const [glob, w] = weighted(value);
      const problem = globProblem(glob);
      if (problem) problems.push(`Path "${glob}": ${problem}.`);
      if (w !== null && !(w >= 0.3 && w <= 0.95))
        problems.push(`Path "${glob}": weight must be 0.3–0.95.`);
    }
    for (const value of list(terms, LIMITS.terms) ? terms : []) {
      const [term, w] = weighted(value);
      const problem = termProblem(term);
      if (problem) problems.push(`Term "${term}" ${problem}.`);
      if (w !== null && !(w >= 0.3 && w <= 0.95))
        problems.push(`Term "${term}": weight must be 0.3–0.95.`);
      if (termNames.has(term)) problems.push(`Term "${term}" is listed twice.`);
      termNames.add(term);
    }
    for (const value of list(files, LIMITS.files) ? files : []) {
      const [name] = weighted(value);
      if (!/^[a-z0-9._-]{2,64}$/.test(name))
        problems.push(`File "${name}" must be a lower-case file name without folders.`);
    }
    for (const value of list(commands, LIMITS.commands) ? commands : [])
      if (
        !/^[a-z0-9][a-z0-9:._-]{1,39}$/i.test(value) ||
        GENERIC.has(value.toLowerCase()) ||
        ['test', 'lint', 'build', 'check', 'dev', 'start'].includes(value.toLowerCase())
      )
        problems.push(
          `Command "${value}" must be a specific script or task name, such as "test:ledger".`,
        );
    if (!unless || typeof unless !== 'object' || Array.isArray(unless))
      problems.push('"signals.unless" must map a term to the words that veto it.');
    else {
      const entries = Object.entries(unless);
      if (entries.length > LIMITS.unless)
        problems.push(`"signals.unless" may name at most ${LIMITS.unless} terms.`);
      for (const [term, veto] of entries.slice(0, LIMITS.unless)) {
        if (!termNames.has(term))
          problems.push(`"unless" refers to "${term}", which is not one of this area's terms.`);
        if (!list(veto, LIMITS.unlessWords) || !veto.every((w) => /^[a-z0-9]{2,20}$/.test(w)))
          problems.push(`"unless.${term}" must list up to ${LIMITS.unlessWords} lower-case words.`);
      }
    }
    const ex = a.examples && typeof a.examples === 'object' ? a.examples : {};
    for (const key of ['match', 'ignore'])
      if (!list(ex[key], LIMITS.examples) || ex[key].length < LIMITS.minExamples)
        problems.push(
          `"examples.${key}" must list ${LIMITS.minExamples}–${LIMITS.examples} workspace paths.`,
        );
      else
        for (const p of ex[key])
          if (p.length > 256 || p.startsWith('/') || p.includes('..') || p.includes('\\'))
            problems.push(`Example "${p}" must be a relative workspace path.`);
    if (!paths.length && terms.length)
      notes.push(
        'Add path globs for the folders where this work lives; paths are the strongest signal.',
      );
    areas.push({
      id,
      label: typeof a.label === 'string' ? a.label.trim() : id,
      errors: problems,
      warnings: notes,
      source: a,
    });
  }
  return { errors, warnings, areas };
}
/** Compiles valid areas into an index. Area ids are prefixed "x:" so they never meet built-in ids. */
function compile(areas) {
  const groups = [],
    meta = [];
  for (const a of areas) {
    const s = a.signals || {},
      id = 'x:' + a.id;
    groups.push({
      dim: 'custom',
      id,
      terms: (s.terms || []).map((v) => {
        const [t, w] = weighted(v);
        return `${t}:${w ?? 0.75}`;
      }),
      files: (s.files || []).map((v) => {
        const [f, w] = weighted(v);
        return `${f.toLowerCase()}:${w ?? 0.85}`;
      }),
      globs: (s.paths || []).map((v) => {
        const [g, w] = weighted(v);
        return `${g}:${w ?? 0.9}`;
      }),
      unless: s.unless || {},
    });
    meta.push({
      id,
      label: a.label.trim(),
      description: a.description.trim(),
      colour: a.colour,
      commands: new Set((s.commands || []).map((c) => c.toLowerCase())),
    });
  }
  return { index: lexicon.compile(groups), areas: meta };
}
/** Custom-area confidences for one workspace path or script name. */
function matchCustom(compiled, value, source = 'path', factor = 1) {
  if (!compiled?.areas.length) return new Map();
  return lexicon.run(compiled.index, value, source, factor).custom;
}
/**
 * Validates a definition and runs each area's examples and breadth check. Returns a report:
 * { status: 'ready' | 'needs work' | 'invalid', errors, warnings, stakes, areas: [{ id, label,
 * status, errors, warnings, examples: { matched, match, ignored, ignore, failures }, breadth }] }.
 */
function check(doc) {
  const v = validate(doc);
  const report = {
    status: 'invalid',
    errors: v.errors,
    warnings: v.warnings,
    stakes: STAKES.includes(doc?.stakes) ? doc.stakes : undefined,
    areas: [],
  };
  for (const area of v.areas) {
    const out = {
      id: area.id,
      label: area.label,
      status: 'needs work',
      errors: [...area.errors],
      warnings: [...area.warnings],
    };
    if (!area.errors.length) {
      const compiled = compile([area.source]),
        key = 'x:' + area.id,
        conf = (p) => matchCustom(compiled, p).get(key)?.[0] || 0;
      const failures = [];
      const match = area.source.examples.match,
        ignore = area.source.examples.ignore;
      const matched = match.filter(
        (p) => conf(p) >= MATCH || (failures.push(`should match: ${p}`), false),
      ).length;
      const ignored = ignore.filter(
        (p) => conf(p) < IGNORE || (failures.push(`should ignore: ${p}`), false),
      ).length;
      const breadth = REFERENCE.filter((p) => conf(p) >= MATCH).length / REFERENCE.length;
      out.examples = { matched, match: match.length, ignored, ignore: ignore.length, failures };
      out.breadth = Math.round(breadth * 1000) / 10;
      for (const f of failures) out.errors.push(`Example ${f}.`);
      if (breadth > BROAD_FAIL)
        out.errors.push(
          `Matches ${out.breadth}% of common project files; narrow the paths and terms to this project's own work.`,
        );
      else if (breadth > BROAD_WARN)
        out.warnings.push(
          `Matches ${out.breadth}% of common project files; check that ordinary work is not counted.`,
        );
    }
    out.status = out.errors.length ? 'needs work' : 'ready';
    report.areas.push(out);
  }
  report.status = report.errors.length
    ? 'invalid'
    : report.areas.every((a) => a.status === 'ready')
      ? 'ready'
      : 'needs work';
  return report;
}
/** Reads and checks a workspace definition. Returns { text, hash, doc, report } or null if absent. */
function readDefinition(workspace) {
  const file = path.join(workspace, FILE);
  let text;
  try {
    const stat = fs.lstatSync(file);
    // Never follow a link out of the workspace, and never read an oversized file.
    if (!stat.isFile()) return null;
    if (stat.size > LIMITS.bytes)
      return {
        hash: 'oversized',
        report: {
          status: 'invalid',
          errors: [`The file is larger than ${LIMITS.bytes / 1024} KiB.`],
          warnings: [],
          areas: [],
        },
      };
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return {
      text,
      hash: hash(text),
      report: {
        status: 'invalid',
        errors: ['The file is not valid JSON: ' + String(error.message).slice(0, 120)],
        warnings: [],
        areas: [],
      },
    };
  }
  return { text, hash: hash(text), doc, report: check(doc) };
}
/** The enabled areas of a checked definition: only areas that are ready. */
function readyAreas(doc, report) {
  const ready = new Set(report.areas.filter((a) => a.status === 'ready').map((a) => a.id));
  return (doc?.areas || [])
    .filter((a) => ready.has(a.id))
    .map((a) => ({
      id: a.id,
      label: a.label.trim(),
      description: a.description.trim(),
      ...(a.colour ? { colour: a.colour } : {}),
      signals: a.signals,
    }));
}

// Collector cache: profiles written by the extension for open workspaces.
function cacheFile(root) {
  return path.join(root, 'profiles.json');
}
function readProfiles(root) {
  const store = require('./store');
  const raw = store.readJSON(cacheFile(root), null, LIMITS.cacheBytes);
  if (!raw || raw.version !== 1 || !Array.isArray(raw.profiles)) return [];
  return raw.profiles
    .filter(
      (p) =>
        p &&
        typeof p.root === 'string' &&
        path.isAbsolute(p.root) &&
        STAKES.includes(p.stakes) &&
        Array.isArray(p.areas),
    )
    .slice(0, LIMITS.profiles);
}
function writeProfiles(root, profiles) {
  const store = require('./store');
  const list = profiles
    .slice()
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .slice(0, LIMITS.profiles);
  const text = JSON.stringify({ version: 1, profiles: list });
  if (Buffer.byteLength(text) > LIMITS.cacheBytes)
    throw Error('Focus profiles exceed the cache limit.');
  store.ensure(root);
  store.atomic(cacheFile(root), text);
}
function contains(parent, child) {
  const rel = path.relative(parent, child);
  return (
    rel === '' ||
    (!!rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
  );
}
/**
 * The profile for an agent's working directory: the deepest cached workspace root containing it.
 * Cached areas are validated again before use. Returns { stakes, root, custom } or null.
 */
function profileFor(root, cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const match = readProfiles(root)
    .filter((p) => contains(p.root, cwd))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (!match) return null;
  const v = validate({
    version: 1,
    areas: match.areas.map((a) => ({
      ...a,
      examples: { match: ['a/b/c'], ignore: ['d/e/f', 'g/h/i', 'j/k/l'] },
    })),
  });
  const safe = match.areas.filter((a) =>
    v.areas.find((x) => x.id === a.id)?.errors.every((e) => e.startsWith('"examples')),
  );
  return { stakes: match.stakes, root: match.root, custom: safe.length ? compile(safe) : null };
}

function format(report, file) {
  const lines = [`Agent Monitor focus definition: ${file}`];
  if (report.stakes) lines.push(`Stakes: ${report.stakes}`);
  for (const e of report.errors) lines.push(`✗ ${e}`);
  for (const w of report.warnings) lines.push(`! ${w}`);
  for (const a of report.areas) {
    lines.push(`${a.status === 'ready' ? '✓' : '✗'} ${a.label} (${a.id}): ${a.status}`);
    if (a.examples)
      lines.push(
        `  Examples: ${a.examples.matched}/${a.examples.match} matched, ${a.examples.ignored}/${a.examples.ignore} ignored · matches ${a.breadth}% of common project files`,
      );
    for (const e of a.errors) lines.push(`  - ${e}`);
    for (const w of a.warnings) lines.push(`  ! ${w}`);
  }
  const ready = report.areas.filter((a) => a.status === 'ready').length;
  lines.push(
    report.status === 'ready'
      ? `Result: all ${ready} area${ready === 1 ? '' : 's'} ready. Approve them in Agent Monitor.`
      : `Result: ${ready} of ${report.areas.length} areas ready. Fix the problems above and run this check again.`,
  );
  return lines.join('\n');
}
if (require.main === module) {
  const [command = 'check', target = FILE, flag] = process.argv.slice(2);
  if (command !== 'check') {
    process.stderr.write('Usage: node profile.js check [path/to/focus.json] [--json]\n');
    process.exit(2);
  }
  const file = path.resolve(target);
  const found = readDefinition(path.dirname(path.dirname(file)));
  if (
    !found ||
    path.basename(file) !== 'focus.json' ||
    path.basename(path.dirname(file)) !== '.agent-monitor'
  ) {
    process.stderr.write(
      `Write the definition to ${FILE} in the workspace root, then run this check.\n`,
    );
    process.exit(2);
  }
  process.stdout.write(
    (flag === '--json' ? JSON.stringify(found.report, null, 2) : format(found.report, target)) +
      '\n',
  );
  process.exit(found.report.status === 'ready' ? 0 : 1);
}
module.exports = {
  FILE,
  STAKES,
  LIMITS,
  REFERENCE,
  validate,
  check,
  compile,
  matchCustom,
  readDefinition,
  readyAreas,
  readProfiles,
  writeProfiles,
  profileFor,
  format,
  hash,
};
