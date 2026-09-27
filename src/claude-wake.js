'use strict';
// A sleeping shell owns the native asyncRewake hook; Node runs only at its edges.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  { execFileSync } = require('node:child_process');
const store = require('./store'),
  steering = require('./steering'),
  { sessionKey } = require('./classify');
const SID = /^[a-f0-9]{20}$/,
  UUID = /^[a-f0-9-]{36}$/,
  TTL = 3600;
function files(root, sid) {
  if (!SID.test(sid)) throw Error('Invalid wake identity.');
  const dir = path.join(root, 'wake');
  return { dir, lease: path.join(dir, sid + '.json'), pipe: path.join(dir, sid + '.pipe') };
}
function ready(root, sid, now = Date.now() / 1000) {
  try {
    const f = files(root, sid),
      r = store.readJSON(f.lease, null, 2048);
    if (
      !r ||
      r.sid !== sid ||
      r.expires <= now ||
      !r.ready ||
      !UUID.test(r.token) ||
      !Number.isInteger(r.pid) ||
      r.pid < 2
    )
      return null;
    const stat = fs.lstatSync(f.pipe);
    if (!stat.isFIFO() || stat.uid !== process.getuid?.() || stat.mode & 0o077) return null;
    process.kill(r.pid, 0);
    return r;
  } catch {
    return null;
  }
}
function writeSignal(root, sid, token, value) {
  const r = ready(root, sid);
  if (!r || r.token !== token) throw Error('The native wake listener is no longer available.');
  const f = files(root, sid);
  let fd;
  try {
    fd = fs.openSync(
      f.pipe,
      fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
    fs.writeSync(fd, value + '\n');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function cancel(root, sid) {
  const r = ready(root, sid);
  if (r)
    try {
      writeSignal(root, sid, r.token, 'cancel');
    } catch {}
}
function cancelAll(root) {
  let names;
  try {
    names = fs
      .readdirSync(path.join(root, 'wake'))
      .filter((n) => /^[a-f0-9]{20}\.json$/.test(n))
      .slice(0, 12);
  } catch {
    return;
  }
  for (const n of names) {
    const sid = n.slice(0, 20),
      r = ready(root, sid);
    if (r)
      try {
        writeSignal(root, sid, r.token, 'cancel');
      } catch {}
  }
}
function cleanup(root, sid, token) {
  const f = files(root, sid);
  store.withLock(root, () => {
    const r = store.readJSON(f.lease, null, 2048);
    if (r?.token !== token) return;
    fs.rmSync(f.lease, { force: true });
    fs.rmSync(f.pipe, { force: true });
    const data = store.state(root);
    if (!data.issue) store.save(root, data);
  });
}
function prepare(root, event, pid, now = Date.now() / 1000) {
  if (
    process.platform === 'win32' ||
    event.hook_event_name !== 'Stop' ||
    event.agent_id ||
    !Number.isInteger(pid) ||
    pid < 2
  )
    return null;
  const sid = sessionKey('claude', event);
  if (!sid) return null;
  // The ordinary collector may run concurrently. Its hook remains independent and fail-open.
  require('./collector').record(event, 'claude', root, now);
  let result = null;
  store.withLock(root, () => {
    if (fs.existsSync(path.join(root, 'paused'))) return;
    const s = store.state(root).sessions[sid];
    if (
      !s ||
      s.isSubagent ||
      s.routing?.agentId ||
      s.routing?.sessionId !== event.session_id ||
      !['waiting', 'idle'].includes(s.status)
    )
      return;
    const f = files(root, sid);
    store.ensure(f.dir);
    let count = 0;
    for (const name of fs
      .readdirSync(f.dir)
      .filter((n) => /^[a-f0-9]{20}\.json$/.test(n))
      .slice(0, 24)) {
      const id = name.slice(0, 20),
        old = store.readJSON(files(root, id).lease, null, 2048);
      let live = false;
      try {
        if (old?.expires > now) {
          process.kill(old.pid, 0);
          live = true;
        }
      } catch {}
      if (live) {
        count++;
        if (id === sid) return;
      } else {
        fs.rmSync(files(root, id).lease, { force: true });
        fs.rmSync(files(root, id).pipe, { force: true });
      }
    }
    if (count >= 12) return;
    const token = crypto.randomUUID();
    fs.rmSync(f.pipe, { force: true });
    execFileSync('/usr/bin/mkfifo', ['-m', '600', f.pipe], { timeout: 1000, stdio: 'ignore' });
    result = { sid, token, pid, expires: now + TTL, ready: false };
    store.atomic(f.lease, JSON.stringify(result));
  });
  return result;
}
function advertise(root, sid, token) {
  let advertised = false;
  store.withLock(root, () => {
    const f = files(root, sid),
      r = store.readJSON(f.lease, null, 2048);
    if (r?.token !== token || fs.existsSync(path.join(root, 'paused'))) return;
    r.ready = true;
    store.atomic(f.lease, JSON.stringify(r));
    const data = store.state(root);
    if (!data.issue) store.save(root, data);
    advertised = true;
  });
  return advertised;
}
function deliver(root, sid, token, id) {
  let text = null;
  store.withLock(root, () => {
    const lease = ready(root, sid),
      data = store.state(root),
      s = data.sessions[sid];
    if (
      !lease ||
      lease.token !== token ||
      fs.existsSync(path.join(root, 'paused')) ||
      !s ||
      s.isSubagent ||
      s.routing?.agent !== 'claude' ||
      s.routing.agentId
    )
      return;
    const rows = steering.read(root),
      r = rows.find(
        (r) => r.id === id && r.sid === sid && r.transport === 'wake' && r.status === 'dispatching',
      );
    const area = r && steering.describe(r);
    if (!area) return;
    r.status = 'delivered';
    r.event = 'AsyncRewake';
    r.delivered = Date.now() / 1000;
    store.atomic(path.join(root, 'steering.json'), JSON.stringify(rows));
    text = steering.prompt([area.label], area.description ? [area.description] : [], r.stakes);
  });
  cleanup(root, sid, token);
  return text;
}
module.exports = {
  ready,
  prepare,
  advertise,
  deliver,
  cleanup,
  cancel,
  cancelAll,
  writeSignal,
  TTL,
};
if (require.main === module) {
  const [mode, root, sid, token, id] = process.argv.slice(2);
  try {
    if (mode === 'prepare') {
      let bytes = 0,
        raw = '';
      process.stdin.on('data', (c) => {
        bytes += c.length;
        if (bytes > 65536) process.exit(0);
        raw += c;
      });
      process.stdin.on('end', async () => {
        try {
          const event = JSON.parse(raw);
          for (let attempt = 0; attempt < 5; attempt++) {
            const r = prepare(root, event, Number(sid));
            if (r) {
              process.stdout.write(r.sid + ' ' + r.token);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
        } catch {}
      });
    } else if (mode === 'ready') {
      (async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
          if (advertise(root, sid, token)) return;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        process.exitCode = 1;
      })();
    } else if (mode === 'cleanup') cleanup(root, sid, token);
    else if (mode === 'deliver') {
      const text = deliver(root, sid, token, id);
      if (text) {
        process.stderr.write(text + '\n');
        process.exitCode = 2;
      }
    }
  } catch {
    /* Optional native wake hooks fail open. */
  }
}
