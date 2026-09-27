'use strict';
const fs = require('node:fs');
const path = require('node:path');
const LIMITS = Object.freeze({
  threads: 12,
  images: 20,
  metadata: 262144,
  // Every supported image is kept at its original quality within these byte budgets.
  imageBytes: 24 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  // Larger or animated images are shown as a reduced, static preview; above previewPixels the
  // view shows a placeholder instead of decoding. "View clearer image" always opens the original.
  displayPixels: 16_000_000,
  displayBytes: 12 * 1024 * 1024,
  previewPixels: 64_000_000,
  ttl: 86400,
});
const IMAGE_NAME = /^[a-f0-9]{24}\.(png|jpg|webp|gif|bmp|avif)$/;
function ensure(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
}
function readJSON(file, fallback = {}, max = LIMITS.metadata) {
  try {
    if (fs.statSync(file).size > max) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function state(root) {
  const file = path.join(root, 'state.json'),
    raw = readJSON(file, null);
  const valid =
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    raw.sessions &&
    typeof raw.sessions === 'object' &&
    !Array.isArray(raw.sessions) &&
    Array.isArray(raw.images) &&
    Object.values(raw.sessions).every(
      (s) =>
        s &&
        typeof s === 'object' &&
        typeof s.cwd === 'string' &&
        Number.isFinite(s.updated) &&
        (!s.points || Array.isArray(s.points)),
    ) &&
    raw.images.every(
      (i) =>
        i &&
        typeof i === 'object' &&
        typeof i.file === 'string' &&
        typeof i.cwd === 'string' &&
        Array.isArray(i.viewers),
    );
  const data = {
    version: 1,
    sessions: valid ? raw.sessions : {},
    images: valid ? raw.images.slice(0, LIMITS.images) : [],
  };
  Object.defineProperty(data, 'issue', {
    value:
      !valid && fs.existsSync(file)
        ? 'Activity data could not be read. Refresh to try again.'
        : null,
    enumerable: false,
  });
  return data;
}
function atomic(file, data) {
  const tmp = file + '.pending';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
// Sheds the least useful detail, oldest chats first, until the cache fits its budget. Typical
// caches never reach this; it guarantees that unusual activity cannot make collection fail.
// Focus progress itself is small and is never shed; evidence detail and breadth go first.
const COMPACT = [
  (s) => {
    if (Array.isArray(s.points)) s.points = s.points.slice(0, 8);
  },
  (s) => {
    if (Array.isArray(s.points))
      s.points = s.points.map((p) =>
        Array.isArray(p?.areas) ? { ...p, areas: p.areas.map((a) => a.slice(0, 2)) } : p,
      );
  },
  (s) => {
    if (Array.isArray(s.attention?.subjects))
      s.attention.subjects = s.attention.subjects.slice(0, 8);
    if (Array.isArray(s.points)) s.points = s.points.slice(0, 2);
  },
];
function serialise(s) {
  let raw = JSON.stringify(s);
  if (Buffer.byteLength(raw) <= LIMITS.metadata || !s?.sessions) return raw;
  const oldest = Object.values(s.sessions)
    .filter((x) => x && typeof x === 'object')
    .sort((a, b) => (a.updated || 0) - (b.updated || 0));
  // Fully compact the oldest chat before touching a newer one; the newest is usually on screen.
  for (const session of oldest)
    for (const step of COMPACT) {
      step(session);
      raw = JSON.stringify(s);
      if (Buffer.byteLength(raw) <= LIMITS.metadata) return raw;
    }
  return raw;
}
function save(root, s) {
  const raw = serialise(s);
  if (Buffer.byteLength(raw) > LIMITS.metadata) throw Error('Metadata limit exceeded');
  atomic(path.join(root, 'state.json'), raw);
}
function withLock(root, fn) {
  ensure(root);
  const lock = path.join(root, '.lock');
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') return false;
    // Only reclaim a stale lock whose recorded owner is no longer alive.
    try {
      const owner = readJSON(path.join(lock, 'owner.json'));
      if (Date.now() - fs.statSync(lock).mtimeMs < 30000 || !Number.isInteger(owner.pid))
        return false;
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (e) {
        if (e.code !== 'ESRCH') return false;
      }
      fs.unlinkSync(path.join(lock, 'owner.json'));
      fs.rmdirSync(lock);
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch {
      return false;
    }
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });
    fn();
    return true;
  } finally {
    try {
      fs.unlinkSync(path.join(lock, 'owner.json'));
      fs.rmdirSync(lock);
    } catch {}
  }
}
function removeImage(root, image) {
  if (!IMAGE_NAME.test(image.file || '')) return;
  try {
    fs.unlinkSync(path.join(root, image.file));
  } catch {}
}
function safeImage(image) {
  return image.source === 'tool-output' && IMAGE_NAME.test(image.file || '');
}
function pruneLegacyImages(root, s) {
  // Old cache entries may have been collected from untrusted file paths.
  for (const image of s.images) if (!safeImage(image)) removeImage(root, image);
  s.images = s.images.filter(safeImage);
  const files = new Set(s.images.map((image) => image.file));
  // Interrupted old writes may have left copies with no metadata entry.
  for (const file of fs.readdirSync(root).slice(0, 100)) {
    if (IMAGE_NAME.test(file) && !files.has(file)) removeImage(root, { file });
  }
  const ids = new Set(s.images.map((image) => image.id));
  for (const session of Object.values(s.sessions)) {
    session.images = (session.images || []).filter((image) => ids.has(image.id));
    if (session.image && !ids.has(session.image.id)) session.image = null;
  }
}
function prune(s, now) {
  s.sessions = Object.fromEntries(
    Object.entries(s.sessions)
      .filter(([, v]) => v && Number.isFinite(v.updated) && now - v.updated < LIMITS.ttl)
      .sort((a, b) => b[1].updated - a[1].updated)
      .slice(0, LIMITS.threads),
  );
}
module.exports = {
  LIMITS,
  IMAGE_NAME,
  ensure,
  readJSON,
  state,
  atomic,
  save,
  withLock,
  removeImage,
  safeImage,
  pruneLegacyImages,
  prune,
};
