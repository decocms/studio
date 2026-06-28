import { expect, test } from "bun:test";

test("cli harnesses do not import from decopilot namespace", async () => {
  const claude = await Bun.file(
    "packages/harness/src/claude-code/index.ts",
  ).text();
  const codex = await Bun.file("packages/harness/src/codex/index.ts").text();
  expect(claude).not.toContain("../decopilot/");
  expect(codex).not.toContain("../decopilot/");
});
