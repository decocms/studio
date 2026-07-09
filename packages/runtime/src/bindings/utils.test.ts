import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { ToolBinder } from "../mcp.ts";
import { Binding } from "./utils.ts";

const REQUIRED_TOOL = {
  name: "SEND_MESSAGE" as const,
  inputSchema: z.object({}),
};
const OPTIONAL_TOOL = {
  name: "READ_HISTORY" as const,
  inputSchema: z.object({}),
  opt: true as const,
};
// `Binding`'s type signature only accepts string-named binders, but its
// implementation also supports RegExp names at runtime — cast to exercise it.
const REGEX_TOOL = {
  name: /^EVENT_.*$/,
  inputSchema: z.object({}),
} as unknown as ToolBinder;

describe("Binding().isImplementedBy", () => {
  it("is true when every required tool is present", () => {
    const binding = Binding([REQUIRED_TOOL]);
    expect(binding.isImplementedBy([{ name: "SEND_MESSAGE" }])).toBe(true);
  });

  it("is false when a required tool is missing", () => {
    const binding = Binding([REQUIRED_TOOL]);
    expect(binding.isImplementedBy([{ name: "OTHER_TOOL" }])).toBe(false);
  });

  it("ignores optional tools that are missing", () => {
    const binding = Binding([REQUIRED_TOOL, OPTIONAL_TOOL]);
    expect(binding.isImplementedBy([{ name: "SEND_MESSAGE" }])).toBe(true);
  });

  it("matches a regex tool name against any implementing tool", () => {
    const binding = Binding([REGEX_TOOL]);
    expect(binding.isImplementedBy([{ name: "EVENT_PUBLISH" }])).toBe(true);
    expect(binding.isImplementedBy([{ name: "SEND_MESSAGE" }])).toBe(false);
  });

  it("requires an exact match, not a substring, for string tool names", () => {
    const binding = Binding([REQUIRED_TOOL]);
    expect(binding.isImplementedBy([{ name: "SEND_MESSAGE_EXTRA" }])).toBe(
      false,
    );
  });
});
