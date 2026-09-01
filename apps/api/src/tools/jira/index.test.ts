import { describe, expect, it } from "bun:test";
import { JIRA_INTEGRATION_UPSERT } from "./index";

/**
 * Regression: statusMapping had no bound on lane count, statuses per lane,
 * or status-name length — an unbounded jsonb column any org member could
 * grow, re-read by every ~10-minute sync tick.
 */
describe("JIRA_INTEGRATION_UPSERT statusMapping bounds", () => {
  const base = { apiToken: "t", email: "e@example.com", siteUrl: "s" };

  it("rejects more lanes than the cap", () => {
    const statusMapping = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`lane${i}`, ["Done"]]),
    );
    const result = JIRA_INTEGRATION_UPSERT.inputSchema.safeParse({
      ...base,
      statusMapping,
    });
    expect(result.success).toBe(false);
  });

  it("rejects more statuses per lane than the cap", () => {
    const result = JIRA_INTEGRATION_UPSERT.inputSchema.safeParse({
      ...base,
      statusMapping: { Done: Array.from({ length: 101 }, (_, i) => `s${i}`) },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized status name", () => {
    const result = JIRA_INTEGRATION_UPSERT.inputSchema.safeParse({
      ...base,
      statusMapping: { Done: ["x".repeat(201)] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a mapping at the caps", () => {
    const statusMapping = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `lane${i}`,
        Array.from({ length: 100 }, (_, j) => `s${i}-${j}`),
      ]),
    );
    const result = JIRA_INTEGRATION_UPSERT.inputSchema.safeParse({
      ...base,
      statusMapping,
    });
    expect(result.success).toBe(true);
  });
});
