import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import {
  act,
  fireEvent,
  render as rtlRender,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { en } from "@/i18n/en/index.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";
import { DiscardBlockedDialog } from "./discard-blocked-dialog";

const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

const row = {
  blockKey: "pages-promo",
  blockKind: "page" as const,
  title: "Promo",
  path: "/promo",
  variant: 2,
  wholeBlock: false,
  state: "published" as const,
};

describe("DiscardBlockedDialog", () => {
  test("says what to do first for each name, lists the pages, and closes with one button", async () => {
    const onClose = mock(() => {});
    render(
      <DiscardBlockedDialog
        breaks={[
          { kind: "experiments", name: "promo", cause: "removes", rows: [row] },
          {
            kind: "campaigns",
            name: "bf",
            cause: "returns",
            rows: [{ ...row, blockKey: "pages-sale", title: "Sale" }],
          },
        ]}
        onClose={onClose}
      />,
    );
    const dialog = within(within(document.body).getByTestId("discard-blocked"));
    expect(dialog.getByText("This change goes with another one")).toBeTruthy();
    expect(
      dialog.getByText(
        "These pages use the test “promo”, which discarding this would take away. First change those variants or discard those pages' changes; then you can discard this one.",
      ),
    ).toBeTruthy();
    expect(
      dialog.getByText(
        "Discarding this brings back a variant that uses the campaign “bf”, which your draft deleted. First discard the change to “Campaign dates” so the campaign comes back; then you can discard this one.",
      ),
    ).toBeTruthy();
    const items = dialog.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Promo"),
      expect.stringContaining("Sale"),
    ]);
    // Nothing opens from here; one Close.
    expect(dialog.queryByText("Open")).toBeNull();
    const close = dialog
      .getAllByRole("button")
      .filter((b) => !b.classList.contains("hidden"));
    expect(close.map((b) => b.textContent?.trim())).toEqual(["Close"]);
    await act(async () => fireEvent.click(close[0]!));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("speaks pt-br, naming the publish cards as the dialog shows them", () => {
    for (const key of [
      "thread.publishPopover.discardBlocked.title",
      "thread.publishPopover.discardBlocked.removesTest",
      "thread.publishPopover.discardBlocked.removesCampaign",
      "thread.publishPopover.discardBlocked.returnsTest",
      "thread.publishPopover.discardBlocked.returnsCampaign",
      "thread.publishPopover.discardBlocked.close",
    ] as const) {
      expect(ptBR[key]).toBeTruthy();
      expect(ptBR[key]).not.toBe(en[key]);
    }
    expect(ptBR["thread.publishPopover.discardBlocked.returnsTest"]).toContain(
      `“${ptBR["thread.publishPopover.abTests"]}”`,
    );
    expect(
      ptBR["thread.publishPopover.discardBlocked.returnsCampaign"],
    ).toContain(`“${ptBR["thread.publishPopover.campaignDates"]}”`);
    expect(en["thread.publishPopover.discardBlocked.returnsTest"]).toContain(
      `“${en["thread.publishPopover.abTests"]}”`,
    );
  });
});
