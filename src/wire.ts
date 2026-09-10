/** JSON validation and terminal-safe presentation at the remote boundary. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };

/** Require an object from a decoded wire message. */
export function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object from the server');
  }
  return value as ObjectValue;
}

/** Require a string field rather than silently accepting protocol drift. */
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string from the server');
  return value;
}

/** Require an array field from the server. */
export function array(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new Error('Expected an array from the server');
  return value as Json[];
}

/** Remove terminal controls from remote text while retaining line breaks and tabs. */
export function safeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** Return a displayable error without serializing request headers or credentials. */
export function errorText(error: unknown): string {
  return safeText(error instanceof Error ? error.message : String(error));
}
