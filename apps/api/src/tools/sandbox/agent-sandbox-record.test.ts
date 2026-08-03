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

function map(branchMap: Record<string, SandboxRecord>): SandboxMap {
  return {
    [USER_ID]: {
      [BRANCH]: branchMap as SandboxMap[string][string],
    },
  };
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
});
