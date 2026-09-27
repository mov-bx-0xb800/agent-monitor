'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createController, supportsSecondary, belongs } = require('../src/extension');
const signal = () => {
  const listeners = new Set();
  return {
    on: (fn) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    fire: (value) => {
      for (const fn of [...listeners]) fn(value);
    },
  };
};
test('startup opens once, same native sidebar as chat, stops watcher hidden and never opens editors', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-host-')),
    original = fs.watch;
  let watchers = 0,
    callback;
  const commands = [],
    registered = new Map(),
    messages = [];
  fs.watch = (_r, fn) => {
    watchers++;
    callback = fn;
    let closed = false;
    return {
      on() {},
      close() {
        if (!closed) {
          watchers--;
          closed = true;
        }
      },
    };
  };
  t.after(() => {
    fs.watch = original;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const disposable = () => ({ dispose() {} }),
    vs = {
      version: '1.96.0',
      env: { appName: 'Cursor' },
      Uri: { file: (p) => p },
      workspace: {
        workspaceFolders: [],
        isTrusted: true,
        getConfiguration: () => ({ get: (_k, f) => f }),
        onDidChangeWorkspaceFolders: disposable,
      },
      window: {
        registerWebviewViewProvider: (id, p, options) => {
          registered.set(id, p);
          assert.equal(options.webviewOptions.retainContextWhenHidden, false);
          return disposable();
        },
        createWebviewPanel() {
          throw Error('No editor panels');
        },
      },
      commands: {
        executeCommand: async (...args) => commands.push(args),
        registerCommand: disposable,
      },
    };
  const ctx = { subscriptions: [], workspaceState: { get: (_k, f) => f, update: async () => {} } };
  const controller = await createController(vs, ctx, {
    cache: root,
    codex: path.join(root, 'codex'),
    claude: path.join(root, 'claude'),
  });
  t.after(() => controller.dispose());
  assert.equal(commands.filter((c) => c[0] === 'agentMonitor.secondary.focus').length, 1);
  assert.equal(commands[1][1].preserveFocus, true);
  assert.equal(watchers, 0);
  const visibility = signal(),
    dispose = signal(),
    message = signal(),
    view = {
      visible: true,
      show() {},
      onDidDispose: dispose.on,
      onDidChangeVisibility: visibility.on,
      webview: {
        cspSource: 'http://test.invalid',
        onDidReceiveMessage: message.on,
        postMessage: (m) => messages.push(m),
        asWebviewUri: (p) => p,
      },
    };
  controller.provider.resolveWebviewView(view);
  message.fire({ action: 'ready' });
  assert.equal(watchers, 1);
  assert(messages.some((m) => m.type === 'data'));
  visibility.fire();
  assert.equal(watchers, 1);
  callback('change', 'state.json');
  view.visible = false;
  visibility.fire();
  assert.equal(watchers, 0);
  const count = messages.length;
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(messages.length, count);
  view.visible = true;
  visibility.fire();
  assert.equal(watchers, 1);
  dispose.fire();
  assert.equal(watchers, 0);
  assert.equal(commands.filter((c) => c[0] === 'agentMonitor.secondary.focus').length, 1);
});
test('startup opt-out and older VS Code fallback', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-no-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commands = [],
    d = () => ({ dispose() {} }),
    vs = {
      version: '1.95.0',
      env: { appName: 'Visual Studio Code' },
      Uri: { file: (p) => p },
      commands: { executeCommand: async (...args) => commands.push(args), registerCommand: d },
      window: { registerWebviewViewProvider: d },
      workspace: { getConfiguration: () => ({ get: () => false }), onDidChangeWorkspaceFolders: d },
    };
  const c = await createController(vs, { subscriptions: [] }, { cache: root });
  c.dispose();
  assert.equal(commands.length, 1);
  assert.equal(commands[0][2], false);
  assert(supportsSecondary({ version: '1.106.0', env: { appName: 'Visual Studio Code' } }));
  assert(!supportsSecondary(vs));
});
test('workspace isolation uses path boundaries', () => {
  const folders = [{ uri: { fsPath: path.resolve('/work/app') } }];
  assert(belongs(path.resolve('/work/app/src'), folders));
  assert(!belongs(path.resolve('/work/app-other'), folders));
  assert(!belongs('/work/app', []));
});
test('Focus here selects one exact workspace thread and never broadcasts', async (t) => {
  const { record } = require('../src/collector'),
    { sessionKey } = require('../src/classify'),
    steering = require('../src/steering'),
    { event } = require('./fixtures');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-routing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = { ...event(), cwd: root, session_id: 'a' },
    b = { ...a, session_id: 'b' },
    outside = { ...a, cwd: path.dirname(root), session_id: 'outside' };
  for (const e of [a, b, outside]) record(e, 'codex', root);
  const aid = sessionKey('codex', a),
    bid = sessionKey('codex', b);
  let receive,
    picks = 0;
  const d = () => ({ dispose() {} }),
    vs = {
      version: '1.106.0',
      env: { appName: 'Code' },
      Uri: { file: (p) => p },
      commands: { executeCommand: async () => {}, registerCommand: d },
      workspace: {
        isTrusted: true,
        workspaceFolders: [{ uri: { fsPath: root } }],
        getConfiguration: () => ({ get: (_k, f) => f }),
        onDidChangeWorkspaceFolders: d,
      },
      window: {
        registerWebviewViewProvider: d,
        showQuickPick: async (choices) => {
          picks++;
          assert.equal(choices.length, 2);
          return choices.find((c) => c.sid === bid);
        },
      },
    };
  const c = await createController(
    vs,
    { subscriptions: [] },
    { cache: root, codex: path.join(root, 'none'), claude: path.join(root, 'none') },
  );
  t.after(() => c.dispose());
  c.provider.resolveWebviewView({
    visible: true,
    onDidDispose: d,
    onDidChangeVisibility: d,
    webview: {
      cspSource: 'http://test',
      asWebviewUri: (p) => p,
      onDidReceiveMessage: (fn) => {
        receive = fn;
        return d();
      },
      postMessage: async () => {},
    },
  });
  await receive({ action: 'focus', area: 'performance', sid: 'all' });
  assert.equal(picks, 1);
  assert.equal(steering.read(root).length, 1);
  assert.equal(steering.read(root)[0].sid, bid);
  await receive({ action: 'focus', area: 'security', sid: aid });
  assert.equal(picks, 1);
  assert.equal(steering.read(root).length, 2);
  await receive({ action: 'focus', area: 'data', sid: sessionKey('codex', outside) });
  assert.equal(steering.read(root).length, 2);
  vs.workspace.isTrusted = false;
  await receive({ action: 'focus', area: 'data', sid: aid });
  assert.equal(steering.read(root).length, 2);
});
test('Choose areas persists only the chosen thread, prunes stale selections and sends no steering', async (t) => {
  const { record } = require('../src/collector'),
    { sessionKey } = require('../src/classify'),
    steering = require('../src/steering'),
    { event } = require('./fixtures');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-areas-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = { ...event(), cwd: root, session_id: 'a' },
    b = { ...a, session_id: 'b' };
  record(a, 'codex', root);
  record(b, 'codex', root);
  const aid = sessionKey('codex', a),
    bid = sessionKey('codex', b);
  let receive,
    stored = { stale: ['data'], [bid]: ['ux'] },
    cancel = false;
  const messages = [],
    d = () => ({ dispose() {} }),
    vs = {
      version: '1.106.0',
      env: { appName: 'Code' },
      Uri: { file: (p) => p },
      commands: { executeCommand: async () => {}, registerCommand: d },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: root } }],
        getConfiguration: () => ({ get: (_k, f) => f }),
        onDidChangeWorkspaceFolders: d,
      },
      window: {
        registerWebviewViewProvider: d,
        showQuickPick: async (choices) =>
          cancel
            ? undefined
            : choices.filter((c) => ['security', 'performance', 'reliability'].includes(c.id)),
      },
    };
  const ctx = {
    subscriptions: [],
    workspaceState: {
      get: (key, fallback) => (key === 'focusSelections' ? stored : fallback),
      update: async (_key, value) => {
        if (_key === 'focusSelections') stored = value;
      },
    },
  };
  const c = await createController(vs, ctx, {
    cache: root,
    codex: path.join(root, 'none'),
    claude: path.join(root, 'none'),
  });
  t.after(() => c.dispose());
  c.provider.resolveWebviewView({
    visible: true,
    onDidDispose: d,
    onDidChangeVisibility: d,
    webview: {
      cspSource: 'http://test',
      asWebviewUri: (p) => p,
      onDidReceiveMessage: (fn) => {
        receive = fn;
        return d();
      },
      postMessage: async (m) => messages.push(m),
    },
  });
  await receive({ action: 'ready' });
  await receive({ action: 'choose-areas', sid: aid });
  assert.deepEqual(stored[aid], ['security', 'performance', 'reliability']);
  assert.deepEqual(stored[bid], ['ux']);
  assert(!stored.stale);
  assert.deepEqual(steering.read(root), []);
  assert(messages.some((m) => m.type === 'scope' && m.sid === aid));
  assert.deepEqual(
    messages.filter((m) => m.type === 'data').at(-1).data.focusSelections[aid],
    stored[aid],
  );
  cancel = true;
  await receive({ action: 'choose-areas', sid: bid });
  assert.deepEqual(stored[bid], ['ux']);
  c.send();
  assert.deepEqual(messages.filter((m) => m.type === 'data').at(-1).data.focusSelections[aid], [
    'security',
    'performance',
    'reliability',
  ]);
});
test('setup actions target the chosen agent, reuse terminals and respect workspace trust', async (t) => {
  const setup = require('../src/setup'),
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-setup-host-'));
  const originalInstall = setup.install,
    originalFindNode = setup.findNode;
  t.after(() => {
    setup.install = originalInstall;
    setup.findNode = originalFindNode;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const loc = {
    cache: root,
    codex: path.join(root, 'codex.json'),
    claude: path.join(root, 'claude.json'),
    cursor: path.join(root, 'cursor.json'),
  };
  fs.writeFileSync(loc.claude, '{}');
  const installs = [],
    terminals = [],
    shown = [],
    clipboard = [],
    messages = [],
    commands = [];
  setup.findNode = async () => process.execPath;
  setup.install = (agents, node, locations) => {
    installs.push({ agents, node, locations });
    return agents.map((agent) => ({ agent, ok: true }));
  };
  let receive;
  const d = () => ({ dispose() {} }),
    vs = {
      version: '1.106.0',
      env: { appName: 'Code', clipboard: { writeText: async (text) => clipboard.push(text) } },
      Uri: { file: (p) => p },
      commands: { executeCommand: async (...args) => commands.push(args), registerCommand: d },
      workspace: {
        isTrusted: true,
        workspaceFolders: [{ uri: { fsPath: root } }],
        getConfiguration: () => ({ get: (_k, f) => f }),
        onDidChangeWorkspaceFolders: d,
        openTextDocument: async (file) => file,
      },
      window: {
        terminals,
        registerWebviewViewProvider: d,
        showQuickPick: async () => {
          throw Error('Per-agent setup must not ask for the agent again');
        },
        showTextDocument: async (file) => shown.push(file),
        createTerminal: (options) => {
          const terminal = {
            ...options,
            sent: [],
            shows: 0,
            sendText(text) {
              this.sent.push(text);
            },
            show() {
              this.shows++;
            },
          };
          terminals.push(terminal);
          return terminal;
        },
      },
    };
  const c = await createController(vs, { subscriptions: [] }, loc);
  t.after(() => c.dispose());
  c.provider.resolveWebviewView({
    visible: true,
    onDidDispose: d,
    onDidChangeVisibility: d,
    webview: {
      cspSource: 'http://test',
      asWebviewUri: (p) => p,
      onDidReceiveMessage: (fn) => {
        receive = fn;
        return d();
      },
      postMessage: async (m) => messages.push(m),
    },
  });
  await receive({ action: 'ready' });
  await receive({ action: 'connect-agent', agent: 'claude' });
  assert.deepEqual(
    installs.map((i) => i.agents),
    [['claude']],
  );
  assert.equal(installs[0].locations, loc);
  await receive({ action: 'review-hooks', agent: 'codex' });
  await receive({ action: 'review-hooks', agent: 'codex' });
  assert.equal(terminals.length, 1);
  assert.deepEqual(terminals[0].sent, ['codex']);
  assert.equal(terminals[0].shows, 2);
  assert.equal(terminals[0].cwd, root);
  await receive({ action: 'review-hooks', agent: 'claude' });
  assert.deepEqual(terminals[1].sent, ['claude']);
  terminals[0].exitStatus = { code: 0 };
  await receive({ action: 'review-hooks', agent: 'codex' });
  assert.equal(terminals.length, 3);
  await receive({ action: 'copy-hooks' });
  assert.deepEqual(clipboard, ['/hooks']);
  await receive({ action: 'agent-settings', agent: 'claude' });
  assert.deepEqual(shown, [loc.claude]);
  assert.equal(fs.readFileSync(loc.claude, 'utf8'), '{}');
  await receive({ action: 'settings' });
  assert(
    commands.some(
      (c) => c[0] === 'workbench.action.openSettings' && c[1] === '@ext:wojake.agent-monitor',
    ),
  );
  await receive({ action: 'review-hooks', agent: 'codex; arbitrary' });
  await receive({ action: 'connect-agent', agent: 'other' });
  assert.equal(terminals.length, 3);
  assert.equal(installs.length, 1);
  vs.workspace.isTrusted = false;
  await receive({ action: 'connect-agent', agent: 'cursor' });
  await receive({ action: 'review-hooks', agent: 'claude' });
  assert.equal(installs.length, 1);
  assert.equal(terminals[1].shows, 1);
  assert(
    messages
      .filter((m) => m.type === 'data')
      .at(-1)
      .data.notice.includes('trusted workspace'),
  );
  vs.workspace.isTrusted = true;
  vs.env.remoteName = 'ssh-remote';
  await receive({ action: 'review-hooks', agent: 'claude' });
  assert.equal(terminals[1].shows, 1);
  assert(
    messages.some(
      (m) => m.type === 'action-result' && m.action === 'review-hooks' && m.agent === 'claude',
    ),
  );
});

test('chat names and area layouts persist per chat and all-chat view without sending steering', async (t) => {
  const { record } = require('../src/collector'),
    { sessionKey } = require('../src/classify'),
    { event } = require('./fixtures'),
    steering = require('../src/steering');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-chat-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = { ...event(), cwd: root, session_id: 'chat-a' },
    b = { ...a, session_id: 'chat-b' };
  record(a, 'codex', root);
  record(b, 'codex', root);
  const aid = sessionKey('codex', a),
    bid = sessionKey('codex', b),
    state = {},
    messages = [];
  let receive,
    input = 'Design review';
  const d = () => ({ dispose() {} }),
    vs = {
      version: '1.106.0',
      env: { appName: 'Code' },
      Uri: { file: (p) => p },
      commands: { executeCommand: async () => {}, registerCommand: d },
      workspace: {
        isTrusted: true,
        workspaceFolders: [{ uri: { fsPath: root } }],
        getConfiguration: () => ({ get: (_k, f) => f }),
        onDidChangeWorkspaceFolders: d,
      },
      window: {
        registerWebviewViewProvider: d,
        showQuickPick: async (choices) => choices[0],
        showInputBox: async () => input,
      },
    };
  const c = await createController(
    vs,
    {
      subscriptions: [],
      workspaceState: {
        get: (key, f) => state[key] || f,
        update: async (key, value) => {
          state[key] = value;
        },
      },
    },
    { cache: root },
  );
  t.after(() => c.dispose());
  c.provider.resolveWebviewView({
    visible: true,
    onDidDispose: d,
    onDidChangeVisibility: d,
    webview: {
      cspSource: 'http://test',
      asWebviewUri: (p) => p,
      onDidReceiveMessage: (fn) => {
        receive = fn;
        return d();
      },
      postMessage: async (m) => messages.push(m),
    },
  });
  await receive({ action: 'ready' });
  await receive({
    action: 'move-area',
    sid: aid,
    area: 'performance',
    zone: 'primary',
    before: 'security',
  });
  assert.equal(state.focusLayouts[aid].primary[0], 'performance');
  assert(!state.focusLayouts[bid]);
  await receive({ action: 'arrange-area', sid: 'all', area: 'testing' });
  assert(state.focusLayouts.all.extra.includes('testing'));
  assert(state.focusLayouts[aid].primary.includes('testing'));
  await receive({ action: 'rename-chat', sid: aid });
  assert.equal(state.chatNames[aid], 'Design review');
  assert(!state.chatNames[bid]);
  const data = messages.filter((m) => m.type === 'data').at(-1).data;
  assert.equal(data.sessions.find((s) => s.id === aid).titleSource, 'custom');
  assert.equal(data.sessions.find((s) => s.id === bid).title, 'Untitled chat');
  assert.equal(
    Object.values(JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).sessions)[0].title,
    'Untitled chat',
  );
  const before = JSON.stringify(state);
  await receive({ action: 'move-area', sid: 'outside', area: 'security', zone: 'extra' });
  assert.equal(JSON.stringify(state), before);
  input = '';
  await receive({ action: 'rename-chat', sid: aid });
  assert(!state.chatNames[aid]);
  assert.deepEqual(steering.read(root), []);
});
test('Main Window opens one editor copy on request; both copies share one watcher', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-editor-')),
    original = fs.watch;
  let watchers = 0;
  fs.watch = () => {
    watchers++;
    let closed = false;
    return {
      on() {},
      close() {
        if (!closed) watchers--;
        closed = true;
      },
    };
  };
  t.after(() => {
    fs.watch = original;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const surface = (extra = {}) => {
    const visibility = signal(),
      disposal = signal(),
      message = signal(),
      host = {
        visible: true,
        messages: [],
        reveals: 0,
        reveal() {
          host.reveals++;
        },
        onDidDispose: disposal.on,
        onDidChangeVisibility: visibility.on,
        onDidChangeViewState: visibility.on,
        dispose: () => disposal.fire(),
        setVisible(value) {
          host.visible = value;
          visibility.fire();
        },
        send: (m) => message.fire(m),
        webview: {
          cspSource: 'http://test.invalid',
          onDidReceiveMessage: message.on,
          postMessage: async (m) => host.messages.push(m),
          asWebviewUri: (p) => 'webview:' + p,
        },
        ...extra,
      };
    return host;
  };
  const panels = [],
    d = () => ({ dispose() {} }),
    vs = {
      version: '1.106.0',
      env: { appName: 'Code' },
      Uri: { file: (p) => p, joinPath: (...parts) => parts.join('/') },
      ViewColumn: { Active: -1, Beside: -2 },
      commands: { executeCommand: async () => {}, registerCommand: d },
      workspace: {
        isTrusted: true,
        workspaceFolders: [{ uri: { fsPath: root } }],
        getConfiguration: () => ({ get: (_k, f) => (_k === 'openOnStartup' ? false : f) }),
        onDidChangeWorkspaceFolders: d,
      },
      window: {
        registerWebviewViewProvider: d,
        createWebviewPanel(type, title, column, options) {
          assert.equal(type, 'agentMonitor.editor');
          assert.equal(options.retainContextWhenHidden, false);
          const panel = surface();
          panels.push(panel);
          return panel;
        },
      },
    };
  const c = await createController(
    vs,
    { subscriptions: [], extensionUri: '/extension' },
    { cache: root, codex: path.join(root, 'none'), claude: path.join(root, 'none') },
  );
  t.after(() => c.dispose());
  assert.equal(panels.length, 0, 'no editor copy opens by itself');
  const view = surface();
  c.provider.resolveWebviewView(view);
  assert.doesNotMatch(view.webview.html, /data-surface="editor"/);
  view.send({ action: 'ready' });
  view.send({ action: 'open-editor' });
  view.send({ action: 'open-editor' });
  assert.equal(panels.length, 1, 'Main Window reveals the existing copy');
  const panel = panels[0];
  assert.equal(panel.reveals, 1);
  assert.equal(panel.iconPath, '/extension/media/monitor.svg');
  assert.match(panel.webview.html, /data-surface="editor"/);
  panel.send({ action: 'ready' });
  assert(panel.messages.some((m) => m.type === 'data'));
  assert.equal(watchers, 1);
  view.setVisible(false);
  assert.equal(watchers, 1, 'a visible editor copy keeps updates flowing');
  panel.setVisible(false);
  assert.equal(watchers, 0, 'hidden copies keep no watcher');
  panel.setVisible(true);
  assert.equal(watchers, 1);
  panel.dispose();
  assert.equal(watchers, 0);
  view.send({ action: 'open-editor' });
  assert.equal(panels.length, 2, 'a closed editor copy can be reopened');
});
test('“I don’t use” choices persist per user and image opening stays inside the workspace', async (t) => {
  const store = require('../src/store');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-ignore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.ensure(root);
  const file = 'a'.repeat(24) + '.png',
    elsewhere = 'b'.repeat(24) + '.png';
  store.save(root, {
    version: 1,
    sessions: {},
    images: [
      {
        id: 'inside',
        source: 'tool-output',
        file,
        cwd: root,
        label: 'inside.png',
        created: 1,
        viewers: [],
      },
      { id: 'legacy', file: 'c'.repeat(24) + '.png', cwd: root, viewers: [] },
      {
        id: 'outside',
        source: 'tool-output',
        file: elsewhere,
        cwd: path.dirname(root),
        label: 'outside.png',
        created: 1,
        viewers: [],
      },
    ],
  });
  fs.writeFileSync(
    path.join(root, 'health-codex.json'),
    JSON.stringify({
      cwd: root,
      at: 100,
      status: 'received',
      lastFailure: { at: 99, status: 'collector-error' },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'health-claude.json'),
    JSON.stringify({ cwd: path.dirname(root), at: 200, status: 'received' }),
  );
  fs.writeFileSync(path.join(root, 'health-cursor.json'), 'null');
  const stored = {},
    commands = [],
    messages = [];
  let receive;
  const d = () => ({ dispose() {} }),
    vs = {
      version: '1.106.0',
      env: { appName: 'Code' },
      Uri: { file: (p) => p },
      commands: { executeCommand: async (...args) => commands.push(args), registerCommand: d },
      workspace: {
        isTrusted: true,
        workspaceFolders: [{ uri: { fsPath: root } }],
        getConfiguration: () => ({ get: (_k, f) => f }),
        onDidChangeWorkspaceFolders: d,
      },
      window: { registerWebviewViewProvider: d },
    };
  const c = await createController(
    vs,
    {
      subscriptions: [],
      globalState: {
        get: (k, f) => (k in stored ? stored[k] : f),
        update: async (k, v) => {
          stored[k] = v;
        },
      },
    },
    { cache: root, codex: path.join(root, 'none'), claude: path.join(root, 'none') },
  );
  t.after(() => c.dispose());
  c.provider.resolveWebviewView({
    visible: true,
    onDidDispose: d,
    onDidChangeVisibility: d,
    webview: {
      cspSource: 'http://test',
      asWebviewUri: (p) => p,
      onDidReceiveMessage: (fn) => {
        receive = fn;
        return d();
      },
      postMessage: async (m) => messages.push(m),
    },
  });
  await receive({ action: 'ready' });
  const latest = () => messages.filter((m) => m.type === 'data').at(-1).data;
  assert.deepEqual(
    latest().images.map((i) => i.id),
    ['inside'],
  );
  assert.deepEqual(latest().health.codex, { at: 100, status: 'received', lastFailure: undefined });
  assert.deepEqual(latest().health.claude, {});
  assert.deepEqual(latest().health.cursor, {});
  fs.writeFileSync(
    path.join(root, 'health-codex.json'),
    JSON.stringify({
      version: 1,
      cwd: root,
      at: 101,
      status: 'received',
      lastFailure: { at: 100, status: 'collector-error' },
    }),
  );
  await receive({ action: 'refresh' });
  assert.deepEqual(latest().health.codex.lastFailure, { at: 100, status: 'collector-error' });
  assert.deepEqual(latest().ignoredAgents, []);
  await receive({ action: 'ignore-agent', agent: 'cursor' });
  await receive({ action: 'ignore-agent', agent: 'cursor' });
  assert.deepEqual(stored.ignoredAgents, ['cursor']);
  assert.deepEqual(latest().ignoredAgents, ['cursor']);
  await receive({ action: 'ignore-agent', agent: 'other' });
  await receive({ action: 'ignore-agent', agent: 'codex', ignored: true });
  assert.deepEqual(latest().ignoredAgents, ['codex', 'cursor']);
  await receive({ action: 'ignore-agent', agent: 'cursor', ignored: false });
  assert.deepEqual(stored.ignoredAgents, ['codex']);
  stored.ignoredAgents = ['codex', 'unknown'];
  await receive({ action: 'refresh' });
  assert.deepEqual(latest().ignoredAgents, ['codex'], 'unknown stored values are dropped');

  await receive({ action: 'open-image', id: 'inside' });
  assert.deepEqual(commands.at(-1).slice(0, 2), ['vscode.open', path.join(root, file)]);
  const opened = commands.length;
  await receive({ action: 'open-image', id: 'outside' });
  await receive({ action: 'open-image', id: 'legacy' });
  await receive({ action: 'open-image', id: '../../etc/passwd' });
  assert.equal(commands.length, opened, 'only a cached image from this workspace opens');
  assert.equal(latest().notice, 'This image is no longer cached.');
});
test('motion follows its setting and the editor’s Reduce Motion, and updates on change', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-motion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = { 'agentMonitor.motion': true, 'workbench.reduceMotion': 'auto' },
    changes = signal(),
    messages = [];
  let receive;
  const d = () => ({ dispose() {} }),
    vs = {
      version: '1.106.0',
      env: { appName: 'Code' },
      Uri: { file: (p) => p },
      commands: { executeCommand: async () => {}, registerCommand: d },
      workspace: {
        isTrusted: true,
        workspaceFolders: [{ uri: { fsPath: root } }],
        getConfiguration: (section) => ({
          get: (key, fallback) => settings[section + '.' + key] ?? fallback,
        }),
        onDidChangeWorkspaceFolders: d,
        onDidChangeConfiguration: changes.on,
      },
      window: { registerWebviewViewProvider: d },
    };
  const c = await createController(
    vs,
    { subscriptions: [] },
    { cache: root, codex: path.join(root, 'none'), claude: path.join(root, 'none') },
  );
  t.after(() => c.dispose());
  c.provider.resolveWebviewView({
    visible: true,
    onDidDispose: d,
    onDidChangeVisibility: d,
    webview: {
      cspSource: 'http://test',
      asWebviewUri: (p) => p,
      onDidReceiveMessage: (fn) => {
        receive = fn;
        return d();
      },
      postMessage: async (m) => messages.push(m),
    },
  });
  await receive({ action: 'ready' });
  const motion = () => messages.filter((m) => m.type === 'data').at(-1).data.motion;
  assert.equal(motion(), true);
  const change = (key) => changes.fire({ affectsConfiguration: (k) => k === key });
  settings['agentMonitor.motion'] = false;
  change('agentMonitor.motion');
  assert.equal(motion(), false, 'the setting turns motion off');
  settings['agentMonitor.motion'] = true;
  settings['workbench.reduceMotion'] = 'on';
  change('workbench.reduceMotion');
  assert.equal(motion(), false, 'the editor’s Reduce Motion turns it off');
  settings['workbench.reduceMotion'] = 'auto';
  const count = messages.length;
  change('editor.fontSize');
  assert.equal(messages.length, count, 'unrelated settings send nothing');
  change('workbench.reduceMotion');
  assert.equal(motion(), true);
});

test('custom areas and stakes: review, enable, change, start and focus, within workspace trust', async (t) => {
  const setup = require('../src/setup'),
    profile = require('../src/profile'),
    steering = require('../src/steering'),
    { record } = require('../src/collector');
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-areas-cache-')),
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-areas-ws-'));
  const originalFindNode = setup.findNode;
  setup.findNode = async () => process.execPath;
  t.after(() => {
    setup.findNode = originalFindNode;
    for (const dir of [cache, ws]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const ledger = {
    id: 'ledger-integrity',
    label: 'Ledger integrity',
    description: 'Double-entry balances, reconciliation and settlement stay correct.',
    signals: { paths: ['src/ledger/**'], terms: ['ledger:0.9', 'reconciliation'] },
    examples: {
      match: ['src/ledger/a.ts', 'src/ledger/b.ts', 'jobs/reconciliation/c.ts'],
      ignore: ['src/ui/Button.tsx', 'docs/README.md', 'src/journal/log.ts'],
    },
  };
  const weak = { ...ledger, id: 'weak-area', label: 'Weak area', signals: { terms: ['service'] } };
  const writeDef = (areas) => {
    fs.mkdirSync(path.join(ws, '.agent-monitor'), { recursive: true });
    fs.writeFileSync(path.join(ws, profile.FILE), JSON.stringify({ version: 1, areas }));
  };
  writeDef([ledger, weak]);
  const store = new Map([['focusLayouts', { all: { primary: ['security'], extra: [] } }]]);
  const messages = [],
    terminals = [],
    shown = [],
    clipboard = [],
    inputs = [],
    picks = [];
  let receive;
  const d = () => ({ dispose() {} }),
    vs = {
      version: '1.106.0',
      env: { appName: 'Code', clipboard: { writeText: async (text) => clipboard.push(text) } },
      Uri: { file: (p) => p },
      commands: { executeCommand: async () => {}, registerCommand: d },
      workspace: {
        isTrusted: true,
        workspaceFolders: [{ uri: { fsPath: ws }, name: 'ws' }],
        getConfiguration: () => ({ get: (_k, f) => f }),
        onDidChangeWorkspaceFolders: d,
        openTextDocument: async (doc) => doc,
      },
      window: {
        terminals,
        registerWebviewViewProvider: d,
        showInputBox: async () => inputs.shift(),
        showQuickPick: async (items) => {
          const want = picks.shift();
          return (await items).find((i) => i.label === want);
        },
        showInformationMessage: async () => 'Queue for next turn',
        showTextDocument: async (doc) => shown.push(doc),
        createTerminal: (options) => {
          const terminal = {
            ...options,
            sent: [],
            sendText(x) {
              this.sent.push(x);
            },
            show() {},
          };
          terminals.push(terminal);
          return terminal;
        },
      },
    };
  const ctx = {
    subscriptions: [],
    workspaceState: {
      get: (k, f) => (store.has(k) ? store.get(k) : f),
      update: async (k, v) => store.set(k, v),
    },
  };
  const c = await createController(vs, ctx, { cache });
  t.after(() => c.dispose());
  c.provider.resolveWebviewView({
    visible: true,
    onDidDispose: d,
    onDidChangeVisibility: d,
    webview: {
      cspSource: 'http://test',
      asWebviewUri: (p) => p,
      onDidReceiveMessage: (fn) => {
        receive = fn;
        return d();
      },
      postMessage: async (m) => messages.push(m),
    },
  });
  const latest = () => messages.filter((m) => m.type === 'data').at(-1).data;
  const cached = () => profile.readProfiles(cache);
  await receive({ action: 'ready' });
  let p = latest().focusProfiles[0];
  assert.equal(p.definition.pending, true);
  assert.equal(p.definition.status, 'needs work');
  assert.deepEqual(p.areas, [], 'nothing counts before it is enabled');
  assert.deepEqual(cached(), [], 'standard stakes and no areas need no cache entry');

  await receive({ action: 'set-stakes', stakes: 'extreme' });
  assert.equal(store.get('focusStakes'), undefined, 'unknown stakes are ignored');
  await receive({ action: 'set-stakes', stakes: 'critical' });
  assert.equal(latest().stakes, 'critical');
  assert.deepEqual(
    cached().map((x) => [x.root, x.stakes, x.areas.length]),
    [[ws, 'critical', 0]],
  );

  await receive({ action: 'area-enable', root: ws, hash: 'stale' });
  assert.match(latest().notice, /file changed after you opened it/);
  await receive({ action: 'area-enable', root: '/somewhere/else', hash: p.definition.hash });
  assert.match(latest().notice, /no longer open/);
  // The problems go back to the agent as a ready-to-paste request with the check command.
  await receive({ action: 'area-fix', root: ws });
  assert.match(clipboard.at(-1), /needs a fix/);
  assert.match(clipboard.at(-1), /profile\.js" check \.agent-monitor\/focus\.json/);
  assert.match(clipboard.at(-1), /✗ /);
  assert.match(latest().notice, /Fix request copied/);
  await receive({ action: 'area-enable', root: ws, hash: p.definition.hash });
  assert.match(latest().notice, /Now tracking “Ledger integrity”/);
  p = latest().focusProfiles[0];
  assert.deepEqual(
    p.areas.map((a) => a.id),
    ['x:ledger-integrity'],
    'only ready areas are enabled',
  );
  assert.equal(cached()[0].areas[0].id, 'ledger-integrity');
  assert(
    store.get('focusLayouts').all.primary.includes('x:ledger-integrity'),
    'joins the main grid',
  );

  // Any edit needs review again; the previous approval stops applying at once.
  writeDef([ledger]);
  fs.utimesSync(path.join(ws, profile.FILE), new Date(), new Date(Date.now() + 5000));
  await receive({ action: 'refresh' });
  p = latest().focusProfiles[0];
  assert.equal(p.definition.pending, true);
  assert.equal(p.definition.changed, true);
  assert.deepEqual(p.areas, []);
  assert.equal(cached()[0].areas.length, 0);
  await receive({ action: 'area-report', root: ws });
  assert.match(shown.at(-1).content, /Ledger integrity \(ledger-integrity\): ready/);
  await receive({ action: 'area-dismiss', root: ws });
  assert.equal(latest().focusProfiles[0].definition.pending, false);
  await receive({
    action: 'area-enable',
    root: ws,
    hash: latest().focusProfiles[0].definition.hash,
  });
  assert.equal(latest().focusProfiles[0].areas.length, 1);

  // Focus here on a custom area carries its snapshot and the project's stakes.
  const e = {
    session_id: 'custom-chat',
    cwd: ws,
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(ws, 'src/ledger/post.ts') },
  };
  assert(record(e, 'codex', cache));
  await receive({ action: 'refresh' });
  const session = latest().sessions[0];
  assert(
    session.points[0].areas.some(([id]) => id === 'x:ledger-integrity'),
    'hooks use the enabled area',
  );
  await receive({ action: 'focus', area: 'x:unknown', sid: session.id });
  assert.equal(steering.read(cache).length, 0);
  await receive({
    action: 'focus',
    area: 'x:ledger-integrity',
    sid: session.id,
    delivery: 'queue',
  });
  const request = steering.read(cache)[0];
  assert.equal(request.area, 'x:ledger-integrity');
  assert.equal(request.custom.label, 'Ledger integrity');
  assert.equal(request.stakes, 'critical');

  // The card's form: the developer's own agent drafts a definition from the shipped guide.
  const form = (fields) => ({
    action: 'area-start',
    root: ws,
    name: 'Refund safety',
    about: 'Refunds, chargebacks and payout reversal',
    industry: 'Finance, payments and banking',
    provider: 'claude',
    ...fields,
  });
  assert.deepEqual(
    latest().areaSetup.providers.map((p) => p.id),
    ['claude', 'codex', 'cursor', 'copy'],
  );
  assert(!latest().areaSetup.industries.includes('General software'), 'the form offers it');
  // The host checks every field again; nothing starts on a bad one and the form hears why.
  for (const [fields, reason] of [
    [{ name: ' x ' }, /at least 2 characters/],
    [{ name: 'Say "hi"' }, /without quotes/],
    [{ name: 'x'.repeat(33) }, /32 characters or fewer/],
    [{ name: 42 }, /at least 2 characters/],
    [{ about: 'x'.repeat(301) }, /300 characters/],
    [{ provider: 'rm -rf' }, /Choose who sets it up/],
    [{ root: '/somewhere/else' }, /no longer open/],
  ]) {
    await receive(form(fields));
    assert.match(latest().notice, reason);
    assert.match(
      messages.findLast((m) => m.type === 'action-result' && m.action === 'area-start').error,
      reason,
    );
  }
  assert.equal(terminals.length, 0);
  assert.equal(latest().draft, null);
  await receive(form({ name: '  Refund safety  ' }));
  const terminal = terminals.at(-1);
  assert.equal(terminal.cwd, ws);
  assert.match(terminal.sent[0], /^claude '/);
  assert.match(terminal.sent[0], /Area: "Refund safety"/);
  assert.match(terminal.sent[0], /Project stakes: critical/);
  assert.match(terminal.sent[0], /profile\.js" check \.agent-monitor\/focus\.json/);
  const guide = fs.readFileSync(path.join(ws, '.agent-monitor/GUIDE.md'), 'utf8');
  assert.match(guide, /^<!-- Written by Agent Monitor/);
  assert.match(guide, /# Custom focus areas/);
  assert.equal(latest().draft.name, 'Refund safety');
  assert.match(terminal.sent[0], /Industry: Finance, payments and banking/);
  assert.equal(
    messages.findLast((m) => m.type === 'action-result' && m.action === 'area-start').error,
    undefined,
  );
  // A guide someone else wrote at that path is never overwritten.
  fs.writeFileSync(path.join(ws, '.agent-monitor/GUIDE.md'), 'Team notes');
  await receive(form({ name: 'Payout timing', about: '', industry: '', provider: 'copy' }));
  assert.equal(fs.readFileSync(path.join(ws, '.agent-monitor/GUIDE.md'), 'utf8'), 'Team notes');
  assert.match(clipboard.at(-1), /Create an Agent Monitor custom focus area/);
  assert.doesNotMatch(clipboard.at(-1), /Industry:/, 'a skipped field adds nothing');
  assert.equal(latest().draft.copied, true);
  assert.match(latest().notice, /Instructions copied/);
  assert.equal(terminals.length, 1, 'copying opens no terminal');

  await receive({ action: 'area-disable', root: ws });
  assert.deepEqual(latest().focusProfiles[0].areas, []);
  assert.match(latest().notice, /Stopped tracking/);
  vs.workspace.isTrusted = false;
  await receive(form({}));
  assert.match(latest().notice, /trusted local workspace/);
  await receive({
    action: 'area-enable',
    root: ws,
    hash: latest().focusProfiles[0].definition.hash,
  });
  assert.match(latest().notice, /trusted local workspace/);
});
