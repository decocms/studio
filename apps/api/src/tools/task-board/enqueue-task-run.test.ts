import { describe, expect, it } from "bun:test";
import { withOrgTaskPrompt } from "./enqueue-task-run";

describe("withOrgTaskPrompt", () => {
  const run = { agent: { instructions: "You review PRs." }, prompt: "Do it." };

  it("leaves the run untouched when the org set no prompt", () => {
    expect(withOrgTaskPrompt(run, undefined, true)).toBe(run);
    expect(withOrgTaskPrompt(run, "", false)).toBe(run);
  });

  it("appends to the harness instructions on a sandbox run", () => {
    const out = withOrgTaskPrompt(run, "Use pnpm.", true);
    expect(out.agent.instructions).toBe("You review PRs.\n\nUse pnpm.");
    expect(out.prompt).toBe("Do it.");
  });

  it("is the only instruction when the run had no persona", () => {
    const bare: {
      agent: { instructions?: string } | undefined;
      prompt: string;
    } = { agent: undefined, prompt: "Do it." };
    const out = withOrgTaskPrompt(bare, "Use pnpm.", true);
    expect(out.agent?.instructions).toBe("Use pnpm.");
  });

  it("leads the prompt on a hosted run, where instructions would replace the agent's own", () => {
    const out = withOrgTaskPrompt(run, "Use pnpm.", false);
    expect(out.agent).toBe(run.agent);
    expect(out.prompt).toBe("Use pnpm.\n\nDo it.");
  });
});
