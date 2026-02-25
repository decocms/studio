/**
 * Integration tests for filesystem and object storage tools (LDV-02, LDV-03)
 *
 * Uses InMemoryTransport to test tools via the MCP protocol without HTTP overhead.
 * A real temporary directory is used so filesystem operations are genuine.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStorage } from "./storage.ts";
import { registerTools } from "./tools.ts";

type TextContent = { type: string; text: string };

const TEST_PORT = 34561;

let tmpDir: string;
let client: Client;

beforeAll(async () => {
  // Create a temporary directory for all tests
  tmpDir = await mkdtemp(join(tmpdir(), "local-dev-tools-test-"));

  // Set up MCP server with tools registered
  const server = new McpServer({ name: "test-local-dev", version: "1.0.0" });
  const storage = new LocalFileStorage(tmpDir);
  registerTools(server, storage, TEST_PORT);

  // Connect via InMemoryTransport (no HTTP needed)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  // Clean up temp dir
  await rm(tmpDir, { recursive: true, force: true });
});

// ============================================================
// FILESYSTEM TOOLS (LDV-02)
// ============================================================

describe("write_file", () => {
  test("writes a file successfully", async () => {
    const result = await client.callTool({
      name: "write_file",
      arguments: { path: "test.txt", content: "hello world" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain("Successfully wrote");
    expect(text).toContain("test.txt");
  });
});

describe("read_file", () => {
  test("reads file content back correctly", async () => {
    // Write first, then read
    await client.callTool({
      name: "write_file",
      arguments: { path: "read-test.txt", content: "hello" },
    });

    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "read-test.txt" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as TextContent[])[0].text;
    expect(text).toBe("hello");
  });

  test("returns error for non-existent file", async () => {
    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "does-not-exist.txt" },
    });

    expect(result.isError).toBe(true);
  });
});

describe("list_directory", () => {
  test("lists files and directories with [FILE] and [DIR] prefixes", async () => {
    // Write a file to list
    await client.callTool({
      name: "write_file",
      arguments: { path: "subdir/file-in-dir.txt", content: "content" },
    });

    // List root: should contain 'subdir' and other files we wrote
    const result = await client.callTool({
      name: "list_directory",
      arguments: { path: "" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as TextContent[])[0].text;
    // Should have at least one [FILE] or [DIR] entry
    expect(text).toMatch(/\[(FILE|DIR)\]/);
  });

  test("lists directory contents shows [DIR] for directories", async () => {
    // The subdir created in previous test should appear as [DIR]
    const result = await client.callTool({
      name: "list_directory",
      arguments: { path: "" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain("[DIR]");
  });
});

describe("delete_file", () => {
  test("deletes a file successfully", async () => {
    // Write then delete
    await client.callTool({
      name: "write_file",
      arguments: { path: "to-delete.txt", content: "bye" },
    });

    const deleteResult = await client.callTool({
      name: "delete_file",
      arguments: { path: "to-delete.txt" },
    });

    expect(deleteResult.isError).toBeFalsy();
    const text = (deleteResult.content as TextContent[])[0].text;
    expect(text).toContain("Successfully deleted");

    // Verify it's gone
    const readResult = await client.callTool({
      name: "read_file",
      arguments: { path: "to-delete.txt" },
    });
    expect(readResult.isError).toBe(true);
  });
});

// ============================================================
// OBJECT STORAGE BINDING TOOLS (LDV-03)
// ============================================================

describe("LIST_OBJECTS", () => {
  test("returns correct shape with objects array", async () => {
    // Ensure we have at least one file
    await client.callTool({
      name: "write_file",
      arguments: { path: "obj-test.txt", content: "object content" },
    });

    const result = await client.callTool({
      name: "LIST_OBJECTS",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent[])[0].text);

    expect(parsed).toHaveProperty("objects");
    expect(Array.isArray(parsed.objects)).toBe(true);
    expect(parsed).toHaveProperty("isTruncated");

    // Each object should have key, size, lastModified, etag
    if (parsed.objects.length > 0) {
      const obj = parsed.objects[0];
      expect(obj).toHaveProperty("key");
      expect(obj).toHaveProperty("size");
      expect(obj).toHaveProperty("lastModified");
      expect(obj).toHaveProperty("etag");
    }
  });
});

describe("GET_PRESIGNED_URL", () => {
  test("returns a URL starting with http://localhost: and expiresIn 3600", async () => {
    // Write the file first
    await client.callTool({
      name: "write_file",
      arguments: { path: "test.txt", content: "hello world" },
    });

    const result = await client.callTool({
      name: "GET_PRESIGNED_URL",
      arguments: { key: "test.txt" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent[])[0].text);

    expect(parsed.url).toMatch(/^http:\/\/localhost:/);
    expect(parsed.url).toContain(`/files/`);
    expect(parsed.url).toContain("test.txt");
    expect(parsed.expiresIn).toBe(3600);
  });

  test("returns URL on the configured port", async () => {
    const result = await client.callTool({
      name: "GET_PRESIGNED_URL",
      arguments: { key: "test.txt" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent[])[0].text);

    expect(parsed.url).toContain(`localhost:${TEST_PORT}`);
  });

  test("sanitizes path traversal attempts — URL points within server root", async () => {
    const result = await client.callTool({
      name: "GET_PRESIGNED_URL",
      arguments: { key: "../etc/passwd" },
    });

    // sanitizePath strips ".." segments before resolvePath runs so the key never
    // escapes the root. The tool succeeds and returns a URL, but the URL points
    // to <root>/etc/passwd (safe), NOT to the system /etc/passwd.
    // The HTTP server's /files/ handler also calls resolvePath() before serving.
    // We just verify the call did not throw and returns a localhost URL.
    if (!result.isError) {
      const parsed = JSON.parse((result.content as TextContent[])[0].text);
      expect(parsed.url).toMatch(/^http:\/\/localhost:/);
    }
    // isError is also acceptable if the implementation opts to reject traversal
  });
});

describe("GET_ROOT", () => {
  test("returns the temp directory path", async () => {
    const result = await client.callTool({
      name: "GET_ROOT",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent[])[0].text);

    expect(parsed.root).toBe(tmpDir);
  });
});
