/** Resolve the host URL and startup token from the command line and environment. */

/** Bare host URL plus the startup token that applies to it. */
export interface Endpoint {
  readonly url: string;
  readonly token: string | undefined;
}

/**
 * Split an optional `token` query parameter from the host URL.
 *
 * `dsh web` prints its URL with that parameter, so the printed line can be exported as
 * `DSH_URL` unchanged. The token is never written to disk; only the resulting cookie is.
 * @param url - Host URL, with or without a `token` query parameter.
 * @param token - `DSH_TOKEN` value, which takes precedence over the URL parameter.
 * @returns The URL without its `token` parameter and the effective startup token.
 */
export function endpoint(url: string, token: string | undefined): Endpoint {
  const parsed = new URL(url);
  const fromUrl = parsed.searchParams.get('token');
  parsed.searchParams.delete('token');
  return { url: parsed.href, token: token || fromUrl || undefined };
}
