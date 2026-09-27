'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { parse, tokenize, pathLike, script } = require('../src/shell');
const brief = (command) =>
  parse(command).map((s) => ({
    action: s.action,
    check: s.check,
    targets: s.targets,
    ...(s.reads.length ? { reads: s.reads } : {}),
    ...(s.prefix ? { prefix: s.prefix } : {}),
  }));

test('compound commands are read segment by segment with working directories', () => {
  assert.deepEqual(brief('cd web && npm test 2>&1 | tail -40'), [
    { action: 'check', check: 'test', targets: [], prefix: 'web' },
  ]);
  assert.deepEqual(brief('(cd api && npm run lint) ; npm test'), [
    { action: 'check', check: 'static', targets: [], prefix: 'api' },
    { action: 'check', check: 'test', targets: [] },
  ]);
  assert.deepEqual(brief('cd a && cd ../b && cat x/y.ts'), [
    { action: 'read', check: null, targets: ['x/y.ts'], prefix: 'b' },
  ]);
  assert.deepEqual(brief('git -C web diff src/a.ts'), [
    { action: 'read', check: null, targets: ['src/a.ts'], prefix: 'web' },
  ]);
  // A pipe consumer that writes files is still work; one that filters output is not.
  assert.deepEqual(brief('npm test | tee reports/test.log'), [
    { action: 'check', check: 'test', targets: [] },
    { action: 'change', check: null, targets: ['reports/test.log'] },
  ]);
});

test('wrappers, environment assignments and shell -c are unwrapped once', () => {
  for (const command of [
    'CI=1 npm test',
    'env CI=1 FORCE_COLOR=0 npm test',
    'timeout 120 npm test',
    'time npm test',
    'npx --yes jest',
    'bash -lc "npm test"',
    "sh -c 'cd web && npm test'",
    'uv run pytest -q',
    'poetry run pytest',
    'python3 -m pytest',
    'bundle exec rspec',
    'npx c8 node --test',
  ])
    assert.equal(parse(command)[0]?.check, 'test', command);
  assert.equal(parse(['bash', '-lc', 'cargo clippy'])[0].check, 'static');
  assert.equal(parse(['npm', 'run', 'build'])[0].check, 'build');
  // Nesting is bounded: a shell inside a shell is not unwrapped again.
  assert.equal(parse(`bash -c "bash -c 'npm test'"`)[0]?.check ?? null, null);
});

test('inline scripts, heredoc bodies and quoted prose never become targets', () => {
  assert.deepEqual(brief(`python -c 'open("/private/secret.py")'`), [
    { action: 'run', check: null, targets: [] },
  ]);
  assert.deepEqual(brief(`node -e "require('./server/auth/session.ts')"`), [
    { action: 'run', check: null, targets: [] },
  ]);
  assert.deepEqual(brief("cat > docs/a.md <<'EOF'\nsee server/auth/session.ts\nEOF\nls src/x"), [
    { action: 'change', check: null, targets: ['docs/a.md'] },
    { action: 'read', check: null, targets: ['src/x'] },
  ]);
  assert.deepEqual(brief('git commit -m "update src/auth/session.ts"'), [
    { action: 'run', check: null, targets: [] },
  ]);
  assert.deepEqual(brief('echo server/auth/session.ts'), []);
  // A quoted word that is one plain path is a target; Next.js route groups need quotes.
  assert.deepEqual(brief('cat "app/(auth)/page.tsx"'), [
    { action: 'read', check: null, targets: ['app/(auth)/page.tsx'] },
  ]);
  assert.deepEqual(brief('cat $HOME/secrets.txt `pwd`/a.ts'), [
    { action: 'read', check: null, targets: [] },
  ]);
});

