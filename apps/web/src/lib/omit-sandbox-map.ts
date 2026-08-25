export function omitSandboxMap<T extends Record<string, unknown>>(
  metadata: T,
): T {
  const sanitized = { ...metadata };
  delete sanitized.sandboxMap;
  return sanitized as T;
}
