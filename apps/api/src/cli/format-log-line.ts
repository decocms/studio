/**
 * Format the variadic arguments of a `console.*` call into a single log line
 * (no trailing newline). Mirrors console's space-joining; non-string args are
 * coerced with `String()`. Used to tee intercepted parent console output into
 * the `deco link` log file.
 */
export function formatLogLine(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
}
