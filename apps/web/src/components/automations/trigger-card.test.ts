import { describe, expect, it } from "bun:test";
import { swapCronTrigger } from "./trigger-card";

describe("swapCronTrigger", () => {
  it("adds the new trigger then removes the old one", async () => {
    const calls: string[] = [];
    await swapCronTrigger({
      cronExpression: "*/5 * * * *",
      automationId: "auto_1",
      oldTriggerId: "trig_old",
      addTrigger: async () => {
        calls.push("add");
        return { id: "trig_new", automation_id: "auto_1" };
      },
      removeTrigger: async ({ trigger_id }) => {
        calls.push(`remove:${trigger_id}`);
      },
    });
    expect(calls).toEqual(["add", "remove:trig_old"]);
  });

  it("rolls back the newly-added trigger when removing the old one fails", async () => {
    const removed: string[] = [];
    await expect(
      swapCronTrigger({
        cronExpression: "*/5 * * * *",
        automationId: "auto_1",
        oldTriggerId: "trig_old",
        addTrigger: async () => ({ id: "trig_new", automation_id: "auto_1" }),
        removeTrigger: async ({ trigger_id }) => {
          removed.push(trigger_id);
          if (trigger_id === "trig_old") throw new Error("network blip");
        },
      }),
    ).rejects.toThrow("network blip");
    expect(removed).toEqual(["trig_old", "trig_new"]);
  });

  it("does not throw if the rollback removal itself fails", async () => {
    await expect(
      swapCronTrigger({
        cronExpression: "*/5 * * * *",
        automationId: "auto_1",
        oldTriggerId: "trig_old",
        addTrigger: async () => ({ id: "trig_new", automation_id: "auto_1" }),
        removeTrigger: async () => {
          throw new Error("network blip");
        },
      }),
    ).rejects.toThrow("network blip");
  });
});
