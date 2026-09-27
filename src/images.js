'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { LIMITS, removeImage, IMAGE_NAME } = require('./store');
const { clean } = require('./classify');
const { failed } = require('./adapters');
// Reads width, height, format and animation from an image header. It never decodes pixels.
function dimensions(b) {
  if (!Buffer.isBuffer(b) || b.length < 10) return null;
  const sane = (d) =>
    Number.isInteger(d.width) &&
    Number.isInteger(d.height) &&
    d.width >= 1 &&
    d.height >= 1 &&
    d.width <= 1_000_000 &&
    d.height <= 1_000_000
      ? d
      : null;
  if (
    b.length >= 24 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    b.toString('ascii', 12, 16) === 'IHDR'
  ) {
    // APNG announces animation with acTL before its image data; stop at the first IDAT.
    let p = 8,
      chunks = 0,
      animated = false;
    while (p + 12 <= b.length && chunks++ < 10000) {
      const type = b.toString('ascii', p + 4, p + 8);
      if (type === 'acTL') animated = true;
      if (type === 'IDAT' || type === 'IEND') break;
      p += 12 + b.readUInt32BE(p);
    }
    return sane({ width: b.readUInt32BE(16), height: b.readUInt32BE(20), ext: 'png', animated });
  }
  if (b[0] === 255 && b[1] === 216) {
    let p = 2;
    while (p + 4 < b.length) {
      if (b[p++] !== 255) return null;
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > b.length) return null;
      const size = b.readUInt16BE(p);
      if (size < 2 || p + size > b.length) return null;
      // Any start-of-frame marker: baseline, extended, progressive, lossless or arithmetic.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && size >= 8)
        return sane({
          height: b.readUInt16BE(p + 3),
          width: b.readUInt16BE(p + 5),
          ext: 'jpg',
          animated: false,
        });
      p += size;
    }
    return null;
  }
  if (
    b.length >= 30 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X')
      return sane({
        width: b.readUIntLE(24, 3) + 1,
        height: b.readUIntLE(27, 3) + 1,
        ext: 'webp',
        animated: !!(b[20] & 2),
      });
    if (kind === 'VP8L' && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return sane({
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
        ext: 'webp',
        animated: false,
      });
    }
    if (kind === 'VP8 ' && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a)
      return sane({
        width: b.readUInt16LE(26) & 0x3fff,
        height: b.readUInt16LE(28) & 0x3fff,
        ext: 'webp',
        animated: false,
      });
    return null;
  }
  if (b.length >= 13 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) {
    // Count image descriptors within a bounded walk; more than one frame is an animation.
    let p = 13 + (b[10] & 0x80 ? 3 * 2 ** ((b[10] & 7) + 1) : 0),
      frames = 0,
      steps = 0;
    const skip = () => {
      while (p < b.length && b[p] !== 0 && steps++ < 100000) p += b[p] + 1;
      p++;
    };
    while (p < b.length && frames < 2 && steps++ < 100000) {
      const block = b[p++];
      if (block === 0x3b) break;
      if (block === 0x21) {
        p++;
        skip();
      } else if (block === 0x2c) {
        frames++;
        const packed = b[p + 8];
        p += 9 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0) + 1;
        skip();
      } else break;
    }
    return sane({
      width: b.readUInt16LE(6),
      height: b.readUInt16LE(8),
      ext: 'gif',
      animated: frames > 1,
    });
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const header = b.readUInt32LE(14);
    if (header === 12)
      return sane({
        width: b.readUInt16LE(18),
        height: b.readUInt16LE(20),
        ext: 'bmp',
        animated: false,
      });
    if (header >= 40)
      return sane({
        width: Math.abs(b.readInt32LE(18)),
        height: Math.abs(b.readInt32LE(22)),
        ext: 'bmp',
        animated: false,
      });
    return null;
  }
  if (b.length >= 32 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brands = b.toString('ascii', 8, Math.min(b.length, 8 + b.readUInt32BE(0)));
    if (!/avif|avis/.test(brands)) return null;
    // The image spatial extent ("ispe") property holds the displayed size.
    const at = b.subarray(0, 65536).indexOf('ispe');
    if (at < 0 || at + 16 > b.length) return null;
    return sane({
      width: b.readUInt32BE(at + 8),
      height: b.readUInt32BE(at + 12),
      ext: 'avif',
      animated: b.toString('ascii', 8, 12) === 'avis',
    });
  }
  return null;
}
/**
 * How the view shows an image: "direct" at original quality, "reduced" as a static preview drawn
 * by the view (large or animated images), or "unavailable" when decoding it in a sidebar is
 * unsafe. The original is always kept and can be opened full size.
 */
function display(image) {
  const pixels = (image.width || 0) * (image.height || 0);
  if (pixels > LIMITS.previewPixels) return 'unavailable';
  if (image.animated || pixels > LIMITS.displayPixels || image.bytes > LIMITS.displayBytes)
    return 'reduced';
  return 'direct';
}
const FORMATS = /^image\/(png|jpe?g|webp|gif|bmp|x-ms-bmp|avif)$/i,
  DATA_URL = /^data:image\/(png|jpe?g|webp|gif|bmp|x-ms-bmp|avif);base64,/i;
