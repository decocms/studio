import { describe, expect, it } from "bun:test";
import {
  normalizeSandboxProviderKind,
  sandboxProviderKindSchema,
} from "./types";

describe("sandbox provider kind", () => {
  it("normalizes legacy cluster sandbox provider kind to agent-sandbox", () => {
    expect(normalizeSandboxProviderKind("cluster")).toBe("agent-sandbox");
    expect(normalizeSandboxProviderKind("agent-sandbox")).toBe("agent-sandbox");
    expect(normalizeSandboxProviderKind("user-desktop")).toBe("user-desktop");
  });

  it("accepts agent-sandbox as the hosted sandbox provider kind", () => {
    expect(sandboxProviderKindSchema.parse("agent-sandbox")).toBe(
      "agent-sandbox",
    );
  });
});
