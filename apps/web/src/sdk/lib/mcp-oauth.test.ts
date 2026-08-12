import { describe, expect, test, afterEach } from "bun:test";
import { isConnectionAuthenticated } from "./mcp-oauth";

describe("isConnectionAuthenticated", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("surfaces a clear message when the probe times out", async () => {
    global.fetch = (() =>
      Promise.reject(
        new DOMException("The operation timed out.", "TimeoutError"),
      )) as unknown as typeof fetch;

    const result = await isConnectionAuthenticated({
      url: "https://example.com/api/my-org/mcp/conn-1",
      token: null,
    });

    expect(result.isAuthenticated).toBe(false);
    expect(result.error).toBe("Connection check timed out after 15s");
  });
});
