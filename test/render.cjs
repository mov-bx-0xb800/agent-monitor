'use strict';
const { chromium } = require('@playwright/test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { html } = require('../src/webview');
const { evidence } = require('../src/classify');
const now = Date.now() / 1000;
const thread = (id, agent) => ({
  id,
  agent,
  title: id === 'demo-one' ? 'Review sign-in security' : 'Improve account settings',
  titleSource: 'prompt',
  created: now - 600,
  cwd: '/work/example',
  lastTool: 'Edit',
  updated: now,
  lastToolAt: now,
  status: 'active',
  planned: [],
  points: [],
});
const a = thread('demo-one', 'Codex'),
  b = thread('demo-two', 'Claude');
a.image = { id: 'image-one', at: now, phase: 'viewed' };
for (const [s, targets] of [
  [a, ['server/auth/session.ts', 'server/permissions.ts']],
  [
    b,
    [
      'src/features/account-settings/components/AccountPanel.tsx',
      'components/a11y/keyboard-navigation.tsx',
    ],
  ],
]) {
  s.points = targets.map((target, i) => {
    const e = evidence({ cwd: '/demo', tool_name: 'Edit', tool_input: { file_path: target } });
    return {
      id: e.key,
      title: e.subject,
      context: e.context,
      concerns: e.concerns,
      areas: e.areas,
      stage: e.stage,
      detail: e.detail,
      tool: e.tool,
      basis: e.basis,
      at: now - i * 180,
    };
  });
  s.currentPoint = s.points[0].id;
}
const data = {
  focusAreas: require('../src/focus-areas.json'),
  areaSetup: {
    industries: ['Finance, payments and banking', 'Retail and e-commerce'],
    providers: [
      ['claude', 'Claude Code'],
      ['codex', 'Codex'],
      ['cursor', 'Cursor Agent'],
    ]
      .map(([id, label]) => ({
        id,
        label,
        detail: 'Runs in a terminal here.',
      }))
      .concat({
        id: 'copy',
        label: 'Copy instructions',
        detail: 'Paste into any AI assistant.',
      }),
  },
  requests: [],
  focusSelections: {},
  focusLayouts: {},
  ignoredAgents: [],
  sessions: [a, b],
  images: [
    {
      id: 'image-one',
      file: 'one.png',
      label: 'build-history.png',
      created: now - 5,
      width: 800,
      height: 480,
      url: 'http://monitor.test/one.png',
      viewers: [{ sid: a.id, at: now }],
    },
    {
      id: 'image-two',
      file: 'two.png',
      label: 'build-history-earlier.png',
      created: now - 300,
      width: 800,
      height: 480,
      url: 'http://monitor.test/two.png',
      viewers: [{ sid: b.id, at: now - 300 }],
    },
  ],
  connections: { codex: true, claude: true },
  paused: false,
};
const theme =
  ':root{--vscode-font-family:system-ui,sans-serif;--vscode-editor-font-family:monospace;--vscode-foreground:#dce2ed;--vscode-editor-background:#20242e;--vscode-sideBar-background:#191c24;--vscode-descriptionForeground:#9ba6b9;--vscode-panel-border:#353c49;--vscode-focusBorder:#87b3f4;--vscode-list-hoverBackground:#2b3341;--vscode-button-background:#0e639c;--vscode-button-foreground:#ffffff;}';
const page0 = (surface) =>
  html({ cspSource: 'http://monitor.test' }, { surface }).replace(
    /(<style nonce="[^"]+">)/,
    '$1' + theme,
  );
(async () => {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CI ? {} : { channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' }),
    });
    const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
    page.setDefaultTimeout(6000);
    await page.setContent(
      `<html lang="en"><head><title>Image fixture</title><style>body{margin:0;padding:32px;font:14px system-ui;background:#fafafa;color:#242424}h1{font-size:24px;margin:18px 0 8px}p{color:#555}table{width:100%;border-collapse:collapse;margin:28px 0}th,td{text-align:left;padding:14px 12px;border-bottom:1px solid #ddd}th{font-size:12px;color:#555;background:#eee}code{font-size:12px}small{color:#555}</style></head><body><small>TEST FIXTURE</small><h1>Build history</h1><p>Latest runs for the example project</p><table><thead><tr><th>Commit</th><th>Branch</th><th>Status</th><th>Duration</th></tr></thead><tbody><tr><td><code>7d3a9c1</code></td><td>main</td><td>Passed</td><td>42 s</td></tr><tr><td><code>2a4f8b0</code></td><td>fix/retry</td><td>Passed</td><td>38 s</td></tr><tr><td><code>8e2b6a4</code></td><td>feature/export</td><td>Failed</td><td>21 s</td></tr></tbody></table><small>Synthetic image for renderer verification</small></body></html>`,
    );
    const demoImage = await page.screenshot();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // The missing-image journey serves a deliberate 404; any other console error fails the run.
    page.on(
      'console',
      (m) =>
        m.type() === 'error' &&
        !/^Failed to load resource: .*404/.test(m.text()) &&
        errors.push(m.text()),
    );
    await page.addInitScript(() => {
      window.messages = [];
      window.violations = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        window.violations.push(e.violatedDirective),
      );
      window.acquireVsCodeApi = () => ({
        getState: () => ({}),
        setState: (s) => {
          window.savedState = s;
        },
        postMessage: (m) => window.messages.push(m),
      });
    });
    await page.route('http://monitor.test/**', (route) => {
      const url = route.request().url();
      if (url.endsWith('missing.png')) return route.fulfill({ status: 404, body: '' });
      if (url.endsWith('.png')) return route.fulfill({ body: demoImage, contentType: 'image/png' });
      return route.fulfill({
        body: page0(url.endsWith('/editor') ? 'editor' : 'view'),
        contentType: 'text/html',
      });
    });
    await page.setViewportSize({ width: 420, height: 1000 });
    await page.goto('http://monitor.test');
    const send = async (patch) =>
      page.evaluate(
        (data) =>
          window.dispatchEvent(new MessageEvent('message', { data: { type: 'data', data } })),
        patch,
      );
    await send(data);
    const ack = async (action, area, agent) =>
      page.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), {
        type: 'action-result',
        action,
        area,
        agent,
      });
    const last = () => page.evaluate(() => window.messages.at(-1));
    const selectTab = async (name) =>
      page.getByRole('tab', { name: new RegExp('^' + name) }).click();
    const selectChat = async (id) => page.locator(`#chat-strip [data-chat="${id}"]`).click();
    const pressed = async (id) =>
      page.locator(`#chat-strip [data-chat="${id}"]`).getAttribute('aria-pressed');
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    // Motion is on by default: wait for running animations before screenshots and scans, so a
    // half-faded element is never judged or captured.
    const settle = () =>
      page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
      });
    const stripSettled = () =>
      page.waitForFunction(
        () =>
          new Promise((resolve) => {
            const strip = document.getElementById('chat-strip');
            let last = strip.scrollLeft,
              same = 0;
            const tick = () => {
              if (strip.scrollLeft === last) {
                if (++same > 6) return resolve(true);
              } else {
                same = 0;
                last = strip.scrollLeft;
              }
              requestAnimationFrame(tick);
            };
            tick();
          }),
      );
    const out = path.join(
      __dirname,
      process.env.UPDATE_SCREENSHOTS === '1' ? '../docs/images' : '../.evidence/screenshots',
    );
    fs.mkdirSync(out, { recursive: true });
    const evidenceOut = path.join(__dirname, '../.evidence/renderer');
    fs.mkdirSync(evidenceOut, { recursive: true });

    // Frame: two views, Main Window, utilities above the tabs.
    assert.deepEqual(
      await page.locator('[role=tab]').allInnerTexts(),
      ['Focus', 'Images'],
      'Focus and Images are the only views',
    );
    assert.equal(await page.locator('#tab-focus').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#summary').innerText(), '2 active');
    assert(
      await page
        .locator('.monitor-toolbar')
        .evaluate(
          (e) =>
            e.getBoundingClientRect().bottom <=
            document.querySelector('nav').getBoundingClientRect().top,
        ),
    );
    assert.equal(await page.locator('#agent-count').count(), 0, 'no agent ratio in the toolbar');
    await page.locator('#open-editor').click();
    assert.deepEqual(await last(), { action: 'open-editor' });
    assert.match(await page.locator('#open-editor').innerText(), /Main Window/);

    // Chat strip: compact, provider marks, recency tint, no area chips.
    const heat = () =>
      page
        .locator('#chat-strip [data-chat="demo-one"]')
        .evaluate((e) => Number(e.style.getPropertyValue('--heat')));
    const freshHeat = await heat();
    await send({ sessions: [{ ...a, lastToolAt: now - 600, updated: now, status: 'waiting' }, b] });
    assert((await heat()) < freshHeat && (await heat()) > 0);
    await send(data);
    assert.equal(await page.locator('#chat-strip .provider-icon').count(), 2);
    assert.match(await page.locator('[data-chat="demo-two"]').innerText(), /Improve account/);
    assert.match(await page.locator('[data-chat="demo-two"]').innerText(), /Claude Code/);
    await send({ sessions: [...data.sessions, thread('demo-cursor', 'Cursor')] });
    assert.equal(await page.locator('#chat-strip .provider-icon path').count(), 3);
    await send({ sessions: data.sessions });
    assert.equal(await page.locator('#chat-strip .area-chip').count(), 0);
    assert.equal(
      await page
        .locator('#chat-strip [data-chat="demo-one"] .chat-choice-title')
        .evaluate((e) => getComputedStyle(e).webkitLineClamp),
      '2',
      'chat titles get two lines',
    );
    assert.match(
      await page.locator('[data-chat="demo-one"] .choice-head').innerText(),
      /Codex · Active · just now/,
    );
    // Focus always shows one chat, starting with the most recent; only Images has All chats.
    assert.equal(await page.locator('#chat-strip [data-chat="all"]').count(), 0);
    assert.equal(await pressed('demo-one'), 'true');

    // One chat: header with local rename, no repeated chat name inside tiles.
    await selectChat('demo-one');
    assert.equal(await pressed('demo-one'), 'true');
    assert.match(await page.locator('#chat-summary').innerText(), /Review sign-in security/);
    assert.match(await page.locator('#chat-summary').innerText(), /Codex · Active/);
    assert.equal(await page.locator('#groups .tile-thread').count(), 0);
    await page.locator('#rename-demo-one').click();
    assert.deepEqual(await last(), { action: 'rename-chat', sid: 'demo-one' });
    await send({ notice: '' });
    assert(await page.locator('#rename-demo-one').isVisible());
    for (const width of [280, 320, 420, 960]) {
      await page.setViewportSize({ width, height: 1000 });
      assert(await fits(), `focus overflow at ${width}`);
    }
    await page.setViewportSize({ width: 420, height: 1000 });
    await settle();
    await page.screenshot({ path: path.join(out, 'chat.png'), fullPage: true });

    // Meters, arrangement and drag handles.
    assert.match(await page.locator('[data-point=security] .count').innerText(), /^\d+$/);
    assert(
      await page
        .locator('[data-area=security] .meter > span')
        .evaluate((e) => e.getBoundingClientRect().width > 0),
      'the score meter fills to the score',
    );
    assert.equal(
      await page.locator('[data-point=performance] .tile-state').innerText(),
      'No activity',
    );
    assert.equal(await page.locator('#groups .focus-card').count(), 6);
    await page.locator('#move-performance').click();
    assert.deepEqual(await last(), {
      action: 'arrange-area',
      area: 'performance',
      sid: 'demo-one',
    });
    await page.locator('#move-performance').dragTo(page.locator('[data-area=security]'));
    assert.deepEqual(await last(), {
      action: 'move-area',
      area: 'performance',
      sid: 'demo-one',
      zone: 'primary',
      before: 'security',
    });
    await send({
      focusLayouts: {
        'demo-one': {
          primary: ['performance', 'security', 'ux', 'backend', 'data', 'testing'],
          extra: [],
        },
      },
    });
    assert.equal(
      await page.locator('#groups [data-area]').first().getAttribute('data-area'),
      'performance',
    );
    await page.locator('#move-performance').dragTo(page.locator('#more-areas-label'));
    assert.deepEqual(await last(), {
      action: 'move-area',
      area: 'performance',
      sid: 'demo-one',
      zone: 'extra',
    });
    await send({ focusLayouts: {} });

    await selectChat('demo-one');
    await page.locator('#choose-areas').click();
    assert.deepEqual(await last(), { action: 'choose-areas', sid: 'demo-one' });
    await send({ focusSelections: { 'demo-one': ['security', 'performance', 'reliability'] } });
    await ack('choose-areas');
    assert.equal(await page.locator('#groups .focus-card').count(), 3);
    assert.equal(
      await page.locator('#groups [data-point=reliability] .tile-state').innerText(),
      'No activity',
    );
    await page.locator('[data-point=reliability]').click();
    assert(
      (await page.locator('#detail').innerText()).includes('failures, interruptions and recovery'),
    );
    await page.keyboard.press('Escape');
    assert.equal(
      await page.locator('[data-point=reliability]').getAttribute('aria-expanded'),
      'false',
    );
    assert.equal(await page.evaluate(() => document.activeElement.dataset.point), 'reliability');

    // Focus requests keep their lifecycle states.
    await page.locator('[data-focus=performance]').click();
    assert.deepEqual(await last(), { action: 'focus', area: 'performance', sid: 'demo-one' });
    await send({
      requests: [
        { id: 'request-one', sid: 'demo-one', area: 'performance', created: now, status: 'queued' },
      ],
    });
    await ack('focus', 'performance');
    assert(await page.locator('[data-focus=performance]').isDisabled());
    const performanceCard = () =>
      page.locator('.focus-card').filter({ has: page.locator('[data-point=performance]') });
    assert(
      (await performanceCard().innerText()).includes('Waiting for the next supported agent event.'),
    );
    for (const width of [280, 420]) {
      await page.setViewportSize({ width, height: 1000 });
      assert(await fits(), 'queued guidance fits sidebar');
    }
    await page.locator('[data-cancel-focus]').focus();
    await send({ notice: '' });
    assert.equal(
      await page.evaluate(() => document.activeElement.dataset.cancelFocus),
      'request-one',
    );
    await page.locator('[data-cancel-focus]').click();
    assert.deepEqual(await last(), { action: 'cancel-focus', id: 'request-one' });
    await send({
      requests: [
        {
          id: 'request-one',
          sid: 'demo-one',
          area: 'performance',
          created: now - 3601,
          status: 'queued',
        },
      ],
    });
    assert((await performanceCard().innerText()).includes('Expired'));
    assert(!(await page.locator('[data-focus=performance]').isDisabled()));
    // Direct-delivery states (ported from the delivery work) stay on the tile.
    for (const [status, label] of [
      ['dispatching', 'Sending…'],
      ['accepted', 'Accepted'],
      ['unknown', 'Delivery unconfirmed'],
    ]) {
      await send({
        requests: [
          {
            id: 'direct-request',
            sid: 'demo-one',
            area: 'performance',
            created: now,
            delivered: now,
            status,
          },
        ],
      });
      assert((await performanceCard().innerText()).includes(label));
      assert.equal(
        await page.locator('[data-focus=performance]').isDisabled(),
        status === 'dispatching',
      );
    }
    await send({ sessions: [{ ...a, focusDelivery: 'queue' }, b], requests: [] });
    assert.equal(await page.locator('[data-focus=performance]').innerText(), 'Queue for next turn');
    await page.locator('[data-focus=performance]').click();
    assert.equal((await last()).delivery, 'queue');
    await ack('focus', 'performance');
    await send({ sessions: data.sessions });
    await send({
      requests: [
        {
          id: 'request-one',
          sid: 'demo-one',
          area: 'performance',
          created: now,
          status: 'delivered',
          delivered: now,
        },
      ],
    });
    assert((await performanceCard().innerText()).includes('Sent! Task is focusing here…'));
    await send({
      requests: [
        { id: 'request-one', sid: 'demo-one', area: 'performance', created: now, status: 'queued' },
      ],
    });
    await send({ requests: [] });
    await page.locator('[data-point=security]').click();
    assert.equal(await page.locator('#detail .evidence').count(), 1);
    await settle();
    await page.screenshot({ path: path.join(out, 'focus.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.locator('#more-areas > summary').click();
    await page.locator('[data-point=architecture]').focus();
    await page.keyboard.press('Enter');
    assert((await page.locator('#detail').innerText()).includes('maintainability'));
    await page.keyboard.press('Escape');
    await page.locator('#more-areas > summary').click();

    // Project stakes, custom areas, sensitive changes and the custom-area card.
    assert.equal(
      await page.locator('#stakes [role=radio][aria-checked=true]').innerText(),
      'Standard',
    );
    await page.locator('#stakes [data-stakes=production]').click();
    assert.deepEqual(await last(), { action: 'set-stakes', stakes: 'production' });
    assert.match(await page.locator('.stakes-note').innerText(), /Marks sensitive changes/);
    await page.locator('#stakes [data-stakes=production]').focus();
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await last(), { action: 'set-stakes', stakes: 'critical' });
    assert.equal(
      await page.evaluate(() => document.activeElement.dataset.stakes),
      'critical',
      'focus follows the selection',
    );
    const customArea = {
      id: 'x:ledger-integrity',
      label: 'Ledger integrity',
      description: 'Double-entry balances stay correct.',
      colour: '#5fb3a1',
      core: true,
      custom: true,
    };
    const ledgerPoint = {
      id: 'e'.repeat(16),
      title: 'Ledger',
      stage: 'Changed',
      detail: 'src/ledger/post.ts',
      basis: 'Path signal',
      areas: [
        ['data', 0.8, '“ledger” in path'],
        ['x:ledger-integrity', 0.9, 'path matches “src/ledger/**”'],
      ],
      sensitive: 'payments or money movement',
      risk: ['data', 'x:ledger-integrity'],
      at: now,
    };
    const review = {
      hash: 'abc123',
      status: 'needs work',
      approved: false,
      pending: true,
      changed: false,
      errors: [],
      areas: [
        {
          id: 'refunds',
          label: 'Refund safety',
          status: 'ready',
          problems: 0,
          firstProblem: '',
          examples: { matched: 6, match: 6, ignored: 5, ignore: 5 },
          breadth: 0.5,
        },
        {
          id: 'weak',
          label: 'Payments',
          status: 'needs work',
          problems: 1,
          firstProblem: 'Term "service" is too common.',
        },
      ],
    };
    await send({
      stakes: 'critical',
      sessions: [{ ...a, cwd: '/work/example', points: [ledgerPoint, ...a.points] }, b],
      focusProfiles: [
        { root: '/work/example', stakes: 'critical', areas: [customArea], definition: review },
      ],
    });
    const custom = page.locator('[data-area="x:ledger-integrity"]');
    // Saved layouts put a newly enabled area under More areas; its text is present either way.
    assert((await custom.textContent()).includes('Custom'));
    assert((await custom.textContent()).includes('1 sensitive change'));
    assert(
      !(await page.locator('[data-area=backend]').textContent()).includes('sensitive'),
      'only concerned areas are marked',
    );
    assert.match(await page.locator('#more-areas-label').innerText(), /1 to approve/);
    await page.locator('#more-areas > summary').click();
    const card = page.locator('.custom-card');
    assert.match(await card.innerText(), /Ready to approve: “Refund safety”/);
    assert.match(await card.innerText(), /Refund safety · ready, tested on 11 example files/);
    assert.match(await card.innerText(), /Payments · needs a fix: Term "service" is too common\./);
    await card.screenshot({ path: path.join(evidenceOut, 'custom-card.png') });
    await card.getByRole('button', { name: 'Copy fix request' }).click();
    assert.deepEqual(await last(), { action: 'area-fix', root: '/work/example' });
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    assert.deepEqual(await last(), {
      action: 'area-enable',
      root: '/work/example',
      hash: 'abc123',
    });
    await card.getByRole('button', { name: 'View details' }).click();
    assert.deepEqual(await last(), { action: 'area-report', root: '/work/example' });
    await send({
      focusProfiles: [
        { root: '/work/example', stakes: 'critical', areas: [customArea], definition: null },
      ],
    });
    // Start now opens a short form inside the card; nothing is sent until it is submitted.
    const count = () => page.evaluate(() => window.messages.length),
      sentBefore = await count();
    await page.locator('.custom-card').getByRole('button', { name: 'Start now' }).click();
    const areaForm = page.getByRole('form', { name: 'Create your own Focus Area' });
    assert(await areaForm.isVisible());
    assert.equal(await page.evaluate(() => document.activeElement.id), 'area-name');
    assert.equal(await count(), sentBefore, 'opening the form sends nothing');
    assert.equal(await page.getByLabel('Name', { exact: true }).getAttribute('id'), 'area-name');
    assert.equal(await page.getByLabel('Details Optional').getAttribute('id'), 'area-about');
    assert.equal(await page.getByLabel('Kind of product Optional').getAttribute('id'), 'area-kind');
    assert.equal(await areaForm.getByRole('radio').count(), 4);
    await areaForm.getByRole('button', { name: 'Create Focus Area' }).click();
    assert.match(await page.locator('#area-name-error').innerText(), /at least 2 characters/);
    assert.equal(await page.locator('#area-name').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'area-name');
    assert.equal(await count(), sentBefore, 'an invalid form sends nothing');
    await page.locator('#area-name').fill('Checkout');
    assert(await page.locator('#area-name-error').isHidden(), 'the problem clears as you type');
    await page.locator('#area-about').fill('Cart pages and the orders API');
    // A data update while typing keeps the text, the focus and the caret.
    await page.locator('#area-name').press('End');
    await page.locator('#area-name').pressSequentially(' flo');
    await send({ sessions: data.sessions });
    await page.locator('#area-name').pressSequentially('w');
    assert.equal(await page.locator('#area-name').inputValue(), 'Checkout flow');
    await page.locator('#area-kind').selectOption('Retail and e-commerce');
    await areaForm.getByRole('radio', { name: /^Codex/ }).check();
    await page.screenshot({ path: path.join(evidenceOut, 'custom-form.png'), fullPage: true });
    await page
      .locator('.custom-card')
      .screenshot({ path: path.join(evidenceOut, 'custom-form-card.png') });
    await page.locator('#area-name').press('Enter');
    assert.deepEqual(await last(), {
      action: 'area-start',
      root: '/work/example',
      name: 'Checkout flow',
      about: 'Cart pages and the orders API',
      industry: 'Retail and e-commerce',
      provider: 'codex',
    });
    assert(await areaForm.getByRole('button', { name: 'Starting…' }).isDisabled());
    // A problem from the host keeps everything typed and says why, inside the form.
    await page.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), {
      type: 'action-result',
      action: 'area-start',
      error: 'That project is no longer open.',
    });
    assert.match(await page.locator('#area-form-error').innerText(), /no longer open/);
    assert.equal(await page.locator('#area-name').inputValue(), 'Checkout flow');
    assert(await areaForm.getByRole('button', { name: 'Create Focus Area' }).isEnabled());
    // Escape closes the form and returns to Start now; the agent choice is remembered.
    await page.locator('#area-about').press('Escape');
    assert.equal(await areaForm.count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Start now');
    await page.locator('.custom-card').getByRole('button', { name: 'Start now' }).click();
    assert(
      await areaForm.getByRole('radio', { name: /^Codex/ }).isChecked(),
      'remembers the agent',
    );
    await page.locator('#area-name').fill('Checkout flow');
    await areaForm.getByRole('button', { name: 'Create Focus Area' }).click();
    // Success: the card shows who is setting it up, and Start over keeps the name.
    await send({
      draft: { root: '/work/example', name: 'Checkout flow', provider: 'Codex', at: now },
    });
    await ack('area-start');
    assert.equal(await areaForm.count(), 0);
    assert.match(
      await page.locator('.custom-card').innerText(),
      /Codex is setting up “Checkout flow”/,
    );
    await page.locator('.custom-card').getByRole('button', { name: 'Start over' }).click();
    assert.equal(await page.locator('#area-name').inputValue(), 'Checkout flow');
    await areaForm.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await areaForm.count(), 0);
    await send({ draft: null });
    await send({ stakes: 'standard', focusProfiles: [], sessions: data.sessions });
    await page.locator('#more-areas > summary').click();

    // Images: separate selection, round arrows on the preview, history and recovery.
    await selectTab('Images');
    assert.equal(await page.locator('#image-scope').count(), 0, 'no chat dropdown');
    assert.equal(await pressed('all'), 'true');
    assert.equal(await page.locator('#image-stage .in-use').count(), 1);
    assert(
      (await page.locator('#image-stage .image-state').innerText()).includes('Recently viewed'),
    );
    await page.locator('#image-stage img').evaluate((img) => (window.originalImage = img));
    await send({ sessions: data.sessions });
    assert(
      await page.evaluate(
        () => window.originalImage === document.querySelector('#image-stage img'),
      ),
    );
    await page.locator('#image-stage img').evaluate(async (img) => {
      await img.decode();
      if (img.naturalWidth !== 800 || img.getBoundingClientRect().height < 100)
        throw Error('Main image did not render');
    });
    const arrows = await page.evaluate(() => {
      const box = document.querySelector('.image-box').getBoundingClientRect(),
        next = document.getElementById('next').getBoundingClientRect();
      return {
        centred: Math.abs(next.top + next.height / 2 - (box.top + box.height / 2)) < 2,
        onEdge: next.right <= box.right && next.right > box.right - 16,
        round: getComputedStyle(document.getElementById('next')).borderRadius === '50%',
        firstHidden: getComputedStyle(document.getElementById('previous')).visibility === 'hidden',
      };
    });
    assert.deepEqual(arrows, { centred: true, onEdge: true, round: true, firstHidden: true });
    assert.equal(await page.locator('.slider-tools').count(), 0, 'no pager below the history');
    assert(
      await page.evaluate(
        () =>
          document.getElementById('thumbnails').getBoundingClientRect().bottom <=
          document.getElementById('image-stage').getBoundingClientRect().top,
      ),
      'the history sits above the main image',
    );
    await page
      .locator('#thumbnails img')
      .evaluateAll((imgs) => Promise.all(imgs.map((img) => img.decode())));
    assert(
      await page.locator('#thumbnails button').evaluateAll((buttons) =>
        buttons.every((b) => {
          const image = b.querySelector('img').getBoundingClientRect(),
            caption = b.querySelector('.caption').getBoundingClientRect();
          return (
            caption.top >= image.bottom && caption.height < 20 && b.scrollWidth <= b.clientWidth
          );
        }),
      ),
      'Thumbnail ages stay below their images without wrapping or overflow',
    );
    await settle();
    await page.screenshot({ path: path.join(out, 'images.png'), fullPage: true });
    // Browsing never turns Follow latest off; while it is on, a newly used image takes over.
    await page.locator('#next').click();
    assert.equal(await page.locator('#image-position').innerText(), '2 of 2');
    assert.equal(await page.locator('#follow').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'previous');
    await send(data);
    assert.equal(await page.locator('#image-position').innerText(), '2 of 2', 'no new image');
    await page.locator('[data-image="image-two"]').click();
    assert.equal(await page.locator('#follow').getAttribute('aria-pressed'), 'true');
    const arrival = (id, at) => ({
      ...data.images[0],
      id,
      created: at,
      viewers: [{ sid: a.id, at }],
    });
    await send({ images: [arrival('image-three', now + 1), ...data.images] });
    assert.equal(await page.locator('#image-position').innerText(), '1 of 3', 'follows arrival');
    await page.locator('#follow').click();
    assert.equal(await page.locator('#follow').getAttribute('aria-pressed'), 'false');
    await page.locator('#next').click();
    await send({
      images: [arrival('image-four', now + 2), arrival('image-three', now + 1), ...data.images],
    });
    assert.equal(await page.locator('#image-position').innerText(), '3 of 4', 'stays when off');
    await page.locator('#follow').click();
    assert.equal(await page.locator('#image-position').innerText(), '1 of 4', 'on shows newest');
    await send(data);
    assert.equal(await page.locator('#image-position').innerText(), '1 of 2');
    await page.locator('#image-open').click();
    assert.deepEqual(await last(), { action: 'open-image', id: 'image-one' });
    // Only the picture opens a tab: the frame around it, and near misses on the arrows, do not.
    const before = await page.evaluate(() => window.messages.length);
    const view = await page.locator('#image-view').boundingBox(),
      picture = await page.locator('#image-stage img').boundingBox();
    await page.mouse.click(view.x + 3, view.y + 3);
    await page.mouse.click(view.x + view.width / 2, view.y + view.height - 3);
    assert.equal(
      await page.evaluate(() => window.messages.length),
      before,
      'frame clicks do nothing',
    );
    const next = await page.locator('#next').boundingBox();
    await page.mouse.click(next.x - 4, next.y + next.height / 2);
    assert.equal(await page.locator('#image-position').innerText(), '2 of 2', 'near miss moves on');
    assert.equal(await page.evaluate(() => window.messages.length), before, 'and opens nothing');
    await page.locator('#previous').click();
    await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
    assert.deepEqual(await last(), { action: 'open-image', id: 'image-one' });
    // The image strip lists chats by image activity, most recent first.
    await send({
      images: [
        { ...data.images[1], created: now, viewers: [{ sid: b.id, at: now }] },
        { ...data.images[0], created: now - 400, viewers: [{ sid: a.id, at: now - 400 }] },
      ],
    });
    assert.deepEqual(
      await page
        .locator('#chat-strip [data-chat]')
        .evaluateAll((e) => e.map((x) => x.dataset.chat)),
      ['all', 'demo-two', 'demo-one'],
    );
    const shared = {
      ...data.images[0],
      created: now,
      viewers: [
        { sid: b.id, at: now },
        { sid: a.id, at: now - 300 },
      ],
    };
    await send({ images: [shared] });
    await selectChat(a.id);
    assert((await page.locator('#image-stage .image-by').innerText()).includes('5 min ago'));
    await selectTab('Focus');
    assert.equal(await pressed('demo-one'), 'true', 'Focus keeps its own chat selection');
    await selectTab('Images');
    await selectChat('all');
    await send(data);
    await send({ sessions: [{ ...a, status: 'waiting', image: null }, b] });
    assert.equal(await page.locator('#image-stage .in-use').count(), 0);
    await page.locator('[aria-label="Dismiss image"]').click();
    assert.equal((await last()).action, 'remove');
    await send({
      images: [{ ...data.images[0], id: 'missing-image', url: 'http://monitor.test/missing.png' }],
    });
    await page.getByText('This cached image is unavailable.', { exact: false }).waitFor();
    assert(await page.locator('[aria-label="Dismiss image"]').isVisible());
    await send(data);

    // Large or animated images: a still, reduced preview and a way to the original.
    await send({
      images: [
        {
          ...data.images[0],
          id: 'image-large',
          width: 12000,
          height: 3000,
          animated: true,
          display: 'reduced',
        },
      ],
    });
    await page.waitForFunction(() => document.querySelector('#image-view canvas')?.width > 0);
    assert.equal(await page.locator('#image-view img').count(), 0, 'the original is not displayed');
    assert(
      (await page.locator('#image-quality').innerText()).includes('Still preview of an animation'),
    );
    assert.equal(await page.locator('#thumbnails canvas').count(), 1);
    await page.getByRole('button', { name: 'View clearer image' }).click();
    assert.deepEqual(await last(), { action: 'open-image', id: 'image-large' });
    await send({
      images: [
        {
          ...data.images[0],
          id: 'image-huge',
          width: 90000,
          height: 90000,
          display: 'unavailable',
        },
      ],
    });
    await page.getByText('Too large to preview here', { exact: false }).first().waitFor();
    assert.equal(
      await page.locator('#image-view img, #image-view canvas, #thumbnails img').count(),
      0,
      'an oversized image is never decoded in the view',
    );
    await page.getByRole('button', { name: 'View clearer image' }).click();
    assert.deepEqual(await last(), { action: 'open-image', id: 'image-huge' });
    await send(data);
    assert(await page.locator('#image-quality').isHidden());

    // Unseen images: a red count on the tab, then a three-second outline on arrival.
    await selectTab('Focus');
    assert(await page.locator('#image-unseen').isHidden(), 'no count for images already seen');
    await send({
      images: [
        {
          ...data.images[0],
          id: 'image-new',
          created: now + 5,
          viewers: [{ sid: b.id, at: now + 5 }],
        },
        ...data.images,
      ],
    });
    assert.equal(await page.locator('#image-unseen').innerText(), '1');
    assert.equal(await page.locator('#tab-images').getAttribute('aria-label'), 'Images, 1 new');
    assert.equal(
      await page.locator('#image-unseen').evaluate((e) => getComputedStyle(e).backgroundColor),
      'rgb(209, 36, 47)',
    );
    await selectTab('Images');
    assert(await page.locator('#image-unseen').isHidden());
    assert.equal(await page.locator('#thumbnails .fresh').count(), 1);
    assert.equal(await page.locator('#thumbnails .fresh').getAttribute('data-image'), 'image-new');
    await page.waitForFunction(() => !document.querySelector('.fresh'), null, { timeout: 4000 });
    await selectTab('Focus');
    assert(await page.locator('#image-unseen').isHidden(), 'visiting Images marks them seen');
    await send(data);

    await page.locator('#agents-open').click();
    assert((await page.locator('#connections').innerText()).includes('Tool activity received'));
    assert((await page.locator('#connections').innerText()).includes('Cursor'));
    await page.locator('#setup-close').click();
    await send({ paused: true });
    assert(await page.locator('#pause-message').isVisible());
    assert.equal(await page.locator('.presence').count(), 0);
    assert(await page.locator('[data-focus=performance]').isDisabled());
    await send({ paused: false });
    await send({ notice: 'Request queued' });
    await page.locator('[aria-label="Dismiss notification"]').click();
    assert.equal((await last()).action, 'clear-notice');
    await send({ notice: '' });

    // Twelve chats: scrolling strip, keyboard selection and preserved scroll.
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...a,
      id: 'thread-' + i,
      title:
        'A long synthetic thread title describing a cross-platform integration and recovery investigation ' +
        i,
    }));
    await send({ sessions: many });
    assert.equal(
      await page.locator('#chat-strip [data-chat]').count(),
      13,
      'twelve chats plus the selected chat that is no longer retained',
    );
    await selectChat('thread-0');
    assert.equal(await page.locator('#chat-strip [data-chat]').count(), 12);
    await page.locator('#chat-choice-thread-0').focus();
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'chat-choice-thread-11');
    await page.keyboard.press('Enter');
    assert.equal(await pressed('thread-11'), 'true');
    await stripSettled();
    const stripLeft = await page.locator('#chat-strip').evaluate((e) => e.scrollLeft);
    assert(stripLeft > 0);
    await send({ notice: '' });
    assert.equal(await page.locator('#chat-strip').evaluate((e) => e.scrollLeft), stripLeft);
    await page.locator('#chats-previous').click();
    await send({ notice: '' });
    await stripSettled();
    assert(
      (await page.locator('#chat-strip').evaluate((e) => e.scrollLeft)) < stripLeft,
      'a refresh during a smooth scroll does not cancel it',
    );
    assert.equal(await pressed('thread-11'), 'true');
    for (const width of [280, 960]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await fits());
      assert(await page.locator('#chat-strip').evaluate((e) => e.scrollWidth > e.clientWidth));
    }
    await page.setViewportSize({ width: 420, height: 1000 });
    await send({ sessions: many.slice(0, 2) });
    assert.equal(await pressed('thread-11'), 'true', 'a missing chat stays selected');
    assert((await page.locator('#panel-focus').innerText()).includes('Chat unavailable'));
    assert.equal(await page.locator('[data-focus]').count(), 0);
    await send(data);
    await selectChat('demo-one');

    const themes = {
      dark: {
        'editor-background': '#20242e',
        'sideBar-background': '#191c24',
        foreground: '#dce2ed',
        descriptionForeground: '#aeb8c9',
        'panel-border': '#495262',
        focusBorder: '#87b3f4',
        'textLink-foreground': '#9bc5ff',
        'list-hoverBackground': '#2b3341',
        'button-background': '#0e639c',
        'button-foreground': '#ffffff',
      },
      light: {
        'editor-background': '#ffffff',
        'sideBar-background': '#f8f8f8',
        foreground: '#202020',
        descriptionForeground: '#555555',
        'panel-border': '#c7c7c7',
        focusBorder: '#005fb8',
        'textLink-foreground': '#005fb8',
        'list-hoverBackground': '#eeeeee',
        'button-background': '#005fb8',
        'button-foreground': '#ffffff',
      },
    };
    const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
    await page.evaluate(axeSource);
    const scan = async () => {
      await settle();
      return page.evaluate(async () => {
        const r = await axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
        });
        return {
          violations: r.violations.map((v) => ({
            id: v.id,
            targets: v.nodes.map((n) => n.target),
          })),
          incomplete: r.incomplete.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
          })),
        };
      });
    };
    const a11y = [];
    await send({
      sessions: [
        {
          ...a,
          images: [
            { id: 'image-one', at: now, phase: 'viewed' },
            { id: 'image-two', at: now, phase: 'viewed' },
          ],
        },
        b,
      ],
    });
    await selectTab('Images');
    assert.equal(await page.locator('#thumbnails .in-use').count(), 2);
    await send(data);
    for (const [name, values] of Object.entries(themes)) {
      await page.evaluate((values) => {
        for (const [k, v] of Object.entries(values))
          document.documentElement.style.setProperty('--vscode-' + k, v);
      }, values);
      for (const view of ['Focus', 'Images']) {
        await selectTab(view);
        if (view === 'Focus') await page.locator('[data-point=security]').click();
        const result = await scan();
        a11y.push({ theme: name, view, ...result });
        assert.deepEqual(result.violations, [], `${name} ${view} accessibility`);
        if (view === 'Focus') await page.keyboard.press('Escape');
      }
      await selectTab('Focus');
      await page.evaluate(() => {
        document.getElementById('more-areas').open = true;
        for (const tile of document.querySelectorAll('.focus-card'))
          tile.style.setProperty('--heat', '1');
      });
      assert.deepEqual((await scan()).violations, [], `${name} maximum category colour`);
      await page.evaluate(() => {
        document.getElementById('more-areas').open = false;
      });
      await send(data);
      await settle();
      await page.screenshot({
        path: path.join(evidenceOut, 'focus-' + name + '.png'),
        fullPage: true,
      });
    }
    for (const width of [280, 320, 420, 960]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['Focus', 'Images']) {
        await selectTab(name);
        assert(await fits(), `overflow at ${width} in ${name}`);
      }
    }
    await page.setViewportSize({ width: 640, height: 1000 });
    await page.evaluate(() => (document.body.style.zoom = '2'));
    for (const view of ['Focus', 'Images']) {
      await selectTab(view);
      assert(await fits(), `200% reflow ${view}`);
    }
    await page.evaluate(() => (document.body.style.zoom = '1'));
    await page.setViewportSize({ width: 320, height: 900 });
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await selectTab('Focus');
    await page.screenshot({ path: path.join(evidenceOut, 'high-contrast.png'), fullPage: true });
    assert(await fits());
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
    await page.getByRole('tab', { name: 'Focus', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-images').getAttribute('aria-selected'), 'true');

    // Empty, error and setup states.
    await send({ images: [], sessions: [], connections: {}, notice: '', workspaceStatus: 'ready' });
    await selectTab('Focus');
    assert((await page.locator('#panel-focus').innerText()).includes('No chats'));
    assert(await page.locator('#chat-picker').isHidden());
    await page.screenshot({ path: path.join(evidenceOut, 'setup.png'), fullPage: true });
    await selectTab('Images');
    assert(!(await page.locator('#follow').isVisible()));
    assert(!(await page.locator('#previous').isVisible()));
    await selectTab('Focus');
    await send({ connections: { codex: true } });
    assert((await page.locator('#panel-focus').innerText()).includes('No tool activity yet'));
    for (const [status, title] of [
      ['no-folder', 'Open a project'],
      ['remote', 'Local agents only'],
      ['untrusted', 'Workspace trust required'],
    ]) {
      await send({ workspaceStatus: status });
      assert((await page.locator('#panel-focus').innerText()).includes(title));
    }
    await send({ workspaceStatus: 'ready', cacheIssue: 'Unreadable activity file' });
    assert((await page.locator('#panel-focus').innerText()).includes('Activity unavailable'));
    await send({ cacheIssue: null });
    const pending = {
      cacheIssue: null,
      workspaceStatus: 'ready',
      sessions: [],
      images: [],
      connections: { codex: true, claude: true },
      connectionDetails: {
        codex: { configured: true },
        claude: { configured: true, disabled: true },
        cursor: { configured: false },
      },
      ignoredAgents: [],
    };
    await send(pending);
    assert.equal(
      await page.locator('#setup-warning-title').evaluate((e) => getComputedStyle(e).fontWeight),
      '700',
    );
    assert.equal(
      await page.locator('#setup-warning-note').evaluate((e) => getComputedStyle(e).color),
      'rgb(48, 36, 16)',
    );
    await page.screenshot({ path: path.join(evidenceOut, 'setup-warning.png'), fullPage: true });
    assert(await page.locator('#setup-warning').isVisible());
    assert(await page.locator('#setup-ignore').isHidden(), 'several agents are handled in setup');
    await page.locator('#setup-open').click();
    assert(await page.locator('#setup-dialog').isVisible());
    assert(await page.locator('#setup-warning').isHidden(), 'the banner hides behind setup');
    assert(
      (await page.locator('#connections').innerText()).includes('trust the Agent Monitor entries'),
    );
    assert((await page.locator('#connections').innerText()).includes('Hooks disabled'));
    await page.locator('#setup-codex-review-hooks').click();
    assert.deepEqual(await last(), { action: 'review-hooks', agent: 'codex' });
    await ack('review-hooks', undefined, 'codex');
    await page.locator('#copy-hooks-codex').click();
    assert.deepEqual(await last(), { action: 'copy-hooks' });
    await ack('copy-hooks');
    await page.locator('#setup-claude-agent-settings').click();
    assert.deepEqual(await last(), { action: 'agent-settings', agent: 'claude' });
    await ack('agent-settings', undefined, 'claude');
    await page.locator('#setup-cursor-connect-agent').click();
    assert.deepEqual(await last(), { action: 'connect-agent', agent: 'cursor' });
    await ack('connect-agent', undefined, 'cursor');
    // “I don’t use …” hides an agent from warnings without touching its hooks.
    await page.locator('#ignore-cursor').click();
    assert.deepEqual(await last(), { action: 'ignore-agent', agent: 'cursor', ignored: true });
    assert.match(await page.locator('#connections').innerText(), /Cursor\s*Not used/);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ignore-cursor-undo');
    await page.locator('#ignore-cursor-undo').click();
    assert.deepEqual(await last(), { action: 'ignore-agent', agent: 'cursor', ignored: false });
    await page.screenshot({
      path: path.join(evidenceOut, 'agent-setup-light.png'),
      fullPage: true,
    });
    for (const width of [280, 420]) {
      await page.setViewportSize({ width, height: 700 });
      assert(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.getElementById('setup-dialog').scrollWidth <=
              document.getElementById('setup-dialog').clientWidth,
        ),
        `setup overflow at ${width}`,
      );
    }
    await page.evaluate((values) => {
      for (const [k, v] of Object.entries(values))
        document.documentElement.style.setProperty('--vscode-' + k, v);
    }, themes.dark);
    await settle();
    await page.screenshot({ path: path.join(evidenceOut, 'agent-setup-dark.png') });
    assert.deepEqual((await scan()).violations, [], 'setup accessibility');
    await page.keyboard.press('Escape');
    assert(!(await page.locator('#setup-dialog').isVisible()));
    await page.waitForFunction(() => document.activeElement.id === 'setup-open');

    // One agent left to set up: the warning offers “I don’t use …”, and never returns once handled.
    const onlyCursor = {
      ...data,
      connections: { codex: true, claude: true, cursor: true },
      connectionDetails: {
        codex: { configured: true },
        claude: { configured: true },
        cursor: { configured: true },
      },
      ignoredAgents: [],
    };
    await send(onlyCursor);
    assert.equal(await page.locator('#setup-warning-title').innerText(), 'Cursor needs setup');
    assert.equal(await page.locator('#setup-ignore').innerText(), 'I don’t use Cursor');
    await page.locator('#setup-ignore').click();
    assert.deepEqual(await last(), { action: 'ignore-agent', agent: 'cursor', ignored: true });
    assert(await page.locator('#setup-warning').isHidden());
    await send({ ...onlyCursor, ignoredAgents: ['cursor'] });
    assert(await page.locator('#setup-warning').isHidden(), 'ignored agents never warn');
    await send({ ...pending, ignoredAgents: ['codex', 'claude', 'cursor'] });
    assert(
      await page.locator('#setup-warning').isHidden(),
      'no warning once everything is handled',
    );
    await send({
      ...data,
      ignoredAgents: [],
      connectionDetails: {
        codex: { configured: true },
        claude: { configured: true },
        cursor: { configured: false },
      },
    });
    assert(!(await page.locator('#setup-warning').isVisible()));
    assert.equal(await page.locator('[aria-label="Agent Monitor settings"] svg').count(), 1);
    await page.locator('#help-toggle').click();
    assert(await page.locator('#help-panel').isVisible());
    await page.locator('#help-toggle').click();
    // Motion: on by default, one-shot, and fully off through the setting.
    assert.equal(await page.evaluate(() => document.body.dataset.motion), 'on');
    await selectTab('Focus');
    const indicator = () =>
      page.evaluate(
        () => getComputedStyle(document.querySelector('nav'), '::after').transitionDuration,
      );
    assert.equal(await indicator(), '0.18s');
    const live = () => ({ ...a, status: 'active', updated: Date.now() / 1000 });
    await send({ sessions: [{ ...a, status: 'waiting' }, b] });
    await send({ sessions: [live(), b] });
    assert(await page.locator('.presence.ping').count(), 'a chat that becomes active pings once');
    await send({ sessions: [live(), b] });
    assert.equal(await page.locator('.presence.ping').count(), 0, 'and never again while active');
    await selectChat('demo-two');
    assert(await page.locator('.meter.grow').count(), 'meters fill in for a chosen chat');
    await send({ notice: '' });
    assert.equal(await page.locator('.meter.grow').count(), 0, 'refreshes leave meters still');
    await selectChat('demo-one');
    await send({ motion: false });
    assert.equal(await page.evaluate(() => document.body.dataset.motion), 'off');
    assert.equal(await indicator(), '0s');
    assert.equal(
      await page
        .locator('.focus-card')
        .first()
        .evaluate((e) => getComputedStyle(e).transitionDuration),
      '0s',
    );
    await selectChat('demo-two');
    assert.equal(await page.locator('.meter.grow').count(), 0, 'no motion when it is off');
    await selectChat('demo-one');
    await send({ motion: true });
    assert.deepEqual(await page.evaluate(() => window.violations), [], 'no CSP violations');
    fs.writeFileSync(path.join(evidenceOut, 'accessibility.json'), JSON.stringify(a11y, null, 2));

    // The editor-area copy hides Main Window and widens the area grid.
    await page.goto('http://monitor.test/editor');
    await send(data);
    await page.setViewportSize({ width: 1100, height: 900 });
    assert.equal(
      await page.locator('#open-editor').evaluate((e) => getComputedStyle(e).visibility),
      'hidden',
    );
    assert(
      (await page
        .locator('#groups .tile-grid')
        .evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length)) > 2,
    );
    await page.locator('[data-point=security]').click();
    assert.equal(
      await page.evaluate(
        () => document.getElementById('detail').previousElementSibling?.dataset.area !== undefined,
      ),
      true,
      'evidence follows the row in a wide grid',
    );
    assert.deepEqual(await page.evaluate(() => window.violations), []);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: two-view sidebar and editor journeys, chat strips (no All chats in Focus), follow-latest browsing, separate image selection, unseen-image count and highlight, image arrows, request states, focus preservation, image history/recovery/ages, all 12 chats, stable selections, “I don’t use” setup, theme/accessibility scans, 280–960px and 200% reflow, forced colours, keyboard, CSP and empty/error states.',
    );
  } finally {
    if (browser) await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
