export function stripServerManagedMetadata<T extends Record<string, unknown>>(
  metadata: T | null | undefined,
): Omit<T, "sandboxMap"> | null | undefined {
  if (!metadata) return metadata;
  const sanitized = { ...metadata };
  delete sanitized.sandboxMap;
  return sanitized;
}
