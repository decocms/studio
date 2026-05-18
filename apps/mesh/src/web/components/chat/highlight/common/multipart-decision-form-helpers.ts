/**
 * Pure helpers for multipart decision forms — no React, no react-hook-form.
 * Composed by `useMultiPartDecisionForm` and unit-tested in isolation.
 */

export function findIndexByKey<T>(
  parts: T[],
  partKey: (p: T) => string,
  key: string,
): number {
  return parts.findIndex((p) => partKey(p) === key);
}

export function isAllAnswered<T>(
  parts: T[],
  partKey: (p: T) => string,
  values: Record<string, unknown>,
  hasAnswer: (v: unknown) => boolean,
): boolean {
  if (parts.length === 0) return false;
  return parts.every((p) => hasAnswer(values[partKey(p)]));
}

/**
 * Find the next unanswered part after `fromKey`. Wraps around the part list
 * but skips `fromKey` itself. Returns null if every part is answered.
 */
export function findNextUnansweredKey<T>(
  parts: T[],
  partKey: (p: T) => string,
  values: Record<string, unknown>,
  hasAnswer: (v: unknown) => boolean,
  fromKey: string,
): string | null {
  if (parts.length === 0) return null;
  const fromIdx = findIndexByKey(parts, partKey, fromKey);
  const start = fromIdx >= 0 ? fromIdx : -1;
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts[(start + i) % parts.length];
    if (!candidate) continue;
    const key = partKey(candidate);
    if (key === fromKey) continue;
    if (!hasAnswer(values[key])) return key;
  }
  return null;
}

export function canSubmit(opts: {
  isStreaming: boolean;
  allAnswered: boolean;
}): boolean {
  return !opts.isStreaming && opts.allAnswered;
}
