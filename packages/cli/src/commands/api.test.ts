import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession } from "../lib/session";
import { apiCommand } from "./api";

let dir: string;
let err: string[];
let errSpy: ReturnType<typeof spyOn>;
let calls: { url: string; init: RequestInit }[];
let chunks: Uint8Array[];

const output = async (chunk: Uint8Array) => {
  chunks.push(chunk);
};
const stdout = () => Buffer.concat(chunks).toString("utf8");

function respondWith(body: string, status = 200) {
  return (async (input: URL | string, init: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-api-"));
  err = [];
  calls = [];
  chunks = [];
  errSpy = spyOn(console, "error").mockImplementation((msg: unknown) => {
    err.push(String(msg));
  });
  await writeSession(dir, {
    target: "https://studio.example.com",
    clientId: "client_abc",
    user: { sub: "u_1" },
    accessToken: "at_123",
    createdAt: "2026-05-04T00:00:00.000Z",
  });
});

afterEach(async () => {
  errSpy.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

describe("apiCommand", () => {
  it("GETs the path and prints the body", async () => {
    const code = await apiCommand({
      dataDir: dir,
      path: "/api/my-org/fs/files/list?path=/",
      fetch: respondWith('{"entries":[]}'),
      output,
    });

    expect(code).toBe(0);
    expect(stdout()).toBe('{"entries":[]}');
    expect(calls[0]!.url).toBe(
      "https://studio.example.com/api/my-org/fs/files/list?path=/",
    );
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("defaults to POST with a JSON body when --data is given", async () => {
    await apiCommand({
      dataDir: dir,
      path: "/api/my-org/tools/X",
      data: '{"a":1}',
      fetch: respondWith("{}"),
      output,
    });

    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe('{"a":1}');
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("honors -X and -H", async () => {
    const bytes = new TextEncoder().encode("hello");
    await apiCommand({
      dataDir: dir,
      path: "/api/my-org/fs/files/write?path=/a.txt",
      method: "put",
      data: "@-",
      headers: ["Content-Type: text/plain", "X-Trace:  abc "],
      readStdin: async () => bytes,
      fetch: respondWith("{}"),
      output,
    });

    const headers = new Headers(calls[0]!.init.headers);
    expect(calls[0]!.init.method).toBe("PUT");
    expect(calls[0]!.init.body).toBe(bytes);
    expect(headers.get("content-type")).toBe("text/plain");
    expect(headers.get("x-trace")).toBe("abc");
  });

  it("prints the error body and exits 1 on non-2xx", async () => {
    const code = await apiCommand({
      dataDir: dir,
      path: "/api/my-org/nope",
      fetch: respondWith('{"error":"Not found"}', 404),
      output,
    });

    expect(code).toBe(1);
    expect(stdout()).toBe('{"error":"Not found"}');
    expect(err.join("\n")).toContain("HTTP 404");
  });

  it("rejects a malformed header before any request", async () => {
    const code = await apiCommand({
      dataDir: dir,
      path: "/api/x",
      headers: ["no-colon"],
      fetch: respondWith("{}"),
      output,
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(err.join("\n")).toContain('Invalid header "no-colon"');
  });

  it("reports an invalid header name instead of throwing", async () => {
    const code = await apiCommand({
      dataDir: dir,
      path: "/api/x",
      headers: ["Bad Name: x"],
      fetch: respondWith("{}"),
      output,
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(err.join("\n")).toContain('Invalid header "Bad Name: x"');
  });

  it("sends a file with its extension's content type", async () => {
    const path = join(dir, "notes.md");
    await writeFile(path, "# hi");
    await apiCommand({
      dataDir: dir,
      path: "/api/my-org/fs/home/file?path=notes.md",
      method: "PUT",
      data: `@${path}`,
      fetch: respondWith("{}"),
      output,
    });

    expect(new Headers(calls[0]!.init.headers).get("content-type")).toStartWith(
      "text/markdown",
    );
  });

  it("exits 1 when the --data file is missing", async () => {
    const code = await apiCommand({
      dataDir: dir,
      path: "/api/x",
      data: `@${join(dir, "missing.json")}`,
      fetch: respondWith("{}"),
      output,
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("refuses paths that leave the studio", async () => {
    const code = await apiCommand({
      dataDir: dir,
      path: "https://evil.example.net/x",
      fetch: respondWith("{}"),
      output,
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("prints usage without a path", async () => {
    expect(await apiCommand({ dataDir: dir, output })).toBe(1);
    expect(err.join("\n")).toContain("Usage: decocms api <path>");
  });

  it("exits 1 when logged out", async () => {
    const empty = await mkdtemp(join(tmpdir(), "deco-api-empty-"));
    try {
      const code = await apiCommand({
        dataDir: empty,
        path: "/api/x",
        fetch: respondWith("{}"),
        output,
      });
      expect(code).toBe(1);
      expect(calls).toHaveLength(0);
      expect(err.join("\n")).toMatch(/Not logged in/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
