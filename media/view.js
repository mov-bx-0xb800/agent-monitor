'use strict';
const api = acquireVsCodeApi(),
  { relativeTime, categories, visibleCategories, areasFor, profileFor } = FocusModel;
const $ = (id) => document.getElementById(id),
  saved = api.getState() || {};
let data = {
    sessions: [],
    images: [],
    focusAreas: [],
    focusSelections: {},
    focusLayouts: {},
    requests: [],
    connections: {},
    connectionDetails: {},
    ignoredAgents: [],
    focusMappings: [],
  },
  tab = saved.tab === 'images' ? 'images' : 'focus',
  // Focus and Images keep separate chat selections; each strip is ordered by its own activity.
  scope = typeof saved.scope === 'string' ? saved.scope : 'all',
  imageScope = typeof saved.imageScope === 'string' ? saved.imageScope : 'all',
  selected = saved.selected || null,
  imageId = saved.imageId || null,
  follow = saved.follow !== false,
  // The newest image at the last render; a different newest image means a new use arrived.
  latestImage = null,
  // Latest image use already seen in Images. Null until the first data load, which counts as seen.
  imagesSeenAt = Number.isFinite(saved.imagesSeenAt) ? saved.imagesSeenAt : null,
  visible = true,
  timer,
  flashTimer,
  loaded = false,
  flashOnLoad = tab === 'images',
  lastRender = 0;
const busy = new Set(),
  expandedScores = new Set(),
  flashing = new Set(),
  stripState = { focus: { left: 0, selection: null }, images: { left: 0, selection: null } };
let draggedArea = null,
  setupReturnFocus,
  // The Focus Area form lives inside its card and stays mounted across renders, so typing,
  // focus and selection survive data updates.
  areaForm = null,
  areaProvider = ['claude', 'codex', 'cursor', 'copy'].includes(saved.areaProvider)
    ? saved.areaProvider
    : null;
const AGENTS = [
  { key: 'codex', agent: 'Codex', name: 'Codex' },
  { key: 'claude', agent: 'Claude', name: 'Claude Code' },
  { key: 'cursor', agent: 'Cursor', name: 'Cursor' },
];
const node = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const detailNode = $('detail');
const nowSeconds = () => Date.now() / 1000;

/* Motion. Off when the setting or the editor's Reduce Motion is off (sent by the host) or the
   OS asks for reduced motion. Entrance motion runs only for changes a person makes, never for
   data refreshes or timer ticks, and nothing loops. */
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const motion = () => data.motion !== false && !reducedMotion.matches;
function animate(el, cls = 'enter') {
  if (!el || !motion()) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  const done = (e) => {
    if (e.target !== el) return;
    el.classList.remove(cls);
    el.removeEventListener('animationend', done);
  };
  el.addEventListener('animationend', done);
}
const scrollMode = () => (motion() ? 'smooth' : 'instant');
// Last rendered score per chat and area, so a meter moves only when its score changes.
const meterScores = new Map();
let fillMeters = false,
  imageDirection = '',
  stripScrolledAt = 0,
  lastUnseen = 0,
  wasActive = null,
  woke = new Set();
function icon(name) {
  if (name === 'grip') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('icon');
    for (const x of [5, 11])
      for (const y of [3, 8, 13]) {
        const dot = document.createElementNS(svg.namespaceURI, 'circle');
        dot.setAttribute('cx', x);
        dot.setAttribute('cy', y);
        dot.setAttribute('r', '1.25');
        svg.append(dot);
      }
    return svg;
  }
  const template = document.createElement('template');
  // Only bundled SVG markup is ever parsed; unknown names render nothing.
  template.innerHTML = Object.hasOwn(MonitorIcons, name) ? MonitorIcons[name] : '';
  const svg = template.content.firstElementChild || node('span');
  svg.classList.add('icon', 'icon-' + name);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}
function buttonContent(button, name, text) {
  button.replaceChildren(icon(name));
  if (text) button.append(node('span', text));
}
for (const placeholder of document.querySelectorAll('[data-icon]'))
  placeholder.replaceWith(icon(placeholder.dataset.icon));
function remember() {
  api.setState({ tab, scope, imageScope, selected, imageId, follow, imagesSeenAt, areaProvider });
}

/* Time and identity */
function age(at) {
  return relativeTime(at * 1000);
}
function stamp(at, prefix = '', suffix = '', cls = 'caption') {
  const e = node('span', undefined, cls);
  e.dataset.at = at;
  e.dataset.prefix = prefix;
  e.dataset.suffix = suffix;
  e.textContent = prefix + age(at) + suffix;
  return e;
}
function agentName(agent) {
  return agent === 'Claude' ? 'Claude Code' : agent;
}
function providerMark(agent) {
  const mark = document.createElement('template');
  // Only bundled SVGs reach this template, never event text. Their inline styles are removed
  // before parsing, so the content security policy never sees a style attribute.
  mark.innerHTML = (Object.hasOwn(MonitorProviders, agent) ? MonitorProviders[agent] : '').replace(
    /\sstyle="[^"]*"/g,
    '',
  );
  const logo = mark.content.firstElementChild || icon('terminal');
  logo.classList.add('provider-icon');
  logo.setAttribute('aria-hidden', 'true');
  logo.setAttribute('focusable', 'false');
  return logo;
}
function isActive(s, now) {
  return !data.paused && s.status === 'active' && now - s.updated < 120;
}
function statusLabel(s, now) {
  return data.paused
    ? 'Paused'
    : isActive(s, now)
      ? 'Active'
      : s.status === 'waiting'
        ? 'Turn ended'
        : s.status === 'ended'
          ? 'Ended'
          : 'Idle';
}
function lastSeen(s) {
  return s.lastActiveAt || s.lastToolAt || s.updated;
}
function avatar(s, now) {
  const box = node('span', undefined, 'chat-avatar');
  box.style.setProperty('--heat', Attention.chatHeat(s, now).toFixed(3));
  box.append(providerMark(s.agent));
  if (isActive(s, now))
    box.append(node('span', undefined, 'presence' + (woke.has(s.id) && motion() ? ' ping' : '')));
  return box;
}
function joined(parts) {
  const out = [];
  for (const part of parts.filter(Boolean)) {
    if (out.length) out.push(' · ');
    out.push(part);
  }
  return out;
}

/* Scope */
const currentScope = () => (tab === 'images' ? imageScope : scope);
// With no chats at all, the empty and setup states explain more than “Chat unavailable”.
const missing = (id) =>
  id !== 'all' && data.sessions.length > 0 && !data.sessions.some((s) => s.id === id);
