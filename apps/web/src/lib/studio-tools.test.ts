import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { callStudioTool } from "./studio-tools";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("callStudioTool", () => {
  test("returns the parsed JSON body on success", async () => {
    const body = { id: "conn_1", healthy: true, latencyMs: 12 };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
      })) as unknown as typeof globalThis.fetch;

    const result = await callStudioTool("acme", "CONNECTION_TEST", {
      id: "conn_1",
    });
    expect(result).toEqual(body);
  });

  test("throws a StudioToolError with the server message on non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
      })) as unknown as typeof globalThis.fetch;

    await expect(
      callStudioTool("acme", "CONNECTION_TEST", { id: "conn_1" }),
    ).rejects.toMatchObject({ message: "not found", status: 404 });
  });

  test("falls back to a generic message when the error body isn't JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
      })) as unknown as typeof globalThis.fetch;

    await expect(
      callStudioTool("acme", "CONNECTION_TEST", { id: "conn_1" }),
    ).rejects.toMatchObject({
      message: "CONNECTION_TEST failed (502)",
      status: 502,
    });
  });

  test("throws a StudioToolError instead of a raw parse error when a 2xx body isn't JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>upstream proxy glitch</html>", {
        status: 200,
      })) as unknown as typeof globalThis.fetch;

    await expect(
      callStudioTool("acme", "CONNECTION_TEST", { id: "conn_1" }),
    ).rejects.toMatchObject({
      name: "StudioToolError",
      message: "CONNECTION_TEST returned a non-JSON response",
      status: 200,
    });
  });
});
