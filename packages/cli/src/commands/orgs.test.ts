import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession } from "../lib/session";
import { orgsCommand } from "./orgs";

const ORGS = {
  organizations: [
    { id: "org_1", slug: "acme", name: "Acme", logo: null },
    { id: "org_2", slug: "globex", name: "Globex", logo: "https://x/l.png" },
  ],
};

let dir: string;
let out: string[];
let err: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let calls: string[];
let chunks: Uint8Array[];

const output = async (chunk: Uint8Array) => {
  chunks.push(chunk);
};

function respondWith(body: unknown, status = 200) {
  return (async (input: URL | string) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-orgs-"));
  out = [];
  err = [];
  calls = [];
  chunks = [];
  logSpy = spyOn(console, "log").mockImplementation((msg: unknown) => {
    out.push(String(msg));
  });
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
  logSpy.mockRestore();
  errSpy.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

describe("orgsCommand", () => {
  it("prints one slug and name per organization", async () => {
    const code = await orgsCommand({ dataDir: dir, fetch: respondWith(ORGS) });

    expect(code).toBe(0);
    expect(calls).toEqual(["https://studio.example.com/api/_me/organizations"]);
    expect(out).toEqual(["acme\tAcme", "globex\tGlobex"]);
  });

  it("prints the organizations as JSON with --json", async () => {
    await orgsCommand({ dataDir: dir, json: true, fetch: respondWith(ORGS) });

    expect(JSON.parse(out[0]!)).toEqual(ORGS.organizations);
  });

  it("prints nothing for a user with no organizations", async () => {
    const code = await orgsCommand({
      dataDir: dir,
      fetch: respondWith({ organizations: [] }),
    });

    expect(code).toBe(0);
    expect(out).toEqual([]);
  });

  it("passes a non-2xx through", async () => {
    const code = await orgsCommand({
      dataDir: dir,
      fetch: respondWith({ error: "Unauthorized" }, 401),
      output,
    });

    expect(code).toBe(1);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(
      '{"error":"Unauthorized"}',
    );
    expect(err.join("\n")).toContain("decocms auth login");
  });

  it("fails on a response that is not an organization list", async () => {
    const code = await orgsCommand({
      dataDir: dir,
      fetch: respondWith({ organizations: [{ id: "org_1" }] }),
    });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Unexpected response");
  });

  it("exits 1 when logged out", async () => {
    const empty = await mkdtemp(join(tmpdir(), "deco-orgs-empty-"));
    try {
      const code = await orgsCommand({
        dataDir: empty,
        fetch: respondWith(ORGS),
      });
      expect(code).toBe(1);
      expect(calls).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
