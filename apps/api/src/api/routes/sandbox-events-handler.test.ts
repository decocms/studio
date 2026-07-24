import { describe, expect, test } from "bun:test";
import type { SandboxMap } from "@decocms/shared/sdk";
import { resolveSharedThreadVm } from "./sandbox-events-handler";

const BRANCH = "thread:0ced73dc/conn_u3zc";
const OWNER = "owner-user-id";
const VIEWER = "viewer-user-id";

function mapFor(userId: string): SandboxMap {
  return {
    [userId]: {
      [BRANCH]: {
        "agent-sandbox": {
          sandboxHandle: "conn-u3zc-d6f02ea54cdba440",
          previewUrl: "https://conn-u3zc-d6f02ea54cdba440.example.com/",
          sandboxProviderKind: "agent-sandbox",
        },
      },
    },
  };
}

describe("resolveSharedThreadVm", () => {
  test("finds the entry under the owner's key when the viewer has none", () => {
    // The regression: keying this lookup on the caller skipped the stale-handle
    // probe for a teammate's thread, so `gone` never fired and the preview sat
    // on "Reserving sandbox" forever.
    const found = resolveSharedThreadVm(mapFor(OWNER), BRANCH, "agent-sandbox");
    expect(found?.userId).toBe(OWNER);
    expect(found?.entry.sandboxHandle).toBe("conn-u3zc-d6f02ea54cdba440");
  });

  test("returns the viewer's own entry unchanged", () => {
    expect(
      resolveSharedThreadVm(mapFor(VIEWER), BRANCH, "agent-sandbox")?.userId,
    ).toBe(VIEWER);
  });

  test("returns null for another branch or another provider kind", () => {
    const map = mapFor(OWNER);
    expect(
      resolveSharedThreadVm(map, "thread:other/conn_x", "agent-sandbox"),
    ).toBeNull();
    expect(resolveSharedThreadVm(map, BRANCH, "user-desktop")).toBeNull();
  });

  test("returns null on an empty map", () => {
    expect(resolveSharedThreadVm({}, BRANCH, "agent-sandbox")).toBeNull();
  });
});
