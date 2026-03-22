import { describe, expect, it } from "bun:test";
import { PersistedRunConfigSchema } from "./run-config";

describe("PersistedRunConfigSchema", () => {
  const validConfig = {
    models: {
      credentialId: "cred_123",
      thinking: { id: "claude-3-5-sonnet" },
    },
    agent: { id: "agent_456" },
    temperature: 0.7,
    toolApprovalLevel: "auto" as const,
    windowSize: 50,
  };

  it("round-trips through JSON", () => {
    const json = JSON.stringify(validConfig);
    const parsed = PersistedRunConfigSchema.safeParse(JSON.parse(json));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(validConfig);
  });

  it("rejects missing required fields", () => {
    const result = PersistedRunConfigSchema.safeParse({ agent: { id: "x" } });
    expect(result.success).toBe(false);
  });

  it("accepts optional fields as undefined", () => {
    const { windowSize, ...minimal } = validConfig;
    const result = PersistedRunConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });
});
