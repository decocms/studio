import { describe, expect, test } from "bun:test";

import {
  canMutateThread,
  canRenderInteractiveThreadApp,
  isHostedFirstSubmit,
  resolveThreadMutationAuthority,
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

describe("canMutateThread", () => {
  test("allows only an explicit authenticated new-thread state", () => {
    const authority = resolveThreadMutationAuthority(null, null);
    expect(authority).toEqual({ kind: "new" });
    expect(canMutateThread(authority, "viewer")).toBe(true);
    expect(canMutateThread(authority, null)).toBe(false);
  });

  test("allows an existing thread only for its creator", () => {
    const owned = resolveThreadMutationAuthority("thread", {
      id: "thread",
      created_by: "viewer",
    });
    const foreign = resolveThreadMutationAuthority("thread", {
      id: "thread",
      created_by: "owner",
    });
    expect(canMutateThread(owned, "viewer")).toBe(true);
    expect(canMutateThread(foreign, "viewer")).toBe(false);
  });

  test("fails closed while the requested row is missing or mismatched", () => {
    const missing = resolveThreadMutationAuthority("requested", null);
    const stale = resolveThreadMutationAuthority("requested", {
      id: "previous",
      created_by: "viewer",
    });
    expect(missing).toEqual({ kind: "unresolved" });
    expect(stale).toEqual({ kind: "unresolved" });
    expect(canMutateThread(missing, "viewer")).toBe(false);
    expect(canMutateThread(stale, "viewer")).toBe(false);
  });

  test("fails closed for missing identities on an existing row", () => {
    const missingCreator = resolveThreadMutationAuthority("thread", {
      id: "thread",
    });
    const nullCreator = resolveThreadMutationAuthority("thread", {
      id: "thread",
      created_by: null,
    });
    const owned = resolveThreadMutationAuthority("thread", {
      id: "thread",
      created_by: "owner",
    });
    expect(canMutateThread(missingCreator, "viewer")).toBe(false);
    expect(canMutateThread(nullCreator, "viewer")).toBe(false);
    expect(canMutateThread(owned, null)).toBe(false);
    expect(canMutateThread(owned, "")).toBe(false);
  });
});

describe("canRenderInteractiveThreadApp", () => {
  test("requires an explicit mutation grant", () => {
    expect(canRenderInteractiveThreadApp({ canMutateThread: true })).toBe(true);
    expect(canRenderInteractiveThreadApp({ canMutateThread: false })).toBe(
      false,
    );
    expect(canRenderInteractiveThreadApp({})).toBe(false);
    expect(canRenderInteractiveThreadApp(null)).toBe(false);
    expect(canRenderInteractiveThreadApp(undefined)).toBe(false);
  });
});

describe("isHostedFirstSubmit", () => {
  test("treats missing and unlocked rows as first submit", () => {
    expect(isHostedFirstSubmit(null)).toBe(true);
    expect(isHostedFirstSubmit({ routing_locked_at: null })).toBe(true);
  });

  test("treats a persisted routing lock as already submitted", () => {
    expect(
      isHostedFirstSubmit({ routing_locked_at: "2026-08-04T00:00:00.000Z" }),
    ).toBe(false);
  });
});
