/**
 * E2E: the deck preview tab (`?main=deck:<encoded path>`) renders a deck
 * stored in the org-fs home volume through the real `<deck-viewer>`
 * runtime, and inline edits made in the sandboxed iframe round-trip back
 * into the file via the DeckTab editor (op → applyDeckOp → org-fs PUT).
 *
 * No agent/sandbox involved — the deck is seeded straight through the
 * org-fs HTTP API, which is the same surface the sandbox mount writes
 * through.
 */
import { expect, test } from "../fixtures/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";

const DECK_PATH = "decks/e2e-test.html";

/** Minimal real deck: theme-less but uses the actual runtime script. */
const DECK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>E2E Deck</title>
<style>
  section { background: #fff; color: #111; padding: 120px; font-family: sans-serif; }
  h1, h2 { font-size: 96px; margin: 0; }
</style>
</head>
<body>
<deck-viewer width="1920" height="1080">
<section><h1>Alpha</h1></section>
<section><h2>Beta</h2></section>
<section><h2>Gamma</h2></section>
</deck-viewer>
<script src="/deck-runtime/v1/deck-viewer.js"></script>
</body>
</html>
`;

test.describe("deck preview tab", () => {
  test("renders the deck and persists an inline structural edit", async ({
    authedPage,
  }) => {
    // Cold dev-server boot + iframe handshake + save debounces add up;
    // triple the budget so a busy host doesn't flake the save poll.
    test.slow();
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    // Seed the deck in the home volume (same write surface the sandbox
    // mount uses).
    const put = await api.put(
      `/api/${orgSlug}/fs/home/file?path=${encodeURIComponent(DECK_PATH)}`,
      {
        data: DECK_HTML,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
    expect(put.ok()).toBe(true);

    // A thread context to host the main panel.
    const agent = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "deck e2e",
          description: "deck preview spec",
          status: "active",
          pinned: false,
          connections: [],
        },
      },
    );
    const thread = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_THREADS_CREATE",
      { data: { virtual_mcp_id: agent.item.id } },
    );

    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${agent.item.id}&main=deck:${encodeURIComponent(DECK_PATH)}`,
    );

    // The deck pill labels the tab with the deck name. Generous timeout:
    // first paint pays the Vite dev-server cold transform.
    await expect(page.getByText("e2e-test").first()).toBeVisible({
      timeout: 30_000,
    });

    // The runtime renders inside the sandboxed iframe (Playwright pierces
    // the shadow DOM): slide 1 active, slide count in the rail.
    const frame = page.frameLocator(`iframe[title="${DECK_PATH}"]`);
    await expect(frame.locator("section[data-deck-active] h1")).toHaveText(
      "Alpha",
      { timeout: 15_000 },
    );
    await expect(frame.locator(".thumb")).toHaveCount(3);

    // The floating release-announcement card (parent page, fixed bottom-
    // right) overlaps the iframe and intercepts clicks aimed at in-iframe
    // chrome — dismiss it if present.
    const dismissRelease = page.getByRole("button", {
      name: "Dismiss release announcement",
    });
    if (await dismissRelease.isVisible().catch(() => false)) {
      await dismissRelease.click();
    }

    // Releasing a workspace resize over an iframe used to leave the panel
    // group's drag state active forever. The library then kept
    // `pointer-events: none` on the panels, so the framed page still painted
    // but no longer accepted clicks or keyboard focus.
    const resizeHandle = page.locator('[data-slot="resizable-handle"]').first();
    const iframe = page.locator(`iframe[title="${DECK_PATH}"]`);
    const mainResizablePanel = page
      .getByTestId("main-panel")
      .locator("xpath=ancestor::*[@data-panel][1]");
    const resizeHandleBox = await resizeHandle.boundingBox();
    const iframeBox = await iframe.boundingBox();
    expect(resizeHandleBox).not.toBeNull();
    expect(iframeBox).not.toBeNull();
    if (!resizeHandleBox || !iframeBox) {
      throw new Error("Resize handle and preview iframe must be visible");
    }

    const resizeX = resizeHandleBox.x + resizeHandleBox.width / 2;
    const resizeY = iframeBox.y + iframeBox.height / 2;
    await page.mouse.move(resizeX, resizeY);
    await page.mouse.down();
    // Establish the drag while still over the parent document. v4 captures the
    // pointer on this first movement so the later iframe crossing cannot steal
    // the release event.
    await page.mouse.move(resizeX - 4, resizeY);
    await expect(mainResizablePanel).toHaveCSS("pointer-events", "none");
    await page.mouse.move(iframeBox.x + 40, resizeY, { steps: 10 });
    await page.mouse.up();
    await expect(mainResizablePanel).toHaveCSS("pointer-events", "auto");

    // Enter edit mode and delete slide 2 via the rail context menu.
    await page.getByRole("button", { name: "Edit inline" }).click();
    const activeSlide = frame.locator("section[data-deck-active]");
    await expect(activeSlide).toHaveAttribute("contenteditable", "true");
    // Prove the iframe is interactive again, not merely that its parent style
    // changed: a real click must reach and focus its contenteditable slide.
    await activeSlide.click({ position: { x: 20, y: 20 } });
    await expect(activeSlide).toBeFocused();

    await frame.locator(".thumb").nth(1).click({ button: "right" });
    await frame.locator('[data-act="delete"]').click();
    await frame.locator(".confirm .danger").click();

    // Optimistic: the rail drops to 2 immediately.
    await expect(frame.locator(".thumb")).toHaveCount(2);

    // The op debounce-saves (400ms) into org-fs; poll the file until the
    // section is gone from the source of truth.
    await expect
      .poll(
        async () => {
          const res = await api.get(
            `/api/${orgSlug}/fs/home/read?path=${encodeURIComponent(DECK_PATH)}`,
          );
          return res.ok() ? await res.text() : "";
        },
        { timeout: 10_000 },
      )
      .not.toContain("Beta");

    // The surviving slides are intact in the persisted HTML.
    const saved = await (
      await api.get(
        `/api/${orgSlug}/fs/home/read?path=${encodeURIComponent(DECK_PATH)}`,
      )
    ).text();
    expect(saved).toContain("Alpha");
    expect(saved).toContain("Gamma");
    expect(saved).toContain("deck-runtime/v1/deck-viewer.js");
  });
});
