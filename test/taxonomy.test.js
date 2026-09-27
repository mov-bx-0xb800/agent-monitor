'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { evidence, taxonomy } = require('../src/classify'),
  { subject } = require('../src/topics'),
  { event } = require('./fixtures');
const corpus = [
  ['web interface', 'src/features/billing/components/InvoiceCard.tsx', 'experience', []],
  ['mobile interface', 'mobile/screens/AccountView.swift', 'experience', []],
  ['desktop interface', 'desktop/views/Preferences.xaml', 'experience', []],
  ['embedded safety', 'firmware/interlock/motor_control.c', 'devices', ['safety']],
  ['machine learning', 'training/models/forecast.py', 'data', []],
  ['data pipeline', 'pipelines/customer_redaction.py', 'data', ['privacy']],
  ['database migration', 'migrations/202609_create_accounts.sql', 'data', []],
  ['infrastructure', 'infra/terraform/main.tf', 'platform', []],
  ['continuous delivery', '.github/workflows/release.yml', 'platform', []],
  ['agent orchestration', 'agents/research/tools.py', 'automation', []],
  ['service security', 'server/auth/permissions.go', 'application', ['security']],
  ['service reliability', 'services/orders/retry.rs', 'application', ['reliability']],
  ['CLI implementation', 'src/parser.rs', 'application', []],
  ['policy work', 'legal/privacy-policy.md', 'knowledge', ['privacy', 'compliance']],
  ['architecture decision', 'architecture/adr/queue-selection.md', 'planning', []],
  ['research writing', 'research/literature-review.docx', 'knowledge', []],
  ['accessibility', 'components/a11y/keyboard-navigation.tsx', 'experience', ['accessibility']],
  ['operations', 'observability/runbooks/incident.md', 'platform', ['operability']],
  ['performance', 'server/cache/benchmark.go', 'application', ['performance']],
  ['cost analysis', 'reports/finops-budget.xlsx', 'data', ['cost']],
  ['unknown artifact', 'artifacts/mystery.blob', 'other', []],
];
test('industry-diverse signal corpus keeps work areas and concerns separate', () => {
  for (const [name, file, context, concerns] of corpus) {
    const e = evidence(event('Read', { file_path: file }));
    assert.equal(e.context, context, name);
    for (const id of concerns) assert(e.concerns.includes(id), `${name}: ${id}`);
    assert.equal(e.stage, 'Inspected');
    assert(e.subject);
  }
});
test('feature subjects collapse incidental files; generic entrypoints use parent context', () => {
  assert.equal(subject('src/features/billing/components/Invoice.tsx').title, 'Billing');
  assert.equal(subject('src/features/billing/api/route.ts').title, 'Billing');
  assert.equal(subject('app/settings/page.tsx').title, 'Settings');
  assert.equal(subject('src/auth/index.ts').title, 'Authentication');
  assert.equal(subject('', 'unknown_tool').title, 'Tool activity');
});
test('code bodies and directory names outside the workspace do not create concern claims', () => {
  let e = evidence({
    ...event('Edit', {
      file_path: '/workspace/components/button.tsx',
      new_string: 'security privacy safety',
    }),
    cwd: '/workspace',
  });
  assert.deepEqual(e.concerns, []);
  e = evidence({
    ...event('Read', { file_path: '/security/client/src/parser.rs' }),
    cwd: '/security/client',
  });
  assert.deepEqual(e.concerns, []);
});

test('vocabulary entries are well formed and every mapping refers to something real', () => {
  const areas = require('../src/focus-areas.json'),
    { CHECK_LABEL } = require('../src/shell');
  const ids = { contexts: new Set(), concerns: new Set() };
  ids.sensitive = new Set();
  for (const dim of ['contexts', 'concerns', 'sensitive'])
    for (const def of taxonomy[dim]) {
      assert(!ids[dim].has(def.id), `duplicate ${dim} ${def.id}`);
      ids[dim].add(def.id);
      if (dim === 'sensitive') {
        assert(['production', 'critical'].includes(def.level), `${def.id}: stakes level`);
        assert(/^[a-z][a-z ]+$/.test(def.label), `${def.id}: plain lower-case label`);
        assert(
          def.areas?.length && def.areas.every((a) => areas.some((x) => x.id === a)),
          `${def.id}: names the areas it concerns`,
        );
      }
      const terms = new Set();
      // Stakes packs share one term space with the base list: a term is defined once per entry.
      for (const list of ['terms', 'production', 'critical', 'files', 'extensions', 'fallback'])
        for (const value of def[list] || []) {
          const [term, weight = '0.75'] = value.split(/:(?=[\d.]+$)/);
          assert(Number(weight) > 0 && Number(weight) <= 1, `${def.id}: ${value}`);
          assert.equal(term, term.toLowerCase(), `${def.id}: ${value} is lower case`);
          if (['terms', 'production', 'critical'].includes(list)) {
            assert(!terms.has(term), `${def.id}: ${term} is listed twice`);
            terms.add(term);
          }
        }
      for (const key of Object.keys(def.unless || {}))
        assert(terms.has(key), `${def.id}: unless refers to unknown term ${key}`);
      for (const p of def.patterns || [])
        assert.doesNotThrow(() => new RegExp(p.re, p.flags ?? 'i'));
    }
  for (const area of areas) {
    for (const id of area.contexts || []) assert(ids.contexts.has(id), `${area.id}: ${id}`);
    for (const id of area.concerns || []) assert(ids.concerns.has(id), `${area.id}: ${id}`);
    for (const kind of area.checks || []) assert(CHECK_LABEL[kind], `${area.id}: ${kind}`);
  }
});

test('path words split on case, separators and route groups; ambiguous words need context', () => {
  const { match } = require('../src/lexicon');
  const has = (p, dim, id) => match(p, 'path')[dim].has(id);
  assert(has('src/hooks/useAuth.ts', 'concerns', 'security'), 'camelCase');
  assert(has('components/OAuthButton.tsx', 'concerns', 'security'), 'mixed-case brand');
  assert(has('app/(auth)/page.tsx', 'concerns', 'security'), 'route group');
  assert(has('server/rate_limits/index.ts', 'concerns', 'security'), 'phrase with plural');
  assert(has('src/data/retention/job.ts', 'concerns', 'privacy'), 'phrase across folders');
  // A compound word is weaker evidence than a whole folder or file name.
  const whole = match('src/auth/x.ts', 'path').concerns.get('security')[0],
    part = match('src/useAuth.ts', 'path').concerns.get('security')[0];
  assert(whole > part);
  // Vetoes: the same word means something else next to these words.
  assert(!has('styles/design-tokens.css', 'concerns', 'security'));
  assert(!has('src/chat/session.ts', 'concerns', 'security'));
  assert(!has('requirements.txt', 'concerns', 'requirements'));
  assert(!has('package-lock.json', 'concerns', 'reliability'));
  assert(!has('src/components/DataTable.tsx', 'contexts', 'data'));
  // Corroborating terms raise confidence but never reach certainty.
  const one = match('src/session.ts', 'path').concerns.get('security')[0],
    two = match('src/auth/session.ts', 'path').concerns.get('security')[0];
  assert(two > one && two <= 0.9);
  // Extensions and words are not double-counted: ".sql" alone is one piece of evidence.
  assert.equal(match('a.sql', 'path').contexts.get('data')[0], 0.9);
});
