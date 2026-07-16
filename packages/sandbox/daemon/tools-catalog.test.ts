import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_DIR,
  ENDPOINT_FILENAME,
  makeCatalogSync,
  type McpEndpoint,
  toolCatalogFiles,
  writeEndpointFile,
  writeToolCatalog,
} from "./tools-catalog";

describe("toolCatalogFiles", () => {
  test("emits one JSON file per tool with name, description and schemas", () => {
    const files = toolCatalogFiles([
      {
        name: "SEND_EMAIL",
        description: "Send an email",
        inputSchema: {
          type: "object",
          properties: { to: { type: "string" } },
          required: ["to"],
        },
        outputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      },
    ]);

    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("SEND_EMAIL.json");
    const parsed = JSON.parse(files[0].content);
    expect(parsed.name).toBe("SEND_EMAIL");
    expect(parsed.description).toBe("Send an email");
    expect(parsed.inputSchema.properties.to.type).toBe("string");
    expect(parsed.outputSchema.properties.id.type).toBe("string");
  });

  test("omits description/outputSchema when absent and defaults inputSchema", () => {
    const files = toolCatalogFiles([{ name: "PING", inputSchema: undefined }]);
    const parsed = JSON.parse(files[0].content);
    expect("description" in parsed).toBe(false);
    expect("outputSchema" in parsed).toBe(false);
    expect(parsed.inputSchema).toEqual({ type: "object" });
  });

  test("sanitizes unsafe filename chars but keeps the real name inside", () => {
    const files = toolCatalogFiles([
      { name: "conn/../SEND", inputSchema: { type: "object" } },
    ]);
    // Slashes (the traversal risk) become underscores; dots are safe in a
    // bare filename and kept. safePath clamps the write regardless.
    expect(files[0].filename).toBe("conn_.._SEND.json");
    expect(files[0].filename).not.toContain("/");
    expect(JSON.parse(files[0].content).name).toBe("conn/../SEND");
  });

  test("disambiguates distinct tools that sanitize to the same filename", () => {
    const files = toolCatalogFiles([
      { name: "a/b", inputSchema: { type: "object" } },
      { name: "a_b", inputSchema: { type: "object" } },
    ]);
    // Both sanitize to `a_b` — neither may be silently dropped.
    expect(files.map((f) => f.filename)).toEqual(["a_b.json", "a_b-2.json"]);
    expect(JSON.parse(files[0].content).name).toBe("a/b");
    expect(JSON.parse(files[1].content).name).toBe("a_b");
  });
});

describe("writeToolCatalog", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "catalog-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const opts = () => ({ appRoot: root, repoDir: root });
  const dir = () => join(root, CATALOG_DIR);

  test("writes one file per tool and returns the names", async () => {
    const res = await writeToolCatalog(
      [{ name: "LIST", inputSchema: { type: "object" } }],
      opts(),
    );
    expect(res).toEqual({ count: 1, tools: ["LIST"] });
    expect(existsSync(join(dir(), "LIST.json"))).toBe(true);
  });

  test("prunes stale *.json from a previous sync, keeps other files", async () => {
    await writeToolCatalog(
      [
        { name: "OLD", inputSchema: { type: "object" } },
        { name: "KEEP", inputSchema: { type: "object" } },
      ],
      opts(),
    );
    // A non-catalog file must survive the prune.
    writeFileSync(join(dir(), "README.md"), "hi");

    await writeToolCatalog([{ name: "KEEP", inputSchema: {} }], opts());

    const left = (await readdir(dir())).sort();
    expect(left).toEqual(["KEEP.json", "README.md"]);
  });

  test("prune never deletes the endpoint dotfile", async () => {
    await writeEndpointFile(
      { url: "http://x/mcp/virtual-mcp/a", headers: {} },
      opts(),
    );
    await writeToolCatalog([{ name: "LIST", inputSchema: {} }], opts());

    expect(existsSync(join(dir(), ENDPOINT_FILENAME))).toBe(true);
  });
});

describe("writeEndpointFile", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "endpoint-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const opts = () => ({ appRoot: root, repoDir: root });
  const file = () => join(root, CATALOG_DIR, ENDPOINT_FILENAME);

  test("writes url, headers and expiresAt, owner-read-only", async () => {
    const ok = await writeEndpointFile(
      {
        url: "http://x/mcp/virtual-mcp/agent-1",
        headers: { Authorization: "Bearer k", "x-org-id": "org_1" },
        expiresAt: 1234,
      },
      opts(),
    );
    expect(ok).toBe(true);

    const parsed = JSON.parse(await readFile(file(), "utf-8"));
    expect(parsed).toEqual({
      url: "http://x/mcp/virtual-mcp/agent-1",
      headers: { Authorization: "Bearer k", "x-org-id": "org_1" },
      expiresAt: 1234,
    });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  test("omits expiresAt when absent and overwrites a previous file", async () => {
    await writeEndpointFile(
      { url: "http://old", headers: {}, expiresAt: 1 },
      opts(),
    );
    await writeEndpointFile({ url: "http://new", headers: {} }, opts());

    const parsed = JSON.parse(await readFile(file(), "utf-8"));
    expect(parsed).toEqual({ url: "http://new", headers: {} });
  });
});

describe("makeCatalogSync", () => {
  const mcp: McpEndpoint = { url: "http://x/mcp", headers: {} };

  test("coalesces while in flight, then respects the min interval", async () => {
    let calls = 0;
    let release: () => void = () => {};
    let clock = 1000;
    const sync = makeCatalogSync(
      { appRoot: "/", repoDir: "/", minIntervalMs: 100 },
      {
        now: () => clock,
        sync: () => {
          calls++;
          return new Promise<void>((r) => {
            release = r;
          });
        },
      },
    );

    sync(mcp);
    sync(mcp); // in-flight → coalesced
    expect(calls).toBe(1);

    release();
    await Promise.resolve();
    await Promise.resolve();

    clock += 50; // within the interval → skipped
    sync(mcp);
    expect(calls).toBe(1);

    clock += 100; // past the interval → runs again
    sync(mcp);
    expect(calls).toBe(2);
  });
});
