import { expect, test } from "bun:test";
import { join } from "node:path";

test("cli harnesses do not import from decopilot namespace", async () => {
  const claude = await Bun.file(
    join(import.meta.dir, "claude-code/index.ts"),
  ).text();
  const codex = await Bun.file(join(import.meta.dir, "codex/index.ts")).text();
  expect(claude).not.toContain("../decopilot/");
  expect(codex).not.toContain("../decopilot/");
});
