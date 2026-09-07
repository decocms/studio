import { describe, expect, test } from "bun:test";
import { buildImprovePromptDoc } from "./build-improve-prompt-doc";
import { derivePartsFromTiptapDoc } from "../derive-parts";

const baseInput = {
  managerAgentId: "agent_mgr_auto",
  managerName: "Automation Manager",
  kind: "automation" as const,
  id: "vmcp_abc",
  instructions: "Help users with onboarding.\nBe concise.",
};

describe("buildImprovePromptDoc", () => {
  test("starts with leading text, then the manager mention, then the trailing payload", () => {
    const doc = buildImprovePromptDoc(baseInput);
    expect(doc.type).toBe("doc");
    const para = doc.content?.[0];
    expect(para?.type).toBe("paragraph");

    const [leading, mention, trailing] = para?.content ?? [];
    expect(leading?.type).toBe("text");
    expect(leading?.text).toBe("Use ");

    expect(mention?.type).toBe("mention");
    expect(mention?.attrs).toMatchObject({
      id: "agent_mgr_auto",
      name: "Automation Manager",
      char: "@",
      metadata: { agentId: "agent_mgr_auto", title: "Automation Manager" },
    });

    expect(trailing?.type).toBe("text");
    expect(trailing?.text).toContain(
      'to improve the instructions of automation "vmcp_abc"',
    );
    expect(trailing?.text).toContain("Here are its current instructions.");
    expect(trailing?.text).toContain(
      "<current_instructions>Help users with onboarding.\nBe concise.</current_instructions>",
    );
  });

  test("compiles through derivePartsFromTiptapDoc into a DELEGATE directive", () => {
    const doc = buildImprovePromptDoc(baseInput);
    const parts = derivePartsFromTiptapDoc(
      doc as Parameters<typeof derivePartsFromTiptapDoc>[0],
    );
    const text = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    expect(text).toContain(
      "Use @Automation Manager to improve the instructions",
    );
    expect(text).toContain(
      "[DELEGATE TO AGENT: Automation Manager (agent_id: agent_mgr_auto)]",
    );
    expect(text).toContain("subtask tool");
    expect(text).toContain("<current_instructions>");
  });

  /* No manager: the Super Agent owns the agent tools itself, so the agent
     editor sends this with no mention and no delegation directive. */
  test("omits the mention when no manager is given", () => {
    const doc = buildImprovePromptDoc({
      kind: "agent",
      id: "vmcp_abc",
      instructions: "Help users with onboarding.",
    });
    expect(doc.content?.[0]?.content).toHaveLength(1);
    const [only] = doc.content?.[0]?.content ?? [];
    expect(only?.type).toBe("text");
    expect(only?.text).toContain(
      'Improve the instructions of agent "vmcp_abc"',
    );

    const parts = derivePartsFromTiptapDoc(
      doc as Parameters<typeof derivePartsFromTiptapDoc>[0],
    );
    const text = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    expect(text).not.toContain("DELEGATE TO AGENT");
  });
});
