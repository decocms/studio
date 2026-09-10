import { describe, expect, it } from "bun:test";
import { withOrgTaskPrompt } from "./enqueue-task-run";

type Agent = { instructions?: string; appendInstructions?: string };

describe("withOrgTaskPrompt", () => {
  const reviewer: { agent: Agent | undefined; prompt: string } = {
    agent: { instructions: "You review PRs." },
    prompt: "Do it.",
  };
  const superAgent: { agent: Agent | undefined; prompt: string } = {
    agent: undefined,
    prompt: "Do it.",
  };

  it("leaves the run untouched when the board has no prompt", () => {
    expect(withOrgTaskPrompt(reviewer, undefined, true)).toBe(reviewer);
    expect(withOrgTaskPrompt(reviewer, "", false)).toBe(reviewer);
  });

  it("rides as appendInstructions on a sandbox run", () => {
    const out = withOrgTaskPrompt(superAgent, "Use pnpm.", true);
    expect(out.agent?.appendInstructions).toBe("Use pnpm.");
    expect(out.prompt).toBe("Do it.");
  });

  /** The whole point of the append field: a Super Agent run sets no
   *  `instructions`, so writing the board prompt there would make
   *  dispatch-run's `input.agent.instructions ?? virtualMcp.instructions`
   *  resolve to the board prompt and silently drop the agent's own persona. */
  it("never sets instructions, so the agent's own survive", () => {
    const out = withOrgTaskPrompt(superAgent, "Use pnpm.", true);
    expect(out.agent?.instructions).toBeUndefined();
  });

  it("leaves an explicit persona override intact alongside the append", () => {
    const out = withOrgTaskPrompt(reviewer, "Use pnpm.", true);
    expect(out.agent?.instructions).toBe("You review PRs.");
    expect(out.agent?.appendInstructions).toBe("Use pnpm.");
  });

  it("leads the prompt on a hosted run, which reads no append field", () => {
    const out = withOrgTaskPrompt(reviewer, "Use pnpm.", false);
    expect(out.agent).toBe(reviewer.agent);
    expect(out.agent?.appendInstructions).toBeUndefined();
    expect(out.prompt).toBe("Use pnpm.\n\nDo it.");
  });
});
