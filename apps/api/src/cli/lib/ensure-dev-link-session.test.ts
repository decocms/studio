import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureDevLinkSession } from "./ensure-dev-link-session";

describe("ensureDevLinkSession", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `ensure-dev-link-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("local mode: returns once session.json appears", async () => {
    const linkDataDir = join(dir, "link");
    await mkdir(linkDataDir, { recursive: true });
    setTimeout(() => {
      void writeFile(join(linkDataDir, "session.json"), "{}", "utf8");
    }, 50);

    await ensureDevLinkSession({
      localMode: true,
      linkDataDir,
      studioDataDir: dir,
      serverUrl: "http://localhost:3000",
      isInteractive: false,
    });
  });

  test("non-local mode: throws when no session and non-interactive", async () => {
    await expect(
      ensureDevLinkSession({
        localMode: false,
        linkDataDir: dir,
        studioDataDir: dir,
        serverUrl: "http://localhost:3999",
        isInteractive: false,
      }),
    ).rejects.toThrow(/No session for http:\/\/localhost:3999/);
  });

  test("non-local mode: accepts an existing host-keyed session", async () => {
    const session = {
      target: "http://localhost:3000",
      clientId: "test",
      user: { sub: "user-1", email: "tavano@deco.cx" },
      accessToken: "token",
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      join(dir, "session.localhost_3000.json"),
      JSON.stringify(session),
      "utf8",
    );

    await ensureDevLinkSession({
      localMode: false,
      linkDataDir: dir,
      studioDataDir: dir,
      serverUrl: "http://localhost:3000",
      isInteractive: false,
    });
  });
});
