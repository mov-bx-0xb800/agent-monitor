'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { locations } = require('./paths'),
  store = require('./store'),
  setup = require('./setup');
const codexIpc = require('./codex-ipc');
const claudeWake = require('./claude-wake');
const steering = require('./steering'),
  focusAreas = require('./focus-areas.json');
const { visibleCategories, moveArea } = require('../media/model');
const { clean, upgradePoint } = require('./classify');
const { consolidate, foldViewers, alias } = require('./chats'),
  { createTitles } = require('./titles');
const { html } = require('./webview'),
  { display } = require('./images'),
  profile = require('./profile');
function supportsSecondary(vscode) {
  const [major, minor] = vscode.version.split('.').map(Number);
  return /cursor/i.test(vscode.env.appName) || major > 1 || (major === 1 && minor >= 106);
}
function belongs(cwd, folders) {
  return (
    typeof cwd === 'string' &&
    folders.some((f) => {
      const relative = path.relative(f.uri.fsPath, cwd);
      return (
        relative === '' ||
        (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
      );
    })
  );
}
async function createController(vscode, ctx, loc = locations()) {
  const root = loc.cache;
  store.ensure(root);
  // An extension update carries a new collector; keep an already-connected helper current.
  try {
    setup.refreshRuntime(loc);
  } catch {}
  // A surface is the sidebar view or the optional editor tab. They share one watcher and cache.
  const surfaces = new Set();
  let view,
    panel,
    watcher,
    debounce,
    disposed = false,
    notice = '',
    connecting = false,
    choosing = false,
    directBusy = false;
  const directAbort = new AbortController();
  const secondary = supportsSecondary(vscode),
    viewId = secondary ? 'agentMonitor.secondary' : 'agentMonitor.primary';
  await vscode.commands.executeCommand('setContext', 'agentMonitor.secondary', secondary);
  function stop() {
    if (watcher) {
      watcher.close();
      watcher = undefined;
    }
    if (debounce) {
      clearTimeout(debounce);
      debounce = undefined;
    }
  }
  // Project stakes and custom focus areas. A workspace definition takes effect only after it is
  // enabled here, and only for that exact content; the effective profile is copied into the cache
  // so hooks never read workspace files.
  const definitionMemo = new Map();
  let draft = null,
    syncedProfiles = null;
  function definitions() {
    return (vscode.workspace.workspaceFolders || []).slice(0, profile.LIMITS.profiles).map((f) => {
      const folder = f.uri.fsPath;
      let stat;
      try {
        stat = fs.lstatSync(path.join(folder, profile.FILE));
      } catch {
        definitionMemo.delete(folder);
        return { root: folder, found: null };
      }
      const key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`,
        memo = definitionMemo.get(folder);
      if (memo?.key === key) return { root: folder, found: memo.found };
      const found = profile.readDefinition(folder);
      definitionMemo.set(folder, { key, found });
      return { root: folder, found };
    });
  }
  function chosenStakes() {
    const value = ctx.workspaceState?.get('focusStakes');
    return profile.STAKES.includes(value) ? value : null;
  }
  function profiles() {
    const approvals = ctx.workspaceState?.get('focusProfiles', {}) || {},
      dismissed = ctx.workspaceState?.get('focusDismissed', {}) || {},
      chosen = chosenStakes();
    return definitions().map(({ root: folder, found }) => {
      const approved =
        !!found?.doc && found.report.status !== 'invalid' && approvals[folder]?.hash === found.hash;
      const fileStakes =
        approved && profile.STAKES.includes(found.doc.stakes) ? found.doc.stakes : null;
      return {
        root: folder,
        stakes: chosen || fileStakes || 'standard',
        stakesSource: chosen ? 'you' : fileStakes ? 'project' : 'default',
        areas: approved ? profile.readyAreas(found.doc, found.report) : [],
        found,
        approved,
        pending: !!found && !approved && dismissed[folder] !== found.hash,
        wasApproved: !!approvals[folder],
      };
    });
  }
  function syncProfiles(list) {
    const mine = list
      .filter((p) => p.stakes !== 'standard' || p.areas.length)
      .map((p) => ({ root: p.root, stakes: p.stakes, areas: p.areas }));
    const signature = JSON.stringify(mine);
    if (signature === syncedProfiles) return;
    try {
      const now = Date.now() / 1000;
      const others = profile
        .readProfiles(root)
        .filter((cached) => !list.some((p) => p.root === cached.root));
      profile.writeProfiles(root, [...mine.map((p) => ({ ...p, updated: now })), ...others]);
      syncedProfiles = signature;
    } catch {}
  }
  function customOf(p) {
    return p.areas.map((a, i) => ({
      id: 'x:' + a.id,
      label: a.label,
      description: a.description,
      colour:
        a.colour ||
        ['#5fb3a1', '#c9a0dc', '#e0a96d', '#7fb2e5', '#d98c8c', '#a3c47a', '#b8a06a', '#8fa3bf'][
          i % 8
        ],
      core: true,
      custom: true,
    }));
  }
  function profileOf(list, cwd) {
    return list
      .filter((p) => belongs(cwd, [{ uri: { fsPath: p.root } }]))
      .sort((a, b) => b.root.length - a.root.length)[0];
  }
  function allAreas(list = profiles()) {
    const seen = new Set(focusAreas.map((a) => a.id)),
      out = [...focusAreas];
    for (const p of list)
      for (const a of customOf(p))
        if (!seen.has(a.id)) {
          seen.add(a.id);
          out.push(a);
        }
    return out;
  }
  function chatAreas(session, list = profiles()) {
    const p = session?.cwd ? profileOf(list, session.cwd) : null;
    return p ? [...focusAreas, ...customOf(p)] : focusAreas;
  }
  // Starting a custom area: the developer's own agent reads the repository and drafts a definition
  // from the bundled guide; Agent Monitor checks it and the developer enables it.
  const GENERAL = 'General software',
    INDUSTRIES = [
      GENERAL,
      'Finance, payments and banking',
      'Healthcare and life sciences',
      'Energy and utilities',
      'Industrial control and manufacturing',
      'Automotive, aerospace and defence',
      'Telecommunications and networks',
      'Government and public sector',
      'Retail and e-commerce',
      'Media, games and entertainment',
      'Data, AI and machine learning',
      'Developer tools and infrastructure',
    ];
  const PROVIDERS = [
    {
      id: 'claude',
      label: 'Claude Code',
      detail: 'Runs in a terminal here.',
      command: 'claude',
    },
    {
      id: 'codex',
      label: 'Codex',
      detail: 'Runs in a terminal here.',
      command: 'codex',
    },
    {
      id: 'cursor',
      label: 'Cursor Agent',
      detail: 'Runs in a terminal here.',
      command: 'cursor-agent',
    },
    {
      id: 'copy',
      label: 'Copy instructions',
      detail: 'Paste into any AI assistant.',
      copy: true,
    },
  ];
  const GUIDE = '.agent-monitor/GUIDE.md',
    GUIDE_MARK =
      '<!-- Written by Agent Monitor. It is replaced when you start a new area; delete it any time. -->';
  function writeGuide(folder) {
    const file = path.join(folder, GUIDE);
    try {
      const existing = fs.readFileSync(file, 'utf8');
      // Never overwrite a file someone else wrote at this path.
      if (!existing.startsWith(GUIDE_MARK)) return;
    } catch {}
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CUSTOM-AREAS.md'), 'utf8');
    fs.writeFileSync(file, GUIDE_MARK + '\n\n' + text);
  }
  function areaRequest({ name, about, industry, stakes, check }) {
    const text = (v, max) =>
      clean(v, max)
        .replace(/[“”"`]/g, "'")
        .trim();
    return [
      `Create an Agent Monitor custom focus area for this repository.`,
      `Area: "${text(name, 32)}".`,
      about.trim() ? `What it covers: ${text(about, 300)}.` : '',
      industry === GENERAL ? '' : `Industry: ${industry}.`,
      `Project stakes: ${stakes}.`,
      `First read ${GUIDE} and follow its method and quality bar exactly: inspect this repository to find where this work actually lives, then write or update ${profile.FILE}, keeping any areas already there.`,
      `Validate with: ${check} and fix every problem until it reports that every area is ready.`,
      `Do not change any other files.`,
      `Finish by summarising the paths, terms, commands and examples you chose, and anything you were unsure about.`,
    ]
      .filter(Boolean)
      .join(' ');
  }
  // The webview's form supplies these fields; each is checked again here.
  function nameProblem(v) {
    if (v.trim().length < 2) return 'Enter a name of at least 2 characters.';
    if (v.length > 32) return 'Use 32 characters or fewer.';
    if (/[<>`"“”\x00-\x1f]/.test(v))
      return 'Use letters, numbers and simple punctuation, without quotes.';
    return '';
  }
  async function startArea(message) {
    if (!vscode.workspace.isTrusted || vscode.env.remoteName)
      throw Error('Create Focus Areas from a trusted local workspace.');
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) throw Error('Open a project folder first.');
    const folder =
      folders.find((f) => f.uri.fsPath === message.root) ||
      (folders.length === 1 && !message.root ? folders[0] : null);
    if (!folder) throw Error('That project is no longer open. Choose another project.');
    const name = typeof message.name === 'string' ? message.name.trim() : '',
      about = typeof message.about === 'string' ? message.about.trim() : '',
      problem = nameProblem(name);
    if (problem) throw Error(problem);
    if (about.length > 300) throw Error('Use 300 characters or fewer for the details.');
    const industry = INDUSTRIES.includes(message.industry) ? message.industry : GENERAL,
      provider = PROVIDERS.find((p) => p.id === message.provider);
    if (!provider) throw Error('Choose who sets it up.');
    const folderPath = folder.uri.fsPath,
      windows = process.platform === 'win32',
      quote = windows ? setup.quotePS : setup.quotePosix;
    const node = await setup
      .findNode(vscode.workspace.getConfiguration('agentMonitor').get('nodePath', ''))
      .catch(() => 'node');
    const check = `"${node}" "${path.join(__dirname, 'profile.js')}" check ${profile.FILE}`;
    const request = areaRequest({
      name,
      about,
      industry,
      stakes: profileOf(profiles(), folderPath)?.stakes || chosenStakes() || 'standard',
      check,
    });
    writeGuide(folderPath);
    draft = {
      root: folderPath,
      name: clean(name, 32),
      provider: provider.label,
      copied: !!provider.copy,
      at: Date.now() / 1000,
    };
    if (provider.copy) {
      await vscode.env.clipboard.writeText(request);
      notice = `Instructions copied. Paste them into your AI assistant; you'll approve “${draft.name}” under More areas when it is ready.`;
    } else {
      const terminal = vscode.window.createTerminal({
        name: 'Agent Monitor: ' + draft.name,
        cwd: folderPath,
      });
      terminal.sendText(`${provider.command} ${quote(request)}`);
      terminal.show();
      notice = `${provider.label} is setting up “${draft.name}” in a terminal. You'll approve it under More areas when it is ready.`;
    }
    send();
  }
  async function updateArea(message) {
    const list = profiles(),
      p = list.find((x) => x.root === message.root);
    if (!p) throw Error('This folder is no longer open.');
    const approvals = { ...(ctx.workspaceState?.get('focusProfiles', {}) || {}) },
      dismissed = { ...(ctx.workspaceState?.get('focusDismissed', {}) || {}) };
    if (message.action === 'area-open' || message.action === 'area-report') {
      if (!p.found) throw Error(`No ${profile.FILE} was found in this folder.`);
      if (message.action === 'area-open')
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(p.root, profile.FILE))),
        );
      else
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument({
            content: profile.format(p.found.report, profile.FILE),
            language: 'plaintext',
          }),
        );
      return;
    }
    if (message.action === 'area-fix') {
      // The agent that wrote the file fixes it: hand over the check's findings and the command.
      if (!p.found) throw Error(`No ${profile.FILE} was found in this folder.`);
      const node = await setup
        .findNode(vscode.workspace.getConfiguration('agentMonitor').get('nodePath', ''))
        .catch(() => 'node');
      await vscode.env.clipboard.writeText(
        [
          `Agent Monitor checked ${profile.FILE} and it needs a fix. Read ${GUIDE} if you need the rules.`,
          'Fix every problem below, keep the areas that are ready, and change no other files.',
          `Then run: "${node}" "${path.join(__dirname, 'profile.js')}" check ${profile.FILE} and repeat until every area is ready.`,
          '',
          profile.format(p.found.report, profile.FILE),
        ].join('\n'),
      );
      notice =
        'Fix request copied. Paste it into your AI assistant; this card updates when the file changes.';
      send();
      return;
    }
    if (message.action === 'area-enable') {
      if (!vscode.workspace.isTrusted || vscode.env.remoteName)
        throw Error('Approve Focus Areas from a trusted local workspace.');
      if (!p.found?.doc || p.found.hash !== message.hash)
        throw Error('The file changed after you opened it. Check the card again, then approve.');
      const ready = profile.readyAreas(p.found.doc, p.found.report);
      if (p.found.report.status === 'invalid' || !ready.length)
        throw Error('Nothing in this file is ready to approve yet.');
      approvals[p.root] = { hash: p.found.hash, at: Date.now() / 1000 };
      // New areas join the main grid of chats that already have a saved arrangement.
      const saved = ctx.workspaceState?.get('focusLayouts', {}) || {},
        next = {};
      for (const [id, layout] of Object.entries(saved)) {
        if (!layout || !Array.isArray(layout.primary) || !Array.isArray(layout.extra)) continue;
        const add = ready
          .map((a) => 'x:' + a.id)
          .filter((x) => !layout.primary.includes(x) && !layout.extra.includes(x));
        next[id] = { primary: [...layout.primary, ...add], extra: layout.extra };
      }
      await ctx.workspaceState.update('focusLayouts', next);
      if (draft?.root === p.root) draft = null;
      notice = `Now tracking ${ready.map((a) => `“${a.label}”`).join(', ')}. Work counts from now on.`;
    } else if (message.action === 'area-disable') {
      delete approvals[p.root];
      notice = `Stopped tracking this project's own Focus Areas. ${profile.FILE} is unchanged.`;
    } else if (message.action === 'area-dismiss' && p.found) dismissed[p.root] = p.found.hash;
    else return;
    await ctx.workspaceState.update('focusProfiles', approvals);
    await ctx.workspaceState.update('focusDismissed', dismissed);
    send();
  }
  function selections(sessions) {
    const stored = ctx.workspaceState?.get('focusSelections', {}) || {},
      known = allAreas();
    return Object.fromEntries(
      sessions
        .filter((s) => Array.isArray(stored[s.id]))
        .map((s) => [s.id, known.filter((a) => stored[s.id].includes(a.id)).map((a) => a.id)]),
    );
  }
  function layouts(sessions) {
    const stored = ctx.workspaceState?.get('focusLayouts', {}) || {},
      known = allAreas();
    return Object.fromEntries(
      ['all', ...sessions.map((s) => s.id)]
        .filter(
          (id) =>
            stored[id] && Array.isArray(stored[id].primary) && Array.isArray(stored[id].extra),
        )
        .map((id) => {
          const layout = visibleCategories(known, undefined, stored[id]);
          return [
            id,
            { primary: layout.primary.map((a) => a.id), extra: layout.extra.map((a) => a.id) },
          ];
        }),
    );
  }
  async function arrange(message) {
    const state = payload(),
      known = allAreas();
    if (
      state.workspaceStatus !== 'ready' ||
      !state.sessions.length ||
      !known.some((a) => a.id === message.area)
    )
      return;
    if (message.sid !== 'all' && !state.sessions.some((s) => s.id === message.sid)) return;
    const sid = message.sid,
      selection = state.focusSelections[sid],
      layout = state.focusLayouts[sid];
    let { zone, before } = message;
    if (message.action === 'arrange-area') {
      const current = visibleCategories(known, selection, layout);
      const from = current.primary.some((a) => a.id === message.area) ? 'primary' : 'extra';
      const other = from === 'primary' ? 'extra' : 'primary';
      const choices = [
        {
          label: other === 'primary' ? 'Move to Focused areas' : 'Move to More areas',
          zone: other,
        },
      ];
      current[from].forEach((a, index) => {
        if (a.id !== message.area)
          choices.push({
            label: 'Move before ' + a.label,
            description: 'Position ' + (index + 1),
            zone: from,
            before: a.id,
          });
      });
      choices.push({ label: 'Move to last position', zone: from });
      const choice = await vscode.window.showQuickPick(choices, {
        title: 'Arrange ' + known.find((a) => a.id === message.area).label,
      });
      if (!choice) return;
      ({ zone, before } = choice);
    }
    const latest = payload();
    if (sid !== 'all' && !latest.sessions.some((s) => s.id === sid)) return;
    const next = moveArea(
      known,
      latest.focusSelections[sid],
      latest.focusLayouts[sid],
      message.area,
      zone,
      before,
    );
    if (!next) return;
    await ctx.workspaceState.update('focusLayouts', { ...layouts(latest.sessions), [sid]: next });
    send();
  }
  async function selectThread(sid, title) {
    const sessions = payload().sessions;
    if (sid && sid !== 'all') {
      const target = sessions.find((s) => s.id === sid);
      if (!target) throw Error('This chat is no longer available.');
      return target;
    }
    if (sessions.length === 1) return sessions[0];
    if (!sessions.length) throw Error('Waiting for an agent chat in this workspace.');
    const choice = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: s.title,
        description:
          s.agent +
          (s.isSubagent ? ' · Subtask' : '') +
          ' · ' +
          new Date(s.updated * 1000).toLocaleTimeString(),
        sid: s.id,
      })),
      { title, placeHolder: 'Applies only to the chosen chat.' },
    );
    return choice ? sessions.find((s) => s.id === choice.sid) : null;
  }
  function directEndpoint(session) {
    return (
      session?.routing?.agent === 'codex' &&
      !session.isSubagent &&
      !session.routing.agentId &&
      ['waiting', 'idle'].includes(session.status) &&
      codexIpc.supported(vscode) &&
      codexIpc.UUID.test(session.routing.sessionId) &&
      codexIpc.endpoint(path.dirname(loc.codex))
    );
  }
  const AGENTS = ['codex', 'claude', 'cursor'];
  const nativeTitle = createTitles({
    codexHome: loc.codex && path.dirname(loc.codex),
    claudeHome: loc.claude && path.dirname(loc.claude),
  });
  function ignoredAgents() {
    const stored = ctx.globalState?.get('ignoredAgents', []);
    return AGENTS.filter((a) => Array.isArray(stored) && stored.includes(a));
  }
  const shown = () => [...surfaces].filter((s) => s.host.visible);
  function focusPayload() {
    const list = profiles();
    syncProfiles(list);
    return {
      stakes:
        chosenStakes() || list.find((p) => p.stakesSource === 'project')?.stakes || 'standard',
      stakesSource: chosenStakes()
        ? 'you'
        : list.some((p) => p.stakesSource === 'project')
          ? 'project'
          : 'default',
      focusProfiles: list.map((p) => ({
        root: p.root,
        stakes: p.stakes,
        areas: customOf(p),
        definition: p.found
          ? {
              hash: p.found.hash,
              status: p.found.report.status,
              approved: p.approved,
              pending: p.pending,
              changed: p.pending && p.wasApproved,
              errors: p.found.report.errors.slice(0, 3),
              areas: p.found.report.areas.map((a) => ({
                id: a.id,
                label: a.label,
                status: a.status,
                problems: a.errors.length,
                firstProblem: a.errors[0] || a.warnings[0] || '',
                examples: a.examples,
                breadth: a.breadth,
              })),
            }
          : null,
      })),
      draft: draft && Date.now() / 1000 - draft.at < 3600 ? draft : null,
      areaSetup: {
        industries: INDUSTRIES.filter((i) => i !== GENERAL),
        providers: PROVIDERS.map(({ id, label, detail }) => ({ id, label, detail })),
      },
    };
  }
  // Everything but image URLs is the same for every surface, so an update is built once.
  function payload(webview) {
    const base = snapshot();
    return webview ? forSurface(base, webview) : base;
  }
  function forSurface(base, webview) {
    return {
      ...base,
      images: base.images.map((i) => ({
        ...i,
        url: String(webview.asWebviewUri(vscode.Uri.file(path.join(root, i.file)))),
      })),
    };
  }
  function snapshot() {
    const data = store.state(root),
      now = Date.now() / 1000,
      folders = vscode.workspace.workspaceFolders || [];
    const chatNames = ctx.workspaceState?.get('chatNames', {}) || {};
    const retained = Object.values(data.sessions)
      .filter((s) => s && belongs(s.cwd, folders) && now - s.updated < store.LIMITS.ttl)
      .slice(0, store.LIMITS.threads);
    const { sessions: chats, aliases } = consolidate(retained);
    const sessions = chats.map(({ routing, ...s }) => {
      const native = nativeTitle(routing, s);
      return {
        ...s,
        // Evidence recorded by an earlier version gains area confidences for display.
        points: Array.isArray(s.points) ? s.points.map(upgradePoint) : [],
        focusDelivery: directEndpoint({ ...s, routing })
          ? 'direct'
          : routing?.agent === 'claude' && claudeWake.ready(root, s.id)
            ? 'wake'
            : s.status === 'active'
              ? 'hook'
              : 'queue',
        // A local rename wins, then the agent's own chat title, then the first-prompt label.
        title:
          chatNames[s.id] ||
          native ||
          (s.named
            ? s.title
            : s.title && !/ · [a-f0-9]{6}$/.test(s.title) && s.title !== 'Untitled chat'
              ? s.title
              : s.isSubagent
                ? 'Agent subtask'
                : 'Untitled chat'),
        titleSource:
          typeof chatNames[s.id] === 'string' && chatNames[s.id]
            ? 'custom'
            : native
              ? 'native'
              : s.named
                ? 'prompt'
                : 'fallback',
      };
    });
    const images = data.images
      .filter((i) => belongs(i.cwd, folders) && store.safeImage(i))
      .map((i) => ({
        ...i,
        viewers: foldViewers(i.viewers, aliases),
        display: display(i),
        url: '',
      }));
    return {
      sessions,
      images,
      focusAreas,
      ...focusPayload(),
      cacheIssue: data.issue,
      workspaceStatus: vscode.env.remoteName
        ? 'remote'
        : !folders.length
          ? 'no-folder'
          : vscode.workspace.isTrusted === false
            ? 'untrusted'
            : 'ready',
      focusSelections: selections(sessions),
      focusLayouts: layouts(sessions),
      requests: steering
        .read(root)
        .map((r) => (aliases.has(r.sid) ? { ...r, sid: alias(aliases, r.sid) } : r))
        .filter((r) => sessions.some((s) => s.id === r.sid)),
      paused: fs.existsSync(path.join(root, 'paused')),
      connections: {
        codex: setup.configured(loc.codex),
        claude: setup.configured(loc.claude),
        cursor: setup.configured(loc.cursor),
      },
      connectionDetails: Object.fromEntries(
        ['codex', 'claude', 'cursor'].map((agent) => [agent, setup.inspect(loc[agent], agent)]),
      ),
      health: Object.fromEntries(
        ['codex', 'claude', 'cursor'].map((agent) => {
          const h = store.readJSON(path.join(root, 'health-' + agent + '.json'), {}, 2048);
          return [
            agent,
            h && belongs(h.cwd, folders)
              ? {
                  at: h.at,
                  status: h.status,
                  lastFailure: h.version === 1 ? h.lastFailure : undefined,
                }
              : {},
          ];
        }),
      ),
      ignoredAgents: ignoredAgents(),
      motion:
        vscode.workspace.getConfiguration('agentMonitor').get('motion', true) !== false &&
        vscode.workspace.getConfiguration('workbench').get('reduceMotion', 'auto') !== 'on',
      notice,
    };
  }
  function send() {
    if (disposed) return;
    const ready = shown().filter((s) => s.ready);
    if (!ready.length) return;
    const base = snapshot();
    for (const s of ready)
      void s.webview.postMessage({ type: 'data', data: forSurface(base, s.webview) });
  }
  function schedule() {
    if (disposed || debounce || !shown().length) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      send();
    }, 300);
  }
  function syncVisibility() {
    if (disposed) return;
    for (const s of surfaces)
      if (s.ready) void s.webview.postMessage({ type: 'visibility', visible: s.host.visible });
    if (!shown().length) {
      stop();
      return;
    }
    if (!watcher) {
      watcher = fs.watch(root, (_, name) => {
        if (
          [
            'state.json',
            'paused',
            'steering.json',
            'health-codex.json',
            'health-claude.json',
            'health-cursor.json',
          ].includes(String(name))
        )
          schedule();
      });
      watcher.on('error', () => {
        stop();
        notice = 'Live updates paused. Reopen this view to retry.';
        send();
      });
    }
    send();
  }
  async function connect(onlyAgent) {
    if (connecting) return;
    if (!vscode.workspace.isTrusted || vscode.env.remoteName) {
      notice = 'Connect agents from a trusted local workspace.';
      send();
      return;
    }
    connecting = true;
    try {
      const choice = ['codex', 'claude', 'cursor'].includes(onlyAgent)
        ? { agents: [onlyAgent] }
        : await vscode.window.showQuickPick(
            [
              { label: 'Codex, Claude Code and Cursor', agents: ['codex', 'claude', 'cursor'] },
              { label: 'Codex', agents: ['codex'] },
              { label: 'Claude Code', agents: ['claude'] },
              { label: 'Cursor Agent', agents: ['cursor'] },
            ],
            {
              title: 'Connect local agents',
              placeHolder: 'Adds bounded local hooks. Existing settings are preserved.',
            },
          );
      if (!choice) return;
      const node = await setup.findNode(
        vscode.workspace.getConfiguration('agentMonitor').get('nodePath', ''),
      );
      const results = setup.install(choice.agents, node, loc),
        failed = results.filter((r) => !r.ok);
      notice = failed.length
        ? failed.map((r) => `${r.agent}: ${r.error}`).join(' · ')
        : 'Hooks configured. Start a fresh agent session. Codex requires reviewing the new hooks with /hooks.';
    } catch (error) {
      notice = error.message;
    } finally {
      connecting = false;
      send();
    }
  }
  function pause() {
    const file = path.join(root, 'paused');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    else {
      fs.writeFileSync(file, '', { mode: 0o600 });
      claudeWake.cancelAll(root);
    }
    send();
  }
  function openEditor() {
    if (panel) {
      panel.reveal();
      return;
    }
    adopt(
      vscode.window.createWebviewPanel(
        'agentMonitor.editor',
        'Agent Monitor',
        { viewColumn: vscode.ViewColumn?.Active ?? -1, preserveFocus: false },
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.file(root)],
          retainContextWhenHidden: false,
        },
      ),
    );
  }
  function adopt(next) {
    panel = next;
    if (ctx.extensionUri && vscode.Uri.joinPath)
      panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'monitor.svg');
    attach('editor', panel);
  }
  function attach(kind, host) {
    const surface = { kind, host, webview: host.webview, ready: false };
    surfaces.add(surface);
    host.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(root)] };
    const subscriptions = [];
    subscriptions.push(
      host.onDidDispose(() => {
        surfaces.delete(surface);
        if (view === host) view = undefined;
        if (panel === host) panel = undefined;
        if (!shown().length) stop();
        subscriptions.forEach((d) => d.dispose());
      }),
      (kind === 'editor' ? host.onDidChangeViewState : host.onDidChangeVisibility)(syncVisibility),
      host.webview.onDidReceiveMessage((message) => receive(message, surface)),
    );
    host.webview.html = html(host.webview, { surface: kind });
    syncVisibility();
  }
  async function receive(message, surface) {
    if (!message || typeof message !== 'object' || disposed) return;
    let failure = '';
    try {
      if (message.action === 'ready') {
        surface.ready = true;
        send();
      } else if (message.action === 'open-editor') openEditor();
      else if (message.action === 'ignore-agent' && AGENTS.includes(message.agent)) {
        const next = ignoredAgents().filter((a) => a !== message.agent);
        if (message.ignored !== false) next.push(message.agent);
        await ctx.globalState?.update('ignoredAgents', next);
        send();
      } else if (message.action === 'open-image' && typeof message.id === 'string') {
        const item = store
          .state(root)
          .images.find(
            (i) =>
              i.id === message.id &&
              belongs(i.cwd, vscode.workspace.workspaceFolders || []) &&
              store.safeImage(i),
          );
        if (!item) throw Error('This image is no longer cached.');
        await vscode.commands.executeCommand(
          'vscode.open',
          vscode.Uri.file(path.join(root, item.file)),
          {
            preview: true,
            viewColumn: surface.kind === 'editor' ? vscode.ViewColumn?.Beside : undefined,
          },
        );
      } else if (message.action === 'connect') await connect();
      else if (
        message.action === 'connect-agent' &&
        ['codex', 'claude', 'cursor'].includes(message.agent)
      )
        await connect(message.agent);
      else if (
        message.action === 'agent-settings' &&
        ['codex', 'claude', 'cursor'].includes(message.agent)
      ) {
        const file = loc[message.agent];
        if (!file || !fs.existsSync(file))
          throw Error('Connect this agent first to create its hook settings.');
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(vscode.Uri.file(file)),
        );
      } else if (message.action === 'copy-hooks') {
        await vscode.env.clipboard.writeText('/hooks');
        notice = 'Copied /hooks. Run it in your agent to review the installed hooks.';
        send();
      } else if (message.action === 'review-hooks' && ['codex', 'claude'].includes(message.agent)) {
        if (!vscode.workspace.isTrusted || vscode.env.remoteName)
          throw Error('Review local hooks from a trusted workspace.');
        const name =
          'Agent Monitor: ' + (message.agent === 'codex' ? 'Codex' : 'Claude Code') + ' setup';
        let terminal = vscode.window.terminals?.find(
          (t) => t.name === name && t.exitStatus === undefined,
        );
        if (!terminal) {
          terminal = vscode.window.createTerminal({
            name,
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          });
          terminal.sendText(message.agent);
        }
        terminal.show();
        notice =
          'Run /hooks in ' +
          (message.agent === 'codex' ? 'Codex' : 'Claude Code') +
          ' and review Agent Monitor. Then start a new turn.';
        send();
      } else if (message.action === 'pause') pause();
      else if (message.action === 'clear-notice') {
        notice = '';
        send();
      } else if (message.action === 'refresh') {
        notice = '';
        send();
      } else if (message.action === 'open-folder')
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
      else if (message.action === 'trust')
        await vscode.commands.executeCommand('workbench.trust.manage');
      else if (['move-area', 'arrange-area'].includes(message.action)) await arrange(message);
      else if (message.action === 'set-stakes' && profile.STAKES.includes(message.stakes)) {
        // The control itself shows the choice and that it applies to new activity; no banner.
        await ctx.workspaceState.update('focusStakes', message.stakes);
        send();
      } else if (message.action === 'area-start') await startArea(message);
      else if (
        [
          'area-enable',
          'area-disable',
          'area-dismiss',
          'area-open',
          'area-report',
          'area-fix',
        ].includes(message.action) &&
        typeof message.root === 'string'
      )
        await updateArea(message);
      else if (message.action === 'rename-chat') {
        if (payload().workspaceStatus !== 'ready') return;
        const target = await selectThread(message.sid, 'Rename which chat?');
        if (!target) return;
        const name = await vscode.window.showInputBox({
          title: 'Chat name',
          value: target.titleSource === 'fallback' ? '' : target.title,
          prompt: 'Local display name. Leave blank to use the captured label.',
          validateInput: (value) => (value.length > 90 ? 'Use 90 characters or fewer.' : undefined),
        });
        if (name === undefined) return;
        const sessions = payload().sessions;
        if (!sessions.some((s) => s.id === target.id)) return;
        const saved = ctx.workspaceState?.get('chatNames', {}) || {};
        const names = Object.fromEntries(
          sessions.filter((s) => typeof saved[s.id] === 'string').map((s) => [s.id, saved[s.id]]),
        );
        if (name.trim()) names[target.id] = clean(name, 90);
        else delete names[target.id];
        await ctx.workspaceState.update('chatNames', names);
        send();
      } else if (message.action === 'choose-areas') {
        if (choosing) return;
        choosing = true;
        try {
          const target =
            message.sid === 'all'
              ? { id: 'all', title: 'All chats' }
              : await selectThread(message.sid, 'Choose areas for which chat?');
          if (!target) return;
          const own = target.id === 'all' ? allAreas() : chatAreas(target);
          const chosen =
            layouts(payload().sessions)[target.id]?.primary ||
            selections([target])[target.id] ||
            own.filter((a) => a.core).map((a) => a.id);
          const picked = await vscode.window.showQuickPick(
            own.map((a) => ({
              label: a.custom ? a.label + ' (custom)' : a.label,
              description: a.description,
              id: a.id,
              picked: chosen.includes(a.id),
            })),
            {
              title: 'Areas to keep visible · ' + target.title,
              canPickMany: true,
              placeHolder:
                'Quiet areas stay visible. Other areas remain under More areas. This sends no request.',
            },
          );
          if (!picked) return;
          const sessions = payload().sessions;
          if (target.id !== 'all' && !sessions.some((s) => s.id === target.id))
            throw Error('This chat is no longer in the current workspace.');
          const current = selections(sessions);
          current[target.id] = own
            .filter((a) => picked.some((p) => p.id === a.id))
            .map((a) => a.id);
          await ctx.workspaceState.update('focusSelections', current);
          const old = visibleCategories(own, undefined, layouts(sessions)[target.id]);
          const primary = [...old.primary.map((a) => a.id), ...old.extra.map((a) => a.id)].filter(
            (id) => current[target.id].includes(id),
          );
          await ctx.workspaceState.update('focusLayouts', {
            ...layouts(sessions),
            [target.id]: {
              primary,
              extra: [...old.extra, ...old.primary]
                .map((a) => a.id)
                .filter((id) => !primary.includes(id)),
            },
          });
          if (surface.host.visible)
            await surface.webview.postMessage({ type: 'scope', sid: target.id });
          send();
        } finally {
          choosing = false;
        }
      } else if (message.action === 'focus') {
        if (!vscode.workspace.isTrusted || vscode.env.remoteName)
          throw Error('Use a trusted local workspace to steer agents.');
        if (typeof message.area !== 'string' || !allAreas().some((a) => a.id === message.area))
          return;
        const target = await selectThread(message.sid, 'Which chat should focus here?');
        if (!target) return;
        if (!payload().sessions.some((s) => s.id === target.id))
          throw Error('This chat is no longer in the current workspace.');
        const list = profiles(),
          area = chatAreas(target, list).find((a) => a.id === message.area);
        if (!area) throw Error('This area is not enabled for the chat’s workspace.');
        const extra = {
          stakes: profileOf(list, target.cwd)?.stakes || chosenStakes() || 'standard',
          ...(area.custom ? { custom: { label: area.label, description: area.description } } : {}),
        };
        const current = store.state(root).sessions[target.id];
        const listener = current?.routing?.agent === 'claude' && claudeWake.ready(root, target.id);
        if (listener && ['waiting', 'idle'].includes(current.status)) {
          const claimed = steering.claimDirect(
            root,
            target.id,
            message.area,
            current.routing.sessionId,
            undefined,
            'claude',
            extra,
          );
          if (claimed.acquired) {
            try {
              claudeWake.writeSignal(root, target.id, listener.token, claimed.id);
              notice = 'Sending focus request through the native Claude hook.';
            } catch {
              steering.finishDirect(root, claimed.id, false);
              notice =
                'The native wake listener closed. Delivery is unconfirmed; no automatic retry was made.';
            }
          } else notice = 'This chat already has a pending focus request.';
          send();
          return;
        }
        const direct = directEndpoint(current);
        if (direct) {
          if (directBusy) throw Error('A focus request is being sent. Try again shortly.');
          directBusy = true;
          let connection, claimed;
          try {
            connection = await codexIpc.connect(direct, { signal: directAbort.signal });
            const owner = await connection.owner(current.routing.sessionId);
            if (
              disposed ||
              !vscode.workspace.isTrusted ||
              vscode.env.remoteName ||
              !payload().sessions.some((s) => s.id === target.id)
            )
              throw Error('Workspace changed before submission.');
            claimed = steering.claimDirect(
              root,
              target.id,
              message.area,
              current.routing.sessionId,
              undefined,
              'codex',
              extra,
            );
            if (!claimed.acquired) {
              notice = 'This chat already has a queued focus request.';
            } else {
              const described = steering.describe({
                area: area.id,
                revision: 2,
                ...extra,
                ...claimed,
              });
              await connection.start(
                current.routing.sessionId,
                owner,
                steering.prompt([described.label], [described.description], extra.stakes),
                claimed.id,
              );
              steering.finishDirect(root, claimed.id, true);
              notice =
                'Focus request accepted by ' +
                target.agent +
                ' · ' +
                target.title +
                '. The chat continues with its existing permissions.';
            }
          } catch (error) {
            if (claimed?.acquired) {
              steering.finishDirect(root, claimed.id, false);
              notice =
                'Delivery could not be confirmed. Check the selected chat before sending again; no automatic retry was made.';
            } else {
              notice = 'Direct delivery is unavailable for this chat. No request was sent.';
            }
          } finally {
            connection?.close();
            directBusy = false;
          }
          send();
          return;
        }
        if (current?.status !== 'active' && message.delivery !== 'queue') {
          const choice = await vscode.window.showInformationMessage(
            target.agent +
              ' cannot receive an immediate request in this idle chat. Queue it for its next turn?',
            'Queue for next turn',
          );
          if (choice !== 'Queue for next turn') return;
          if (
            disposed ||
            !vscode.workspace.isTrusted ||
            vscode.env.remoteName ||
            !payload().sessions.some((s) => s.id === target.id)
          )
            return;
        }
        // The tile itself shows the queued request and its Cancel button; no banner.
        steering.enqueue(root, target.id, message.area, undefined, extra);
        send();
      } else if (
        message.action === 'cancel-focus' &&
        payload().requests.some((r) => r.id === message.id)
      ) {
        if (!steering.cancel(root, message.id))
          throw Error('An agent is updating. Try cancelling again.');
        notice = '';
        send();
      } else if (message.action === 'settings')
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:wojake.agent-monitor-focus',
        );
      else if (message.action === 'remove' && typeof message.id === 'string') {
        const removed = store.withLock(root, () => {
          const data = store.state(root);
          if (data.issue) throw Error(data.issue);
          const item = data.images.find(
            (i) => i.id === message.id && belongs(i.cwd, vscode.workspace.workspaceFolders || []),
          );
          if (item) {
            data.images = data.images.filter((i) => i.id !== item.id);
            store.save(root, data);
            store.removeImage(root, item);
          }
        });
        if (!removed) notice = 'An image is arriving. Try dismissing again.';
        send();
      }
    } catch (error) {
      notice = error.message || 'The local cache could not be updated.';
      failure = notice;
      send();
    } finally {
      if (
        [
          'focus',
          'choose-areas',
          'area-start',
          'connect-agent',
          'review-hooks',
          'copy-hooks',
          'agent-settings',
        ].includes(message.action) &&
        surfaces.has(surface)
      )
        void surface.webview.postMessage({
          type: 'action-result',
          action: message.action,
          area: message.area,
          agent: message.agent,
          ...(failure ? { error: failure } : {}),
        });
    }
  }
  const provider = {
    resolveWebviewView(next) {
      for (const s of surfaces) if (s.host === view) surfaces.delete(s);
      view = next;
      attach('view', next);
    },
  };
  function open(preserveFocus = false) {
    if (view) {
      view.show(preserveFocus);
      return;
    }
    return vscode.commands.executeCommand(viewId + '.focus', { preserveFocus });
  }
  const disposables = [
    {
      dispose() {
        disposed = true;
        directAbort.abort();
        stop();
        surfaces.clear();
        view = undefined;
        panel = undefined;
      },
    },
    ...['agentMonitor.primary', 'agentMonitor.secondary'].map((id) =>
      vscode.window.registerWebviewViewProvider(id, provider, {
        webviewOptions: { retainContextWhenHidden: false },
      }),
    ),
    vscode.commands.registerCommand('agentMonitor.open', () => open()),
    vscode.commands.registerCommand('agentMonitor.openInEditor', openEditor),
    vscode.window.registerWebviewPanelSerializer?.('agentMonitor.editor', {
      async deserializeWebviewPanel(restored) {
        if (panel || disposed) restored.dispose();
        else adopt(restored);
      },
    }) || { dispose() {} },
    vscode.commands.registerCommand('agentMonitor.connect', connect),
    vscode.commands.registerCommand('agentMonitor.pause', pause),
    vscode.commands.registerCommand('agentMonitor.disconnect', () => {
      if (!vscode.workspace.isTrusted) return;
      try {
        setup.disconnect(loc);
        notice = 'Agent Monitor hooks removed. Cached images remain on this computer.';
      } catch (error) {
        notice = error.message;
      }
      send();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(send),
    vscode.workspace.onDidChangeConfiguration?.((event) => {
      if (
        event.affectsConfiguration('agentMonitor.motion') ||
        event.affectsConfiguration('workbench.reduceMotion')
      )
        send();
    }) || { dispose() {} },
  ];
  ctx.subscriptions.push(...disposables);
  if (vscode.workspace.getConfiguration('agentMonitor').get('openOnStartup', true))
    await open(true);
  return { provider, open, send, dispose: () => disposables.forEach((d) => d.dispose()) };
}
async function activate(ctx) {
  return createController(require('vscode'), ctx);
}
module.exports = { activate, createController, supportsSecondary, belongs };
