import { describe, expect, it } from "bun:test";
import {
  extractPromptRegion,
  replacePromptRegion,
} from "./admin-prompt-region";

const SOURCE = [
  "const X = {",
  "  // prompt-region:start qa-agent",
  '  qa: "be thorough",',
  "  // prompt-region:end qa-agent",
  "};",
  "",
].join("\n");

describe("prompt regions", () => {
  it("extracts only the marked body", () => {
    expect(extractPromptRegion(SOURCE, "qa-agent")).toBe(
      '  qa: "be thorough",\n',
    );
  });

  it("returns null for an unknown region", () => {
    expect(extractPromptRegion(SOURCE, "nope")).toBeNull();
  });

  it("replaces the body and leaves the markers and the rest intact", () => {
    const next = replacePromptRegion(SOURCE, "qa-agent", '  qa: "be quick",');
    expect(next).toBe(
      [
        "const X = {",
        "  // prompt-region:start qa-agent",
        '  qa: "be quick",',
        "  // prompt-region:end qa-agent",
        "};",
        "",
      ].join("\n"),
    );
  });

  it("round-trips an extracted body unchanged", () => {
    const body = extractPromptRegion(SOURCE, "qa-agent");
    expect(replacePromptRegion(SOURCE, "qa-agent", body!)).toBe(SOURCE);
  });

  it("refuses to splice when the markers drifted away", () => {
    expect(() => replacePromptRegion(SOURCE, "gone", "x")).toThrow(
      'prompt region "gone" not found',
    );
  });
});

/**
 * A shorter id that is a prefix of a longer one's marker (e.g. "super-agent" /
 * "super-agent-sandbox", both real ids in the registry today) must not match
 * the longer marker's line — or an edit to the short id would splice into the
 * long id's region instead.
 */
describe("prompt regions with a prefix-colliding id", () => {
  const PREFIX_SOURCE = [
    "const X = {",
    "  // prompt-region:start super-agent-sandbox",
    '  sandbox: "be careful",',
    "  // prompt-region:end super-agent-sandbox",
    "  // prompt-region:start super-agent",
    '  hosted: "be quick",',
    "  // prompt-region:end super-agent",
    "};",
    "",
  ].join("\n");

  it("extracts the exact-id region, not the prefix-matching one", () => {
    expect(extractPromptRegion(PREFIX_SOURCE, "super-agent")).toBe(
      '  hosted: "be quick",\n',
    );
    expect(extractPromptRegion(PREFIX_SOURCE, "super-agent-sandbox")).toBe(
      '  sandbox: "be careful",\n',
    );
  });

  it("replaces only the exact-id region", () => {
    const next = replacePromptRegion(
      PREFIX_SOURCE,
      "super-agent",
      '  hosted: "be quick and safe",',
    );
    expect(next).toContain('sandbox: "be careful"');
    expect(next).toContain('hosted: "be quick and safe"');
  });
});

/**
 * The registry in `admin-prompts.ts` addresses prompts by marker id. A marker
 * deleted or renamed in a refactor turns the editor into "content: null" for
 * that prompt — silently, since nothing else reads these comments. This is the
 * test that fails instead.
 */
describe("the real prompt regions", () => {
  const REGIONS: Array<[string, string]> = [
    ["qa-agent", "../../tools/task-board/enqueue-reviewer.ts"],
    ["code-reviewer", "../../tools/task-board/enqueue-reviewer.ts"],
    ["super-agent", "../../tools/task-board/enqueue-super-agent.ts"],
    ["super-agent-sandbox", "../../tools/task-board/claude-code-task-run.ts"],
  ];

  for (const [id, relativePath] of REGIONS) {
    it(`round-trips ${id}`, async () => {
      const source = await Bun.file(
        new URL(relativePath, import.meta.url),
      ).text();
      const body = extractPromptRegion(source, id);
      expect(body).toBeTruthy();
      expect(replacePromptRegion(source, id, body!)).toBe(source);
    });
  }
});
