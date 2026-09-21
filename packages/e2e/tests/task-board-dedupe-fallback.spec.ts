import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

test("dedupe without a decision provider or fast model still creates the task", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const call = <T>(name: string, input: unknown) =>
    callSelfMcpTool<T>(page.context().request, orgSlug, name, input);
  const draft = {
    title: "Prevent duplicate invoice charges",
    repo: "acme/billing",
  };
  const original = await call<{ item: { id: string } }>(
    "TASK_BOARD_ITEM_CREATE",
    draft,
  );
  const result = await call<{
    item: { id: string; title: string };
    deduplicated: boolean;
    duplicateCheck: string;
    duplicateReason: string | null;
  }>("TASK_BOARD_ITEM_CREATE", { ...draft, onDuplicate: "return_existing" });

  expect(result.item.id).not.toBe(original.item.id);
  expect(result.item.title).toBe(draft.title);
  expect(result.deduplicated).toBe(false);
  expect(result.duplicateCheck).toBe("skipped");
  expect(result.duplicateReason).toContain(
    'No model available for tier "fast"',
  );
});
