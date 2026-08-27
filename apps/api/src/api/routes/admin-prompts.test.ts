import { describe, expect, it } from "bun:test";
import { applyPromptEdits, PromptEditorError } from "./admin-prompts";

const REVIEWER_PATH = "apps/api/src/tools/task-board/enqueue-reviewer.ts";
const SUPER_AGENT_PATH = "apps/api/src/tools/task-board/enqueue-super-agent.ts";

const REVIEWER_SOURCE = [
  "const X = {",
  "  // prompt-region:start reviewer",
  '  reviewer: "be picky",',
  "  // prompt-region:end reviewer",
  "};",
  "",
].join("\n");

describe("applyPromptEdits", () => {
  it("splices an edit into its own region, leaving the surrounding source alone", () => {
    const sources = new Map([[REVIEWER_PATH, REVIEWER_SOURCE]]);
    applyPromptEdits(sources, [
      { id: "reviewer", content: '  reviewer: "be fast",' },
    ]);
    const next = sources.get(REVIEWER_PATH)!;
    expect(next).toContain('reviewer: "be fast"');
    expect(next).toContain("const X = {");
    expect(next).not.toContain("be picky");
  });

  // Reachable via a direct POST, bypassing the editor UI's own guard.
  it("throws a 409 PromptEditorError when the region drifted out of the source instead of a raw splice error", () => {
    const drifted = ["const X = {", '  reviewer: "be picky",', "};", ""].join(
      "\n",
    );
    const sources = new Map([[REVIEWER_PATH, drifted]]);

    let caught: unknown;
    try {
      applyPromptEdits(sources, [{ id: "reviewer", content: "x" }]);
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
      { id: "reviewer", content: '  reviewer: "be lenient",' },
      { id: "super-agent", content: 'hosted: "be slow",' },
    ]);
    expect(sources.get(REVIEWER_PATH)).toContain('reviewer: "be lenient"');
    expect(sources.get(SUPER_AGENT_PATH)).toContain('hosted: "be slow"');
  });
});