function* candidates(event) {
  // Hook text is untrusted: bytes come from the response; only viewedFile() below opens a path.
  if (event?.hook_event_name !== 'PostToolUse' || failed(event)) return;
  let count = 0;
  function* walk(obj, depth = 0) {
    if (depth > 10 || ++count > 1000) return;
    if (Array.isArray(obj)) {
      for (const value of obj.slice(0, 100)) yield* walk(value, depth + 1);
    } else if (obj && typeof obj === 'object') {
      if (failed({ tool_response: obj })) return;
      // MCP and API blocks use data + mimeType/media_type; Claude Code's Read returns
      // { type: 'image', file: { base64, type: 'image/png' } }.
      const mime =
        obj.mimeType ||
        obj.media_type ||
        obj.mime_type ||
        (typeof obj.type === 'string' && FORMATS.test(obj.type) ? obj.type : '');
      let raw = FORMATS.test(mime) ? (obj.data ?? obj.base64) : null;
      for (const value of [obj.url, obj.image_url])
        if (typeof value === 'string' && DATA_URL.test(value))
          raw = value.slice(value.indexOf(',') + 1);
      if (
        typeof raw === 'string' &&
        raw.length <= (LIMITS.imageBytes * 4) / 3 + 4 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(raw)
      ) {
        yield { data: Buffer.from(raw, 'base64'), label: 'Tool image' };
        return;
      }
      for (const [key, value] of Object.entries(obj).slice(0, 100))
        if (
          !['data', 'base64', 'url', 'image_url', 'path', 'file_path', 'image_path'].includes(
            key,
          ) ||
          typeof value === 'object'
        )
          yield* walk(value, depth + 1);
    } else if (
      typeof obj === 'string' &&
      /^[\s]*[\[{]/.test(obj) &&
      obj.length < LIMITS.imageBytes * 2
    ) {
      try {
        yield* walk(JSON.parse(obj), depth + 1);
      } catch {}
    }
  }
  let found = false;
  for (const image of walk(event.tool_response)) {
    found = true;
    yield image;
  }
  if (!found) {
    const viewed = viewedFile(event);
    if (viewed) yield viewed;
  }
}
// Codex replaces image data URLs in hook payloads with a placeholder, so a successful
// view_image call carries no bytes. Only for that tool, the file it names is read once:
// never through a link, never a device or pipe, within the image budget, and it is kept only
// if its bytes decode as a supported image. No other tool or path field is ever opened.
const VIEWABLE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
function viewedFile(event) {
  const target = event.tool_input?.path;
  if (
    event.tool_name !== 'view_image' ||
    typeof target !== 'string' ||
    !target ||
    target.length > 4096 ||
    target.includes('\0') ||
    !VIEWABLE.test(target) ||
    typeof event.cwd !== 'string' ||
    !path.isAbsolute(event.cwd)
  )
    return null;
  const file = path.resolve(event.cwd, target);
  let fd;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 16 || stat.size > LIMITS.imageBytes) return null;
    const data = Buffer.alloc(stat.size);
    let read = 0;
    while (read < data.length) {
      const n = fs.readSync(fd, data, read, data.length - read, read);
      if (!n) return null;
      read += n;
    }
    return { data, label: 'Viewed image' };
  } catch {
    return null;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
  }
}
function candidate(event) {
  return candidates(event).next().value || null;
}
// Every supported image the agent received is kept, at any size, so the person can see it.
function captureFound(root, state, event, sid, now, phase, found) {
  if (!found || !found.data.length || found.data.length > LIMITS.imageBytes) return null;
  const dim = dimensions(found.data);
  if (!dim) return null;
  const id = crypto
    .createHash('sha256')
    .update(event.cwd)
    .update('\0')
    .update(found.data)
    .digest('hex')
    .slice(0, 24);
  let image = state.images.find((x) => x.id === id);
  if (!image) {
    image = {
      id,
      source: 'tool-output',
      file: `${id}.${dim.ext}`,
      cwd: event.cwd,
      label: clean(found.label, 100),
      bytes: found.data.length,
      pixels: dim.width * dim.height,
      width: dim.width,
      height: dim.height,
      ...(dim.animated ? { animated: true } : {}),
      viewers: [],
    };
    while (
      state.images.length >= LIMITS.images ||
      state.images.reduce((n, x) => n + x.bytes, 0) + image.bytes > LIMITS.totalBytes - 524288
    ) {
      const old = state.images.pop();
      if (!old) return null;
      removeImage(root, old);
    }
    fs.writeFileSync(path.join(root, image.file), found.data, { mode: 0o600 });
  }
  image.created = now;
  image.viewers = [
    { sid, at: now, phase },
    ...(image.viewers || []).filter((v) => v.sid !== sid),
  ].slice(0, LIMITS.threads);
  state.images = [image, ...state.images.filter((x) => x.id !== id)];
  // Recover cache bytes after an interrupted write; only validated hash-named cache files are candidates.
  const known = new Set(state.images.map((x) => x.file));
  for (const file of fs.readdirSync(root).slice(0, 100)) {
    if (IMAGE_NAME.test(file) && !known.has(file)) removeImage(root, { file });
  }
  return id;
}
function captureMany(root, state, event, sid, now, phase) {
  const ids = [];
  let bytes = 0,
    examined = 0;
  for (const found of candidates(event)) {
    bytes += found.data.length;
    if (++examined > LIMITS.images || bytes > LIMITS.totalBytes) break;
    const id = captureFound(root, state, event, sid, now, phase, found);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.filter((id) => state.images.some((image) => image.id === id));
}
function capture(...args) {
  return captureMany(...args)[0] || null;
}
module.exports = { dimensions, display, candidate, capture, captureMany };
