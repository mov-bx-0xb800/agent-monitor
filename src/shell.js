'use strict';
/* Reads what a shell command does without running, expanding or storing it. The reader is
   bounded and quote-aware: heredoc bodies and inline scripts are skipped, quoted text is used
   only when it is one path-like word, and only a recognised program/subcommand label is kept
   for display. Compound commands are read segment by segment, so "cd web && npm test | tail"
   is one test run and "npm test && cat a.ts" is a test run plus a separate read. Program
   tables have no prototype, so a command named "constructor" is just an unknown word. */
const MAX_INPUT = 4096,
  MAX_TOKENS = 240,
  MAX_SEGMENTS = 8,
  MAX_TARGETS = 20;

// ---------------------------------------------------------------------------------------------
// Tokenising

const OPERATORS = ['&&', '||', '|&', ';;', '|', ';', '&', '(', ')'];
const REDIRECT = /^(\d*)(>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)|^&>>?/;
function tokenize(source) {
  const src = String(source).slice(0, MAX_INPUT),
    tokens = [],
    heredocs = [];
  let i = 0;
  const push = (token) => tokens.length < MAX_TOKENS && tokens.push(token);
  while (i < src.length && tokens.length < MAX_TOKENS) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n') {
      push({ t: 'op', v: '\n' });
      i++;
      // Skip heredoc bodies registered on the line that just ended.
      while (heredocs.length) {
        const { tag, strip } = heredocs.shift();
        while (i < src.length) {
          const end = src.indexOf('\n', i),
            line = src.slice(i, end < 0 ? src.length : end);
          i = end < 0 ? src.length : end + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === tag) break;
        }
      }
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(src[i - 1]))) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const rest = src.slice(i, i + 4);
    const redirect = rest.match(REDIRECT);
    if (redirect && (c !== '&' || rest[1] === '>')) {
      const op = redirect[0].replace(/^\d+/, '');
      i += redirect[0].length;
      if (op === '<<' || op === '<<-') {
        while (src[i] === ' ' || src[i] === '\t') i++;
        const word = readWord(src, i);
        i = word.end;
        if (word.value) heredocs.push({ tag: word.value, strip: op === '<<-' });
        push({ t: 'heredoc' });
        continue;
      }
      push({ t: 'redir', v: op });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    const word = readWord(src, i);
    if (word.end === i) {
      i++;
      continue;
    }
    i = word.end;
    push({ t: 'word', v: word.value, q: word.quoted, dynamic: word.dynamic });
  }
  return tokens;
}
function readWord(src, start) {
  let i = start,
    value = '',
    quoted = false,
    dynamic = false;
  while (i < src.length) {
    const c = src[i];
    if (/[\s|&;()<>]/.test(c)) break;
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      value += src.slice(i + 1, end < 0 ? src.length : end);
      quoted = true;
      i = end < 0 ? src.length : end + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j++;
        else if (src[j] === '$' || src[j] === '`') dynamic = true;
        value += src[j] ?? '';
        j++;
      }
      quoted = true;
      i = j + 1;
    } else if (c === '\\') {
      value += src[i + 1] ?? '';
      i += 2;
    } else if (c === '$' && (src[i + 1] === '(' || src[i + 1] === '{')) {
      const open = src[i + 1],
        close = open === '(' ? ')' : '}';
      let depth = 0,
        j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === open) depth++;
        else if (src[j] === close && --depth === 0) break;
      }
      dynamic = true;
      i = j + 1;
    } else if (c === '`') {
      const end = src.indexOf('`', i + 1);
      dynamic = true;
      i = end < 0 ? src.length : end + 1;
    } else {
      if (c === '$') dynamic = true;
      value += c;
      i++;
    }
  }
  return { value, quoted, dynamic, end: i };
}

// ---------------------------------------------------------------------------------------------
// Paths

