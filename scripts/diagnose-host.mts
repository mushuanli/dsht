/**
 * Diagnose one host's wire shapes before or after adapting to it.
 *
 * `dsht` decodes only the fields it reads and treats a wrong *envelope* as a protocol error, so the
 * first question after a host upgrade is "which value is not the JSON type this client assumes?".
 * This script asks the host directly, without a UI and without writing anything:
 *
 * ```
 * npm run diagnose:host                      # uses DSH_URL or the saved cookie for 127.0.0.1:3080
 * npm run diagnose:host -- <sessionId>       # also inspects that session's history records
 * ```
 *
 * It prints, per endpoint, the JSON type of the value the host returns; the projection keys whose
 * values are not objects; and the distribution of `surfaceOp` values in real history records — the
 * shape that changed in `dsh` 0.2 and broke the transcript. Nothing is mutated: every call is a read,
 * and the two streams are cancelled as soon as their opening frame arrives.
 */
import { Client } from '../src/transport/client.ts';
import { CookieStore, login } from '../src/transport/auth.ts';
import { controlFrame } from '../src/transport/events.ts';
import { surfaceOpOf } from '../src/transport/dsh-contract.ts';
import { HOST_ENDPOINTS, HOST_ENDPOINT_NAMES } from '../src/transport/endpoints.ts';
import { follow } from '../src/transport/dsh.ts';
import type { Json, ObjectValue } from '../src/transport/wire.ts';

/**
 * The read-only endpoints this script probes, with the argument each needs.
 *
 * Only the probe arguments live here: the endpoint *names* come from the capability table, so this
 * script cannot drift into a second list of capabilities. Every key must be a row there, which the
 * assertion below enforces before anything is called.
 */
const PROBES: readonly { endpoint: string; args: ObjectValue; needs?: 'session' }[] = [
  { endpoint: 'session/list', args: { _request: {} } },
  { endpoint: 'session/modelCatalog', args: {} },
  { endpoint: 'agentPresets/list', args: {} },
  { endpoint: 'session/search', args: { request: { query: 'a' } } },
  { endpoint: 'fileReferences/list', args: { agentId: '', query: 'pack' }, needs: 'session' },
];
for (const probe of PROBES) {
  if (!HOST_ENDPOINT_NAMES.has(probe.endpoint)) throw new Error(`${probe.endpoint} is not a row in transport/endpoints.ts`);
}

/** The JSON type of one value, in the vocabulary the decoders use. */
function typeOf(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

const store = new CookieStore(undefined);
const client = new Client(process.env.DSH_URL ?? 'http://127.0.0.1:3080');
console.log(`host ${client.base}`);
try {
  await login(client, process.env.DSH_TOKEN, store);
} catch (error) {
  console.error(`Login failed: ${(error as Error).message}`);
  process.exit(1);
}
await client.connect();

/** A value worth reporting as "not an object" even though a decoder may accept it. */
const notable: string[] = [];
const sessions = await client.listSessions();
const requested = process.argv[2];
const sessionId = requested ?? sessions.find(row => !row.running)?.sessionId ?? sessions[0]?.sessionId;

console.log(`\nRPC values (${sessions.length} sessions visible, ${HOST_ENDPOINTS.length} capabilities in the table)`);
for (const { endpoint, args, needs } of PROBES) {
  if (needs === 'session' && sessionId === undefined) continue;
  const resolved = needs === 'session'
    ? JSON.parse(JSON.stringify(args).replaceAll('""', JSON.stringify(sessionId)) as string) as ObjectValue
    : args;
  try {
    const value = await client.call(endpoint, resolved, undefined, null);
    console.log(`  ${endpoint.padEnd(22)} ${typeOf(value).padEnd(7)} ${JSON.stringify(value)?.slice(0, 90) ?? ''}`);
    if (typeOf(value) !== 'object' && typeOf(value) !== 'absent') notable.push(`${endpoint} → ${typeOf(value)}`);
  } catch (error) { console.log(`  ${endpoint.padEnd(22)} error   ${(error as Error).message.slice(0, 90)}`); }
}

if (sessionId !== undefined) {
  console.log('\nControl baseline');
  await new Promise<void>(resolve => {
    const sub = client.subscribe('session/control', {}, {
      item: value => {
        try {
          const frame = controlFrame(value);
          if (frame.kind !== 'baseline') return;
          console.log(`  sections   projections=${frame.projections.size} queues=${frame.queues.size} jobs=${frame.jobs.size}`);
          const values = new Map<string, string>();
          for (const snapshot of frame.projections.values()) {
            for (const [key, entry] of Object.entries(snapshot.values)) values.set(key, typeOf(entry));
          }
          const scalars = [...values].filter(([, type]) => type !== 'object').map(([key, type]) => `${key}=${type}`);
          console.log(`  value keys ${values.size}; not objects: ${scalars.join(', ') || 'none'}`);
          for (const entry of scalars) notable.push(`projections.${entry}`);
        } catch (error) { console.log(`  error      ${(error as Error).message.slice(0, 90)}`); }
        sub.cancel(); resolve();
      },
      end: error => { console.log(`  end        ${error?.message ?? 'closed'}`); resolve(); },
    });
    setTimeout(() => { sub.cancel(); resolve(); }, 10_000);
  });

  console.log('\nHistory records');
  const surfaceOps = new Map<string, number>();
  const records = await new Promise<readonly Json[]>((resolve, reject) => {
    const sub = follow(client, { address: { kind: 'session', sessionId }, maxMessages: 80 }, {
      frame: frame => { if (frame.kind === 'snapshot') { sub.cancel(); resolve(frame.snapshot.records); } },
      invalid: error => { sub.cancel(); reject(error); },
      end: error => { sub.cancel(); reject(error ?? new Error('stream ended')); },
    });
    setTimeout(() => { sub.cancel(); reject(new Error('timed out')); }, 10_000);
  }).catch(error => { console.log(`  error      ${(error as Error).message.slice(0, 90)}`); return [] as readonly Json[]; });
  for (const record of records) {
    const event = (record as { event?: ObjectValue }).event;
    if (event === undefined) continue;
    // Only display records carry a surface operation; everything else has none by design.
    const display = ['user/message', 'assistant/message', 'tool/result'].includes(String(event.type));
    if (!display) {
      surfaceOps.set(`${String(event.type)} (no surface operation)`, (surfaceOps.get(`${String(event.type)} (no surface operation)`) ?? 0) + 1);
      continue;
    }
    const op = surfaceOpOf(event.surfaceOp);
    const label = op === undefined ? `unknown ${JSON.stringify(event.surfaceOp)?.slice(0, 40) ?? 'absent'}` : op.op;
    surfaceOps.set(`${String(event.type)} ${label}`, (surfaceOps.get(`${String(event.type)} ${label}`) ?? 0) + 1);
    if (event.data === undefined && ['user/message', 'assistant/message', 'tool/result'].includes(String(event.type))) {
      notable.push(`record ${String(event.type)} seq=${String(event.seq)} has no data`);
    }
  }
  for (const [key, count] of [...surfaceOps].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(count).padStart(4)} ${key}`);
  }
  console.log(`  ${records.length} records in the opening snapshot`);
}

console.log('\nNot objects (decoders must tolerate these)');
for (const line of notable.length ? notable : ['none']) console.log(`  ${line}`);
await client.close();
