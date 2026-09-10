/** Loopback wire fixture; each test atomically owns its server and closes every socket. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { array, object, type ObjectValue } from '../src/wire.ts';

export const workspace = { workspaceId: 'w1', title: 'Project α', path: '/host/project', sessionIds: ['s1'] };
export const session = { sessionId: 's1', running: false, projections: { values: { title: 'First conversation' } } };
export const snapshot = { type: 'snapshot', cursor: 0, hasMore: false, header: { id: 's1' }, records: [
  { type: 'event', event: { seq: 0, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: '你好' }] } } },
], assistantStream: { revision: 0 } };

export async function host() {
  const calls: ObjectValue[] = [];
  const opens: ObjectValue[] = [];
  const cancels: ObjectValue[] = [];
  const sockets = new Set<WebSocket>();
  const events = new Map<WebSocket, string>();
  let replayInteractions: ObjectValue[] = [];
  const controls = new Map<WebSocket, string>();
  let controlAvailable = true;
  const failFollow = new Set<string>();
  let subagent: ObjectValue | undefined;
  let subagentMode: 'one-shot' | 'continuable' = 'continuable';
  let presets: ObjectValue[] = ['standard', 'ptc', 'minimal', 'cordis'].map(id => ({ id, trust: 'system' }));
  let modelCatalog: ObjectValue = { groups: [], failures: [], routableProviders: ['fixture'] };
  let defaultModel: ObjectValue = { provider: 'fixture', model: 'chat' };
  let controlBaseline: ObjectValue = { queues: { s1: [] }, jobs: { s1: [] }, projections: {} };
  const follows = new Map<WebSocket, string>();
  let baseline = [workspace];
  let archivedSessionIds: string[] = [];
  let blank = false;
  let running = false;
  let onPage: (() => Promise<ObjectValue>) | undefined;
  let searchResult: ObjectValue = { items: [{ sessionId: 's1', snippet: '你好' }, { sessionId: 's2', snippet: '你好 too' }], hasMore: false };
  let followSnapshot: ObjectValue = snapshot;
  let onPrompt: (() => Promise<void>) | undefined;
  let onCancel: (() => Promise<void>) | undefined;
  let wrongIdentity = false;
  let businessError = false;
  let cookie = 'valid';
  let loginCount = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, 'http://fixture');
      if (url.pathname === '/') {
        loginCount++;
        assert.equal(request.method, 'GET');
        if (url.searchParams.get('token') !== 'fixture-token') { response.writeHead(401).end(); return; }
        response.writeHead(303, { 'set-cookie': `dsh-auth-fixture=${cookie}; HttpOnly; Path=/; SameSite=Strict; Max-Age=3600`, location: '/' }).end();
        return;
      }
      if (request.headers.cookie !== `dsh-auth-fixture=${cookie}`) { response.writeHead(401).end(); return; }
      assert.equal(request.method, 'POST');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = object(JSON.parse(raw));
      assert.equal(body.type, 'client-request');
      assert.equal(url.pathname, `/api/${body.method}`);
      assert.deepEqual(Object.keys(object(body.payload)), ['args']);
      const args = object(object(body.payload).args);
      calls.push(body);
      let value: unknown;
      switch (body.method) {
        case 'agentPresets/list': assert.deepEqual(args, {}); value = { presets, authorable: false }; break;
        case 'session/modelCatalog': assert.deepEqual(args, {}); value = { ...modelCatalog, default: defaultModel }; break;
        case 'session/selectModel': {
          const selection = object(args.request);
          assert.equal(typeof selection.sessionId, 'string');
          assert.equal(typeof selection.provider, 'string');
          assert.equal(typeof selection.model, 'string');
          value = { selected: { provider: selection.provider, model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) } }; break;
        }
        case 'fileReferences/list':
          assert.equal(args.agentId, 's1');
          assert.equal(typeof args.query, 'string');
          value = args.query === 'src/' ? [{ path: 'src/hello world.ts', kind: 'file' }]
            : args.query === 'missing' ? [] : [{ path: 'src', kind: 'directory' }, { path: 'README.md', kind: 'file' }];
          break;
        case 'session/list': assert.deepEqual(args, { _request: {} }); value = { items: [...[{ ...session, running, blank }, { sessionId: 's2', running: true }], ...subagent === undefined ? [] : [subagent]] }; break;
        case 'session/create': assert.deepEqual(args, { request: { workspaceId: 'w1' } }); value = { sessionId: 's-new' }; break;
        case 'workspace/delete': {
          const id = object(args.request).workspaceId;
          assert.equal(typeof id, 'string');
          if (!businessError) baseline = baseline.filter(row => row.workspaceId !== id);
          value = { deleted: true }; break;
        }
        case 'workspace/archiveSession': {
          const id = object(args.request).sessionId;
          assert.equal(typeof id, 'string');
          if (!businessError) archivedSessionIds = [...new Set([...archivedSessionIds, String(id)])];
          value = { archivedSessionIds }; break;
        }
        case 'workspace/create': assert.equal(typeof object(args.request).path, 'string'); value = { workspace, created: false }; break;
        case 'session/prompt': {
          const prompt = object(args.request);
          await onPrompt?.();
          assert.equal(typeof prompt.requestId, 'string');
          assert.equal(typeof prompt.sessionId, 'string');
          assert.equal(array(prompt.content).length, 1);
          value = { accepted: true }; break;
        }
        case 'session/cancel': assert.equal(typeof object(args.request).sessionId, 'string'); await onCancel?.(); value = { accepted: true }; break;
        case 'session/search': assert.equal(typeof object(args.request).query, 'string'); value = searchResult; break;
        case 'session/page': value = await onPage?.() ?? { records: [], hasMore: false }; break;
        case '$events/result': assert.equal(args.clientId, 'client-1'); value = {}; break;
        default: response.writeHead(404).end(); return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        type: 'server-response', rpcId: wrongIdentity ? 'wrong' : body.rpcId,
        result: businessError ? { ok: false, error: { code: 'session/agent-busy', message: 'busy', details: { reason: 'test' } } }
          : { ok: true, value },
      }));
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/remote.mux' || request.headers.cookie !== `dsh-auth-fixture=${cookie}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    sockets.add(ws);
    ws.on('close', () => { sockets.delete(ws); events.delete(ws); follows.delete(ws); controls.delete(ws); });
    ws.on('message', raw => {
      const frame = object(JSON.parse(raw.toString()));
      if (frame.type === 'cancel') { cancels.push(frame); return; }
      opens.push(frame);
      const item = (value: unknown) => ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value }));
      if (frame.endpoint === '$events') { events.set(ws, String(frame.streamId)); item({ type: 'ready', clientId: 'client-1', host: { home: '/host' } }); for (const frame of replayInteractions) item(frame); }
      else if (frame.endpoint === 'workspace/follow') { assert.deepEqual(object(frame.payload).args, {}); item({ type: 'baseline', value: { items: baseline, archivedSessionIds } }); }
      else if (frame.endpoint === 'session/control') {
        if (!controlAvailable) { ws.send(JSON.stringify({ type: 'error', streamId: frame.streamId, error: { code: 'gateway/method-unavailable', message: 'not installed' } })); return; }
        assert.deepEqual(object(frame.payload).args, {}); controls.set(ws, String(frame.streamId)); item({ type: 'baseline', value: controlBaseline }); }
      else if (frame.endpoint === 'session/follow') {
        const request = object(object(object(frame.payload).args).request);
        assert.equal(request.assistantStream, true);
        const address = object(request.address);
        const target = String(address.sessionId ?? address.childSessionId ?? '');
        if (failFollow.has(target)) { ws.send(JSON.stringify({ type: 'error', streamId: frame.streamId,
          error: { code: 'gateway/method-unavailable', message: 'follow failed', details: {} } })); return; }
        if (address.kind === 'subagent' && address.mode !== subagentMode) { ws.send(JSON.stringify({ type: 'error', streamId: frame.streamId,
          error: { code: 'subagent/unauthorized', message: 'subagent mode does not match the supplied address', details: {} } })); return; }
        follows.set(ws, String(frame.streamId)); item(followSnapshot);
      } else ws.send(JSON.stringify({ type: 'error', streamId: frame.streamId,
        error: { code: 'gateway/method-unavailable', message: 'unknown', details: {} } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`, calls, opens, cancels,
    set replayInteractions(value: ObjectValue[]) { replayInteractions = value; },
    set blank(value: boolean) { blank = value; },
    set onPage(value: (() => Promise<ObjectValue>) | undefined) { onPage = value; },
    set searchResult(value: ObjectValue) { searchResult = value; },
    set followSnapshot(value: ObjectValue) { followSnapshot = value; },
    set onPrompt(value: (() => Promise<void>) | undefined) { onPrompt = value; },
    set onCancel(value: (() => Promise<void>) | undefined) { onCancel = value; },
    set controlAvailable(value: boolean) { controlAvailable = value; },
    set failFollow(value: Set<string>) { failFollow.clear(); for (const id of value) failFollow.add(id); },
    set subagent(value: ObjectValue | undefined) { subagent = value; },
    set subagentMode(value: 'one-shot' | 'continuable') { subagentMode = value; },
    set presets(value: ObjectValue[]) { presets = value; },
    set modelCatalog(value: ObjectValue) { modelCatalog = value; },
    set defaultModel(value: ObjectValue) { defaultModel = value; },
    set controlBaseline(value: ObjectValue) { controlBaseline = value; },
    control(value: ObjectValue) { for (const [ws, streamId] of controls) ws.send(JSON.stringify({ type: 'item', streamId, value })); },
    get loginCount() { return loginCount; },
    set cookie(value: string) { cookie = value; },
    set baseline(value: typeof baseline) { baseline = value; },
    set wrongIdentity(value: boolean) { wrongIdentity = value; },
    set businessError(value: boolean) { businessError = value; },
    emit(value: ObjectValue) {
      if (value.type === 'emit' && value.event === 'api-session/status' && array(value.args)[0] === 's1') running = array(value.args)[1] === true;
      for (const [ws, streamId] of events) ws.send(JSON.stringify({ type: 'item', streamId, value })); },
    follow(value: ObjectValue) { for (const [ws, streamId] of follows) ws.send(JSON.stringify({ type: 'item', streamId, value })); },
    disconnect() { for (const ws of sockets) ws.terminate(); },
    async close() {
      for (const ws of sockets) ws.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

/** Poll observable state with a bounded deadline, never assume readiness from a fixed delay. */
export async function until(condition: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
