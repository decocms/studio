import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmod, mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Session,
  readSession,
  writeSession,
  clearSession,
  sessionPath,
} from "./session";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-session-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sample: Session = {
  target: "https://studio.decocms.com",
  clientId: "client_abc",
  user: { sub: "u_1", email: "tlgimenes@gmail.com" },
  accessToken: "tok_abc",
  createdAt: "2026-05-04T12:00:00.000Z",
};

describe("sessionPath", () => {
  it("places session.json directly in the given data dir", () => {
    expect(sessionPath("/tmp/x")).toBe("/tmp/x/session.json");
  });
});

describe("writeSession + readSession", () => {
  it("round-trips a session object", async () => {
    await writeSession(dir, sample);
    expect(await readSession(dir)).toEqual(sample);
  });

  it("creates the data dir if it does not exist", async () => {
    const nested = join(dir, "nested", "deeper");
    await writeSession(nested, sample);
    expect(await readSession(nested)).toEqual(sample);
  });

  it("writes the file with mode 0600", async () => {
    await writeSession(dir, sample);
    const s = await stat(sessionPath(dir, sample.target));
    // Mask off the file-type bits and compare permission bits.
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("forces mode 0600 even when overwriting an existing file with looser permissions", async () => {
    const path = sessionPath(dir, sample.target);
    // Pre-create the file with mode 0644 to simulate a broken prior state.
    await writeFile(path, "{}", { mode: 0o644 });
    await chmod(path, 0o644); // ensure 0644 even if writeFile honored mode
    const before = await stat(path);
    expect(before.mode & 0o777).toBe(0o644);

    await writeSession(dir, sample);

    const after = await stat(path);
    expect(after.mode & 0o777).toBe(0o600);
    expect(await readSession(dir)).toEqual(sample);
  });
});

describe("per-studio session keying", () => {
  const prod = sample;
  const stg: Session = {
    ...sample,
    target: "https://studio-stg.decocms.com",
    accessToken: "tok_stg",
  };

  it("keeps sessions for different studios side by side", async () => {
    await writeSession(dir, prod);
    await writeSession(dir, stg);
    expect(await readSession(dir, prod.target)).toEqual(prod);
    expect(await readSession(dir, stg.target)).toEqual(stg);
  });

  it("falls back to the legacy session.json when no host-keyed file exists", async () => {
    // The dev-link bootstrap writes the legacy single-file form.
    await writeFile(sessionPath(dir), JSON.stringify(prod), { mode: 0o600 });
    expect(await readSession(dir, prod.target)).toEqual(prod);
  });

  it("clears every studio's session when no target is given", async () => {
    await writeSession(dir, prod);
    await writeSession(dir, stg);
    await clearSession(dir);
    expect(await readSession(dir, prod.target)).toBeNull();
    expect(await readSession(dir, stg.target)).toBeNull();
  });

  it("clears only the targeted studio's session", async () => {
    await writeSession(dir, prod);
    await writeSession(dir, stg);
    await clearSession(dir, stg.target);
    expect(await readSession(dir, stg.target)).toBeNull();
    expect(await readSession(dir, prod.target)).toEqual(prod);
  });
});

describe("readSession", () => {
  it("returns null when the file does not exist", async () => {
    expect(await readSession(dir)).toBeNull();
  });

  it("returns null and does not throw when the file is malformed JSON", async () => {
    await writeFile(sessionPath(dir), "not-json", { mode: 0o600 });
    expect(await readSession(dir)).toBeNull();
  });

  it("returns null when the file is missing required fields", async () => {
    await writeFile(sessionPath(dir), JSON.stringify({ target: "x" }), {
      mode: 0o600,
    });
    expect(await readSession(dir)).toBeNull();
  });
});

describe("clearSession", () => {
  it("removes the session file", async () => {
    await writeSession(dir, sample);
    await clearSession(dir);
    expect(await readSession(dir)).toBeNull();
  });

  it("is a no-op when the file does not exist", async () => {
    await clearSession(dir);
    expect(await readSession(dir)).toBeNull();
  });
});