const EXTENSIONS = new Set(
  (
    'ts tsx mts cts js jsx mjs cjs css scss sass less styl html htm vue svelte astro py pyi ipynb rb php ' +
    'java kt kts swift go rs c h cc cpp cxx hpp cs scala ex exs erl clj dart lua zig nim hs ml fs ' +
    'sql prisma graphql gql proto md mdx rst txt adoc json jsonc json5 yaml yml toml ini cfg conf ' +
    'env xml plist gradle tf tfvars hcl sh bash zsh fish ps1 bat cmd lock csv tsv parquet xlsx ' +
    'log snap svg png jpg jpeg gif webp ico pdf docx pptx tex bib ino sol r rmd dockerfile ' +
    'pem crt key cer lockb patch diff'
  ).split(' '),
);
const NAMED = new Set(
  (
    'dockerfile containerfile makefile justfile procfile jenkinsfile gemfile rakefile vagrantfile ' +
    'brewfile podfile caddyfile tiltfile license licence readme changelog codeowners notice authors ' +
    'contributing copying'
  ).split(' '),
);
function pathLike(word) {
  const v = word.v;
  if (!v || v.length > 512 || word.dynamic) return false;
  if (/^-|:\/\/|^\.{1,2}$|^~$|^&/.test(v) || /\s/.test(v)) return false;
  // Quoted words qualify only when they are one plain path; inline code has quotes, parens or spaces.
  if (!/^[\w./@+~:\\,\-[\]*?{}()]+$/.test(v)) return false;
  if (word.q && /[()]/.test(v) && !/\/\([\w-]+\)\//.test(v)) return false;
  if (/^\d+(\.\d+)*[a-z]?$/i.test(v) || !/[A-Za-z0-9]/.test(v)) return false;
  if (/[/\\]/.test(v)) return true;
  if (/^\.[\w.-]+$/.test(v)) return true;
  const base = v.toLowerCase(),
    dot = base.lastIndexOf('.');
  return NAMED.has(base) || (dot > 0 && EXTENSIONS.has(base.slice(dot + 1)));
}

// ---------------------------------------------------------------------------------------------
// Programs

const TEXT_OUTPUT = new Set(
  'echo printf cat tee sed awk gawk jq yq sort uniq cut tr head tail envsubst column nl fmt'.split(
    ' ',
  ),
);
const READ = new Set(
  (
    'cat head tail less more bat batcat nl wc file stat xxd od hexdump strings diff cmp comm ' +
    'colordiff delta jq yq xmllint column ls tree find fd fdfind du realpath readlink basename ' +
    'dirname exa eza lsd sort uniq cut tr md5sum sha256sum shasum sha1sum open code cursor xdg-open ' +
    'rg grep egrep fgrep ag ack zgrep sed awk gawk perl'
  ).split(' '),
);
// The first positional argument of these is a pattern or script, never a path.
const PATTERN_FIRST = new Set(
  'rg grep egrep fgrep ag ack zgrep sed awk gawk perl jq yq'.split(' '),
);
const PIPE_FILTERS = new Set(
  'head tail grep egrep fgrep rg sort uniq wc cut tr sed awk gawk jq less more cat column nl fold fmt true xargs'.split(
    ' ',
  ),
);
// Flags that take a value, per program, so "sed -n '1,80p' file" keeps its file.
const VALUED = Object.assign(
  Object.create(null),
  Object.fromEntries(
    Object.entries({
      head: '-n -c',
      tail: '-n -c',
      sed: '-e -f -l',
      awk: '-f -v -F',
      gawk: '-f -v -F',
      perl: '-e -E -I -M',
      grep: '-e -f -m -A -B -C -d -D --include --exclude --exclude-dir',
      egrep: '-e -f -m -A -B -C --include --exclude',
      fgrep: '-e -f -m -A -B -C --include --exclude',
      zgrep: '-e -f -m -A -B -C',
      rg: '-e -f -m -A -B -C -g --glob --iglob -t --type -T --type-not --max-count -M --max-columns -j --threads -r --replace --sort --sortr',
      ag: '-G -A -B -C -m --ignore',
      ack: '-A -B -C -m --type',
      find: '-name -iname -path -ipath -type -maxdepth -mindepth -newer -size -mtime -mmin -user -group -perm -regex -iregex -exec -execdir -printf -fprint',
      fd: '-e --extension -t --type -E --exclude -d --max-depth -x --exec',
      jq: '--arg --argjson -f --from-file --slurpfile --rawfile --indent',
      yq: '-o -p -I --output-format --input-format',
      cut: '-d -f -c -b',
      sort: '-k -t -o -S',
      xxd: '-l -s -c -g',
      od: '-t -N -j -A',
      ls: '-I --ignore -w',
      tree: '-L -I -P',
      du: '-d --max-depth',
      diff: '-U -L',
      cp: '-t --target-directory',
      mv: '-t --target-directory',
      install: '-m -o -g',
      mkdir: '-m --mode',
      chmod: '',
      chown: '',
      ln: '-t',
    }).map(([k, v]) => [k, v ? v.split(' ') : []]),
  ),
);
const WRITE = new Set(
  'cp mv rm rmdir mkdir touch ln chmod chown chgrp truncate tee patch unzip'.split(' '),
);
const SILENT = new Set(
  'echo printf pwd cd pushd popd true false export set unset source alias which type whereis sleep wait clear exit read test ['.split(
    ' ',
  ),
);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const INTERPRETERS = new Set('node python python3 py ruby php deno bun'.split(' '));
const WRAPPERS = Object.assign(Object.create(null), {
  sudo: ['-u', '-g', '-C', '-h', '-p'],
  doas: ['-u'],
  time: [],
  nice: ['-n'],
  nohup: [],
  command: [],
  exec: ['-a'],
  builtin: [],
  env: ['-u', '-C', '-S'],
  stdbuf: [],
  'xvfb-run': ['-s', '-n', '-f', '-e'],
  caffeinate: [],
  chronic: [],
  unbuffer: [],
  ionice: ['-c', '-n'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  gtimeout: ['-s', '-k'],
  npx: ['-p', '--package', '-c', '--call'],
  bunx: ['-p', '--package'],
  pnpx: [],
  uvx: ['--from', '--with', '--python'],
  dotenv: ['-e', '-c', '-v'],
  'cross-env': [],
  'env-cmd': ['-f', '-e'],
  c8: ['-r', '--reporter', '-o', '--exclude', '-x', '--include', '-n'],
  nyc: ['-r', '--reporter', '--exclude', '-x', '--include', '-n'],
});
const COVERAGE = new Set(['c8', 'nyc']);

const SCRIPT_RULES = [
  [/(^|[:_\-./])(a11y|accessibility|axe|pa11y)([:_\-./]|$)/, { check: 'accessibility' }],
  [
    /(^|[:_\-./])(test|tests|spec|specs|e2e|unit|coverage|cov|cypress|cy|playwright|jest|vitest|mocha|ava|t)([:_\-./]|$)/,
    { check: 'test' },
  ],
  [
    /(^|[:_\-./])(bench|benchmark|benchmarks|perf|lighthouse|loadtest|size|size-limit)([:_\-./]|$)/,
    { check: 'benchmark' },
  ],
  [
    /(^|[:_\-./])(audit|security|snyk|secrets|vuln|vulns|semgrep)([:_\-./]|$)/,
    { check: 'security' },
  ],
  [
    /(^|[:_\-./])(lint|linter|eslint|stylelint|typecheck|types|tsc|check|knip|validate|prettier:check|format:check|fmt:check)([:_\-./]|$)/,
    { check: 'static' },
  ],
  [
    /(^|[:_\-./])(format|fmt|prettier|prettify)([:_\-./]|$)/,
    { action: 'change', concern: 'maintainability' },
  ],
  [
    /(^|[:_\-./])(build|compile|bundle|package|pack|dist|prepack|prepublish|vscode:prepublish)([:_\-./]|$)/,
    { check: 'build' },
  ],
  [/(^|[:_\-./])(docs|doc|typedoc|jsdoc)([:_\-./]|$)/, { check: 'docs' }],
  [/(^|[:_\-./])(deploy|release|publish|ship)([:_\-./]|$)/, { action: 'run', context: 'platform' }],
  [
    /(^|[:_\-./])(migrate|migration|migrations|db|seed|schema)([:_\-./]|$)/,
    { action: 'run', context: 'data' },
  ],
];
// Common script and task names that are not checks but are safe and useful to display.
const COMMON = new Set(
  'dev start serve preview watch storybook generate codegen clean prepare setup bootstrap install ci run'.split(
    ' ',
  ),
);
// Subcommands that may appear in a label after the program name.
const SUBCOMMANDS = new Set(
  (
    'run test t tst build check clippy fmt bench audit deny vet get mod tidy publish pack version ' +
    'install i ci add remove rm uninstall update up upgrade outdated ls list why explain exec ' +
    'format analyze compile credo dialyzer migrate makemigrations dbshell loaddata dumpdata db ' +
    'migration gen diff log show status blame grep branch commit push pull fetch clone checkout ' +
    'restore switch stash reset merge rebase tag apply mv clean init describe shortlog reflog ' +
    'remote config rev-parse ls-files ls-tree cat-file whatchanged annotate range-diff am lint ' +
    'typecheck plan validate destroy down logs ps images buildx compose start stop serve dev ' +
    'preview generate package verify assemble jar nextest doc spec open fix watch related ' +
    '--test --prof --check'
  ).split(' '),
);
/**
 * A label shows what ran ("npm run lint") without copying arbitrary command text. The first
 * word is the recognised program; each later word must be a known subcommand or a recognised or
 * common script name, and the first word that is not ends the label.
 */
function safeLabel(label) {
  const out = [];
  for (const word of String(label || '').split(' ')) {
    const plain = /^(--)?[A-Za-z][\w:.+-]{0,24}$/.test(word) && !/\d{5,}/.test(word);
    const known = SUBCOMMANDS.has(word) || COMMON.has(word.toLowerCase()) || script(word);
    if (!plain || (out.length && !known)) break;
    out.push(word);
  }
  return out.join(' ');
}
function named(name) {
  const n = String(name || '');
  return script(n) || COMMON.has(n.toLowerCase()) ? n : '';
}
function script(name) {
  const n = String(name || '').toLowerCase();
  if (!n || n.length > 80) return null;
  for (const [re, result] of SCRIPT_RULES) if (re.test(n)) return result;
  return null;
}
const CHECK_LABEL = {
  test: 'Test run',
  static: 'Static check',
  benchmark: 'Benchmark',
  security: 'Security scan',
  build: 'Build',
  accessibility: 'Accessibility check',
  docs: 'Documentation build',
};

function result(action, extra = {}) {
  return {
    action,
    check: null,
    label: '',
    names: [],
    signals: [],
    targets: [],
    reads: [],
    ...extra,
  };
}
function flagsFirst(words, i, valued = []) {
  // Skips flags and the values of flags known to take one. Returns the first positional index.
  while (i < words.length && words[i].v.startsWith('-') && words[i].v !== '--') {
    const flag = words[i].v;
    i += valued.includes(flag) && !flag.includes('=') ? 2 : 1;
  }
  if (words[i]?.v === '--') i++;
  return i;
}
function positional(words, from, valued = []) {
  const out = [];
  for (let i = from; i < words.length; i++) {
    const v = words[i].v;
    if (v === '--') continue;
    if (v.startsWith('-')) {
      const eq = v.indexOf('=');
      if (eq > 0) {
        const value = { ...words[i], v: v.slice(eq + 1) };
        if (pathLike(value)) out.push(value);
      } else if (valued.includes(v)) i++;
      continue;
    }
    out.push(words[i]);
  }
  return out;
}
function paths(list) {
  return list.filter(pathLike).map((w) => w.v);
}
function has(words, ...flags) {
  return words.some(
    (w) => flags.includes(w.v) || flags.some((f) => f.endsWith('=') && w.v.startsWith(f)),
  );
}
function base(word) {
  return String(word || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
}

// Package-manager front ends that run project scripts.
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno']);
const RUNNER_VALUE_FLAGS = [
  '--prefix',
  '-C',
  '--dir',
  '--cwd',
  '--filter',
  '-F',
  '-w',
  '--workspace',
  '--loglevel',
  '--config',
];
function runner(program, words, ctx) {
  let i = 1,
    dir = null;
  // Global options before the subcommand, including working-directory selectors.
  while (i < words.length && words[i].v.startsWith('-')) {
    const flag = words[i].v;
    if (['--prefix', '-C', '--dir', '--cwd'].includes(flag) && words[i + 1]) dir = words[i + 1].v;
    else if (/^--(prefix|dir|cwd)=/.test(flag)) dir = flag.split('=')[1];
    i += RUNNER_VALUE_FLAGS.includes(flag) ? 2 : 1;
  }
  let sub = words[i]?.v || '';
  if (program === 'yarn' && sub === 'workspace') {
    i += 2;
    sub = words[i]?.v || '';
  } else if (program === 'yarn' && sub === 'workspaces' && words[i + 1]?.v === 'foreach') {
    i = flagsFirst(words, i + 2, ['--include', '--exclude', '--from']);
    sub = words[i]?.v || '';
  }
  const rest = words.slice(i + 1);
  const label = (s) => `${program} ${s}`.trim();
  const found = (name, verb) => {
    const rule = script(name),
      shown = named(name);
    const out = result(rule?.action || (rule?.check ? 'check' : 'run'), {
      check: rule?.check || null,
      label: label(verb ? `${verb} ${shown}` : shown || 'run'),
      names: [name],
      dir,
    });
    if (rule?.concern) out.signals.push(['concerns', rule.concern, 0.6, `“${name}” script`]);
    if (rule?.context) out.signals.push(['contexts', rule.context, 0.7, `“${name}” script`]);
    out.targets = paths(positional(rest, name === sub ? 0 : 1));
    return out;
  };
  if (!sub) return result('run', { label: program });
  if (['run', 'run-script', 'rs'].includes(sub)) {
    const at = flagsFirst(rest, 0, ['--workspace', '-w', '--filter', '-F']);
    const name = rest[at]?.v;
    if (!name) return result('run', { label: label(sub) });
    const out = found(name, 'run');
    out.targets = paths(positional(rest, at + 1));
    return out;
  }
  if (['test', 't', 'tst'].includes(sub))
    return result('check', {
      check: 'test',
      label: label('test'),
      targets: paths(positional(rest, 0)),
      dir,
    });
  if (sub === 'audit') {
    const fix = rest.some((w) => w.v === 'fix');
    return result(fix ? 'change' : 'check', {
      check: 'security',
      label: label(fix ? 'audit fix' : 'audit'),
      dir,
    });
  }
  if (
    ['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade'].includes(
      sub,
    )
  ) {
    const packages = positional(rest, 0).length;
    // Installing the existing lockfile is environment setup; adding or removing a package changes dependencies.
    if (!packages && ['install', 'i'].includes(sub))
      return result('run', { label: label('install'), dir });
    return result('change', {
      label: label(sub),
      dir,
      signals: [['concerns', 'maintainability', 0.7, 'dependency change']],
    });
  }
  if (['ci'].includes(sub)) return result('run', { label: label('ci'), dir });
  if (['outdated', 'ls', 'list', 'why', 'explain'].includes(sub))
    return result('read', {
      label: label(sub),
      dir,
      signals: [['concerns', 'maintainability', 0.6, 'dependency review']],
    });
  if (['publish', 'version'].includes(sub))
    return result('run', {
      label: label(sub),
      dir,
      signals: [['contexts', 'platform', 0.8, 'release command']],
    });
  if (['pack'].includes(sub)) return result('check', { check: 'build', label: label('pack'), dir });
  if (['exec', 'x', 'dlx'].includes(sub)) return { unwrap: rest };
  if (program === 'deno' && ['test', 'bench', 'lint', 'check', 'fmt', 'compile'].includes(sub)) {
    const kind = {
      test: 'test',
      bench: 'benchmark',
      lint: 'static',
      check: 'static',
      compile: 'build',
    }[sub];
    if (sub === 'fmt')
      return has(rest, '--check')
        ? result('check', { check: 'static', label: 'deno fmt --check' })
        : result('change', {
            label: 'deno fmt',
            signals: [['concerns', 'maintainability', 0.6, 'formatter']],
          });
    return result('check', { check: kind, label: label(sub), targets: paths(positional(rest, 0)) });
  }
  if (program === 'bun' && ['build'].includes(sub))
    return result('check', { check: 'build', label: 'bun build' });
  if (program === 'deno' && ['run', 'task'].includes(sub)) return found(rest[0]?.v || sub, sub);
  if (['start', 'stop', 'restart', 'dev', 'serve'].includes(sub))
    return result('run', { label: label(sub), dir });
  // yarn, pnpm and bun run package scripts directly: "pnpm lint", "yarn build".
  if (program !== 'npm') return found(sub);
  return result('run', { label: label(sub), dir });
}

const TABLE = Object.assign(Object.create(null), {
  // Language test runners and their siblings.
  pytest: (w) =>
    w.some((x) => x.v.startsWith('--benchmark')) ? { check: 'benchmark' } : { check: 'test' },
  vitest: (w) =>
    w[1]?.v === 'bench'
      ? { check: 'benchmark', label: 'vitest bench' }
      : { check: 'test', skip: ['run', 'watch', 'related'].includes(w[1]?.v) ? 2 : 1 },
  playwright: (w) =>
    w[1]?.v === 'test' ? { check: 'test', skip: 2, label: 'playwright test' } : { action: 'run' },
  cypress: (w) =>
    ['run', 'open'].includes(w[1]?.v)
      ? { check: 'test', skip: 2, label: 'cypress ' + w[1].v }
      : { action: 'run' },
  // Static analysis and formatting.
  ktlint: (w) =>
    has(w, '-F', '--format')
      ? { action: 'change', concern: 'maintainability' }
      : { check: 'static' },
  sqlfluff: (w) =>
    w[1]?.v === 'fix'
      ? { action: 'change', context: 'data' }
      : { check: 'static', context: 'data' },
  prettier: (w) =>
    has(w, '--check', '-c', '--list-different', '-l')
      ? { check: 'static' }
      : has(w, '--write', '-w')
        ? { action: 'change', concern: 'maintainability' }
        : { action: 'read' },
  biome: (w) =>
    ['format'].includes(w[1]?.v) && has(w, '--write')
      ? { action: 'change', concern: 'maintainability', skip: 2 }
      : { check: 'static', skip: ['check', 'lint', 'ci', 'format'].includes(w[1]?.v) ? 2 : 1 },
  ruff: (w) =>
    w[1]?.v === 'format' && !has(w, '--check', '--diff')
      ? { action: 'change', concern: 'maintainability', skip: 2 }
      : { check: 'static', skip: ['check', 'format'].includes(w[1]?.v) ? 2 : 1 },
  black: (w) =>
    has(w, '--check', '--diff')
      ? { check: 'static' }
      : { action: 'change', concern: 'maintainability' },
  isort: (w) =>
    has(w, '--check', '--check-only', '-c', '--diff')
      ? { check: 'static' }
      : { action: 'change', concern: 'maintainability' },
  gofmt: (w) =>
    has(w, '-w') ? { action: 'change', concern: 'maintainability' } : { check: 'static' },
  goimports: (w) =>
    has(w, '-w') ? { action: 'change', concern: 'maintainability' } : { check: 'static' },
  rustfmt: (w) =>
    has(w, '--check') ? { check: 'static' } : { action: 'change', concern: 'maintainability' },
  'clang-format': (w) =>
    has(w, '-i') ? { action: 'change', concern: 'maintainability' } : { check: 'static' },
  swiftformat: (w) =>
    has(w, '--lint') ? { check: 'static' } : { action: 'change', concern: 'maintainability' },
  // Security scanners.
  safety: (w) => (['check', 'scan'].includes(w[1]?.v) ? { check: 'security' } : { action: 'run' }),
  // Performance measurement.
  k6: () => ({ check: 'benchmark', skip: 2 }),
  artillery: () => ({ check: 'benchmark', skip: 2 }),
  lighthouse: (w) =>
    w.some((x) => /accessibility/.test(x.v)) ? { check: 'accessibility' } : { check: 'benchmark' },
  perf: (w) =>
    ['record', 'stat', 'report', 'top'].includes(w[1]?.v)
      ? { check: 'benchmark' }
      : { action: 'run' },
  // Accessibility.
  // Documentation builds.
  mkdocs: () => ({ check: 'docs', skip: 2 }),
  // Builds and compilers.
  vite: (w) => (w[1]?.v === 'build' ? { check: 'build', label: 'vite build' } : { action: 'run' }),
  next: (w) =>
    w[1]?.v === 'build'
      ? { check: 'build', label: 'next build' }
      : w[1]?.v === 'lint'
        ? { check: 'static' }
        : { action: 'run' },
  nuxt: (w) => (w[1]?.v === 'build' ? { check: 'build' } : { action: 'run' }),
  astro: (w) =>
    w[1]?.v === 'build'
      ? { check: 'build' }
      : w[1]?.v === 'check'
        ? { check: 'static' }
        : { action: 'run' },
  parcel: (w) => (w[1]?.v === 'build' ? { check: 'build' } : { action: 'run' }),
  vsce: (w) =>
    w[1]?.v === 'package'
      ? { check: 'build', label: 'vsce package' }
      : w[1]?.v === 'publish'
        ? { action: 'run', context: 'platform' }
        : { action: 'run' },
  meson: (w) => (w[1]?.v === 'test' ? { check: 'test' } : { check: 'build' }),
  cmake: (w) => (has(w, '--build') ? { check: 'build' } : { action: 'run', context: 'platform' }),
  xcodebuild: (w) => (w.some((x) => x.v === 'test') ? { check: 'test' } : { check: 'build' }),
  // Data tools.
  'redis-cli': () => ({ action: 'run', context: 'data', weight: 0.6 }),
  prisma: (w) => ({
    action: ['migrate', 'db'].includes(w[1]?.v) ? 'change' : 'run',
    context: 'data',
    skip: 2,
  }),
  'drizzle-kit': () => ({ action: 'run', context: 'data', skip: 2 }),
  knex: () => ({ action: 'run', context: 'data', skip: 2 }),
  sequelize: () => ({ action: 'run', context: 'data', skip: 2 }),
  typeorm: () => ({ action: 'run', context: 'data', skip: 2 }),
  alembic: () => ({ action: 'run', context: 'data', skip: 2 }),
  flyway: () => ({ action: 'run', context: 'data', skip: 2 }),
  liquibase: () => ({ action: 'run', context: 'data', skip: 2 }),
  atlas: () => ({ action: 'run', context: 'data', skip: 2 }),
  dbt: (w) =>
    w[1]?.v === 'test'
      ? { check: 'test', context: 'data', skip: 2 }
      : { action: 'run', context: 'data', skip: 2 },
  jupyter: () => ({ action: 'run', context: 'data', weight: 0.7 }),
  supabase: (w) =>
    w[1]?.v === 'test'
      ? { check: 'test', context: 'data', skip: 3 }
      : ['db', 'migration', 'gen'].includes(w[1]?.v)
        ? { action: 'run', context: 'data', skip: 3 }
        : { action: 'run', context: 'platform', weight: 0.6, skip: 2 },
  // Infrastructure and delivery.
  docker: dockerish,
  podman: dockerish,
  kubectl: (w) => ({
    action: ['logs', 'describe', 'get', 'top'].includes(w[1]?.v) ? 'read' : 'run',
    context: 'platform',
    weight: 0.95,
  }),
  helm: (w) =>
    w[1]?.v === 'lint'
      ? { check: 'static', context: 'platform' }
      : { action: 'run', context: 'platform', weight: 0.9 },
  terraform: terraformish,
  tofu: terraformish,
  terragrunt: terraformish,
  pulumi: () => ({ action: 'run', context: 'platform', weight: 0.95 }),
  aws: () => ({ action: 'run', context: 'platform', weight: 0.7 }),
  gcloud: () => ({ action: 'run', context: 'platform', weight: 0.7 }),
  az: () => ({ action: 'run', context: 'platform', weight: 0.7 }),
  firebase: () => ({ action: 'run', context: 'platform', weight: 0.7 }),
  systemctl: () => ({ action: 'run', context: 'platform', weight: 0.7 }),
  journalctl: () => ({ action: 'read', concern: 'operability', weight: 0.7 }),
  nginx: (w) =>
    has(w, '-t')
      ? { check: 'static', context: 'platform' }
      : { action: 'run', context: 'platform' },
  gh: (w) =>
    ['workflow', 'run', 'release'].includes(w[1]?.v)
      ? {
          action: w[2]?.v === 'view' || w[2]?.v === 'list' ? 'read' : 'run',
          context: 'platform',
          weight: 0.7,
        }
      : { action: 'run' },
});
// Programs recognised by name alone. Adding a tool here is adding one word.
const SIMPLE = [
  [
    { check: 'test' },
    'py.test nose2 jest mocha ava tap tape jasmine karma wdio testcafe uvu rspec phpunit pest ctest tox nox',
  ],
  [{ check: 'test', context: 'data' }, 'pg_prove'],
  [
    { check: 'static' },
    'tsc vue-tsc svelte-check eslint oxlint stylelint markdownlint markdownlint-cli2 knip depcheck madge publint attw mypy pyright pytype flake8 pylint pydocstyle golangci-lint staticcheck rubocop standardrb shellcheck yamllint detekt swiftlint phpstan psalm phpcs clang-tidy cppcheck',
  ],
  [{ check: 'static', context: 'platform' }, 'hadolint actionlint tflint'],
  [{ check: 'static', concern: 'operability' }, 'promtool'],
  [
    { check: 'security' },
    'semgrep opengrep gitleaks trufflehog detect-secrets ggshield snyk trivy grype osv-scanner govulncheck gosec bandit pip-audit brakeman bundler-audit kics retire dependency-check codeql',
  ],
  [{ check: 'security', context: 'platform' }, 'checkov tfsec terrascan'],
  [
    { check: 'benchmark' },
    'hyperfine ab wrk wrk2 autocannon locust vegeta oha hey bombardier siege jmeter lhci unlighthouse size-limit bundlesize bundlewatch clinic 0x py-spy scalene',
  ],
  [{ action: 'run', concern: 'performance' }, 'valgrind'],
  [{ action: 'read', concern: 'performance' }, 'webpack-bundle-analyzer source-map-explorer'],
  [{ check: 'accessibility' }, 'pa11y pa11y-ci axe'],
  [{ check: 'docs' }, 'sphinx-build typedoc jsdoc docusaurus vitepress mdbook'],
  [
    { check: 'build' },
    'webpack rollup esbuild tsup electron-builder pyinstaller gcc g++ clang clang++ rustc javac ninja',
  ],
  [
    { action: 'run', context: 'data' },
    'psql pgcli mysql mariadb sqlite3 sqlite duckdb mongosh mongo clickhouse-client cqlsh bq pg_dump pg_restore papermill dvc mlflow',
  ],
  [
    { action: 'run', context: 'platform' },
    'docker-compose kustomize minikube kind cdk sam serverless sls doctl flyctl vercel netlify heroku wrangler eas fastlane ansible ansible-playbook vagrant packer act twine',
  ],
  [{ action: 'run', concern: 'operability' }, 'sentry-cli'],
];
for (const [spec, names] of SIMPLE)
  for (const name of names.split(' ')) if (!TABLE[name]) TABLE[name] = () => ({ ...spec });
function dockerish(w) {
  const sub = w[1]?.v === 'compose' || w[1]?.v === 'buildx' ? w[2]?.v : w[1]?.v;
  if (sub === 'build') return { check: 'build', context: 'platform', label: w[0].v + ' build' };
  if (['logs', 'ps', 'images', 'inspect'].includes(sub))
    return { action: 'read', context: 'platform', weight: 0.8 };
  return { action: 'run', context: 'platform', weight: 0.85 };
}
function terraformish(w) {
  const sub = w.find((x, i) => i > 0 && !x.v.startsWith('-'))?.v;
  if (sub === 'validate') return { check: 'static', context: 'platform' };
  if (sub === 'fmt')
    return has(w, '-check', '--check')
      ? { check: 'static', context: 'platform' }
      : { action: 'change', context: 'platform' };
  return { action: 'run', context: 'platform', weight: 0.95 };
}
// Subcommand-driven toolchains.
function toolchain(program, words) {
  const sub = words[1]?.v || '',
    rest = words.slice(2);
  const check = (kind, extra = {}) =>
    result('check', {
      check: kind,
      label: `${program} ${sub}`,
      targets: paths(positional(rest, 0)),
      ...extra,
    });
  if (program === 'cargo') {
    if (['test', 'nextest'].includes(sub)) return check('test');
    if (sub === 'bench') return check('benchmark');
    if (['clippy', 'check'].includes(sub)) return check('static');
    if (sub === 'fmt')
      return has(words, '--check')
        ? check('static')
        : result('change', {
            label: 'cargo fmt',
            signals: [['concerns', 'maintainability', 0.6, 'formatter']],
          });
    if (['build', 'doc'].includes(sub)) return check(sub === 'doc' ? 'docs' : 'build');
    if (['audit', 'deny'].includes(sub)) return check('security');
    if (['add', 'remove', 'update'].includes(sub))
      return result('change', {
        label: `cargo ${sub}`,
        signals: [['concerns', 'maintainability', 0.7, 'dependency change']],
      });
    if (sub === 'publish')
      return result('run', {
        label: 'cargo publish',
        signals: [['contexts', 'platform', 0.8, 'release command']],
      });
    return result('run', { label: sub ? `cargo ${sub}` : 'cargo' });
  }
  if (program === 'go') {
    if (sub === 'test')
      return has(words, '-bench', '-bench=') || words.some((w) => w.v.startsWith('-bench'))
        ? check('benchmark')
        : check('test');
    if (sub === 'vet') return check('static');
    if (sub === 'build') return check('build');
    if (sub === 'get' || (sub === 'mod' && rest[0]?.v === 'tidy'))
      return result('change', {
        label: `go ${sub}`,
        signals: [['concerns', 'maintainability', 0.7, 'dependency change']],
      });
    if (sub === 'fmt')
      return result('change', {
        label: 'go fmt',
        signals: [['concerns', 'maintainability', 0.6, 'formatter']],
      });
    return result('run', { label: `go ${sub}`.trim(), targets: paths(positional(rest, 0)) });
  }
  if (program === 'dotnet') {
    if (sub === 'test') return check('test');
    if (['build', 'publish', 'pack'].includes(sub)) return check('build');
    if (sub === 'format')
      return has(words, '--verify-no-changes')
        ? check('static')
        : result('change', { label: 'dotnet format' });
    return result('run', { label: `dotnet ${sub}`.trim() });
  }
  if (program === 'swift') {
    if (sub === 'test') return check('test');
    if (sub === 'build') return check('build');
    return result('run', { label: `swift ${sub}`.trim() });
  }
  if (program === 'flutter' || program === 'dart') {
    if (sub === 'test') return check('test');
    if (sub === 'analyze') return check('static');
    if (sub === 'build' || sub === 'compile') return check('build');
    if (sub === 'format')
      return has(words, '--set-exit-if-changed')
        ? check('static')
        : result('change', { label: `${program} format` });
    return result('run', { label: `${program} ${sub}`.trim() });
  }
  if (program === 'mix') {
    if (sub === 'test') return check('test');
    if (['credo', 'dialyzer'].includes(sub)) return check('static');
    if (sub === 'format')
      return has(words, '--check-formatted')
        ? check('static')
        : result('change', { label: 'mix format' });
    if (sub === 'compile') return check('build');
    if (sub.startsWith('ecto.'))
      return result('run', {
        label: `mix ${sub}`,
        signals: [['contexts', 'data', 0.85, 'database task']],
      });
    return result('run', { label: `mix ${sub}`.trim() });
  }
  if (
    [
      'gradle',
      'gradlew',
      'mvn',
      'mvnw',
      'sbt',
      'lein',
      'bazel',
      'bazelisk',
      'rake',
      'invoke',
      'hatch',
      'turbo',
      'nx',
      'lerna',
      'just',
      'task',
      'mage',
      'make',
      'gmake',
    ].includes(program)
  ) {
    const tasks = positional(words, 1, [
      '-p',
      '--project-dir',
      '-C',
      '-f',
      '--filter',
      '--target',
      '--scope',
      '-P',
      '-e',
      '--env',
      '-j',
      '--jobs',
      '--file',
      '--directory',
    ]);
    const names = tasks
      .filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.v))
      .map((t) => t.v.replace(/^:?[\w-]+:(?=[\w-]+$)/, '').replace(/^:/, ''));
    const BUILD = ['package', 'install', 'assemble', 'compile', 'jar', 'build'];
    // "nx run web:test", "turbo run test", "gradle :app:check", "bazel test //...", "mvn clean install"
    const pick =
      names.find(
        (n) =>
          n && n !== 'run' && n !== 'run-many' && (script(n) || BUILD.includes(n.toLowerCase())),
      ) || names.find((n) => n && n !== 'run' && n !== 'run-many');
    if (!pick)
      return program.startsWith('make') || program === 'gmake'
        ? result('check', { check: 'build', label: program })
        : result('run', { label: program });
    const lowered = pick.toLowerCase();
    // JVM "check" and "verify" run tests and static analysis together.
    const kind =
      ['check', 'verify'].includes(lowered) && /^(gradle|gradlew|mvn|mvnw)$/.test(program)
        ? { check: 'test' }
        : script(lowered);
    if (['package', 'install', 'assemble', 'compile', 'jar'].includes(lowered))
      return result('check', { check: 'build', label: `${program} ${pick}`, names: [pick] });
    const out = result(kind?.action || (kind?.check ? 'check' : 'run'), {
      check: kind?.check || null,
      label: `${program} ${named(pick)}`.trim(),
      names: [pick],
    });
    if (kind?.context) out.signals.push(['contexts', kind.context, 0.7, `“${pick}” task`]);
    return out;
  }
  return null;
}

function python(words) {
  // python -m module …, python manage.py …, python script.py
  let i = 1;
  while (i < words.length && words[i].v.startsWith('-') && !['-m', '-c', '-'].includes(words[i].v))
    i += ['-W', '-X'].includes(words[i].v) ? 2 : 1;
  const w = words[i];
  if (!w) return result('run');
  if (w.v === '-m') {
    const module = words[i + 1]?.v || '';
    const inner = [{ ...words[i + 1], v: module }, ...words.slice(i + 2)];
    if (module === 'unittest')
      return result('check', { check: 'test', label: 'python -m unittest' });
    if (module === 'build') return result('check', { check: 'build', label: 'python -m build' });
    if (module === 'http.server') return result('run', { label: 'python -m http.server' });
    if (module === 'pip') return pip(inner);
    return { unwrap: inner };
  }
  if (w.v === '-c' || w.v === '-') return result('run');
  if (/(^|\/)manage\.py$/.test(w.v)) {
    const sub = words[i + 1]?.v || '';
    if (sub === 'test') return result('check', { check: 'test', label: 'manage.py test' });
    if (['migrate', 'makemigrations', 'dbshell', 'loaddata', 'dumpdata'].includes(sub))
      return result(sub === 'makemigrations' ? 'change' : 'run', {
        label: `manage.py ${sub}`,
        signals: [['contexts', 'data', 0.85, 'database task']],
      });
    return result('run', { label: `manage.py ${sub}`.trim() });
  }
  return result('run', { targets: paths([w]), label: '' });
}
function pip(words) {
  const sub = words[1]?.v || '';
  if (sub === 'install' || sub === 'uninstall')
    return result(
      sub === 'install' && words.some((w) => w.v === '-r' || w.v === '-e') ? 'run' : 'change',
      {
        label: `pip ${sub}`,
        signals: [['concerns', 'maintainability', 0.6, 'dependency change']],
      },
    );
  if (sub === 'audit') return result('check', { check: 'security', label: 'pip audit' });
  return result('run', { label: `pip ${sub}`.trim() });
}
function git(words) {
  let i = 1,
    dir = null;
  while (i < words.length && words[i].v.startsWith('-')) {
    if (words[i].v === '-C' && words[i + 1]) {
      dir = words[i + 1].v;
      i += 2;
    } else i += ['-c'].includes(words[i].v) ? 2 : 1;
  }
  const sub = words[i]?.v || '',
    rest = words.slice(i + 1);
  const label = `git ${sub}`.trim(),
    done = (out) => Object.assign(out, dir ? { dir } : {});
  const read = [
    'diff',
    'log',
    'show',
    'status',
    'blame',
    'grep',
    'ls-files',
    'ls-tree',
    'branch',
    'rev-parse',
    'describe',
    'shortlog',
    'reflog',
    'remote',
    'config',
    'tag',
    'cat-file',
    'whatchanged',
    'annotate',
    'range-diff',
  ];
  const change = ['checkout', 'restore', 'mv', 'rm', 'apply', 'am', 'clean'];
  const after = rest.findIndex((w) => w.v === '--');
  const candidates = paths(
    positional(after >= 0 ? rest.slice(after + 1) : sub === 'grep' ? rest.slice(1) : rest, 0, [
      '-m',
      '-n',
      '-U',
      '--format',
      '--pretty',
      '-S',
      '-G',
      '--author',
      '--since',
      '--until',
      '-e',
      '-p',
    ]),
  );
  if (sub === 'tag' && rest.some((w) => !w.v.startsWith('-')))
    return done(result('run', { label, signals: [['contexts', 'platform', 0.5, 'release tag']] }));
  if (read.includes(sub)) return done(result('read', { label, targets: candidates }));
  if (change.includes(sub))
    return done(result(candidates.length ? 'change' : 'run', { label, targets: candidates }));
  if (sub === 'push')
    return done(result('run', { label, signals: [['contexts', 'platform', 0.5, 'push']] }));
  return done(result('run', { label }));
}

/**
 * Reads one command segment (a simple command inside a list or pipeline).
 * ctx carries the working-directory prefix across segments.
 */
function segment(words, redirects, ctx, depth) {
  let i = 0;
  // Leading environment assignments.
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].v) && !words[i].q) i++;
  let rest = words.slice(i),
    covered = false;
  // Unwrap command wrappers such as timeout, sudo, env and npx.
  for (let guard = 0; guard < 6 && rest.length; guard++) {
    const program = base(rest[0].v),
      flags = WRAPPERS[program];
    if (!flags) break;
    if (COVERAGE.has(program)) covered = true;
    let j = 1;
    while (j < rest.length) {
      const v = rest[j].v;
      if (v === '--') {
        j++;
        break;
      }
      if (v.startsWith('-')) {
        j += flags.includes(v) ? 2 : 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) {
        j++;
        continue;
      }
      if ((program === 'timeout' || program === 'gtimeout') && /^\d+(\.\d+)?[smhd]?$/.test(v)) {
        j++;
        continue;
      }
      break;
    }
    rest = rest.slice(j);
  }
  if (!rest.length) return null;
  const program = base(rest[0].v);
  const out = read(program, rest, ctx, depth);
  if (!out || out.nested !== undefined) return out;
  if (covered && out.action !== 'check') Object.assign(out, { action: 'check', check: 'test' });
  const inputs = [],
    outputs = [];
  for (const r of redirects) {
    if (r.op === '<' && pathLike(r.word)) inputs.push(r.word.v);
    // Output redirection writes a file only for commands that emit text into it, not a check's log.
    else if (
      /^(>|>>|>\||&>|&>>)$/.test(r.op) &&
      TEXT_OUTPUT.has(program) &&
      pathLike(r.word) &&
      !/^\/dev\//.test(r.word.v)
    )
      outputs.push(r.word.v);
  }
  if (outputs.length && out.action !== 'check') {
    // "cat a.ts > b.ts" reads a.ts and changes b.ts.
    out.reads = [...(out.reads || []), ...out.targets, ...inputs];
    out.targets = outputs;
    out.action = 'change';
  } else if (inputs.length) {
    if (out.action === 'read' || out.action === 'none') out.targets.push(...inputs);
    else out.reads = [...(out.reads || []), ...inputs];
  }
  if (out.action === 'none')
    return out.targets.length ? Object.assign(out, { action: 'read' }) : null;
  return out;
}
function read(program, words, ctx, depth) {
  if (program === 'echo' || program === 'printf') return result('none');
  if (SILENT.has(program)) {
    if ((program === 'cd' || program === 'pushd') && words[1] && !words[1].dynamic) {
      const dir = words[1].v;
      if (dir && dir !== '-' && !dir.startsWith('~')) ctx.prefix = join(ctx.prefix, dir);
    }
    return null;
  }
  if (SHELLS.has(program)) {
    const at = words.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(w.v));
    if (at > 0 && words[at + 1] && depth < 1) return { nested: words[at + 1].v };
    const script = words.find((w, i) => i > 0 && !w.v.startsWith('-'));
    return result('run', { targets: script ? paths([script]) : [] });
  }
  if (program === 'xargs') {
    const at = flagsFirst(words, 1, [
      '-n',
      '-I',
      '-P',
      '-L',
      '-d',
      '-s',
      '-E',
      '--max-args',
      '--replace',
    ]);
    return words[at] ? read(base(words[at].v), words.slice(at), ctx, depth) : null;
  }
  if (RUNNERS.has(program)) {
    const out = runner(program, words, ctx);
    if (out.unwrap)
      return out.unwrap.length ? read(base(out.unwrap[0].v), out.unwrap, ctx, depth) : null;
    return out;
  }
  if (['python', 'python3', 'py'].includes(program)) {
    const out = python(words);
    if (out.unwrap)
      return out.unwrap.length ? read(base(out.unwrap[0].v), out.unwrap, ctx, depth) : null;
    return out;
  }
  if (['pip', 'pip3'].includes(program)) return pip(words);
  if (['uv', 'poetry', 'pdm', 'pipenv', 'rye', 'hatch'].includes(program)) {
    const sub = words[1]?.v;
    if (sub === 'run' && program === 'hatch') {
      const name = (words[2]?.v || '').split(':').pop();
      const rule = script(name);
      return result(rule?.check ? 'check' : 'run', {
        check: rule?.check || null,
        label: `hatch run ${name}`,
        names: [name],
      });
    }
    if (sub === 'run') {
      const at = flagsFirst(words, 2, ['--with', '--python', '-p', '--env', '-e', '--group']);
      return words[at] ? read(base(words[at].v), words.slice(at), ctx, depth) : null;
    }
    if (['add', 'remove', 'lock', 'update'].includes(sub))
      return result('change', {
        label: `${program} ${sub}`,
        signals: [['concerns', 'maintainability', 0.7, 'dependency change']],
      });
    if (sub === 'build') return result('check', { check: 'build', label: `${program} build` });
    if (program === 'hatch') return toolchain('hatch', words);
    return result('run', { label: `${program} ${sub || ''}`.trim() });
  }
  if (program === 'bundle') {
    if (words[1]?.v === 'exec')
      return words[2] ? read(base(words[2].v), words.slice(2), ctx, depth) : null;
    if (words[1]?.v === 'audit')
      return result('check', { check: 'security', label: 'bundle audit' });
    if (['add', 'update', 'remove'].includes(words[1]?.v))
      return result('change', {
        label: `bundle ${words[1].v}`,
        signals: [['concerns', 'maintainability', 0.7, 'dependency change']],
      });
    return result('run', { label: 'bundle' });
  }
  if (program === 'composer') {
    const sub = words[1]?.v || '';
    if (sub === 'audit') return result('check', { check: 'security', label: 'composer audit' });
    if (['require', 'remove', 'update'].includes(sub))
      return result('change', {
        label: `composer ${sub}`,
        signals: [['concerns', 'maintainability', 0.7, 'dependency change']],
      });
    if (sub && !['install', 'dump-autoload', 'show'].includes(sub)) {
      const rule = script(sub === 'run-script' ? words[2]?.v : sub);
      if (rule?.check) return result('check', { check: rule.check, label: `composer ${sub}` });
    }
    return result('run', { label: `composer ${sub}`.trim() });
  }
  if (program === 'rails' || program === 'rake') {
    const sub = words[1]?.v || '';
    if (sub === 'test' || sub === 'spec')
      return result('check', { check: 'test', label: `${program} ${sub}` });
    if (sub.startsWith('db:'))
      return result('run', {
        label: `${program} ${sub}`,
        signals: [['contexts', 'data', 0.85, 'database task']],
      });
    if (program === 'rake') return toolchain('rake', words);
    return result('run', { label: `${program} ${sub}`.trim() });
  }
  if (program === 'php' && /(^|\/)artisan$/.test(words[1]?.v || '')) {
    const sub = words[2]?.v || '';
    if (sub === 'test') return result('check', { check: 'test', label: 'artisan test' });
    if (sub.startsWith('migrate') || sub.startsWith('db:'))
      return result('run', {
        label: `artisan ${sub}`,
        signals: [['contexts', 'data', 0.85, 'database task']],
      });
    return result('run', { label: `artisan ${sub}`.trim() });
  }
  if (program === 'node' || program === 'tsx' || program === 'ts-node') {
    if (has(words, '--test'))
      return result('check', {
        check: 'test',
        label: `${program} --test`,
        targets: paths(positional(words, 1)),
      });
    if (words.some((w) => /^--(cpu-prof|heap-prof|prof)$/.test(w.v)))
      return result('check', { check: 'benchmark', label: `${program} --prof` });
    if (has(words, '-e', '--eval', '-p', '--print')) return result('run');
    const at = flagsFirst(words, 1, [
      '-r',
      '--require',
      '--import',
      '--loader',
      '--env-file',
      '--conditions',
      '-C',
    ]);
    return result('run', { label: '', targets: words[at] ? paths([words[at]]) : [] });
  }
  if (INTERPRETERS.has(program)) {
    if (has(words, '-e', '-c', '-r')) return result('run');
    const at = flagsFirst(words, 1);
    return result('run', { targets: words[at] ? paths([words[at]]) : [] });
  }
  if (program === 'git') return git(words);
  const chain = toolchain(program, words);
  if (chain) return chain;
  const known = TABLE[program]?.(words);
  if (known) {
    const skip = known.skip ?? 1;
    const out = result(known.check ? 'check' : known.action || 'run', {
      check: known.check || null,
      label: known.label || (skip > 1 && words[1] ? `${program} ${words[1].v}` : program),
      targets: paths(positional(words, skip)),
    });
    if (known.context)
      out.signals.push(['contexts', known.context, known.weight ?? 0.85, `${program} command`]);
    if (known.concern)
      out.signals.push(['concerns', known.concern, known.weight ?? 0.7, `${program} command`]);
    return out;
  }
  // perl -e/-n/-p is text processing (read or in-place edit); "perl script.pl" runs a script.
  if (program === 'perl' && !words.some((w) => /^-[a-zA-Z]*[enpE]/.test(w.v))) {
    const at = flagsFirst(words, 1, ['-I', '-M']);
    return result('run', { targets: words[at] ? paths([words[at]]) : [] });
  }
  if (READ.has(program)) {
    const inPlace =
      (['sed', 'perl'].includes(program) &&
        words.some((w) => /^-[a-z]*i/.test(w.v) || w.v === '--in-place')) ||
      (['awk', 'gawk'].includes(program) &&
        words.some((w, i) => w.v === '-i' && words[i + 1]?.v === 'inplace')) ||
      (program === 'yq' && has(words, '-i', '--inplace'));
    let list = positional(words, 1, VALUED[program] || []);
    // The first argument of a search or script is its pattern, unless -e/-f supplied it.
    if (
      PATTERN_FIRST.has(program) &&
      !has(words, '-e', '-f', '--regexp', '--file') &&
      !(program === 'rg' && has(words, '--files'))
    )
      list = list.slice(1);
    if (program === 'find') list = list.filter((w) => !/^[!(]$/.test(w.v));
    return result(inPlace ? 'change' : 'read', { targets: paths(list), label: '' });
  }
  if (WRITE.has(program)) {
    const list = paths(positional(words, 1, VALUED[program] || []));
    // cp/rsync read their sources and change the destination; the others change every path.
    if (program === 'cp' && list.length > 1)
      return result('change', { targets: list.slice(-1), reads: list.slice(0, -1), label: '' });
    return result('change', { targets: list, label: '' });
  }
  if (program === 'rsync' || program === 'scp') {
    const list = paths(positional(words, 1, ['-e', '--exclude', '--include', '-i', '-P']));
    return result('change', {
      targets: list.slice(-1).filter((p) => !p.includes(':')),
      reads: list.slice(0, -1),
      label: '',
    });
  }
  // Scripts run directly: ./scripts/check.sh, bin/setup
  if (/[/\\]/.test(words[0].v) && pathLike(words[0])) {
    const rule = script(base(words[0].v).replace(/\.[a-z]+$/, ''));
    const out = result(rule?.check ? 'check' : 'run', {
      check: rule?.check || null,
      targets: [words[0].v],
    });
    if (rule?.check) out.label = base(words[0].v);
    return out;
  }
  return result('run', { targets: paths(positional(words, 1)) });
}
function join(prefix, dir) {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^([A-Za-z]:)?\//.test(d)) return d;
  const parts = prefix ? prefix.split('/') : [];
  for (const p of d.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop();
      else parts.push('..');
    } else parts.push(p);
  }
  return parts.join('/');
}

