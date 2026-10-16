import { describe, expect, it } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import type { Automation } from "@/storage/types";
import {
  type FireAutomationContext,
  prepareFireStep,
  setAutomationRuntime,
} from "./dbos-workflow";

const FAKE_CTX = {} as StudioContext;

const automation: Automation = {
  id: "auto_1",
  organization_id: "org_1",
  name: "Jira rule",
  active: true,
  created_by: "user_gone",
  messages: "[]",
  models: '{"tier":"smart"}',
  tools: null,
  temperature: 1,
  max_agent_steps: null,
  virtual_mcp_id: "agent_1",
  system_key: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function runtimeWithMembers(members: Set<string>) {
  let deactivated = false;
  setAutomationRuntime({
    storage: {
      findById: async () => automation,
      deactivateAutomation: async () => {
        deactivated = true;
      },
    } as never,
    studioContextFactory: async (_orgId, userId) =>
      members.has(userId) ? FAKE_CTX : null,
  });
  return () => deactivated;
}

const manualJiraFire = (requestedBy: string): FireAutomationContext => ({
  automationId: automation.id,
  organizationId: automation.organization_id,
  triggerId: null,
  target: {
    kind: "jira",
    issues: ["OS-1"],
    eventKey: "manual:1",
    manual: { requestedBy },
  },
});

describe("prepareFireStep", () => {
  it("falls back to a manual fire's own requester when the creator left, without deactivating", async () => {
    const wasDeactivated = runtimeWithMembers(new Set(["user_present"]));
    const outcome = await prepareFireStep(manualJiraFire("user_present"));
    expect("skip" in outcome).toBe(false);
    expect(wasDeactivated()).toBe(false);
  });

  it("still deactivates an automatic (non-manual) fire whose creator left", async () => {
    const wasDeactivated = runtimeWithMembers(new Set());
    const outcome = await prepareFireStep({
      automationId: automation.id,
      organizationId: automation.organization_id,
      triggerId: null,
    });
    expect(outcome).toEqual({ skip: "creator_invalid" });
    expect(wasDeactivated()).toBe(true);
  });

  it("skips without deactivating when even the manual requester has left", async () => {
    const wasDeactivated = runtimeWithMembers(new Set());
    const outcome = await prepareFireStep(manualJiraFire("user_also_gone"));
    expect(outcome).toEqual({ skip: "creator_invalid" });
    expect(wasDeactivated()).toBe(false);
  });
});
