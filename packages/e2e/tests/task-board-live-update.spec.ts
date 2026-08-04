import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface TaskBoardItem {
  id: string;
  status: string;
}
interface WatchEvent {
  type: string;
  subject: string;
  data: { id: string; status: string };
}

declare global {
  interface Window {
    __watchEvents?: WatchEvent[];
  }
}

test.describe("task board live updates", () => {
  test("a tool-driven status change broadcasts over /watch", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Live update task" },
    );

    // The board's real listener: an EventSource on the app origin so the
    // session cookie rides along.
    await page.goto(`/${orgSlug}`);
    await page.evaluate(async (slug) => {
      const received: WatchEvent[] = [];
      window.__watchEvents = received;
      const es = new EventSource(
        `/api/${encodeURIComponent(slug)}/watch?types=task-board.item.updated`,
      );
      es.addEventListener("task-board.item.updated", (e) => {
        received.push(JSON.parse((e as MessageEvent).data) as WatchEvent);
      });
      if (es.readyState === EventSource.OPEN) return;
      await new Promise<void>((resolve, reject) => {
        es.onopen = () => resolve();
        es.onerror = () => reject(new Error("watch stream failed to open"));
      });
    }, orgSlug);

    // An agent moving its task to In Review goes straight through the tool —
    // there's no client mutation to invalidate, so the SSE push is the only
    // thing that moves the card without a page refresh.
    await call("TASK_BOARD_ITEM_UPDATE", { id: item.id, status: "in_review" });

    await expect
      .poll(() => page.evaluate(() => window.__watchEvents ?? []), {
        timeout: 10_000,
      })
      .toEqual([
        expect.objectContaining({
          subject: item.id,
          data: expect.objectContaining({ id: item.id, status: "in_review" }),
        }),
      ]);
  });
});
