import { describe, expect, it } from "bun:test";
import type { SandboxMap, SandboxRecord } from "@decocms/shared/sdk";
import { selectAgentSandboxRecord } from "./agent-sandbox-record";

const USER_ID = "user_1";
const BRANCH = "thread:thread_1";

function record(
  sandboxHandle: string,
  sandboxProviderKind: SandboxRecord["sandboxProviderKind"],
): SandboxRecord {
  return {
    sandboxHandle,
    previewUrl: null,
    sandboxProviderKind,
  };
}

function map(branchMap: Record<string, unknown>): SandboxMap {
  return {
    [USER_ID]: {
      [BRANCH]: branchMap,
    },
  } as unknown as SandboxMap;
}

describe("selectAgentSandboxRecord", () => {
  it("selects the canonical agent-sandbox cell", () => {
    const entry = record("hosted", "agent-sandbox");

    expect(
      selectAgentSandboxRecord(
        map({ "agent-sandbox": entry }),
        USER_ID,
        BRANCH,
      ),
    ).toEqual(entry);
  });

  it("stamps an absent provider kind from the agent-sandbox key", () => {
    expect(
      selectAgentSandboxRecord(
        map({
          "agent-sandbox": {
            sandboxHandle: "hosted-without-kind",
            previewUrl: null,
          },
        }),
        USER_ID,
        BRANCH,
      ),
    ).toEqual({
      sandboxHandle: "hosted-without-kind",
      previewUrl: null,
      sandboxProviderKind: "agent-sandbox",
    });
  });

  it("normalizes a legacy cluster cell and embedded kind", () => {
    expect(
      selectAgentSandboxRecord(
        map({
          cluster: {
            sandboxHandle: "legacy-hosted",
            previewUrl: null,
            sandboxProviderKind: "cluster",
          },
        }),
        USER_ID,
        BRANCH,
      ),
    ).toEqual({
      sandboxHandle: "legacy-hosted",
      previewUrl: null,
      sandboxProviderKind: "agent-sandbox",
    });
  });

  it("selects the hosted record when a valid desktop sibling also exists", () => {
    const hosted = record("hosted", "agent-sandbox");

    expect(
      selectAgentSandboxRecord(
        map({
          "agent-sandbox": hosted,
          "user-desktop": record("desktop", "user-desktop"),
        }),
        USER_ID,
        BRANCH,
      ),
    ).toEqual(hosted);
  });

  it("does not fall back to a desktop sibling", () => {
    expect(
      selectAgentSandboxRecord(
        map({ "user-desktop": record("desktop", "user-desktop") }),
        USER_ID,
        BRANCH,
      ),
    ).toBeNull();
  });

  it("rejects a desktop record stored under the hosted key", () => {
    expect(
      selectAgentSandboxRecord(
        map({ "agent-sandbox": record("desktop", "user-desktop") }),
        USER_ID,
        BRANCH,
      ),
    ).toBeNull();
  });

  it("does not fall back to a legacy cell when the hosted cell is desktop", () => {
    expect(
      selectAgentSandboxRecord(
        map({
          "agent-sandbox": record("desktop", "user-desktop"),
          cluster: {
            sandboxHandle: "legacy-hosted",
            previewUrl: null,
            sandboxProviderKind: "cluster",
          },
        }),
        USER_ID,
        BRANCH,
      ),
    ).toBeNull();
  });
});
