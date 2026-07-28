import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./persistence";

async function repoWithDaemonJson(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "persistence-test-"));
  await mkdir(join(dir, ".decocms"), { recursive: true });
  await writeFile(join(dir, ".decocms", "daemon.json"), contents);
  return dir;
}

describe("readConfig", () => {
  const tmpDirs: string[] = [];
  afterAll(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  });

  it("returns absent when no file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persistence-test-"));
    tmpDirs.push(dir);
    expect(await readConfig(dir)).toEqual({ kind: "absent" });
  });

  it("accepts a valid config", async () => {
    const dir = await repoWithDaemonJson(
      JSON.stringify({ application: { port: 3000 } }),
    );
    tmpDirs.push(dir);
    expect(await readConfig(dir)).toEqual({
      kind: "valid",
      config: { application: { port: 3000 } },
    });
  });

  it("rejects a config that fails schema validation instead of trusting it blindly", async () => {
    // Regression: a tenant-committed .decocms/daemon.json bypasses the
    // daemon-token auth that guards PUT /config, so it must not skip the
    // same field validation that route enforces (here: port out of range).
    const dir = await repoWithDaemonJson(
      JSON.stringify({ application: { port: 99999 } }),
    );
    tmpDirs.push(dir);
    const outcome = await readConfig(dir);
    expect(outcome.kind).toBe("invalid");
  });
});
