import { describe, expect, it } from "bun:test";
import type { AutomationsStorage } from "@/storage/automations";
import type { Automation, AutomationTrigger } from "@/storage/types";
import { AutomationEventDispatcher } from "./automation-event-dispatcher";
import type { ContextMessage } from "./dbos-workflow";

const automation = { id: "auto-1", name: "Test" } as unknown as Automation;

const trigger: AutomationTrigger & { automation: Automation } = {
  id: "trig-1",
  automation_id: "auto-1",
  type: "event",
  cron_expression: null,
  connection_id: "conn-1",
  event_type: "message",
  params: null,
  last_run_at: null,
  next_run_at: null,
  api_key_id: null,
  column_key: null,
  from_kind: null,
  from_statuses: [],
  created_at: new Date().toISOString(),
  automation,
};

function dispatcherFor(fire: (input: unknown) => Promise<void>) {
  const storage = {
    findActiveEventTriggers: async () => [trigger],
  } as unknown as AutomationsStorage;
  return new AutomationEventDispatcher(storage, fire as never);
}

async function fireOnce(data: unknown): Promise<ContextMessage> {
  const captured = new Promise<ContextMessage>((resolve) => {
    const dispatcher = dispatcherFor(async (input) => {
      const [message] = (input as { contextMessages: ContextMessage[] })
        .contextMessages;
      resolve(message!);
    });
    dispatcher.dispatchForEvents([
      { source: "conn-1", type: "message", data, organizationId: "org-1" },
    ]);
  });
  return captured;
}

describe("AutomationEventDispatcher.buildContextMessages", () => {
  it("passes small event data through untouched in both parts", async () => {
    const data = { hello: "world" };
    const message = await fireOnce(data);
    const dataPart = message.parts.find((p) => p.type === "data-trigger-event");
    expect(dataPart?.type).toBe("data-trigger-event");
    if (dataPart?.type === "data-trigger-event") {
      expect(dataPart.data.data).toEqual(data);
    }
  });

  it("bounds the persisted data-trigger-event part, not just the model-visible text", async () => {
    const huge = { blob: "x".repeat(2 * 1024 * 1024) };
    const message = await fireOnce(huge);
    const dataPart = message.parts.find((p) => p.type === "data-trigger-event");
    expect(dataPart?.type).toBe("data-trigger-event");
    if (dataPart?.type === "data-trigger-event") {
      expect(JSON.stringify(dataPart.data.data).length).toBeLessThan(1024);
    }
    const textPart = message.parts.find((p) => p.type === "text");
    expect(textPart?.type).toBe("text");
    if (textPart?.type === "text") {
      expect(textPart.text).toContain("[TRUNCATED]");
    }
  });
});
