import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./persistence";

function repoWithDaemonJson(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "persistence-test-"));
  mkdirSync(join(dir, ".decocms"), { recursive: true });
  writeFileSync(join(dir, ".decocms", "daemon.json"), contents);
  return dir;
}

describe("readConfig", () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it("returns absent when no file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "persistence-test-"));
    tmpDirs.push(dir);
    expect(readConfig(dir)).toEqual({ kind: "absent" });
  });

  it("accepts a valid config", () => {
    const dir = repoWithDaemonJson(
      JSON.stringify({ application: { port: 3000 } }),
    );
    tmpDirs.push(dir);
    expect(readConfig(dir)).toEqual({
      kind: "valid",
      config: { application: { port: 3000 } },
    });
  });

  it("rejects a config that fails schema validation instead of trusting it blindly", () => {
    // Regression: a tenant-committed .decocms/daemon.json bypasses the
    // daemon-token auth that guards PUT /config, so it must not skip the
    // same field validation that route enforces (here: port out of range).
    const dir = repoWithDaemonJson(
      JSON.stringify({ application: { port: 99999 } }),
    );
    tmpDirs.push(dir);
    const outcome = readConfig(dir);
    expect(outcome.kind).toBe("invalid");
  });
});
