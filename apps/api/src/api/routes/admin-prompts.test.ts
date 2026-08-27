import { describe, expect, it } from "bun:test";
import { applyPromptEdits, PromptEditorError } from "./admin-prompts";

const REVIEWER_PATH = "apps/api/src/tools/task-board/enqueue-reviewer.ts";
const SUPER_AGENT_PATH = "apps/api/src/tools/task-board/enqueue-super-agent.ts";

const REVIEWER_SOURCE = [
  "const X = {",
  "  // prompt-region:start qa-agent",
  '  qa: "be thorough",',
  "  // prompt-region:end qa-agent",
  "  // prompt-region:start code-reviewer",
  '  review: "be picky",',
  "  // prompt-region:end code-reviewer",
  "};",
  "",
].join("\n");

describe("applyPromptEdits", () => {
  it("splices an edit into its own region and leaves siblings sharing the file untouched", () => {
    const sources = new Map([[REVIEWER_PATH, REVIEWER_SOURCE]]);
    applyPromptEdits(sources, [
      { id: "qa-agent", content: '  qa: "be fast",' },
    ]);
    const next = sources.get(REVIEWER_PATH)!;
    expect(next).toContain('qa: "be fast"');
    expect(next).toContain('review: "be picky"');
  });

  // Reachable via a direct POST, bypassing the editor UI's own guard.
  it("throws a 409 PromptEditorError when the region drifted out of the source instead of a raw splice error", () => {
    const drifted = [
      "const X = {",
      "  // prompt-region:start code-reviewer",
      '  review: "be picky",',
      "  // prompt-region:end code-reviewer",
      "};",
      "",
    ].join("\n");
    const sources = new Map([[REVIEWER_PATH, drifted]]);

    let caught: unknown;
    try {
      applyPromptEdits(sources, [{ id: "qa-agent", content: "x" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PromptEditorError);
    expect((caught as InstanceType<typeof PromptEditorError>).status).toBe(409);
  });

  it("applies edits across different files independently", () => {
    const sources = new Map([
      [REVIEWER_PATH, REVIEWER_SOURCE],
      [
        SUPER_AGENT_PATH,
        [
          "// prompt-region:start super-agent",
          'hosted: "be quick",',
          "// prompt-region:end super-agent",
          "",
        ].join("\n"),
      ],
    ]);
    applyPromptEdits(sources, [
      { id: "code-reviewer", content: '  review: "be lenient",' },
      { id: "super-agent", content: 'hosted: "be slow",' },
    ]);
    expect(sources.get(REVIEWER_PATH)).toContain('review: "be lenient"');
    expect(sources.get(SUPER_AGENT_PATH)).toContain('hosted: "be slow"');
  });
});