/**
 * Parses a command string (or an argv array) into observed actions.
 * Returns [{ action, check, label, names, signals, targets, reads, prefix }], at most
 * eight segments and twenty targets in total.
 */
function parse(command, depth = 0, ctx = { prefix: '' }) {
  let source = command;
  if (Array.isArray(command)) {
    const argv = command.filter((a) => typeof a === 'string').slice(0, 64);
    if (argv.length >= 3 && SHELLS.has(base(argv[0])) && /^-[a-z]*c[a-z]*$/.test(argv[1]))
      return parse(argv[2], depth, ctx);
    source = argv
      .map((a) => (/^[\w./@+=:,-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`))
      .join(' ');
  }
  if (typeof source !== 'string' || !source.trim()) return [];
  const tokens = tokenize(source),
    segments = [],
    stack = [];
  let words = [],
    redirects = [],
    piped = false,
    nextPiped = false,
    total = 0;
  const flush = () => {
    const current = { words, redirects, piped };
    words = [];
    redirects = [];
    piped = nextPiped;
    nextPiped = false;
    if (!current.words.length || segments.length >= MAX_SEGMENTS) return;
    const program = base(current.words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.v))?.v);
    // Output filters after a pipe (| tail, | grep) describe the previous command's output only;
    // tee is not a filter here because it writes the files it names.
    if (current.piped && PIPE_FILTERS.has(program) && program !== 'xargs') return;
    const out = segment(current.words, current.redirects, ctx, depth);
    if (!out) return;
    if (out.nested !== undefined) {
      for (const inner of parse(out.nested, depth + 1, ctx))
        if (segments.length < MAX_SEGMENTS) segments.push(inner);
      return;
    }
    const prefix = out.dir ? join(ctx.prefix, out.dir) : ctx.prefix;
    const cap = (list) => (list || []).slice(0, Math.max(0, MAX_TARGETS - total));
    out.targets = cap(out.targets);
    total += out.targets.length;
    out.reads = cap(out.reads);
    total += out.reads.length;
    out.prefix = prefix;
    out.label = safeLabel(out.label);
    delete out.dir;
    segments.push(out);
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'word') words.push(t);
    else if (t.t === 'redir') {
      const next = tokens[k + 1];
      if (next?.t === 'word') {
        redirects.push({ op: t.v, word: next });
        k++;
      }
    } else if (t.t === 'heredoc') continue;
    else if (t.t === 'op') {
      if (t.v === '(') {
        flush();
        stack.push(ctx.prefix);
        continue;
      }
      if (t.v === ')') {
        flush();
        if (stack.length) ctx.prefix = stack.pop();
        continue;
      }
      if (t.v === '|' || t.v === '|&') nextPiped = true;
      flush();
    }
  }
  flush();
  return segments;
}
module.exports = { parse, tokenize, pathLike, script, safeLabel, CHECK_LABEL };
