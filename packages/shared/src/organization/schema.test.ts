import { describe, expect, it } from "bun:test";
import { DEFAULT_ON_FLAGS, orgFlagEnabled } from "./schema";

describe("orgFlagEnabled", () => {
  it("default-on flags read as enabled unless stored exactly false", () => {
    expect(DEFAULT_ON_FLAGS.has("qa_agent_enabled")).toBe(true);
    // unset / null / true → on; only explicit false opts out.
    expect(orgFlagEnabled(null, "qa_agent_enabled")).toBe(true);
    expect(orgFlagEnabled(undefined, "qa_agent_enabled")).toBe(true);
    expect(orgFlagEnabled({}, "qa_agent_enabled")).toBe(true);
    expect(orgFlagEnabled({ qa_agent_enabled: null }, "qa_agent_enabled")).toBe(
      true,
    );
    expect(orgFlagEnabled({ qa_agent_enabled: true }, "qa_agent_enabled")).toBe(
      true,
    );
    expect(
      orgFlagEnabled({ qa_agent_enabled: false }, "qa_agent_enabled"),
    ).toBe(false);
  });

  it("default-off flags read as disabled unless stored exactly true", () => {
    expect(DEFAULT_ON_FLAGS.has("auto_merge")).toBe(false);
    expect(orgFlagEnabled(null, "auto_merge")).toBe(false);
    expect(orgFlagEnabled(undefined, "auto_merge")).toBe(false);
    expect(orgFlagEnabled({}, "auto_merge")).toBe(false);
    expect(orgFlagEnabled({ auto_merge: null }, "auto_merge")).toBe(false);
    expect(orgFlagEnabled({ auto_merge: false }, "auto_merge")).toBe(false);
    expect(orgFlagEnabled({ auto_merge: true }, "auto_merge")).toBe(true);
  });

  it("a non-boolean stored value follows the branch's strict comparison", () => {
    // Reads hit raw jsonb, bypassing zod: only a strict boolean flips the gate.
    expect(
      orgFlagEnabled({ qa_agent_enabled: "true" }, "qa_agent_enabled"),
    ).toBe(true);
    expect(orgFlagEnabled({ auto_merge: "true" }, "auto_merge")).toBe(false);
  });
});
