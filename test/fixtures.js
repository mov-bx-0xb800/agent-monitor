'use strict';
const zlib = require('node:zlib');
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
function png(width = 320, height = 180, seed = 1) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * (width * 3 + 1) + 1 + x * 3;
      const tile = x > width * 0.08 && x < width * 0.92 && y > height * 0.22 && y < height * 0.8;
      rows[p] = tile ? 50 + seed * 12 : 22;
      rows[p + 1] = tile ? 88 + Math.floor((x / width) * 40) : 29;
      rows[p + 2] = tile ? 110 + Math.floor((y / height) * 80) : 40;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function event(
  tool = 'Read',
  input = { file_path: 'lib/auth/session.ts' },
  kind = 'PostToolUse',
  sid = 'demo-thread',
) {
  return {
    session_id: sid,
    cwd: process.cwd(),
    tool_name: tool,
    tool_input: input,
    hook_event_name: kind,
  };
}
module.exports = { png, chunk, event };
