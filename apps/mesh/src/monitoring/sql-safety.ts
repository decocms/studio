const UNSAFE_PATTERN = /['";)(\\]|--/;

/**
 * Validate a JSONPath string for use in DuckDB SQL queries.
 * Throws if the path contains SQL injection characters.
 *
 * Safe: "$.usage.total_tokens", "result", "$.key_name"
 * Unsafe: "$.key'", "$.key; DROP TABLE", "$.key) OR 1=1"
 */
export function assertSafeJsonPath(path: string): void {
  if (UNSAFE_PATTERN.test(path)) {
    throw new Error(`Invalid JSONPath: contains unsafe characters: ${path}`);
  }
}

/**
 * Validate a property key for use in DuckDB JSON extraction queries.
 * Throws if the key contains SQL injection characters.
 */
export function assertSafeIdentifier(key: string): void {
  if (UNSAFE_PATTERN.test(key)) {
    throw new Error(`Invalid identifier: contains unsafe characters: ${key}`);
  }
}
