'use strict';
// Version-gated local transport. No server, subprocess, retries or transcript reads.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const VERSION = '26.5917.51856';
const MAX_FRAME = 2 * 1024 * 1024;
function endpoint(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  if (process.platform !== 'darwin') return null;
  const uid = process.getuid?.();
  for (const file of [
    path.join(home, 'ipc', 'ipc.sock'),
    path.join(os.tmpdir(), 'codex-ipc', `ipc-${uid}.sock`),
  ]) {
    try {
      const dir = fs.lstatSync(path.dirname(file)),
        socket = fs.lstatSync(file);
      if (
        uid != null &&
        dir.isDirectory() &&
        dir.uid === uid &&
        !(dir.mode & 0o077) &&
        socket.isSocket() &&
        socket.uid === uid &&
        !(socket.mode & 0o077)
      )
        return file;
    } catch {}
  }
  return null;
}
function supported(vscode) {
  return vscode.extensions?.getExtension('openai.chatgpt')?.packageJSON?.version === VERSION;
}
async function connect(file, { timeoutMs = 7000, signal } = {}) {
  const socket = net.createConnection(file);
  let buffer = Buffer.alloc(0),
    clientId = 'initializing-client',
    closed = false;
  const pending = new Map();
  function close(error = new Error('Direct connection closed.')) {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
    socket.destroy();
    buffer = Buffer.alloc(0);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }
  const abort = () => close(new Error('Direct connection cancelled.'));
  const deadline = setTimeout(() => close(new Error('Direct connection timed out.')), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  function write(message) {
    if (closed) throw new Error('Direct connection closed.');
    const body = Buffer.from(JSON.stringify(message)),
      header = Buffer.alloc(4);
    if (body.length > 16384) throw new Error('Direct request exceeds the size limit.');
    header.writeUInt32LE(body.length);
    socket.write(Buffer.concat([header, body]));
  }
  function request(method, params, version, targetClientId) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new Error('Direct connection closed.'));
      const requestId = crypto.randomUUID();
      pending.set(requestId, { resolve, reject, method });
      try {
        write({
          type: 'request',
          requestId,
          sourceClientId: clientId,
          method,
          params,
          version,
          targetClientId,
          timeoutMs: 5000,
        });
      } catch (error) {
        pending.delete(requestId);
        reject(error);
      }
    });
  }
  socket.on('error', () => close(new Error('Direct connection unavailable.')));
  socket.on('close', () => close());
  socket.on('data', (chunk) => {
    try {
      if (buffer.length + chunk.length > MAX_FRAME + 4)
        throw new Error('Direct response exceeds the size limit.');
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0);
        if (!size || size > MAX_FRAME) throw new Error('Invalid direct response frame.');
        if (buffer.length < size + 4) break;
        const message = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
        buffer = buffer.subarray(size + 4);
        if (message.type === 'client-discovery-request') {
          write({
            type: 'client-discovery-response',
            requestId: message.requestId,
            response: { canHandle: false },
          });
        } else if (message.type === 'response') {
          const item = pending.get(message.requestId);
          if (!item) continue;
          pending.delete(message.requestId);
          if (message.resultType !== 'success')
            item.reject(new Error('Provider did not confirm delivery.'));
          else if (message.method !== item.method)
            item.reject(new Error('Direct response method mismatch.'));
          else item.resolve(message);
        }
        // Unsolicited broadcasts are discarded, never retained or sent to the webview.
      }
    } catch (error) {
      close(error);
    }
  });
  try {
    if (signal?.aborted) abort();
    const initial = await request('initialize', { clientType: 'agent-monitor' }, 0);
    if (!UUID.test(initial.result?.clientId || ''))
      throw new Error('Invalid direct client identity.');
    clientId = initial.result.clientId;
    return {
      close,
      async owner(conversationId) {
        if (!UUID.test(conversationId)) throw new Error('Invalid chat identity.');
        const response = await request(
          'thread-owner-discovery',
          { hostId: 'local', conversationId },
          1,
        );
        if (!UUID.test(response.handledByClientId || '')) throw new Error('No exact chat owner.');
        return response.handledByClientId;
      },
      async start(conversationId, owner, text, requestId) {
        if (
          !UUID.test(conversationId) ||
          !UUID.test(owner) ||
          !UUID.test(requestId) ||
          typeof text !== 'string' ||
          !text ||
          text.length > 4096
        )
          throw new Error('Invalid direct submission.');
        const response = await request(
          'thread-follower-start-turn',
          {
            conversationId,
            turnStart: {
              request: {
                threadId: conversationId,
                input: [{ type: 'text', text, text_elements: [] }],
                clientUserMessageId: requestId,
              },
              context: { inheritThreadSettings: true, attachments: [], commentAttachments: [] },
            },
          },
          2,
          owner,
        );
        const turn = response.result?.result?.turn;
        if (
          response.handledByClientId !== owner ||
          !turn ||
          typeof turn.id !== 'string' ||
          !turn.id ||
          !['inProgress', 'completed'].includes(turn.status)
        )
          throw new Error('Provider did not return an exact-owner turn receipt.');
        return { turnId: turn.id, status: 'accepted' };
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
module.exports = { VERSION, UUID, endpoint, supported, connect };
