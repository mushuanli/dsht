/** What the startup picker shows when the host it needs is not answering.
 *
 * `dsht` deliberately never starts Harness, so an unreachable host is an operator problem with a
 * known fix. This module turns the connection's published status into a short, accurate block: the
 * state first, then the one command that resolves it. It is pure text, so the wording is testable on
 * its own and the rendering belongs to `dialogs/`.
 */

/** The command that starts the host this client talks to. */
export const HOST_COMMAND = 'npx @deepseek-ai/dsh web';

/** What the startup picker shows while the host cannot be reached. */
export interface OfflineGuidance {
  /** Which host, and which of its three states the connection published. */
  readonly title: string;
  /** What happened and what to do about it, in reading order. */
  readonly lines: readonly string[];
  /** The raw transport failure, rendered dim under the guidance rather than as the message. */
  readonly detail?: string;
}

/** The `DSH_URL` export that carries a first-run token for one host.
 *
 * `dsh web` prints its URL with a `token` parameter, and that printed line is what a first run
 * exports unchanged; a host URL that already carries query parameters keeps its own separator.
 * @param base - Host URL this client targets.
 * @returns One `export DSH_URL=…` line.
 */
export function dshUrlLine(base: string): string {
  const separator = base.includes('?') ? '&' : '?';
  const root = base.includes('?') || base.endsWith('/') ? base : `${base}/`;
  return `export DSH_URL='${root}${separator}token=<token>'`;
}

/** Build the startup guidance for one connection state.
 *
 * The first attempt is named as connecting rather than as offline: a client that has not finished
 * trying yet has not learned that anything is wrong, and saying "offline" then would be a guess.
 * @param source - Published connection status, host URL and last failure.
 * @returns The guidance block; never empty, because the caller renders it only while offline.
 */
export function offlineGuidance(source: { status: string; base: string; lastFailure?: string }): OfflineGuidance {
  const { base, status } = source;
  const detail = source.lastFailure === undefined || source.lastFailure === '' ? undefined : source.lastFailure;
  const url = dshUrlLine(base);
  if (status === 'Login required') {
    return { title: `Login required · ${base}`, lines: [
      'No token was given, or the saved cookie no longer works.',
      'Start the host and export the URL it prints, then run dsht again:',
      `  ${url}`,
      'Or export DSH_TOKEN. Tokens are never saved.',
    ], ...(detail === undefined ? {} : { detail }) };
  }
  if (status === 'Connecting…') {
    return { title: `Connecting… · ${base}`, lines: [
      'Waiting for DeepSeek Harness at that address.',
      'If nothing is listening yet, start it there:',
      `  ${HOST_COMMAND}`,
      'First run only, point dsht at the URL it prints:',
      `  ${url}`,
    ], ...(detail === undefined ? {} : { detail }) };
  }
  return { title: `Host offline · ${base}`, lines: [
    'DeepSeek Harness is not answering yet.',
    'Start it on that host; this screen reconnects by itself:',
    `  ${HOST_COMMAND}`,
    'First run only, point dsht at the URL it prints:',
    `  ${url}`,
  ], ...(detail === undefined ? {} : { detail }) };
}
