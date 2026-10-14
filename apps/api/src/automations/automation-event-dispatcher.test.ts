/**
 * The event payload cap must bound the UTF-8 BYTE size sent to the model,
 * not the JS string length — a payload full of multi-byte characters can be
 * well under the character cap yet far over the byte cap.
 */

import { describe, expect, it } from "bun:test";
import type { AutomationsStorage } from "@/storage/automations";
import type { Automation, AutomationTrigger } from "@/storage/types";
import { AutomationEventDispatcher } from "./automation-event-dispatcher";

function stubStorage(
  triggers: (AutomationTrigger & { automation: Automation })[],
): AutomationsStorage {
  return {
    findActiveEventTriggers: async () => triggers,
  } as unknown as AutomationsStorage;
}

describe("AutomationEventDispatcher payload truncation", () => {
  it("caps the event-data text part at the UTF-8 byte budget", async () => {
    const trigger = {
      id: "trig_1",
      params: null,
      automation: { id: "auto_1", name: "test" },
    } as unknown as AutomationTrigger & { automation: Automation };

    let text = "";
    const dispatcher = new AutomationEventDispatcher(
      stubStorage([trigger]),
      async ({ contextMessages }) => {
        const part = contextMessages[0]!.parts.find((p) => p.type === "text");
        text = part && "text" in part ? part.text : "";
      },
    );

    // 4-byte-per-char emoji keeps JS string length far under the byte cap.
    const data = { blob: "\u{1F600}".repeat(400_000) };
    dispatcher.dispatchForEvents([
      {
        source: "test",
        type: "test.event",
        data,
        organizationId: "org_1",
      },
    ]);

    await new Promise((r) => setTimeout(r, 0));

    const begin = text.indexOf("---BEGIN EVENT DATA---");
    const end = text.indexOf("---END EVENT DATA---");
    const serialized = text
      .slice(begin + "---BEGIN EVENT DATA---".length, end)
      .trim();
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      1_048_576,
    );
  });
});
