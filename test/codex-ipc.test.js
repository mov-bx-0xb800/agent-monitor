'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  net = require('node:net'),
  crypto = require('node:crypto');
const ipc = require('../src/codex-ipc');
async function server(t, respond) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-ipc-'));
  const file = path.join(dir, 'test.sock'),
    sockets = new Set();
  const srv = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const size = buffer.readUInt32LE(0),
          msg = JSON.parse(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4);
        respond(msg, (reply) => {
          const body = Buffer.from(JSON.stringify(reply)),
            header = Buffer.alloc(4);
          header.writeUInt32LE(body.length);
          socket.write(header.subarray(0, 2));
          socket.write(Buffer.concat([header.subarray(2), body]));
        });
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => srv.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((r) => srv.listen(file, r));
  return file;
}
test('exact owner, complete text metadata, inherited permissions and explicit receipt', async (t) => {
  const owner = crypto.randomUUID(),
    chat = crypto.randomUUID(),
    sent = [];
  const file = await server(t, (m, reply) => {
    sent.push(m);
    reply({
      type: 'response',
      requestId: m.requestId,
      method: m.method,
      resultType: 'success',
      handledByClientId: owner,
      result:
        m.method === 'initialize'
          ? { clientId: crypto.randomUUID() }
          : m.method === 'thread-owner-discovery'
            ? {}
            : { result: { turn: { id: 'test-turn', status: 'inProgress' } } },
    });
  });
  const c = await ipc.connect(file);
  t.after(c.close);
  assert.equal(await c.owner(chat), owner);
  assert.deepEqual(await c.start(chat, owner, 'Synthetic focus request', crypto.randomUUID()), {
    turnId: 'test-turn',
    status: 'accepted',
  });
  const start = sent[2];
  assert.equal(start.targetClientId, owner);
  assert.equal(start.params.conversationId, chat);
  assert.deepEqual(start.params.turnStart.request.input, [
    { type: 'text', text: 'Synthetic focus request', text_elements: [] },
  ]);
  assert.equal(start.params.turnStart.context.inheritThreadSettings, true);
  assert.equal('approvalPolicy' in start.params.turnStart.request, false);
  c.close();
});
test('timeout is bounded and never retries', async (t) => {
  let count = 0;
  const file = await server(t, () => count++);
  await assert.rejects(ipc.connect(file, { timeoutMs: 30 }), /timed out/);
  assert.equal(count, 1);
});
test('abort closes a pending connection', async (t) => {
  const abort = new AbortController();
  const file = await server(t, () => abort.abort());
  await assert.rejects(ipc.connect(file, { signal: abort.signal }), /cancelled/);
});
test('wrong owner receipt is unconfirmed and never resubmitted', async (t) => {
  let starts = 0;
  const owner = crypto.randomUUID();
  const file = await server(t, (m, reply) => {
    if (m.method === 'thread-follower-start-turn') starts++;
    reply({
      type: 'response',
      requestId: m.requestId,
      method: m.method,
      resultType: 'success',
      handledByClientId: crypto.randomUUID(),
      result:
        m.method === 'initialize'
          ? { clientId: crypto.randomUUID() }
          : { result: { turn: { id: 'wrong', status: 'inProgress' } } },
    });
  });
  const c = await ipc.connect(file);
  try {
    await assert.rejects(
      c.start(crypto.randomUUID(), owner, 'test', crypto.randomUUID()),
      /exact-owner/,
    );
    assert.equal(starts, 1);
  } finally {
    c.close();
  }
});
