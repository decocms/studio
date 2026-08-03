import { describe, expect, test } from "bun:test";

import {
  isHostedFirstSubmit,
  resolveThreadVirtualMcpId,
} from "./thread-authority";

describe("resolveThreadVirtualMcpId", () => {
  test("uses the persisted thread agent over a stale URL query", () => {
    expect(
      resolveThreadVirtualMcpId(
        { virtual_mcp_id: "canonical-agent" },
        "stale-query-agent",
      ),
    ).toBe("canonical-agent");
  });

  test("uses the URL agent only as a missing-thread creation hint", () => {
    expect(resolveThreadVirtualMcpId(null, "new-thread-agent")).toBe(
      "new-thread-agent",
    );
  });

  test("does not borrow the URL identity for a malformed existing row", () => {
    expect(resolveThreadVirtualMcpId({}, "stale-query-agent")).toBe("");
  });
});

describe("isHostedFirstSubmit", () => {
  test("treats missing and unpinned rows as first submit", () => {
    expect(isHostedFirstSubmit(null)).toBe(true);
    expect(isHostedFirstSubmit({ harness_id: null })).toBe(true);
  });

  test("treats every persisted harness as locked", () => {
    expect(isHostedFirstSubmit({ harness_id: "decopilot" })).toBe(false);
    expect(isHostedFirstSubmit({ harness_id: "codex" })).toBe(false);
  });
});
