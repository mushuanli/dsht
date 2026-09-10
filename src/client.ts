/** Cookie-authenticated HTTP RPC and one multiplexed WebSocket; imports no Harness code. */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { array, object, string, type Json, type ObjectValue } from './wire.ts';

/** Host business failure, including the original machine-readable details. */
export class RemoteError extends Error {
  readonly code: string;
  readonly details: Json | undefined;
  constructor(value: unknown) {
    const error = object(value);
    super(`${string(error.code)}: ${string(error.message)}`);
    this.code = string(error.code);
    this.details = error.details;
  }
}

/** A logical stream owns its callback registration until cancellation or termination. */
export interface Subscription {
  cancel(): void;
}
interface Listener {
  item(value: Json | undefined): void;
  end(error?: Error): void;
}

/** A single authenticated host connection; close before reconnecting or exiting. */
export class Client {
  readonly base: URL;
  private cookie = '';
  private socket: WebSocket | undefined;
  private listeners = new Map<string, Listener>();
  private lifetime = new AbortController();
  constructor(base: string, readonly timeoutMs = 15_000) {
    this.base = new URL(base);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password
      || this.base.pathname !== '/' || this.base.search || this.base.hash) {
      throw new Error('Server URL must be an HTTP(S) origin without token, path, or credentials');
    }
  }

  /** Exchange a startup token only at GET /; the cookie is kept in memory. */
  async authenticate(token: string): Promise<void> {
    const url = new URL('/', this.base);
    url.searchParams.set('token', token);
    const response = await fetch(url, { redirect: 'manual', signal: this.signal() });
    if (response.status !== 303) throw new Error(`Authentication failed (HTTP ${response.status})`);
    this.cookie = response.headers.getSetCookie()
      .map(value => value.split(';')[0]!).filter(value => value.startsWith('dsh-auth-')).join('; ');
    await response.body?.cancel();
    if (!this.cookie) throw new Error('Authentication response omitted the dsh-auth cookie');
  }

  /** Invoke an exact endpoint once. Mutations are never automatically retried. */
  async call(endpoint: string, args: ObjectValue = {}): Promise<Json | undefined> {
    if (!/^[\w$-]+\/[\w$-]+$/.test(endpoint)) throw new Error('Invalid RPC endpoint');
    const rpcId = randomUUID();
    const response = await fetch(new URL(`/api/${endpoint}`, this.base), {
      method: 'POST', redirect: 'error', signal: this.signal(),
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    });
    if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
    const body = object(await response.json());
    if (body.type !== 'server-response' || body.rpcId !== rpcId) throw new Error('RPC response identity mismatch');
    const result = object(body.result);
    if (result.ok === false) throw new RemoteError(result.error);
    if (result.ok !== true) throw new Error('Malformed RPC result');
    return result.value;
  }

  /** Connect the physical mux. A disconnected instance may reconnect with its cookie. */
  async connect(): Promise<void> {
    if (this.socket) throw new Error('Mux is already connected');
    const url = new URL('/api/remote.mux', this.base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { cookie: this.cookie }, handshakeTimeout: this.timeoutMs });
    this.socket = socket;
    socket.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error('Unexpected binary mux frame');
        const frame = object(JSON.parse(raw.toString()));
        const id = string(frame.streamId);
        if (!['item', 'end', 'error'].includes(string(frame.type))) throw new Error('Invalid mux frame type');
        const listener = this.listeners.get(id);
        if (!listener) return;
        if (frame.type === 'item') {
          try { listener.item(frame.value); }
          catch (error) {
            this.listeners.delete(id);
            socket.send(JSON.stringify({ type: 'cancel', streamId: id }));
            this.finish(listener, error instanceof Error ? error : new Error('Stream callback failed'));
          }
        }
        else {
          this.listeners.delete(id);
          this.finish(listener, frame.type === 'error' ? new RemoteError(frame.error) : undefined);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Invalid mux frame'));
        socket.terminate();
      }
    });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      this.fail(new Error('Connection closed'));
    });
    await once(socket, 'open');
  }

  /** Subscribe on the existing mux; each subscription has a fresh stream identity. */
  subscribe(endpoint: string, args: ObjectValue, listener: Listener): Subscription {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('Mux is not connected');
    const streamId = randomUUID();
    this.listeners.set(streamId, listener);
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    return { cancel: () => {
      if (!this.listeners.delete(streamId)) return;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }));
    } };
  }

  /** List workspaces by consuming and cancelling the authoritative opening baseline. */
  async listWorkspaces(): Promise<ObjectValue[]> {
    return new Promise((resolve, reject) => {
      let sub: Subscription;
      const timer = setTimeout(() => { sub.cancel(); reject(new Error('Workspace baseline timed out')); }, this.timeoutMs);
      try { sub = this.subscribe('workspace/follow', {}, {
        item: value => {
          clearTimeout(timer);
          sub.cancel();
          try {
            const frame = object(value);
            if (frame.type !== 'baseline') throw new Error('Workspace stream omitted its baseline');
            resolve(array(object(frame.value).items).map(object));
          } catch (error) { reject(error); }
        },
        end: error => { clearTimeout(timer); reject(error ?? new Error('Workspace stream ended before baseline')); },
      }); } catch (error) { clearTimeout(timer); reject(error); }
    });
  }

  /** List visible sessions, optionally filtering by the workspace's accounted IDs. */
  async listSessions(workspaceId?: string): Promise<ObjectValue[]> {
    const sessions = array(object(await this.call('session/list', { _request: {} })).items).map(object);
    if (!workspaceId) return sessions;
    const workspace = (await this.listWorkspaces()).find(item => item.workspaceId === workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const ids = new Set(array(workspace.sessionIds).map(string));
    return sessions.filter(item => ids.has(string(item.sessionId)));
  }

  /** Close all streams, abort in-flight HTTP, and await the physical socket's closure. */
  async close(): Promise<void> {
    this.lifetime.abort();
    const socket = this.socket;
    this.socket = undefined;
    this.fail(new Error('Client closed'));
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
      socket.terminate();
      await closed;
    }
  }

  private signal(): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)]);
  }
  private fail(error: Error): void {
    const listeners = [...this.listeners.values()];
    this.listeners.clear();
    for (const listener of listeners) this.finish(listener, error);
  }
  private finish(listener: Listener, error?: Error): void {
    try { listener.end(error); } catch { /* Termination callbacks cannot prevent other streams from closing. */ }
  }
}
