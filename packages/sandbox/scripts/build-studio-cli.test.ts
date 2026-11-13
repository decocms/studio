import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillMd } from "@decocms/shared/harness/skill-md";

let root: string;
let out: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-cli-build-"));
  out = join(root, "decocms");
  // A separate process, as the image build runs it: inside `bun test`,
  // Bun.build resolves the CLI's dependencies differently (zod's v3 entry).
  const build = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "build-studio-cli.ts"), out],
    { stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Runs the bundle the way the image's shim does, from a cwd with no node_modules to fall back on. */
function run(...args: string[]) {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "--config=/dev/null",
      join(out, "bin/decocms.js"),
      ...args,
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH, DECOCMS_HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("the sandbox decocms CLI build", () => {
  it("runs standalone and reports this revision's version", () => {
    const apiVersion = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../apps/api/package.json"),
        "utf8",
      ),
    ).version;
    expect(run("--version")).toMatchObject({
      code: 0,
      stdout: `Deco CMS v${apiVersion}\n`,
    });
  });

  it("reaches the client commands", () => {
    const tools = run("tools", "list", "--org", "my-org");
    expect(tools.code).toBe(1);
    expect(tools.stderr).toContain("Not logged in");
  });

  it("stubs the server-only backfill command instead of bundling the server", () => {
    const backfill = run("backfill-assets");
    expect(backfill.code).toBe(1);
    expect(backfill.stderr).toContain("not this CLI build");
  });

  it("ships the decocms-studio skill as a plugin", () => {
    const skill = join(out, "plugin/skills/decocms-studio");
    expect(existsSync(join(out, "plugin/.claude-plugin/plugin.json"))).toBe(
      true,
    );
    expect(existsSync(join(skill, "rest.md"))).toBe(true);
    const meta = parseSkillMd(readFileSync(join(skill, "SKILL.md"), "utf8"));
    expect(meta.name).toBe("decocms-studio");
    expect(meta.disableModelInvocation).toBe(false);
  });
});
