import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCredential, resolveRestCredential } from "./credentials";
import { writeSession } from "./session";

let root: string;
let dataDir: string;
let workspace: string;
let errors: string[];
let errSpy: ReturnType<typeof spyOn>;

const ENDPOINT = {
  url: "https://studio.example.com/mcp/virtual-mcp/vir_run",
  headers: { Authorization: "Bearer run-key" },
};

async function writeEndpointFile(contents: string) {
  await mkdir(join(workspace, ".deco", "tools"), { recursive: true });
  await writeFile(
    join(workspace, ".deco", "tools", ".endpoint.json"),
    contents,
  );
}

async function logIn(target = "https://studio.example.com") {
  await writeSession(dataDir, {
    target,
    clientId: "client_abc",
    user: { sub: "u_1", email: "person@example.com" },
    accessToken: `at_${new URL(target).host}`,
    createdAt: "2026-05-04T00:00:00.000Z",
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "deco-credentials-"));
  dataDir = join(root, "home");
  workspace = join(root, "repo");
  await mkdir(join(workspace, "src", "nested"), { recursive: true });
  errors = [];
  errSpy = spyOn(console, "error").mockImplementation((msg: unknown) => {
    errors.push(String(msg));
  });
});

afterEach(async () => {
  errSpy.mockRestore();
  await rm(root, { recursive: true, force: true });
});

describe("resolveCredential", () => {
  it("uses the login when nothing else is present", async () => {
    await logIn();
    const credential = await resolveCredential({
      dataDir,
      cwd: workspace,
      env: {},
    });
    expect(credential).toMatchObject({
      kind: "session",
      target: "https://studio.example.com",
      token: "at_studio.example.com",
    });
  });

  it("prefers the run's endpoint file over the login, walking up from the cwd", async () => {
    await logIn();
    await writeEndpointFile(JSON.stringify(ENDPOINT));
    const credential = await resolveCredential({
      dataDir,
      cwd: join(workspace, "src", "nested"),
      env: {},
    });
    expect(credential).toEqual({ kind: "run", ...ENDPOINT });
  });

  it("falls back to the login when the endpoint file is malformed", async () => {
    await logIn();
    await writeEndpointFile("{not json");
    const credential = await resolveCredential({
      dataDir,
      cwd: workspace,
      env: {},
    });
    expect(credential?.kind).toBe("session");
  });

  it("prefers STUDIO_API_KEY over the endpoint file and the login", async () => {
    await logIn();
    await writeEndpointFile(JSON.stringify(ENDPOINT));
    const credential = await resolveCredential({
      dataDir,
      cwd: workspace,
      env: {
        STUDIO_API_KEY: "sk_1",
        STUDIO_BASE_URL: "http://localhost:3000/",
      },
    });
    expect(credential).toEqual({
      kind: "apiKey",
      target: "http://localhost:3000",
      token: "sk_1",
    });
  });

  it("defaults STUDIO_API_KEY to the hosted studio", async () => {
    const credential = await resolveCredential({
      dataDir,
      cwd: workspace,
      env: { STUDIO_API_KEY: "sk_1" },
    });
    expect(credential).toMatchObject({
      kind: "apiKey",
      target: "https://studio.decocms.com",
    });
  });

  it("uses the login for an explicit --target, even inside a run", async () => {
    await logIn("http://localhost:3000");
    await writeEndpointFile(JSON.stringify(ENDPOINT));
    const credential = await resolveCredential({
      dataDir,
      target: "http://localhost:3000",
      cwd: workspace,
      env: { STUDIO_API_KEY: "sk_1" },
    });
    expect(credential).toMatchObject({
      kind: "session",
      target: "http://localhost:3000",
    });
  });

  it("returns null with a login hint when there is no credential", async () => {
    expect(
      await resolveCredential({ dataDir, cwd: workspace, env: {} }),
    ).toBeNull();
    expect(errors.join("\n")).toContain("decocms auth login");
  });
});

describe("resolveRestCredential", () => {
  it("refuses a run's endpoint and points at tools", async () => {
    await writeEndpointFile(JSON.stringify(ENDPOINT));
    expect(
      await resolveRestCredential({ dataDir, cwd: workspace, env: {} }, "orgs"),
    ).toBeNull();
    expect(errors.join("\n")).toContain("`decocms orgs` needs a login");
    expect(errors.join("\n")).toContain("decocms tools");
  });

  it("accepts a login", async () => {
    await logIn();
    const credential = await resolveRestCredential(
      { dataDir, cwd: workspace, env: {} },
      "api",
    );
    expect(credential?.kind).toBe("session");
  });
});
