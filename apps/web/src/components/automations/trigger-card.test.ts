import { describe, expect, test } from "bun:test";
import { swapCronTrigger } from "./trigger-card";

describe("swapCronTrigger", () => {
  test("adds the new schedule, then removes the old one", async () => {
    const calls: string[] = [];
    await swapCronTrigger({
      cronExpression: "0 */3 * * *",
      automationId: "automation-1",
      oldTriggerId: "old-trigger",
      addTrigger: async (input) => {
        calls.push(`add:${input.cron_expression}`);
        return { id: "new-trigger" };
      },
      removeTrigger: async (input) => {
        calls.push(`remove:${input.trigger_id}`);
      },
    });

    expect(calls).toEqual(["add:0 */3 * * *", "remove:old-trigger"]);
  });

  test("rolls the new trigger back when removing the old one fails", async () => {
    const removed: string[] = [];
    const attempt = swapCronTrigger({
      cronExpression: "0 */3 * * *",
      automationId: "automation-1",
      oldTriggerId: "old-trigger",
      addTrigger: async () => ({ id: "new-trigger" }),
      removeTrigger: async (input) => {
        removed.push(input.trigger_id);
        if (input.trigger_id === "old-trigger") {
          throw new Error("network blip");
        }
      },
    });

    await expect(attempt).rejects.toThrow("network blip");
    expect(removed).toEqual(["old-trigger", "new-trigger"]);
  });

  test("gives up quietly if the rollback itself fails", async () => {
    const removed: string[] = [];
    const attempt = swapCronTrigger({
      cronExpression: "0 */3 * * *",
      automationId: "automation-1",
      oldTriggerId: "old-trigger",
      addTrigger: async () => ({ id: "new-trigger" }),
      removeTrigger: async (input) => {
        removed.push(input.trigger_id);
        throw new Error(`cannot remove ${input.trigger_id}`);
      },
    });

    await expect(attempt).rejects.toThrow("cannot remove old-trigger");
    expect(removed).toEqual(["old-trigger", "new-trigger"]);
  });
});