test('reads, writes and in-place edits are distinguished', () => {
  assert.equal(parse("sed -n '1,20p' src/a.ts")[0].action, 'read');
  assert.deepEqual(parse("sed -n '1,20p' src/a.ts")[0].targets, ['src/a.ts']);
  assert.equal(parse("sed -i 's/a/b/' src/a.ts")[0].action, 'change');
  assert.equal(parse("perl -pi -e 's/a/b/' src/a.ts")[0].action, 'change');
  assert.deepEqual(brief('cp src/a.ts src/b.ts'), [
    { action: 'change', check: null, targets: ['src/b.ts'], reads: ['src/a.ts'] },
  ]);
  assert.deepEqual(brief('cat src/a.ts > out/b.ts'), [
    { action: 'change', check: null, targets: ['out/b.ts'], reads: ['src/a.ts'] },
  ]);
  // A check's log output is not the work.
  assert.deepEqual(brief('npm test > test-output.log'), [
    { action: 'check', check: 'test', targets: [] },
  ]);
  assert.deepEqual(brief('psql < migrations/001.sql'), [
    { action: 'run', check: null, targets: [], reads: ['migrations/001.sql'] },
  ]);
  // The first argument of a search is its pattern.
  assert.deepEqual(brief('rg auth src/auth'), [
    { action: 'read', check: null, targets: ['src/auth'] },
  ]);
  assert.deepEqual(brief('rg --files src/components'), [
    { action: 'read', check: null, targets: ['src/components'] },
  ]);
});

test('checks are recognised across ecosystems, including task runners and scripts', () => {
  const kinds = {
    'pnpm --filter web test': 'test',
    'yarn workspace api test': 'test',
    'npm run test:unit': 'test',
    'mvn clean install': 'build',
    'mvn verify': 'test',
    './gradlew :app:check': 'test',
    'nx run web:lint': 'static',
    'npx nx affected -t test': 'test',
    'turbo run build --filter=web': 'build',
    'make CI=1 lint': 'static',
    make: 'build',
    'bazel test //...': 'test',
    'go test -bench=. ./x': 'benchmark',
    'pytest --benchmark-only': 'benchmark',
    'vitest bench': 'benchmark',
    'cargo fmt --check': 'static',
    'ruff format --check .': 'static',
    'terraform validate': 'static',
    'docker buildx build .': 'build',
    'npm audit': 'security',
    'pnpm audit --prod': 'security',
    'npx lighthouse --only-categories=accessibility http://x': 'accessibility',
    'hatch run test': 'test',
    'rails test': 'test',
    'php artisan test': 'test',
    'python manage.py test': 'test',
    'deno fmt --check': 'static',
    'dotnet format --verify-no-changes': 'static',
    'mkdocs build': 'docs',
  };
  for (const [command, kind] of Object.entries(kinds))
    assert.equal(parse(command)[0]?.check, kind, command);
  for (const command of ['npm run dev', 'npm start', 'npm ci', 'cargo run', 'ruff format .'])
    assert.notEqual(parse(command)[0]?.action, 'check', command);
  assert.equal(script('format:check').check, 'static');
  assert.equal(script('test:a11y').check, 'accessibility');
  assert.equal(script('db:migrate').context, 'data');
  assert.equal(script('dev'), null);
});

test('the reader is bounded and cannot stall on hostile input', () => {
  // Only the first 4 KiB is read: a check hidden beyond it is not seen.
  const huge = parse('a'.repeat(100_000) + ' && npm test');
  assert(huge.length <= 1 && !huge.some((s) => s.check));
  assert(tokenize('x '.repeat(10_000)).length <= 240);
  assert(parse(Array.from({ length: 50 }, (_, i) => `cat f${i}.ts`).join(' && ')).length <= 8);
  const many = parse('cat ' + Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`).join(' '));
  assert(many[0].targets.length <= 20);
  for (const input of [
    '\v\f',
    '"unterminated',
    "'open",
    '$(',
    '`',
    '<<',
    '2>&',
    '\\',
    '((((',
    '|||',
  ])
    assert.doesNotThrow(() => parse(input), input);
  assert.deepEqual(parse(null), []);
  assert.deepEqual(parse({ command: 'npm test' }), []);
});

test('path-like words need a separator, known extension or known file name', () => {
  const w = (v, q = false) => ({ v, q, dynamic: false });
  for (const v of [
    'src/a.ts',
    'README.md',
    'Dockerfile',
    '.env',
    'app/[id]/page.tsx',
    'test/*.test.js',
  ])
    assert(pathLike(w(v)), v);
  for (const v of [
    'lint',
    'test',
    '-rf',
    'https://x.test/a',
    '1.2.3',
    './...',
    '{}',
    '~',
    '.',
    'a b',
  ])
    assert(!pathLike(w(v)), v);
  assert(!pathLike(w('print(1)', true)));
  assert(!pathLike({ v: 'src/$X.ts', q: false, dynamic: true }));
});
