import { describe, test, expect } from "bun:test";
import { registerTestHooks, testState } from "../lib/setup";
import { mcpCall } from "../lib/studio-client";

registerTestHooks();

describe("Multi-core (--num-threads 4)", () => {
  test("health check works with multiple workers", async () => {
    const res = await fetch("http://127.0.0.1:13000/health/ready");
    expect(res.status).toBe(200);
  }, 10_000);

  test("tool calls work with multiple workers", async () => {
    const { result } = await mcpCall(
      `${testState.orgId}_self`,
      "tools/call",
      { name: "COLLECTION_CONNECTIONS_LIST", arguments: {} },
      { apiKey: testState.apiKey },
      { timeoutMs: 10_000 },
    );
    expect(result).toBeTruthy();
  }, 15_000);

  test("concurrent requests all succeed", async () => {
    const concurrency = 20;
    const requests = Array.from({ length: concurrency }, () =>
      mcpCall(
        `${testState.orgId}_self`,
        "tools/call",
        { name: "COLLECTION_CONNECTIONS_LIST", arguments: {} },
        { apiKey: testState.apiKey },
        { timeoutMs: 15_000 },
      ),
    );

    const results = await Promise.all(requests);
    for (const { result } of results) {
      expect(result).toBeTruthy();
    }
  }, 30_000);
});
