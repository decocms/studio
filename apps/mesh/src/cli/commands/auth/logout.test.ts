import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, writeSession } from "../../lib/session";
import { logoutCommand } from "./logout";

let dir: string;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-logout-"));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  logSpy.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

describe("logoutCommand", () => {
  it("clears the session and exits 0 when logged in", async () => {
    await writeSession(dir, {
      target: "https://studio.decocms.com",
      clientId: "client_abc",
      user: { sub: "u_1", email: "tlgimenes@gmail.com" },
      accessToken: "tok_abc",
      createdAt: "2026-05-04T00:00:00.000Z",
    });

    const code = await logoutCommand({ dataDir: dir });
    expect(code).toBe(0);
    expect(await readSession(dir)).toBeNull();
  });

  it("is a no-op + exit 0 when no session is present", async () => {
    const code = await logoutCommand({ dataDir: dir });
    expect(code).toBe(0);
  });
});
