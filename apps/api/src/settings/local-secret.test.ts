import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalAuthSecret } from "./local-secret";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-local-secret-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveLocalAuthSecret", () => {
  it("generates and persists a non-empty secret on first call", async () => {
    const secret = resolveLocalAuthSecret(dir);
    expect(secret.length).toBeGreaterThan(0);
    expect(await readFile(join(dir, "local-auth-secret"), "utf8")).toBe(secret);
  });

  it("returns the same secret across restarts (stable)", () => {
    const first = resolveLocalAuthSecret(dir);
    const second = resolveLocalAuthSecret(dir);
    expect(second).toBe(first);
  });

  it("creates the data dir if it does not exist yet", async () => {
    const nested = join(dir, "does", "not", "exist");
    const secret = resolveLocalAuthSecret(nested);
    expect(await readFile(join(nested, "local-auth-secret"), "utf8")).toBe(
      secret,
    );
  });

  it("writes the secret file with owner-only permissions", async () => {
    resolveLocalAuthSecret(dir);
    const mode = (await stat(join(dir, "local-auth-secret"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
