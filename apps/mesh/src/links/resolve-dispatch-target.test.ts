import { describe, expect, test } from "bun:test";
import type { LegacySandboxProviderKind } from "@decocms/sandbox/provider";
import { resolveDispatchTarget } from "./resolve-dispatch-target";

describe("resolveDispatchTarget", () => {
  test("agent-sandbox resolves to hosted execution", () => {
    expect(
      resolveDispatchTarget({ sandboxProviderKind: "agent-sandbox" }),
    ).toEqual({
      sandboxProviderKind: "agent-sandbox",
    });
  });

  test("legacy cluster normalizes to agent-sandbox", () => {
    expect(
      resolveDispatchTarget({
        sandboxProviderKind: "cluster" as LegacySandboxProviderKind,
      }),
    ).toEqual({ sandboxProviderKind: "agent-sandbox" });
  });

  test("user-desktop resolves to a desktop target with no liveness check", () => {
    expect(
      resolveDispatchTarget({ sandboxProviderKind: "user-desktop" }),
    ).toEqual({
      sandboxProviderKind: "user-desktop",
    });
  });
});
