import { describe, expect, test } from "bun:test";
import type { SandboxMap, SandboxRecord } from "@decocms/shared/sdk/types";
import { withoutLegacyAgentSandboxEntries } from "./agent-sandbox-map";

const TAVANO = "sDGY2MbZs5Izp9FnbYOpRclDjd8MtWTB";
const BRANCH = "tavano-vgfdyxrm";

/** `cluster` is accepted for the legacy-spelling case; it normalizes to
 *  agent-sandbox, so the stored record still carries a valid kind. */
function record(
  handle: string,
  kind: "agent-sandbox" | "user-desktop" | "cluster",
): SandboxRecord {
  return {
    sandboxHandle: handle,
    previewUrl: `https://${handle}.preview-studio.decocms.com/`,
    sandboxApiUrl: `https://${handle}.preview-studio.decocms.com/`,
    sandboxProviderKind: kind === "cluster" ? "agent-sandbox" : kind,
  };
}

describe("withoutLegacyAgentSandboxEntries", () => {
  test("strips the leftover agent-sandbox entry that suppressed auto-start", () => {
    // The regression: this entry pointed at a reaped sandbox, made `vmEntry`
    // non-null for the one user whose key held it, and so no SANDBOX_START was
    // ever issued for them.
    const map = {
      [TAVANO]: {
        [BRANCH]: {
          "agent-sandbox": record("tavano-vgfdyxrm-77c2", "agent-sandbox"),
        },
      },
    } as unknown as SandboxMap;
    expect(withoutLegacyAgentSandboxEntries(map)).toEqual({});
  });

  test("strips the legacy `cluster` spelling too", () => {
    // `parseBranchMap` normalizes `cluster` to agent-sandbox, so leaving it
    // would reintroduce the bug through the back door.
    const map = {
      [TAVANO]: { [BRANCH]: { cluster: record("legacy-abcd", "cluster") } },
    } as unknown as SandboxMap;
    expect(withoutLegacyAgentSandboxEntries(map)).toEqual({});
  });

  test("keeps user-desktop entries and drops only the agent-sandbox sibling", () => {
    const desktop = record("desk-1234", "user-desktop");
    const map = {
      [TAVANO]: {
        [BRANCH]: {
          "agent-sandbox": record("tavano-vgfdyxrm-77c2", "agent-sandbox"),
          "user-desktop": desktop,
        },
      },
    } as unknown as SandboxMap;
    expect(withoutLegacyAgentSandboxEntries(map)).toEqual({
      [TAVANO]: { [BRANCH]: { "user-desktop": desktop } },
    });
  });

  test("leaves sibling branches and other users intact", () => {
    const desktop = record("desk-1234", "user-desktop");
    const map = {
      [TAVANO]: {
        [BRANCH]: { "agent-sandbox": record("dead-77c2", "agent-sandbox") },
        "other-branch": { "user-desktop": desktop },
      },
      "other-user": { [BRANCH]: { "user-desktop": desktop } },
    } as unknown as SandboxMap;
    expect(withoutLegacyAgentSandboxEntries(map)).toEqual({
      [TAVANO]: { "other-branch": { "user-desktop": desktop } },
      "other-user": { [BRANCH]: { "user-desktop": desktop } },
    });
  });

  test("returns the same reference when there is nothing to strip", () => {
    const map = {
      [TAVANO]: {
        [BRANCH]: { "user-desktop": record("desk-1", "user-desktop") },
      },
    } as unknown as SandboxMap;
    expect(withoutLegacyAgentSandboxEntries(map)).toBe(map);
  });

  test("passes undefined through", () => {
    expect(withoutLegacyAgentSandboxEntries(undefined)).toBeUndefined();
  });
});
