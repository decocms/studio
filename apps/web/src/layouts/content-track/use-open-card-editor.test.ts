import { describe, expect, test } from "bun:test";
import { cardEditorThreadId } from "./use-open-card-editor";

describe("cardEditorThreadId", () => {
  test("is the same chat every time a person opens the same card", async () => {
    const first = await cardEditorThreadId("org_1", "card1", "user_1");
    expect(first).toBe(await cardEditorThreadId("org_1", "card1", "user_1"));
    expect(first).toMatch(/^thrd_[0-9a-f]{32}$/);
  });

  test("a teammate, another card or another organization gets its own", async () => {
    const mine = await cardEditorThreadId("org_1", "card1", "user_1");
    expect(await cardEditorThreadId("org_1", "card1", "user_2")).not.toBe(mine);
    expect(await cardEditorThreadId("org_1", "card2", "user_1")).not.toBe(mine);
    expect(await cardEditorThreadId("org_2", "card1", "user_1")).not.toBe(mine);
  });
});
