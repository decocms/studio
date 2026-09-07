import { describe, expect, test } from "bun:test";
import { buildImprovePromptDoc } from "./build-improve-prompt-doc";
import { derivePartsFromTiptapDoc } from "../derive-parts";

const baseInput = {
  managerAgentId: "agent_mgr_123",
  managerName: "Agent Manager",
  kind: "agent" as const,
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
      id: "agent_mgr_123",
      name: "Agent Manager",
      char: "@",
      metadata: { agentId: "agent_mgr_123", title: "Agent Manager" },
    });

    expect(trailing?.type).toBe("text");
    expect(trailing?.text).toContain(
      'to improve the instructions of agent "vmcp_abc"',
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
    expect(text).toContain("Use @Agent Manager to improve the instructions");
    expect(text).toContain(
      "[DELEGATE TO AGENT: Agent Manager (agent_id: agent_mgr_123)]",
    );
    expect(text).toContain("subtask tool");
    expect(text).toContain("<current_instructions>");
  });

  test("handles automation kind", () => {
    const doc = buildImprovePromptDoc({
      managerAgentId: "agent_mgr_auto",
      managerName: "Automation Manager",
      kind: "automation",
      id: "auto_42",
      instructions: "ping every minute",
    });
    const trailing = doc.content?.[0]?.content?.[2]?.text ?? "";
    expect(trailing).toContain(
      'to improve the instructions of automation "auto_42"',
    );
    expect(trailing).toContain(
      "<current_instructions>ping every minute</current_instructions>",
    );
  });
});
