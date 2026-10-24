/**
 * mv3c native Mongo search: only literal, length-bounded substrings.
 * No user-provided regular expression is evaluated.
 */
export function createLiteralSearchRegex(query: string): RegExp {
  const input = String(query).trim().slice(0, 120);
  const literal = [...input].map((char) =>
    '\\.^$*+?()[]{}|'.includes(char) ? '\\' + char : char,
  ).join('');
  return new RegExp(literal || '(?!)', 'i');
}

/** The native backend must never widen an arbitrary Meili filter. */
export function extractNativeSearchUser(filter: unknown): string | null {
  if (typeof filter !== 'string') return null;
  const match = /^user = ("(?:\\.|[^"\\])*")$/.exec(filter);
  if (!match) return null;
  try {
    const user = JSON.parse(match[1]) as unknown;
    return typeof user === 'string' && /^[a-f0-9]{24}$/i.test(user) ? user : null;
  } catch {
    return null;
  }
}
