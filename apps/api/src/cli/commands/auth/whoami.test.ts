import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, writeSession } from "../../lib/session";
import { whoamiCommand } from "./whoami";

let dir: string;
let logs: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-whoami-"));
  logs = [];
  logSpy = spyOn(console, "log").mockImplementation((msg: unknown) => {
    logs.push(String(msg));
  });
  errSpy = spyOn(console, "error").mockImplementation((msg: unknown) => {
    logs.push(String(msg));
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

describe("whoamiCommand", () => {
  it("prints session details and exits 0 when logged in", async () => {
    await writeSession(dir, {
      target: "https://studio.decocms.com",
      clientId: "client_abc",
      user: { sub: "u_1", email: "tlgimenes@gmail.com" },
      accessToken: "tok",
      createdAt: "2026-05-04T00:00:00.000Z",
    });

    const code = await whoamiCommand({ dataDir: dir });
    const joined = logs.join("\n");

    expect(code).toBe(0);
    expect(joined).toContain("https://studio.decocms.com");
    expect(joined).toContain("tlgimenes@gmail.com");
  });

  it("prints a hint and exits 1 when no session is present", async () => {
    const code = await whoamiCommand({ dataDir: dir });
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/Not logged in.*decocms auth login/);
  });

  it("silently refreshes an expired session and prints the new identity", async () => {
    const nowMs = 1_700_000_000_000;
    const nowS = Math.floor(nowMs / 1000);

    await writeSession(dir, {
      target: "https://studio.decocms.com",
      clientId: "client_abc",
      user: { sub: "u_1", email: "tlgimenes@gmail.com" },
      accessToken: "at_stale",
      refreshToken: "rt_xyz",
      expiresAt: nowS - 60,
      createdAt: "2026-05-04T00:00:00.000Z",
    });

    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ access_token: "at_fresh", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const code = await whoamiCommand({
      dataDir: dir,
      fetch: fetchMock,
      now: () => nowMs,
    });

    expect(code).toBe(0);
    const joined = logs.join("\n");
    expect(joined).toContain("tlgimenes@gmail.com");

    const onDisk = await readSession(dir);
    expect(onDisk?.accessToken).toBe("at_fresh");
  });

  it("prints not-logged-in when refresh is rejected", async () => {
    const nowMs = 1_700_000_000_000;
    const nowS = Math.floor(nowMs / 1000);

    await writeSession(dir, {
      target: "https://studio.decocms.com",
      clientId: "client_abc",
      user: { sub: "u_1", email: "tlgimenes@gmail.com" },
      accessToken: "at_stale",
      refreshToken: "rt_xyz",
      expiresAt: nowS - 60,
      createdAt: "2026-05-04T00:00:00.000Z",
    });

    const fetchMock = mock(
      async () => new Response("invalid_grant", { status: 400 }),
    ) as unknown as typeof fetch;

    const code = await whoamiCommand({
      dataDir: dir,
      fetch: fetchMock,
      now: () => nowMs,
    });

    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/Not logged in.*decocms auth login/);
  });
});
