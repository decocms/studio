import { describe, expect, test } from "bun:test";
import { hasHostedExecutionAuthority } from "./hosted-execution-authority";

describe("hasHostedExecutionAuthority", () => {
  test("accepts a claimed thread without a hosted tombstone", () => {
    expect(
      hasHostedExecutionAuthority({
        routing_locked_at: "2026-08-04T12:00:00.000Z",
        hosted_execution_disabled_at: null,
      }),
    ).toBe(true);
  });

  test("rejects missing, pristine, and tombstoned threads", () => {
    expect(hasHostedExecutionAuthority(null)).toBe(false);
    expect(hasHostedExecutionAuthority(undefined)).toBe(false);
    expect(
      hasHostedExecutionAuthority({
        routing_locked_at: null,
        hosted_execution_disabled_at: null,
      }),
    ).toBe(false);
    expect(
      hasHostedExecutionAuthority({
        routing_locked_at: "2026-08-04T12:00:00.000Z",
        hosted_execution_disabled_at: "2026-08-04T12:01:00.000Z",
      }),
    ).toBe(false);
  });
});
