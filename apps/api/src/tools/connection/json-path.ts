export const prop = (path: string, object: unknown): unknown => {
  if (object === null || object === undefined) {
    return undefined;
  }

  // Split path into parts, handling both dot notation and bracket notation
  // e.g., "CONFIG[0].items[1].name" -> ["CONFIG", "0", "items", "1", "name"]
  const parts = path
    .replace(/\[(\w+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  let current: unknown = object;

  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
};
