import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession } from "../../lib/session";
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
});