function scoped() {
  return data.sessions.filter((s) => scope === 'all' || s.id === scope);
}
function images() {
  return data.images.filter(
    (i) => imageScope === 'all' || i.viewers?.some((v) => v.sid === imageScope),
  );
}
function imageViewer(item) {
  return imageScope === 'all' ? item.viewers?.[0] : item.viewers?.find((v) => v.sid === imageScope);
}
function imageAt(item) {
  return imageViewer(item)?.at || item.created;
}
// Viewers are stored newest first.
function lastImageUse(item) {
  return item.viewers?.[0]?.at || item.created || 0;
}
function chatImageAt(sid) {
  let at = 0;
  for (const item of data.images)
    for (const v of item.viewers || []) if (v.sid === sid && v.at > at) at = v.at;
  return at;
}
function unseen() {
  return imagesSeenAt === null ? [] : data.images.filter((i) => lastImageUse(i) > imagesSeenAt);
}
function markImagesSeen() {
  const latest = Math.max(imagesSeenAt || 0, ...data.images.map(lastImageUse));
  if (latest !== imagesSeenAt) {
    imagesSeenAt = latest;
    remember();
  }
}
function flash(ids) {
  clearTimeout(flashTimer);
  flashing.clear();
  ids.forEach((id) => flashing.add(id));
  if (!flashing.size) return;
  flashTimer = setTimeout(() => {
    flashing.clear();
    applyFlash();
  }, 3000);
}
function applyFlash() {
  for (const b of $('thumbnails').children)
    b.classList.toggle('fresh', flashing.has(b.dataset.image));
  $('image-frame').classList.toggle('fresh', flashing.has(imageId));
}
function unavailable(ignoreScope = false) {
  return (
    !!data.cacheIssue ||
    ['remote', 'no-folder', 'untrusted'].includes(data.workspaceStatus) ||
    (!ignoreScope && missing(currentScope()))
  );
}
function empty(title, text, label, action) {
  const box = node('div', undefined, 'empty');
  box.append(node('strong', title), node('p', text));
  if (label) {
    const b = node('button', label, 'primary');
    b.dataset.action = action;
    box.append(b);
  }
  return box;
}
function waiting(ignoreScope = false) {
  if (!loaded) return empty('Loading activity', 'Reading this workspace’s local activity.');
  if (data.cacheIssue)
    return empty(
      'Activity unavailable',
      'The local activity file could not be read. Your saved files have not been replaced.',
      'Retry',
      'refresh',
    );
  if (data.workspaceStatus === 'no-folder')
    return empty(
      'Open a project',
      'Choose a local project folder to see its agent activity.',
      'Open folder',
      'open-folder',
    );
  if (data.workspaceStatus === 'remote')
    return empty(
      'Local agents only',
      'Activity from agents running in remote workspaces is not available here.',
    );
  if (data.workspaceStatus === 'untrusted')
    return empty(
      'Workspace trust required',
      'Review workspace trust before connecting or steering agents.',
      'Review trust',
      'trust',
    );
  if (!ignoreScope && missing(currentScope()))
    return empty(
      'Chat unavailable',
      'Choose another chat above. This chat may have ended or left the retained history.',
    );
  if (data.paused)
    return empty(
      'Collection paused',
      'Resume collection to receive new activity.',
      'Resume',
      'pause',
    );
  if (Object.values(data.connections || {}).some(Boolean))
    return empty(
      'No tool activity yet',
      'Complete agent setup, then start a turn in this workspace.',
    );
  return empty('No chats', 'Set up the agent you use, then start a turn in this workspace.');
}
function focusIdentity() {
  const e = document.activeElement;
  return e?.id
    ? ['id', e.id]
    : Object.entries(e?.dataset || {}).find(([k]) =>
        ['focus', 'point', 'cancelFocus', 'chat', 'image'].includes(k),
      );
}
function restoreFocus(key) {
  if (!key) return;
  const target =
    key[0] === 'id'
      ? $(key[1])
      : [...document.querySelectorAll('button')].find((b) => b.dataset[key[0]] === key[1]);
  if (target && target !== document.activeElement) target.focus({ preventScroll: true });
}
function imageUse(image) {
  const now = nowSeconds();
  return data.sessions
    .filter((s) => imageScope === 'all' || s.id === imageScope)
    .map((s) => ({ ...s, image: s.images?.find((i) => i.id === image.id) || s.image }))
    .filter(
      (s) =>
        isActive(s, now) &&
        s.image?.id === image.id &&
        now - s.image.at < (s.image.phase === 'opening' ? 30 : 120),
    );
}

/* Chat strip, shared by both views */
function stripChats() {
  if (tab !== 'images') return data.sessions.map((s) => [s, lastSeen(s)]);
  const ranked = data.sessions
    .map((s) => [s, chatImageAt(s.id)])
    .filter(([, at]) => at > 0)
    .sort((a, b) => b[1] - a[1]);
  const chosen = data.sessions.find((s) => s.id === imageScope);
  if (chosen && !ranked.some(([s]) => s === chosen)) ranked.push([chosen, 0]);
  return ranked;
}
function updateStripControls() {
  const strip = $('chat-strip'),
    overflow = strip.scrollWidth > strip.clientWidth + 2;
  $('chats-previous').disabled = !overflow || strip.scrollLeft <= 2;
  $('chats-next').disabled =
    !overflow || strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2;
  $('chats-previous').hidden = $('chats-next').hidden = !overflow;
}
function renderPicker() {
  const picker = $('chat-picker'),
    chosen = currentScope();
  picker.hidden = !loaded || unavailable(true) || (!data.sessions.length && !missing(chosen));
  if (picker.hidden) return;
  const strip = $('chat-strip'),
    state = stripState[tab],
    now = nowSeconds(),
    focusKey = focusIdentity(),
    chats = stripChats();
  const active = data.sessions.filter((s) => isActive(s, now));
  $('summary').textContent =
    tab === 'images'
      ? ''
      : data.paused
        ? 'Collection paused'
        : active.length
          ? `${active.length} active`
          : 'No recent activity';
  const all = tab === 'images' && node('button', undefined, 'chat-choice all-chats');
  if (all) {
    all.dataset.chat = 'all';
    all.id = 'chat-choice-all';
    all.setAttribute('aria-pressed', String(chosen === 'all'));
    all.append(
      node('span', 'All chats', 'chat-choice-title'),
      node('span', `${chats.length} chat${chats.length === 1 ? '' : 's'}`, 'caption'),
    );
  }
  const choices = chats.map(([s, at]) => {
    const b = node('button', undefined, 'chat-choice'),
      head = node('span', undefined, 'choice-head'),
      meta = node('span', undefined, 'caption');
    b.dataset.chat = s.id;
    b.id = 'chat-choice-' + s.id;
    b.setAttribute('aria-pressed', String(chosen === s.id));
    b.style.setProperty('--heat', Attention.chatHeat(s, now).toFixed(3));
    b.title = s.title;
    // Focus shows the chat's state and last activity; Images shows when it last used an image.
    meta.append(
      ...joined([
        agentName(s.agent) + (s.isSubagent ? ' subtask' : ''),
        tab === 'images' ? null : statusLabel(s, now),
        at ? stamp(at, '', '', '') : 'No images',
      ]),
    );
    head.append(avatar(s, now), meta);
    b.append(head, node('span', s.title, 'chat-choice-title'));
    return b;
  });
  if (missing(chosen)) {
    const absent = node('button', undefined, 'chat-choice');
    absent.append(node('span', 'Chat unavailable', 'chat-choice-title'));
    absent.id = 'chat-choice-' + chosen;
    absent.dataset.chat = chosen;
    absent.setAttribute('aria-pressed', 'true');
    choices.push(absent);
  }
  strip.replaceChildren(...(all ? [all] : []), ...choices);
  // Restoring the position would cut short a smooth scroll that is still running.
  if (Date.now() - stripScrolledAt > 500) strip.scrollLeft = state.left;
  restoreFocus(focusKey);
  // Reveal only an explicitly changed selection, never on incoming activity or timer ticks.
  if (state.selection !== chosen) {
    const first = state.selection === null;
    state.selection = chosen;
    if (!first) stripScrolledAt = Date.now();
    $('chat-choice-' + chosen)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: first ? 'instant' : scrollMode(),
    });
    state.left = strip.scrollLeft;
  }
  updateStripControls();
}

