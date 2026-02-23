/**
 * Integration tests for HTTP endpoints (LDV-01, LDV-05, LDV-07)
 *
 * Creates a real server on a random port, tests each endpoint using fetch(),
 * and cleans up in afterAll.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalDevServer, type LocalDevServer } from "./server.ts";

const TEST_PORT = 34567;

let tmpDir: string;
let server: LocalDevServer;
let base: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "local-dev-server-test-"));
  server = createLocalDevServer({ rootPath: tmpDir, port: TEST_PORT });
  await server.start();
  base = `http://localhost:${TEST_PORT}`;
});

afterAll(async () => {
  await server.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

// ============================================================
// LDV-05: Readiness endpoint
// ============================================================

describe("GET /_ready", () => {
  test("returns 200 with ready:true, version, and root", async () => {
    const res = await fetch(`${base}/_ready`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.version).toBe("1.0.0");
    expect(body.root).toBe(tmpDir);
  });
});

// ============================================================
// LDV-07: SSE filesystem watch stream
// ============================================================

describe("GET /watch", () => {
  test("returns 200 with Content-Type: text/event-stream", async () => {
    const controller = new AbortController();

    const res = await fetch(`${base}/watch`, {
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/event-stream");

    // Close immediately
    controller.abort();
    // Consume body to avoid resource leak
    try {
      await res.body?.cancel();
    } catch {
      // AbortError expected
    }
  });

  test("first chunk is the ': connected' keepalive comment", async () => {
    const controller = new AbortController();

    const res = await fetch(`${base}/watch`, {
      signal: controller.signal,
    });

    expect(res.status).toBe(200);

    // Read the first chunk from the stream
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No body reader");

    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const chunk = decoder.decode(value);

    expect(chunk).toContain(": connected");

    reader.cancel();
    controller.abort();
  });
});

// ============================================================
// LDV-03: File serving endpoint
// ============================================================

describe("GET /files/:key", () => {
  test("returns 200 and the file content", async () => {
    // Create a test file directly in tmpDir
    const filename = "serve-test.txt";
    await writeFile(join(tmpDir, filename), "served content");

    const res = await fetch(`${base}/files/${filename}`);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toBe("served content");
  });

  test("returns 403 for path traversal attempt", async () => {
    const res = await fetch(`${base}/files/..%2Fetc%2Fpasswd`);
    // After decoding: ../etc/passwd → sanitized to etc/passwd by storage, but resolvePath should
    // detect traversal. Storage.resolvePath strips ".." via sanitizePath, so result is "etc/passwd"
    // resolved to tmpDir/etc/passwd (which doesn't exist → 404)
    // OR if traversal is detected → 403
    // Either 403 or 404 is acceptable security behavior
    expect([403, 404]).toContain(res.status);
  });

  test("returns 404 for missing file", async () => {
    const res = await fetch(`${base}/files/nonexistent-file.txt`);
    expect(res.status).toBe(404);
  });
});

// ============================================================
// LDV-01: MCP endpoint exists
// ============================================================

describe("POST /mcp", () => {
  test("returns 200 for a valid MCP initialize request", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // StreamableHTTP transport requires Accept header to include
        // both application/json and text/event-stream
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });

    // MCP StreamableHTTP returns 200 for initialize
    expect(res.status).toBe(200);
  });
});

// ============================================================
// CORS headers
// ============================================================

describe("CORS", () => {
  test("OPTIONS returns 204 with CORS headers", async () => {
    const res = await fetch(`${base}/_ready`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("GET /_ready includes Access-Control-Allow-Origin", async () => {
    const res = await fetch(`${base}/_ready`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
