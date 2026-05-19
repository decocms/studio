import { describe, expect, test } from "bun:test";
import { KEYS } from "../../../lib/query-keys";

describe("thread cache-key contract", () => {
  test("filter dimensions are never part of the key", () => {
    const a = KEYS.threads("loc", "org");
    const b = KEYS.threads("loc", "org");
    expect(a).toEqual(b);
  });

  test("scope distinguishes keys", () => {
    const org = KEYS.threads("loc", "org");
    const agent = KEYS.threads("loc", {
      kind: "agent",
      virtualMcpId: "v1",
    });
    expect(org).not.toEqual(agent);
  });

  test("agents are distinguished by virtualMcpId", () => {
    const v1 = KEYS.threads("loc", { kind: "agent", virtualMcpId: "v1" });
    const v2 = KEYS.threads("loc", { kind: "agent", virtualMcpId: "v2" });
    expect(v1).not.toEqual(v2);
  });

  test("threadsPrefix matches both scopes", () => {
    const prefix = KEYS.threadsPrefix("loc");
    const org = KEYS.threads("loc", "org");
    const agent = KEYS.threads("loc", {
      kind: "agent",
      virtualMcpId: "v1",
    });
    expect(org.slice(0, prefix.length)).toEqual([...prefix]);
    expect(agent.slice(0, prefix.length)).toEqual([...prefix]);
  });
});
