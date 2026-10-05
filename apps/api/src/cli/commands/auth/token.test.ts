import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, writeSession } from "../../lib/session";
import { tokenCommand } from "./token";

let dir: string;
let out: string[];
let err: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-token-"));
  out = [];
  err = [];
  logSpy = spyOn(console, "log").mockImplementation((msg: unknown) => {
    out.push(String(msg));
  });
  errSpy = spyOn(console, "error").mockImplementation((msg: unknown) => {
    err.push(String(msg));
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

describe("tokenCommand", () => {
  it("prints only the access token", async () => {
    await writeSession(dir, {
      target: "https://studio.example.com",
      clientId: "client_abc",
      user: { sub: "u_1" },
      accessToken: "at_123",
      createdAt: "2026-05-04T00:00:00.000Z",
    });

    expect(await tokenCommand({ dataDir: dir })).toBe(0);
    expect(out).toEqual(["at_123"]);
  });

  it("refreshes an expired token before printing it", async () => {
    const nowMs = 1_700_000_000_000;
    await writeSession(dir, {
      target: "https://studio.example.com",
      clientId: "client_abc",
      user: { sub: "u_1" },
      accessToken: "at_stale",
      refreshToken: "rt_xyz",
      expiresAt: Math.floor(nowMs / 1000) - 60,
      createdAt: "2026-05-04T00:00:00.000Z",
    });
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ access_token: "at_fresh", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const code = await tokenCommand({
      dataDir: dir,
      fetch: fetchMock,
      now: () => nowMs,
    });

    expect(code).toBe(0);
    expect(out).toEqual(["at_fresh"]);
    expect((await readSession(dir))?.accessToken).toBe("at_fresh");
  });

  it("selects the session for --target", async () => {
    for (const [target, accessToken] of [
      ["https://studio.example.com", "at_prod"],
      ["http://localhost:3000", "at_local"],
    ] as const) {
      await writeSession(dir, {
        target,
        clientId: "client_abc",
        user: { sub: "u_1" },
        accessToken,
        createdAt: "2026-05-04T00:00:00.000Z",
      });
    }

    expect(
      await tokenCommand({ dataDir: dir, target: "http://localhost:3000" }),
    ).toBe(0);
    expect(out).toEqual(["at_local"]);
  });

  it("exits 1 with a login hint and no stdout when logged out", async () => {
    expect(
      await tokenCommand({ dataDir: dir, target: "http://localhost:3000" }),
    ).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain(
      "decocms auth login --target http://localhost:3000",
    );
  });
});
