/**
 * Unit tests for bash tool execution (LDV-04, LDV-06)
 *
 * Uses InMemoryTransport + registerBashTool. Tests that:
 * - Commands run in the correct cwd (rootPath scoping)
 * - stdout/stderr/exitCode are returned correctly
 * - Timeout kills processes and returns non-zero exitCode
 * - activeChildren Set is empty after completion
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBashTool, activeChildren } from "./bash.ts";

let tmpDir: string;
let client: Client;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "local-dev-bash-test-"));

  const server = new McpServer({ name: "test-bash", version: "1.0.0" });
  registerBashTool(server, tmpDir);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await rm(tmpDir, { recursive: true, force: true });
});

type TextContent = { type: string; text: string };

function parseOutput(result: Awaited<ReturnType<typeof client.callTool>>): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const text = (result.content as TextContent[])[0].text;
  return JSON.parse(text);
}

describe("bash tool", () => {
  test("echo hello → stdout=hello, stderr='', exitCode=0", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: { cmd: "echo hello" },
    });

    expect(result.isError).toBeFalsy();
    const output = parseOutput(result);
    expect(output.stdout).toBe("hello");
    expect(output.stderr).toBe("");
    expect(output.exitCode).toBe(0);
  });

  test("pwd returns the temp directory (cwd scoping)", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: { cmd: "pwd -P" },
    });

    expect(result.isError).toBeFalsy();
    const output = parseOutput(result);
    // On macOS /var is a symlink to /private/var — use realpath on both sides
    const { realpathSync } = await import("node:fs");
    const realTmpDir = realpathSync(tmpDir);
    expect(output.stdout).toBe(realTmpDir);
    expect(output.exitCode).toBe(0);
  });

  test("exit 1 → exitCode=1", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: { cmd: "exit 1" },
    });

    expect(result.isError).toBeFalsy();
    const output = parseOutput(result);
    expect(output.exitCode).toBe(1);
  });

  test("stderr is captured", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: { cmd: "echo 'error message' >&2" },
    });

    expect(result.isError).toBeFalsy();
    const output = parseOutput(result);
    expect(output.stderr).toContain("error message");
  });

  test("timeout kills process and returns non-zero exitCode", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: { cmd: "sleep 10", timeout: 200 },
    });

    expect(result.isError).toBeFalsy();
    const output = parseOutput(result);
    // SIGTERM produces null code → -1, or non-zero
    expect(output.exitCode).not.toBe(0);
  }, 3000);

  test("activeChildren is empty after command completes", async () => {
    await client.callTool({
      name: "bash",
      arguments: { cmd: "echo done" },
    });

    // After a synchronous command, the child should be removed
    // Allow a tick for cleanup
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activeChildren.size).toBe(0);
  });

  test("multi-line output is captured", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: { cmd: "printf 'line1\\nline2\\nline3'" },
    });

    expect(result.isError).toBeFalsy();
    const output = parseOutput(result);
    expect(output.stdout).toContain("line1");
    expect(output.stdout).toContain("line2");
    expect(output.stdout).toContain("line3");
  });
});
