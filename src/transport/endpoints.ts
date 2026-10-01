/**
 * Every host capability this client may reach.
 *
 * One row per endpoint, naming the module that reads its value and how a wrong shape is treated. It is
 * the only list of endpoint names in the source: `tests/transport/endpoints.test.ts` fails when a call
 * site reaches an endpoint that is missing here, when a row names a reader the module does not export,
 * or when a row survives an endpoint nothing calls any more, and `scripts/diagnose-host.mts` probes
 * exactly these rows instead of inventing its own list.
 *
 * The facade in `dsh.ts` owns arguments and round trips; this table owns vocabulary and posture.
 */

/** How the value of one endpoint is read.
 *
 * `structured` is a value the caller acts on, so protocol drift throws; `rows` is display data, so one
 * odd row degrades instead of emptying a list; `void` is a write whose receipt is checked but whose
 * value carries no data; `raw` is not an RPC value at all (the export ZIP); `stream` is a subscription
 * whose items are decoded frame by frame.
 */
export type EndpointPosture = 'structured' | 'rows' | 'void' | 'raw' | 'stream';

/** One endpoint, its readers, and what a wrong shape means. */
export interface HostEndpoint {
  /** Endpoint as the host names it; `session.export` is the one raw HTTP path. */
  readonly endpoint: string;
  /** Module exporting the readers. */
  readonly owner: 'contract' | 'events' | 'none';
  /** Exported reader functions, in the order they are applied. Empty when the value is not read. */
  readonly readers: readonly string[];
  readonly posture: EndpointPosture;
}

/** The capability table. Adding a host call means adding a row here and a facade function in `dsh.ts`. */
export const HOST_ENDPOINTS: readonly HostEndpoint[] = [
  { endpoint: 'session/list', owner: 'contract', readers: ['sessionRows'], posture: 'rows' },
  { endpoint: 'session/search', owner: 'contract', readers: ['searchResult'], posture: 'structured' },
  { endpoint: 'session/create', owner: 'contract', readers: ['sessionCreated'], posture: 'structured' },
  { endpoint: 'session/selectModel', owner: 'contract', readers: ['modelSelected'], posture: 'structured' },
  { endpoint: 'session/modelCatalog', owner: 'contract', readers: ['modelCatalog'], posture: 'structured' },
  { endpoint: 'session/rename', owner: 'none', readers: [], posture: 'void' },
  { endpoint: 'session/prompt', owner: 'contract', readers: ['accepted'], posture: 'void' },
  { endpoint: 'session/cancel', owner: 'contract', readers: ['accepted'], posture: 'void' },
  { endpoint: 'session/updateQueue', owner: 'contract', readers: ['accepted'], posture: 'void' },
  { endpoint: 'session/page', owner: 'contract', readers: ['pageResult'], posture: 'structured' },
  { endpoint: 'session/follow', owner: 'contract', readers: ['followFrame'], posture: 'stream' },
  { endpoint: 'session/control', owner: 'events', readers: ['controlFrame'], posture: 'stream' },
  { endpoint: 'session.export', owner: 'none', readers: [], posture: 'raw' },
  { endpoint: 'workspace/create', owner: 'contract', readers: ['workspaceCreated'], posture: 'structured' },
  { endpoint: 'workspace/delete', owner: 'contract', readers: ['workspaceDeleted'], posture: 'structured' },
  { endpoint: 'workspace/archiveSession', owner: 'contract', readers: ['archivedSessions'], posture: 'structured' },
  { endpoint: 'workspace/follow', owner: 'contract', readers: ['workspaceBaseline'], posture: 'stream' },
  { endpoint: 'agentPresets/list', owner: 'contract', readers: ['presetRows'], posture: 'rows' },
  { endpoint: 'fileReferences/list', owner: 'contract', readers: ['fileReferenceCandidates'], posture: 'rows' },
  { endpoint: 'commands/execute', owner: 'contract', readers: ['commandExecution'], posture: 'structured' },
  { endpoint: '$events', owner: 'events', readers: ['readyClientId', 'hostEvent'], posture: 'stream' },
  { endpoint: '$events/result', owner: 'none', readers: [], posture: 'void' },
];

/** Endpoint names, for the guards that keep the source and this table in step. */
export const HOST_ENDPOINT_NAMES: ReadonlySet<string> = new Set(HOST_ENDPOINTS.map(row => row.endpoint));