/* Focus */
function renderChatSummary(now) {
  const box = $('chat-summary');
  const s = data.sessions.find((x) => x.id === scope);
  const head = node('div', undefined, 'summary-head'),
    rename = node('button', undefined, 'icon-button chat-rename');
  buttonContent(rename, 'edit');
  rename.dataset.rename = s.id;
  rename.id = 'rename-' + s.id;
  rename.title = 'Rename chat';
  rename.setAttribute('aria-label', 'Rename chat: ' + s.title);
  head.append(avatar(s, now), node('h2', s.title, 'summary-title'), rename);
  const queued = (data.requests || []).filter(
      (r) => r.sid === s.id && r.status === 'queued' && now - r.created < 3600,
    ).length,
    imageCount = data.images.filter((i) => i.viewers?.some((v) => v.sid === s.id)).length,
    folders = new Set(
      data.sessions.map((x) => (x.cwd || '').split(/[\\/]/).filter(Boolean).at(-1)),
    );
  const line = node('p', undefined, 'chat-line');
  const first = s.created ? stamp(s.created, 'first seen ') : null;
  if (first) first.title = 'First observed by Agent Monitor, not when the chat started.';
  const status = node('span', statusLabel(s, now));
  status.title = isActive(s, now)
    ? 'An event arrived within two minutes and no end event followed. This is not a live heartbeat.'
    : 'Based on the last received event.';
  line.append(
    ...joined([
      agentName(s.agent) + (s.isSubagent ? ' subtask' : ''),
      status,
      stamp(lastSeen(s)),
      first,
      s.subtasks && `${s.subtasks} subtask${s.subtasks === 1 ? '' : 's'}`,
      queued && `${queued} queued`,
      imageCount && `${imageCount} image${imageCount === 1 ? '' : 's'}`,
      folders.size > 1 && (s.cwd || '').split(/[\\/]/).filter(Boolean).at(-1),
    ]),
  );
  box.replaceChildren(head, line);
  if (s.imageIssue)
    box.append(node('p', 'An image from this chat was not captured.', 'chat-fault'));
}
function renderFocus() {
  const now = nowSeconds(),
    threads = scoped().map((s) => (data.paused ? { ...s, status: 'waiting' } : s)),
    focusKey = focusIdentity();
  const blocked = !loaded || unavailable() || !threads.length;
  $('focus-content').hidden = blocked;
  if (blocked) {
    $('chat-summary').replaceChildren(waiting());
    $('groups').replaceChildren();
    $('extra-groups').replaceChildren();
    detailNode.hidden = true;
    $('choose-areas').disabled = true;
    return;
  }
  renderChatSummary(now);
  renderStakes();
  const chatProfile = profileFor(data.focusProfiles, threads[0]);
  const cards = categories(areasFor(data.focusAreas, data.focusProfiles, threads[0]), threads),
    requests = (data.requests || [])
      .filter((r) => scope === 'all' || r.sid === scope)
      .map((r) =>
        r.status === 'queued' && now - r.created > 3600 ? { ...r, status: 'expired' } : r,
      );
  function card(p) {
    const box = node('article', undefined, `focus-card ${p.tone}`);
    box.style.setProperty('--category', p.colour);
    box.style.setProperty('--heat', p.heat.toFixed(3));
    box.style.setProperty('--score', p.score);
    box.dataset.area = p.id;
    const b = node('button', undefined, 'focus-info');
    b.dataset.point = p.id;
    b.title = p.description;
    b.setAttribute('aria-description', p.description);
    b.setAttribute('aria-expanded', String(selected === p.id));
    b.setAttribute('aria-controls', 'detail');
    const top = node('span', undefined, 'area-top'),
      observed = p.score > 0 || p.observed.length > 0;
    top.append(node('strong', p.label));
    if (p.custom) top.append(node('span', 'Custom', 'tag'));
    const count = node('span', observed ? String(p.score) : '—', observed ? 'count' : 'count none');
    count.title = observed ? `Focus score ${p.score} out of 100` : 'No observed activity';
    count.setAttribute('aria-label', count.title);
    const meter = node('span', undefined, 'meter'),
      row = node('span', undefined, 'meter-row');
    meter.setAttribute('aria-hidden', 'true');
    meter.append(node('span'));
    // Fill in when a person picks a chat; otherwise move only when the score changed.
    const key = scope + ':' + p.id,
      from = fillMeters ? 0 : meterScores.get(key);
    meterScores.set(key, p.score);
    if (motion() && from !== undefined && from !== p.score) {
      meter.classList.add('grow');
      meter.style.setProperty('--from', from);
    }
    row.append(meter, count);
    const state = node('span', undefined, 'tile-state');
    if (p.at) {
      if (p.active.length)
        state.append(node('span', undefined, 'live-dot'), node('span', 'Active now, ', 'sr-only'));
      if (p.sensitive) {
        const risk = node('span', undefined, 'sensitive');
        risk.append(
          icon('warning'),
          `${p.sensitive} sensitive change${p.sensitive === 1 ? '' : 's'}`,
        );
        risk.title =
          'Changes to files of a risky kind for this project’s stakes. It does not mean they are wrong.';
        state.append(risk, ' · ');
      }
      if (p.breadth) state.append(`${p.breadth} subject${p.breadth === 1 ? '' : 's'} · `);
      state.append(stamp(p.at, '', '', ''));
    } else state.textContent = 'No activity';
    b.append(top, row, state);
    box.append(b);
    const pending = requests.filter((r) => r.area === p.id && r.status === 'queued'),
      dispatching = requests.some((r) => r.area === p.id && r.status === 'dispatching'),
      queueOnly = threads.length === 1 && threads[0].focusDelivery === 'queue',
      latest = requests.filter((r) => r.area === p.id).sort((a, b) => b.created - a.created)[0];
    const actions = node('div', undefined, 'focus-actions'),
      blocks = (pending.length || dispatching) && (scope !== 'all' || threads.length === 1),
      label =
        busy.has(p.id) || dispatching
          ? 'Sending…'
          : blocks
            ? 'Queued'
            : queueOnly
              ? 'Queue for next turn'
              : 'Focus here';
    const action = node('button', undefined, 'secondary focus-button');
    buttonContent(action, blocks ? 'check' : 'target', label);
    action.dataset.focus = p.id;
    action.dataset.delivery = queueOnly ? 'queue' : '';
    action.title = data.paused
      ? 'Resume collection to send requests.'
      : queueOnly
        ? 'This provider cannot wake this idle chat. Queue a request for its next turn.'
        : 'Ask the chat to give this area attention. Direct delivery depends on provider support.';
    action.disabled = !!blocks || !!data.paused || busy.has(p.id);
    action.setAttribute(
      'aria-label',
      `${queueOnly ? 'Queue for next turn' : 'Focus here'}: ${p.label}`,
    );
    actions.append(action);
    if (pending.length) {
      const cancel = node('button', 'Cancel', 'secondary');
      cancel.dataset.cancelFocus = pending[0].id;
      cancel.title =
        'Cancel request for ' +
        (data.sessions.find((s) => s.id === pending[0].sid)?.title || 'this chat');
      actions.append(cancel);
    } else if (latest) {
      const text =
        latest.status === 'accepted'
          ? 'Accepted ' + age(latest.delivered)
          : latest.status === 'unknown'
            ? 'Delivery unconfirmed'
            : latest.status === 'delivered'
              ? 'Sent! Task is focusing here…'
              : latest.status === 'expired'
                ? 'Expired'
                : latest.status === 'cancelled'
                  ? 'Cancelled'
                  : '';
      if (text) {
        const status = node('span', text, 'caption');
        if (latest.status === 'unknown')
          status.title = 'Check the chat before sending again. No automatic retry was made.';
        else if (latest.status === 'delivered')
          status.title = `Sent to the agent ${age(latest.delivered)}. The agent has not confirmed it yet.`;
        actions.append(status);
      }
    }
    const handle = node('button', undefined, 'area-handle icon-button');
    buttonContent(handle, 'grip');
    handle.dataset.move = p.id;
    handle.id = 'move-' + p.id;
    handle.draggable = true;
    handle.title = 'Drag to reorder, or click to move ' + p.label;
    handle.setAttribute('aria-label', 'Arrange ' + p.label);
    if (pending.length) {
      actions.append(
        node('span', 'Waiting for the next supported agent event.', 'caption request-note'),
      );
    }
    box.append(actions, handle);
    return box;
  }
  const { primary, extra } = visibleCategories(
    cards,
    scope === 'all' ? undefined : data.focusSelections?.[scope],
    data.focusLayouts?.[scope],
  );
  $('choose-areas').disabled = busy.has('choose-areas');
  const activeExtra = extra.filter((p) => p.active.length).length,
    pendingExtra = requests.filter(
      (r) => r.status === 'queued' && extra.some((p) => p.id === r.area),
    ).length;
  $('more-areas-label').textContent =
    'More areas' +
    (activeExtra ? ` · ${activeExtra} active` : '') +
    (pendingExtra ? ` · ${pendingExtra} queued` : '');
  const grid = node('div', undefined, 'tile-grid');
  detailNode.remove();
  grid.append(...primary.map(card));
  $('groups').replaceChildren(grid);
  if (!primary.length)
    $('groups').append(node('p', 'Choose areas to keep here, or open More areas.', 'muted'));
  const extras = node('div', undefined, 'tile-grid');
  extras.append(...extra.map(card));
  if (!extra.length)
    extras.append(node('p', 'Drop an area here to keep it out of the main grid.', 'muted'));
  const group = $('extra-groups'),
    areaCard = customCard(chatProfile);
  if (areaCard.parentNode === group) {
    // An open form is never detached, so typing and focus are not interrupted.
    for (const child of [...group.children]) if (child !== areaCard) child.remove();
    group.insertBefore(extras, areaCard);
  } else group.replaceChildren(extras, areaCard);
  syncAreaForm();
  if (chatProfile?.definition?.pending) $('more-areas-label').textContent += ' · 1 to approve';
  fillMeters = false;
  restoreFocus(focusKey);
  renderDetail(cards, primary, extra, grid, extras, focusKey);
}
/* Project stakes: how closely Focus watches this project. It applies to new activity. */
const STAKES = [
  ['standard', 'Standard', 'Prototypes, internal tools and personal projects.'],
  [
    'production',
    'Production',
    'Real users, money or data depend on it. Marks sensitive changes such as migrations, access control, secrets and deployment.',
  ],
  [
    'critical',
    'Critical',
    'Failures could cause serious harm. Adds safety, regulatory and integrity vocabulary and marks more kinds of sensitive change.',
  ],
];
function renderStakes() {
  const current = data.stakes || 'standard',
    group = node('div', undefined, 'segmented');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', 'stakes-label');
  for (const [value, label, text] of STAKES) {
    const b = node('button', label);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(value === current));
    b.tabIndex = value === current ? 0 : -1;
    b.dataset.stakes = value;
    b.title = text;
    b.disabled = busy.has('stakes');
    group.append(b);
  }
  const note = STAKES.find(([v]) => v === current)[2],
    source =
      data.stakesSource === 'project' ? ' Set by this project’s .agent-monitor/focus.json.' : '';
  $('stakes').replaceChildren(
    node('span', 'Project stakes', 'stakes-label'),
    group,
    node('p', note + source + ' Applies to new activity.', 'caption stakes-note'),
  );
  $('stakes').querySelector('.stakes-label').id = 'stakes-label';
}
/* The "your own focus area" card at the end of More areas, for the chat's workspace folder. */
function customCard(p) {
  const box = Object.assign(node('section', undefined, 'custom-card'), { tabIndex: -1 }),
    def = p?.definition,
    draft = data.draft && p && data.draft.root === p.root ? data.draft : null,
    actions = node('div', undefined, 'custom-actions'),
    target = p ? { root: p.root } : {};
  const button = (label, dataset, kind = 'secondary', iconName) => {
    const b = node('button', undefined, kind);
    if (iconName) buttonContent(b, iconName, label);
    else b.textContent = label;
    Object.assign(b.dataset, dataset);
    return b;
  };
  const start = (label, kind = 'primary', name = '') => {
    const b = button(label, { areaStart: '1', root: p?.root || '', name }, kind, 'edit');
    b.disabled = !!data.paused;
    return b;
  };
  if (areaForm) return areaForm.box;
  const quoted = (names) => (names.length === 1 ? `“${names[0]}”` : `${names.length} Focus Areas`);
  if (def?.pending) {
    // The agent has written (or changed) the file: plain results and what to do next.
    const ready = def.areas.filter((a) => a.status === 'ready'),
      broken = def.status === 'invalid' || def.areas.some((a) => a.status !== 'ready'),
      approvable = ready.length > 0 && def.status !== 'invalid';
    const [title, caption] = !approvable
      ? [
          'Needs a fix before you can approve it',
          (def.changed ? 'Tracking is paused. ' : '') +
            'Send the problems back to your agent; this card updates when it saves a fix.',
        ]
      : def.changed
        ? [
            `Updated: approve to keep tracking ${quoted(ready.map((a) => a.label))}`,
            'The file changed, so tracking is paused until you approve it again.',
          ]
        : [
            `Ready to approve: ${quoted(ready.map((a) => a.label))}`,
            'Your agent set this up by looking through your project. Approve to start tracking.',
          ];
    box.append(node('h3', title), node('p', caption, 'caption'));
    const list = node('ul', undefined, 'custom-report');
    for (const e of def.errors) list.append(node('li', `The file has a problem: ${e}`, 'problem'));
    for (const a of def.areas) {
      const item = node('li', undefined, a.status === 'ready' ? 'ready' : 'problem');
      item.append(node('strong', a.label));
      if (a.status === 'ready') {
        const tried = a.examples.match + a.examples.ignore;
        item.append(
          ` · ready, tested on ${tried} example files` +
            (a.breadth > 8 ? ' · may also pick up some unrelated files' : ''),
        );
      } else
        item.append(
          ` · needs a fix: ${a.firstProblem}` +
            (a.problems > 1 ? ` (and ${a.problems - 1} more)` : ''),
        );
      list.append(item);
    }
    box.append(list);
    if (approvable)
      actions.append(
        button(
          ready.length === 1 ? 'Approve' : `Approve ${ready.length}`,
          { areaAction: 'area-enable', hash: def.hash, ...target },
          'primary',
        ),
      );
    if (broken)
      actions.append(
        button(
          'Copy fix request',
          { areaAction: 'area-fix', ...target },
          approvable ? 'secondary' : 'primary',
          'copy',
        ),
      );
    actions.append(
      button('View details', { areaAction: 'area-report', ...target }),
      button('Edit file', { areaAction: 'area-open', ...target }),
      button('Not now', { areaAction: 'area-dismiss', ...target }, 'text-button'),
    );
  } else if (draft && !def?.approved) {
    box.append(
      node('h3', 'Create your own Focus Area'),
      node(
        'p',
        draft.copied
          ? `Paste the copied instructions into your AI assistant. This card asks you to approve “${draft.name}” when it is ready.`
          : `${draft.provider} is setting up “${draft.name}”. Keep working; this card asks you to approve it when it is ready.`,
        'caption',
      ),
    );
    actions.append(start('Start over', 'secondary', draft.name));
  } else if (def?.approved && p.areas.length) {
    box.append(
      node('h3', 'Your Focus Areas'),
      node('p', `Tracking: ${p.areas.map((a) => a.label).join(', ')}.`, 'caption'),
    );
    actions.append(
      start('Create another'),
      button('Edit file', { areaAction: 'area-open', ...target }),
      button('Stop tracking', { areaAction: 'area-disable', ...target }, 'text-button'),
    );
  } else {
    box.append(
      node('h3', 'Create your own Focus Area'),
      node(
        'p',
        'Watch any part of your project, like a feature, service or workflow. Your AI agent sets it up by looking through your code, and you approve it before it counts.',
        'caption',
      ),
    );
    actions.append(start('Start now'));
  }
  box.append(actions);
  return box;
}
/* Creating a Focus Area: a short form in the card. The host checks every field again. */
function areaNameProblem(value) {
  if (value.trim().length < 2) return 'Enter a name of at least 2 characters.';
  if (value.length > 32) return 'Use 32 characters or fewer.';
  if (/[<>`"“”\x00-\x1f]/.test(value))
    return 'Use letters, numbers and simple punctuation, without quotes.';
  return '';
}
function areaField(label, control, { hint, optional } = {}) {
  const wrap = node('div', undefined, 'field'),
    title = node('label', undefined, 'field-label');
  title.htmlFor = control.id;
  title.append(label);
  if (optional) title.append(' ', node('span', 'Optional', 'optional'));
  wrap.append(title, control);
  if (hint) {
    const text = node('p', hint, 'field-hint');
    text.id = control.id + '-hint';
    control.setAttribute('aria-describedby', text.id);
    wrap.append(text);
  }
  return wrap;
}
function openAreaForm(root, name = '') {
  const roots = (data.focusProfiles || []).map((p) => p.root),
    setup = data.areaSetup || { industries: [], providers: [] },
    agent = { Claude: 'claude', Codex: 'codex', Cursor: 'cursor' }[
      data.sessions.find((s) => s.id === scope)?.agent
    ],
    chosen = [areaProvider, agent, 'claude'].find((id) => setup.providers.some((p) => p.id === id));
  const box = node('section', undefined, 'custom-card creating'),
    form = node('form', undefined, 'area-form'),
    heading = node('h3', 'Create your own Focus Area');
  heading.id = 'area-form-title';
  form.noValidate = true;
  form.setAttribute('aria-labelledby', heading.id);

  const nameInput = Object.assign(node('input'), {
    id: 'area-name',
    type: 'text',
    value: name,
    maxLength: 32,
    required: true,
    autocomplete: 'off',
    spellcheck: false,
    placeholder: 'For example: Checkout flow',
  });
  const about = Object.assign(node('textarea'), {
    id: 'area-about',
    rows: 2,
    maxLength: 300,
    placeholder: 'For example: the cart pages, the orders API and payment webhooks',
  });
  const kind = node('select');
  kind.id = 'area-kind';
  kind.append(new Option('General software', ''));
  for (const label of setup.industries) kind.append(new Option(label, label));

  const nameField = areaField('Name', nameInput, { hint: 'A short name for its tile in Focus.' }),
    nameError = node('p', undefined, 'field-error');
  nameError.id = 'area-name-error';
  nameError.hidden = true;
  nameField.append(nameError);

  const who = node('fieldset', undefined, 'field'),
    choices = node('div', undefined, 'choice-list');
  who.append(node('legend', 'Who sets it up', 'field-label'), choices);
  for (const provider of setup.providers) {
    const option = node('label', undefined, 'choice'),
      radio = Object.assign(node('input'), {
        type: 'radio',
        name: 'area-provider',
        id: 'area-provider-' + provider.id,
        value: provider.id,
        checked: provider.id === chosen,
      }),
      text = node('span', undefined, 'choice-text');
    text.append(node('strong', provider.label), node('span', provider.detail, 'caption'));
    option.append(radio, text);
    choices.append(option);
  }

  const fields = [nameField];
  if (roots.length > 1) {
    const project = node('select');
    project.id = 'area-root';
    for (const r of roots) project.append(new Option(r.split(/[\\/]/).pop() || r, r));
    project.value = roots.includes(root) ? root : roots[0];
    fields.push(areaField('Project', project));
  }
  fields.push(
    areaField('Details', about, {
      optional: true,
      hint: 'Folders, services or rules that help your agent find it.',
    }),
    areaField('Kind of product', kind, {
      optional: true,
      hint: 'Helps your agent use the right words for your field.',
    }),
    who,
  );

  const failure = node('p', undefined, 'field-error');
  failure.id = 'area-form-error';
  failure.setAttribute('role', 'alert');
  failure.hidden = true;
  const submit = node('button', 'Create Focus Area', 'primary'),
    cancel = node('button', 'Cancel', 'secondary'),
    actions = node('div', undefined, 'custom-actions');
  submit.type = 'submit';
  submit.id = 'area-submit';
  cancel.type = 'button';
  cancel.id = 'area-cancel';
  actions.append(submit, cancel);
  form.append(...fields, failure, actions);
  box.append(
    heading,
    node(
      'p',
      'Your AI agent looks through this project and sets it up. You approve it before it counts.',
      'caption',
    ),
    form,
  );

  const showNameProblem = () => {
    const problem = areaForm.tried ? areaNameProblem(nameInput.value) : '';
    nameError.textContent = problem;
    nameError.hidden = !problem;
    nameInput.setAttribute('aria-invalid', problem ? 'true' : 'false');
    nameInput.setAttribute(
      'aria-describedby',
      problem ? 'area-name-error area-name-hint' : 'area-name-hint',
    );
    return problem;
  };
  nameInput.addEventListener('input', showNameProblem);
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    closeAreaForm();
  });
  cancel.addEventListener('click', closeAreaForm);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy.has('area-start') || data.paused) return;
    areaForm.tried = true;
    failure.hidden = true;
    if (showNameProblem()) {
      nameInput.focus();
      return;
    }
    const provider = form.querySelector('input[name=area-provider]:checked')?.value;
    areaProvider = provider;
    remember();
    busy.add('area-start');
    syncAreaForm();
    api.postMessage({
      action: 'area-start',
      root: $('area-root')?.value || areaForm.root,
      name: nameInput.value.trim(),
      about: about.value.trim(),
      industry: kind.value,
      provider,
    });
  });
  areaForm = { box, root: roots.includes(root) ? root : roots[0] || '', tried: false };
  renderFocus();
  nameInput.focus();
}
function syncAreaForm() {
  if (!areaForm) return;
  const submit = $('area-submit'),
    waiting = busy.has('area-start');
  submit.disabled = waiting || !!data.paused;
  submit.textContent = waiting ? 'Starting…' : 'Create Focus Area';
}
function closeAreaForm() {
  areaForm = null;
  renderFocus();
  document.querySelector('.custom-card button[data-area-start]')?.focus();
}
function renderDetail(cards, primary, extra, grid, extras, focusKey) {
  const p = cards.find((c) => c.id === selected),
    detail = detailNode;
  detail.hidden = !p;
  if (!p) {
    $('focus-content').append(detail);
    return;
  }
  const list = primary.some((a) => a.id === selected) ? primary : extra,
    target = list === primary ? grid : extras,
    cols = getComputedStyle(target).gridTemplateColumns.split(' ').filter(Boolean).length || 1,
    index = list.findIndex((a) => a.id === selected),
    after = Math.min(Math.floor(index / cols) * cols + cols - 1, list.length - 1);
  target.children[after].after(detail);
  const head = node('div', undefined, 'detail-head'),
    close = node('button', undefined, 'icon-button');
  buttonContent(close, 'close');
  close.title = 'Close evidence';
  close.setAttribute('aria-label', 'Close evidence');
  close.dataset.close = 'detail';
  head.append(node('h3', p.label), close);
  detail.replaceChildren(head, node('p', p.description, 'detail-desc'));
  const entries = p.scores.filter(
    (r) => r.at || p.observed.some((o) => o.thread.id === r.thread.id),
  );
  if (!entries.length)
    detail.append(node('p', 'No matching activity recorded.', 'detail-desc evidence-none'));
  const modes = {
    read: 'inspected',
    change: 'changed',
    check: 'checks run',
    fail: 'checks reported failures',
    other: 'tool activity',
  };
  for (const result of entries) {
    const s = result.thread,
      o = p.observed.find((x) => x.thread.id === s.id),
      recent = o ? o.recent || [o.evidence] : [],
      row = node('div', undefined, 'evidence');
    // Focus shows one chat, whose name and score are already on screen; show only the evidence.
    const summary = [
      result.modes.map((m) => modes[m]).join(', '),
      `${result.breadth} subject${result.breadth === 1 ? '' : 's'}`,
    ]
      .filter(Boolean)
      .join(' · ');
    row.append(node('p', summary.charAt(0).toUpperCase() + summary.slice(1), 'evidence-summary'));
    // Each item says what was done and why it counts here, such as "Changed · “auth” in path".
    for (const e of recent) {
      const origin = node('p', undefined, 'caption');
      origin.append(
        `${[e.stage, e.reason || e.basis, e.sensitive && 'sensitive: ' + e.sensitive].filter(Boolean).join(' · ')} · `,
        stamp(e.at, '', '', ''),
      );
      row.append(node('code', e.detail, 'evidence-path'), origin);
    }
    if (!recent.length)
      row.append(node('p', 'Detailed evidence is no longer retained.', 'caption'));
    detail.append(row);
  }
  const explanation = node('details', undefined, 'score-explanation'),
    method = node('summary');
  method.append(icon('chevron-right'), node('span', 'How the score works'));
  method.id = 'score-method-' + p.id;
  explanation.open = expandedScores.has(p.id);
  explanation.addEventListener('toggle', () => {
    if (!explanation.isConnected) return;
    if (explanation.open) expandedScores.add(p.id);
    else expandedScores.delete(p.id);
  });
  explanation.append(
    method,
    node(
      'p',
      'The score builds up as this chat works on the area: changes and checks count more than reads, clear signals more than ambiguous names, and repeated calls within a minute are capped. It is kept: time alone never lowers it, and work in other areas lowers it only slowly. The colour fades when the work is not recent. Subjects show breadth, not coverage. Requests and plans add nothing.',
    ),
  );
  detail.append(explanation);
  restoreFocus(focusKey);
}

/* Images */
// Large or animated images are shown as a static preview drawn once by the editor's own image
// decoder, scaled to about 1.5 megapixels so tall screenshots stay readable. The original is kept
// full size and opens with "View clearer image". Bitmaps are released when no longer retained.
const PREVIEW_PIXELS = 1_500_000,
  previews = new Map();
function preview(item) {
  if (!previews.has(item.id)) {
    const task = (async () => {
      const img = new Image();
      img.decoding = 'async';
      img.src = item.url;
      await img.decode();
      const w = img.naturalWidth,
        h = img.naturalHeight,
        scale = Math.min(1, Math.sqrt(PREVIEW_PIXELS / (w * h)));
      const bitmap = await createImageBitmap(img, {
        resizeWidth: Math.max(1, Math.round(w * scale)),
        resizeHeight: Math.max(1, Math.round(h * scale)),
        resizeQuality: 'medium',
      });
      img.src = '';
      return bitmap;
    })().catch(() => null);
    previews.set(item.id, task);
  }
  return previews.get(item.id);
}
function releasePreviews(list) {
  const keep = new Set(list.map((i) => i.id));
  for (const [id, task] of previews)
    if (!keep.has(id)) {
      previews.delete(id);
      void task.then((bitmap) => bitmap?.close());
    }
}
function pictureFor(item, onFailure) {
  if (item.display === 'unavailable') return onFailure();
  if (item.display !== 'reduced') {
    const img = node('img');
    img.src = item.url;
    return img;
  }
  const canvas = node('canvas', undefined, 'preview');
  canvas.setAttribute('role', 'img');
  void preview(item).then((bitmap) => {
    if (!canvas.isConnected) return;
    if (!bitmap) return canvas.replaceWith(onFailure());
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  });
  return canvas;
}
function renderQuality(item) {
  const line = $('image-quality');
  if (item.display !== 'reduced' && item.display !== 'unavailable') {
    line.hidden = true;
    line.replaceChildren();
    return;
  }
  const open = node('button', undefined, 'secondary');
  buttonContent(open, 'go-to-file', 'View clearer image');
  open.dataset.openImage = item.id;
  open.title = 'Open the original image at full size in an editor tab';
  const reason =
    item.display === 'unavailable'
      ? 'Too large to preview here'
      : item.animated
        ? 'Still preview of an animation'
        : 'Reduced preview';
  // The by-line already shows the original size.
  line.replaceChildren(node('span', reason), open);
  line.hidden = false;
}
function renderMain(item, list, index) {
  const frame = $('image-frame'),
    view = $('image-view');
  if (!item) {
    frame.hidden = true;
    view.dataset.id = '';
    view.replaceChildren();
    $('image-empty').replaceChildren(
      !loaded || unavailable() || !data.sessions.length
        ? waiting()
        : empty('No images yet', 'Images appear after a supported agent opens or returns one.'),
    );
    return;
  }
  $('image-empty').replaceChildren();
  frame.hidden = false;
  if (view.dataset.id !== item.id) {
    const open = node('button', undefined, 'image-open');
    open.dataset.openImage = item.id;
    open.title = 'Open in editor';
    open.setAttribute('aria-label', `Open ${item.label} in editor`);
    const placeholder = () =>
      node(
        'span',
        item.display === 'unavailable'
          ? 'No preview for an image this large.'
          : 'This image could not be previewed here.',
        'image-placeholder',
      );
    const img = pictureFor(item, placeholder);
    if (img.tagName === 'IMG') {
      img.alt = item.label;
      img.decoding = 'async';
      img.addEventListener(
        'error',
        () =>
          view.replaceChildren(
            node(
              'p',
              'This cached image is unavailable. Dismiss it or ask the agent to view it again.',
              'empty image-missing',
            ),
          ),
        { once: true },
      );
    } else if (img.tagName === 'CANVAS') img.setAttribute('aria-label', item.label);
    open.append(img);
    if (motion()) open.classList.add(imageDirection || 'fade-in');
    view.replaceChildren(open);
    view.dataset.id = item.id;
  }
  $('image-name').textContent = item.label;
  $('image-name').title = item.label;
  renderQuality(item);
  $('image-open').dataset.openImage = item.id;
  $('image-dismiss').dataset.remove = item.id;
  $('previous').hidden = $('next').hidden = list.length < 2;
  $('previous').disabled = index <= 0;
  $('next').disabled = index >= list.length - 1;
  const users = imageUse(item);
  frame.classList.toggle('in-use', users.length > 0);
  frame.classList.toggle('fresh', flashing.has(item.id));
  const state = $('image-state');
  state.replaceChildren(
    ...(users.length ? [node('span', undefined, 'live-dot')] : []),
    users
      .map(
        (s) =>
          `${s.image.phase === 'opening' ? 'Opening' : s.image.phase === 'referenced' ? 'Recently referenced' : 'Recently viewed'} by ${agentName(s.agent)}`,
      )
      .join(' · '),
  );
  state.hidden = !users.length;
  const viewer = imageViewer(item),
    s = data.sessions.find((x) => x.id === viewer?.sid),
    by = $('image-by');
  by.dataset.at = imageAt(item);
  by.dataset.prefix = s ? agentName(s.agent) + ' · ' : '';
  by.dataset.suffix = ` · ${item.width} × ${item.height}`;
  by.textContent = by.dataset.prefix + age(imageAt(item)) + by.dataset.suffix;
}
function renderImages() {
  const list = images();
  const newest = list[0]?.id || null;
  if (!list.some((i) => i.id === imageId) || (follow && newest !== latestImage)) imageId = newest;
  latestImage = newest;
  const index = list.findIndex((i) => i.id === imageId);
  $('image-title').hidden = !list.length;
  $('thumbnails').hidden = !list.length;
  $('image-position').textContent = list.length ? `${index + 1} of ${list.length}` : '';
  $('follow').setAttribute('aria-pressed', String(follow));
  $('follow').title = follow ? 'Stop following new images' : 'Show each new image as it arrives';
  renderMain(list[index], list, index);
  releasePreviews(list);
  const root = $('thumbnails'),
    existing = new Map([...root.children].map((b) => [b.dataset.image, b]));
  for (const [n, item] of list.entries()) {
    let b = existing.get(item.id);
    if (!b) {
      b = node('button');
      b.dataset.image = item.id;
      const img = pictureFor(item, () => node('span', undefined, 'thumb-placeholder'));
      if (img.tagName === 'IMG') {
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
      }
      b.append(img, stamp(imageAt(item)));
    }
    const time = b.querySelector('[data-at]');
    time.dataset.at = imageAt(item);
    time.textContent = age(imageAt(item));
    b.setAttribute('aria-label', `${item.label}, ${age(imageAt(item))}`);
    b.setAttribute('aria-current', String(item.id === imageId));
    b.classList.toggle('in-use', imageUse(item).length > 0);
    b.classList.toggle('fresh', flashing.has(item.id));
    b.title = `${item.label} · ${age(imageAt(item))}`;
    if (root.children[n] !== b) root.insertBefore(b, root.children[n] || null);
    existing.delete(item.id);
  }
  for (const old of existing.values()) old.remove();
}

/* Agent setup */
function agentStates() {
  const ignored = new Set(data.ignoredAgents || []),
    now = nowSeconds();
  return AGENTS.map(({ key, agent, name }) => {
    const config = data.connectionDetails?.[key] || { configured: !!data.connections?.[key] };
    const sessions = data.sessions.filter((s) => s.agent === agent),
      toolAt = Math.max(0, ...sessions.map((s) => s.lastToolAt || 0)),
      received = toolAt > 0 && toolAt >= (config.changedAt || 0);
    const fault = data.health?.[key]?.lastFailure;
    return {
      key,
      name,
      config,
      sessions,
      toolAt,
      received,
      fault,
      recentFault: !!fault && now - fault.at < 3600,
      needsSetup: !config.configured || !!config.disabled || !!config.issue || !received,
      relevant: !!(config.configured || config.partial || config.issue || sessions.length),
      // Receiving activity overrides an earlier “not used” choice.
      ignored: ignored.has(key) && !received,
    };
  });
}
function setupAction(label, action, agent, cls = 'secondary') {
  const button = node('button', label, cls);
  button.dataset.action = action;
  if (agent) button.dataset.agent = agent;
  button.id = 'setup-' + (agent || 'all') + '-' + action;
  button.disabled = busy.has(action + (agent ? ':' + agent : ''));
  return button;
}
function ignoreButton(s, ignored = true) {
  const b = node('button', ignored ? `I don’t use ${s.name}` : `Use ${s.name}`, 'text-button');
  b.dataset.ignoreAgent = s.key;
  b.dataset.ignored = String(ignored);
  b.id = `ignore-${s.key}${ignored ? '' : '-undo'}`;
  if (ignored) b.title = `Hide setup warnings for ${s.name}. Its hooks are not changed.`;
  return b;
}
function renderConnections() {
  const focusKey = focusIdentity(),
    states = agentStates(),
    considered = states.filter((s) => !s.ignored),
    relevant = considered.filter((s) => s.relevant),
    pendingSetup = relevant.filter((s) => s.needsSetup);
  $('setup-feedback').hidden = !data.notice;
  $('setup-feedback').textContent = data.notice || '';
  const warning = $('setup-warning');
  // Once every agent is receiving activity or marked as not used, the warning never returns.
  warning.hidden =
    !loaded ||
    unavailable(true) ||
    !!data.paused ||
    !!$('setup-dialog').open ||
    (relevant.length ? !pendingSetup.length : states.some((s) => s.ignored));
  $('setup-warning-title').textContent = !relevant.length
    ? 'Connect an agent'
    : pendingSetup.length === 1
      ? pendingSetup[0].name + ' needs setup'
      : 'Agent setup incomplete';
  $('setup-warning-note').textContent = !relevant.length
    ? 'Codex, Claude Code or Cursor.'
    : 'No tool activity received from ' +
      new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(
        pendingSetup.map((s) => s.name),
      ) +
      '.';
  const only = relevant.length && pendingSetup.length === 1 ? pendingSetup[0] : null,
    skip = $('setup-ignore');
  skip.hidden = !only;
  if (only) {
    skip.textContent = `I don’t use ${only.name}`;
    skip.dataset.ignoreAgent = only.key;
    skip.dataset.ignored = 'true';
  }
  $('connections').replaceChildren(
    ...states.map((s) => {
      const { key, name, config, received, toolAt } = s,
        box = node('section', undefined, 'agent-setup' + (s.ignored ? ' ignored' : '')),
        head = node('div', undefined, 'agent-setup-head'),
        actions = node('div', undefined, 'setup-actions');
      const status = s.ignored
        ? 'Not used'
        : busy.has('connect-agent:' + key)
          ? 'Installing hooks…'
          : config.issue
            ? 'Settings unreadable'
            : config.disabled
              ? 'Hooks disabled'
              : config.partial
                ? 'Hooks incomplete'
                : !config.configured
                  ? 'Not connected'
                  : received
                    ? 'Tool activity received'
                    : s.sessions.length
                      ? 'Session detected · no tool events'
                      : 'Configured · no tool events';
      const state = node(
        'span',
        status,
        'agent-state' +
          (s.ignored ? '' : received && !config.disabled ? ' ok' : s.relevant ? ' warn' : ''),
      );
      head.append(providerMark(key === 'claude' ? 'Claude' : name), node('h3', name), state);
      box.append(head);
      if (s.ignored) {
        box.append(
          node('p', 'Setup warnings are hidden. Its hooks, if any, are unchanged.', 'setup-step'),
        );
        actions.append(ignoreButton(s, false));
        box.append(actions);
        return box;
      }
      if (received) box.append(stamp(toolAt, 'Last tool event '));
      if (!config.configured && !config.issue) {
        box.append(
          node(
            'p',
            'Installs Agent Monitor’s local hooks. Existing agent settings are kept.',
            'setup-step',
          ),
        );
        actions.append(
          setupAction(config.partial ? 'Repair hooks' : 'Connect ' + name, 'connect-agent', key),
        );
      } else if (config.issue || config.disabled) {
        box.append(
          node(
            'p',
            config.issue ||
              'Hook execution is disabled in Claude Code settings. Review that setting before collecting activity.',
            'setup-step',
          ),
        );
        actions.append(setupAction('Open hook settings', 'agent-settings', key));
      } else if (!received && key !== 'cursor') {
        box.append(
          node(
            'p',
            key === 'codex'
              ? 'Run /hooks in Codex and trust the Agent Monitor entries. Then start a new turn in this workspace.'
              : 'Run /hooks in Claude Code and check Agent Monitor is enabled. Start a fresh session in this workspace.',
            'setup-step',
          ),
        );
        const open = setupAction('Open ' + name, 'review-hooks', key);
        buttonContent(open, 'terminal', 'Open ' + name);
        const copy = setupAction('', 'copy-hooks', null, 'icon-button');
        buttonContent(copy, 'copy');
        copy.id = 'copy-hooks-' + key;
        copy.title = 'Copy /hooks';
        copy.setAttribute('aria-label', 'Copy /hooks for ' + name);
        actions.append(open, copy);
      } else if (!received) {
        box.append(
          node(
            'p',
            'Start a new Cursor Agent chat in this workspace. If activity does not arrive, check Cursor’s Hooks settings.',
            'setup-step',
          ),
        );
        actions.append(setupAction('Open hook settings', 'agent-settings', key));
      }
      if (s.recentFault) {
        const labels = {
          'input-limit': 'An event exceeded the input limit.',
          'cache-error': 'The activity file could not be read.',
          busy: 'An event was missed while the cache was busy.',
          timeout: 'A collector call timed out.',
          'unsupported-event': 'An event format was not recognised.',
          'collector-error': 'A collector call failed.',
        };
        box.append(
          node(
            'p',
            (Object.hasOwn(labels, s.fault.status) && labels[s.fault.status]) ||
              'A collection error was reported.',
            'setup-fault',
          ),
        );
      }
      if (received && !config.disabled && !config.issue) {
        const edit = setupAction('Hook settings', 'agent-settings', key, 'text-button');
        edit.title = 'Open ' + name + ' hook settings';
        actions.append(edit);
      } else actions.append(ignoreButton(s));
      box.append(actions);
      return box;
    }),
  );
  restoreFocus(focusKey);
}
function showSetup() {
  setupReturnFocus = document.activeElement?.id;
  if (!$('setup-dialog').open) $('setup-dialog').showModal();
  renderConnections();
}

/* Frame */
function showTab(next) {
  if (next === 'images' && tab !== 'images') {
    const fresh = unseen();
    // New images from another chat are shown with all chats rather than hidden by the selection.
    if (fresh.some((i) => !images().includes(i))) {
      imageScope = 'all';
      imageId = null;
    }
    flash(fresh.map((i) => i.id));
  }
  const changed = tab !== next;
  tab = next;
  if (changed && tab === 'focus') fillMeters = true;
  remember();
  render();
  if (changed) {
    animate($('chat-picker'));
    animate($('panel-' + tab));
  }
  if (tab === 'images')
    $('thumbnails')
      .querySelector('.fresh')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: scrollMode() });
}
function render() {
  if (draggedArea) return;
  lastRender = Date.now();
  for (const b of document.querySelectorAll('[role=tab]')) {
    const chosen = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(chosen));
    b.tabIndex = chosen ? 0 : -1;
    $('panel-' + b.dataset.tab).hidden = !chosen;
  }
  const onImages = tab === 'images';
  document.querySelector('nav').style.setProperty('--tab', onImages ? 1 : 0);
  document.body.dataset.motion = motion() ? 'on' : 'off';
  // A chat that has just become active gets one ring on its presence dot.
  const now = nowSeconds(),
    active = new Set(data.sessions.filter((s) => isActive(s, now)).map((s) => s.id));
  woke = wasActive ? new Set([...active].filter((id) => !wasActive.has(id))) : new Set();
  if (loaded) wasActive = active;
  // Focus has no All chats view: start on the most recent chat. A chosen chat that has gone
  // stays selected with an unavailable message.
  if (loaded && scope === 'all' && data.sessions.length) {
    scope = data.sessions[0].id;
    selected = null;
    remember();
  }
  if (loaded && imagesSeenAt === null) markImagesSeen();
  if (onImages && loaded && visible && !document.hidden) {
    if (flashOnLoad) flash(unseen().map((i) => i.id));
    flashOnLoad = false;
    markImagesSeen();
  }
  const fresh = onImages ? 0 : unseen().length;
  $('image-unseen').textContent = fresh > 99 ? '99+' : String(fresh);
  $('image-unseen').hidden = !fresh;
  if (fresh > lastUnseen) animate($('image-unseen'), 'bump');
  lastUnseen = fresh;
  $('tab-images').setAttribute('aria-label', fresh ? `Images, ${fresh} new` : 'Images');
  buttonContent($('pause'), data.paused ? 'debug-continue' : 'debug-pause');
  $('pause').title = data.paused ? 'Resume collection' : 'Pause collection';
  $('pause').setAttribute('aria-label', $('pause').title);
  $('notice').hidden = !data.notice || $('setup-dialog').open;
  $('notice-text').textContent = data.notice || '';
  $('pause-message').hidden = !data.paused;
  renderConnections();
  renderPicker();
  if (onImages) renderImages();
  else renderFocus();
  imageDirection = '';
  schedule();
}
function schedule() {
  clearTimeout(timer);
  if (document.hidden || !visible) return;
  // Ages are coarse (“just now”, “5 min ago”), so a few seconds of lag is invisible.
  timer = setTimeout(() => {
    if (Date.now() - lastRender >= 15000) {
      render();
      return;
    }
    for (const e of document.querySelectorAll('[data-at]'))
      e.textContent =
        (e.dataset.prefix || '') + age(Number(e.dataset.at)) + (e.dataset.suffix || '');
    schedule();
  }, 5000);
}
function sleep() {
  clearTimeout(timer);
  clearTimeout(flashTimer);
  flashing.clear();
}
window.addEventListener('message', (e) => {
  if (e.data.type === 'data') {
    loaded = true;
    data = { ...data, ...e.data.data };
    render();
  } else if (e.data.type === 'action-result') {
    busy.delete(
      e.data.action === 'focus'
        ? e.data.area
        : e.data.action + (e.data.agent ? ':' + e.data.agent : ''),
    );
    if (e.data.action === 'area-start' && areaForm) {
      if (e.data.error) {
        render();
        $('area-form-error').textContent = e.data.error;
        $('area-form-error').hidden = false;
        return;
      }
      areaForm = null;
      render();
      document.querySelector('.custom-card')?.focus({ preventScroll: true });
      return;
    }
    render();
  } else if (e.data.type === 'scope') {
    scope = e.data.sid;
    selected = null;
    remember();
    render();
  } else if (e.data.type === 'visibility') {
    visible = e.data.visible;
    if (visible) {
      flashOnLoad = tab === 'images';
      render();
    } else sleep();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) sleep();
  else render();
});
window.addEventListener('pagehide', sleep);
// Stakes behave as a radio group: arrow keys, Home and End move the selection.
$('stakes').addEventListener('keydown', (e) => {
  const options = [...$('stakes').querySelectorAll('[data-stakes]')],
    index = options.indexOf(document.activeElement);
  if (index < 0) return;
  const next =
    e.key === 'ArrowRight' || e.key === 'ArrowDown'
      ? (index + 1) % options.length
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
        ? (index + options.length - 1) % options.length
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? options.length - 1
            : null;
  if (next === null) return;
  e.preventDefault();
  options[next].click();
  $('stakes').querySelector(`[data-stakes="${options[next].dataset.stakes}"]`)?.focus();
});
$('choose-areas').addEventListener('click', () => {
  busy.add('choose-areas');
  renderFocus();
  api.postMessage({ action: 'choose-areas', sid: scope });
});
function chooseChat(id) {
  if (tab === 'images') {
    imageScope = id;
    imageId = null;
  } else {
    fillMeters = scope !== id;
    scope = id;
    selected = null;
  }
  remember();
  render();
  if (tab === 'focus') animate($('chat-summary'));
}
$('chat-strip').addEventListener(
  'scroll',
  () => {
    stripState[tab].left = $('chat-strip').scrollLeft;
    updateStripControls();
  },
  { passive: true },
);
let resizeFrame;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    updateStripControls();
    // The evidence row follows the grid's current column count.
    if (tab === 'focus' && selected && visible && !document.hidden) renderFocus();
  });
});
for (const [id, direction] of [
  ['chats-previous', -1],
  ['chats-next', 1],
]) {
  $(id).addEventListener('click', () =>
    $('chat-strip').scrollBy({
      left: direction * Math.max(160, $('chat-strip').clientWidth * 0.8),
      behavior: ((stripScrolledAt = Date.now()), scrollMode()),
    }),
  );
}
$('chat-strip').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const buttons = [...$('chat-strip').querySelectorAll('button')],
    at = buttons.indexOf(document.activeElement);
  if (at < 0) return;
  e.preventDefault();
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? buttons.length - 1
        : Math.max(0, Math.min(buttons.length - 1, at + (e.key === 'ArrowRight' ? 1 : -1)));
  buttons[next].focus();
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.chat) chooseChat(b.dataset.chat);
  if (b.dataset.rename) api.postMessage({ action: 'rename-chat', sid: b.dataset.rename });
  if (b.dataset.move) api.postMessage({ action: 'arrange-area', area: b.dataset.move, sid: scope });
  if (b.dataset.tab) showTab(b.dataset.tab);
  if (b.dataset.point) {
    selected = selected === b.dataset.point ? null : b.dataset.point;
    remember();
    renderFocus();
    if (selected) {
      animate($('detail'));
      $('detail').scrollIntoView({ block: 'nearest', behavior: scrollMode() });
    }
  }
  if (b.dataset.close) {
    const previous = selected;
    selected = null;
    remember();
    renderFocus();
    restoreFocus(['point', previous]);
  }
  if (b.dataset.focus) {
    busy.add(b.dataset.focus);
    renderFocus();
    api.postMessage({
      action: 'focus',
      area: b.dataset.focus,
      sid: scope,
      ...(b.dataset.delivery ? { delivery: b.dataset.delivery } : {}),
    });
  }
  if (b.dataset.cancelFocus) api.postMessage({ action: 'cancel-focus', id: b.dataset.cancelFocus });
  if (b.dataset.stakes && b.getAttribute('aria-checked') !== 'true') {
    data.stakes = b.dataset.stakes;
    data.stakesSource = 'you';
    render();
    api.postMessage({ action: 'set-stakes', stakes: b.dataset.stakes });
  }
  if (b.dataset.areaStart) openAreaForm(b.dataset.root, b.dataset.name);
  if (b.dataset.areaAction)
    api.postMessage({
      action: b.dataset.areaAction,
      root: b.dataset.root,
      ...(b.dataset.hash ? { hash: b.dataset.hash } : {}),
    });
  if (b.dataset.remove) api.postMessage({ action: 'remove', id: b.dataset.remove });
  if (b.dataset.openImage) api.postMessage({ action: 'open-image', id: b.dataset.openImage });
  if (b.dataset.ignoreAgent) {
    const agent = b.dataset.ignoreAgent,
      ignored = b.dataset.ignored !== 'false';
    // Apply locally at once; the host persists the choice and sends it back.
    data.ignoredAgents = [...(data.ignoredAgents || []).filter((a) => a !== agent)];
    if (ignored) data.ignoredAgents.push(agent);
    api.postMessage({ action: 'ignore-agent', agent, ignored });
    render();
    if ($('setup-dialog').open) $(`ignore-${agent}${ignored ? '-undo' : ''}`)?.focus();
  }
  if (b.dataset.action === 'setup') showSetup();
  else if (b.dataset.action) {
    const agent = b.dataset.agent;
    if (
      ['connect-agent', 'review-hooks', 'agent-settings', 'copy-hooks'].includes(b.dataset.action)
    ) {
      busy.add(b.dataset.action + (agent ? ':' + agent : ''));
      renderConnections();
    }
    api.postMessage({ action: b.dataset.action, ...(agent ? { agent } : {}) });
  }
  if (b.dataset.image) {
    const list = images().map((i) => i.id);
    imageDirection =
      list.indexOf(b.dataset.image) > list.indexOf(imageId)
        ? 'from-right'
        : list.indexOf(b.dataset.image) < list.indexOf(imageId)
          ? 'from-left'
          : '';
    imageId = b.dataset.image;
    remember();
    renderImages();
    imageDirection = '';
  }
});
$('follow').addEventListener('click', () => {
  follow = !follow;
  // Turning it on shows the newest image now; browsing never turns it off.
  if (follow) imageId = images()[0]?.id || null;
  remember();
  renderImages();
});
function step(delta) {
  const list = images(),
    i = list.findIndex((x) => x.id === imageId),
    next = list[i + delta];
  if (!next) return;
  const from = document.activeElement;
  imageId = next.id;
  imageDirection = delta > 0 ? 'from-right' : 'from-left';
  remember();
  renderImages();
  imageDirection = '';
  $('thumbnails')
    .querySelector(`[data-image="${imageId}"]`)
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: scrollMode() });
  // An arrow hides at the end of the history; keep keyboard focus on the viewer.
  if ((from === $('previous') || from === $('next')) && from.disabled)
    (from === $('previous') ? $('next') : $('previous')).focus();
}
$('previous').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
for (const id of ['thumbnails', 'image-view'])
  $(id).addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    step(e.key === 'ArrowRight' ? 1 : -1);
    if (id === 'thumbnails') $('thumbnails').querySelector(`[data-image="${imageId}"]`)?.focus();
    else $('image-view').querySelector('button')?.focus();
  });
document.querySelector('[role=tablist]').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const names = ['focus', 'images'],
    i = names.indexOf(e.target.closest('[data-tab]')?.dataset.tab || tab),
    n = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : (i + 1) % 2;
  showTab(names[n]);
  $('tab-' + names[n]).focus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('setup-dialog').open && tab === 'focus' && selected) {
    const previous = selected;
    selected = null;
    remember();
    renderFocus();
    restoreFocus(['point', previous]);
  }
});
$('setup-close').addEventListener('click', () => $('setup-dialog').close());
$('setup-dialog').addEventListener('close', () => {
  render();
  const opener = $(setupReturnFocus);
  (opener?.getClientRects().length ? opener : $('agents-open')).focus({ preventScroll: true });
});
$('help-toggle').addEventListener('click', () => {
  const open = $('help-panel').hidden;
  $('help-panel').hidden = !open;
  $('help-toggle').setAttribute('aria-expanded', String(open));
  if (open) animate($('help-panel'));
});
render();
api.postMessage({ action: 'ready' });

// Native drag events carry only a known category ID, never file or external payload data.
document.addEventListener('dragstart', (event) => {
  const handle = event.target.closest('[data-move]');
  if (!handle) return;
  draggedArea = handle.dataset.move;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedArea);
  document.body.classList.add('arranging');
});
document.addEventListener('dragover', (event) => {
  if (!draggedArea) return;
  const zone = event.target.closest('[data-zone]');
  if (!zone) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drop-target').forEach((e) => e.classList.remove('drop-target'));
  (event.target.closest('[data-area]') || zone).classList.add('drop-target');
});
document.addEventListener('drop', (event) => {
  const zone = event.target.closest('[data-zone]');
  if (!zone || !draggedArea) return;
  event.preventDefault();
  const before = event.target.closest('[data-area]')?.dataset.area;
  if (before !== draggedArea)
    api.postMessage({
      action: 'move-area',
      area: draggedArea,
      sid: scope,
      zone: zone.dataset.zone,
      ...(before ? { before } : {}),
    });
  endDrag();
});
function endDrag() {
  const wasDragging = !!draggedArea;
  draggedArea = null;
  document.body.classList.remove('arranging');
  document.querySelectorAll('.drop-target').forEach((e) => e.classList.remove('drop-target'));
  if (wasDragging) render();
}
document.addEventListener('dragend', endDrag);
