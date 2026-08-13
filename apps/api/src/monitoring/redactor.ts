/**
 * PII Redaction Interface and Implementations
 *
 * Provides pluggable PII redaction for monitoring logs.
 * Default implementation uses regex patterns, but can be swapped
 * with ML-based services like Microsoft Presidio.
 */

// ============================================================================
// Redactor Interface
// ============================================================================

export interface Redactor {
  /**
   * Redact PII from any data structure (objects, arrays, primitives)
   */
  redact(data: unknown): unknown;

  /**
   * Redact PII from a string
   */
  redactString(text: string): string;
}

// ============================================================================
// Regex-Based Redactor (Default Implementation)
// ============================================================================

// Redaction types in match-precedence order. A single combined regex (below)
// scans the string ONCE; the first alternative to match at a position wins —
// replacing the old per-type sequential `replace()` loop, which walked the
// whole (up-to-64KB) string five times per emit and showed up in event-loop
// stalls. Named groups carry the type label through to the replacement.
const REDACTION_TYPES = [
  "jwt",
  "api_key",
  "email",
  "credit_card",
  "ssn",
] as const;

// The email lookbehind keeps this linear. Without it the local part retried at
// every offset inside a run of local-part characters, and each retry scanned to
// the end of the run looking for "@" — quadratic, so one 64KB payload cost
// seconds on the synchronous emit path. Since the local part is greedy over a
// contiguous class, a match reachable from an inner offset is always reachable
// from the run's first character, so anchoring the start loses no match.
const COMBINED_PII_REGEX = new RegExp(
  [
    `(?<jwt>eyJ[A-Za-z0-9-_]+\\.eyJ[A-Za-z0-9-_]+\\.[A-Za-z0-9-_.+/=]*)`,
    `(?<api_key>(?:api[_-]?key|token|secret|password|bearer)\\s*[:=]\\s*['"]?[\\w-]{16,}['"]?)`,
    `(?<email>(?<![a-zA-Z0-9._%+-])[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})`,
    `(?<credit_card>\\b\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b)`,
    `(?<ssn>\\b\\d{3}-\\d{2}-\\d{4}\\b)`,
  ].join("|"),
  "gi",
);

export class RegexRedactor implements Redactor {
  redact(data: unknown): unknown {
    if (data === null || data === undefined) {
      return data;
    }

    // Handle strings
    if (typeof data === "string") {
      return this.redactString(data);
    }

    // Handle arrays
    if (Array.isArray(data)) {
      return data.map((item) => this.redact(item));
    }

    // Handle objects
    if (typeof data === "object") {
      const redacted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        // Redact both key and value
        const redactedKey = this.redactString(key);
        redacted[redactedKey] = this.redact(value);
      }
      return redacted;
    }
    // Return primitives as-is (numbers, booleans, etc.)
    return data;
  }

  redactString(text: string): string {
    return text.replace(COMBINED_PII_REGEX, (match, ...args) => {
      const groups = args[args.length - 1] as
        | Record<string, string | undefined>
        | undefined;
      if (groups) {
        for (const type of REDACTION_TYPES) {
          if (groups[type] != null) return `[REDACTED:${type}]`;
        }
      }
      return match;
    });
  }
}
