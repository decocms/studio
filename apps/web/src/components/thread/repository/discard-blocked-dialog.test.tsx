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
  test("has the delete dialog's shape: one title, one short line per name, the pages with Open, and Close", async () => {
    const onClose = mock(() => {});
    const onOpen = mock((_row: unknown) => {});
    render(
      <DiscardBlockedDialog
        breaks={[
          { kind: "experiments", name: "promo", cause: "removes", rows: [row] },
          { kind: "campaigns", name: "bf", cause: "removes", rows: [row] },
          {
            kind: "campaigns",
            name: "xmas",
            cause: "returns",
            rows: [{ ...row, blockKey: "pages-sale", title: "Sale" }],
          },
        ]}
        onClose={onClose}
        onOpen={onOpen}
      />,
    );
    const dialog = within(within(document.body).getByTestId("discard-blocked"));
    expect(dialog.getByText("Please change these pages first.")).toBeTruthy();
    expect(dialog.getByText("They use the test “promo”.")).toBeTruthy();
    expect(dialog.getByText("They use the campaign “bf”.")).toBeTruthy();
    expect(
      dialog.getByText(
        "Discarding this brings back a variant that uses “xmas”, which your draft deleted.",
      ),
    ).toBeTruthy();
    const items = dialog.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Promo"),
      expect.stringContaining("Promo"),
      expect.stringContaining("Sale"),
    ]);
    // Each page opens in the site editor, as in Delete's dialog; the dialog
    // closes first.
    await act(async () =>
      fireEvent.click(within(items[2]!).getByRole("button", { name: /Open/ })),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ blockKey: "pages-sale" }),
    );
    const close = dialog
      .getAllByRole("button")
      .filter((b) => !b.classList.contains("hidden"))
      .filter((b) => b.textContent?.trim() !== "Open");
    expect(close.map((b) => b.textContent?.trim())).toEqual(["Close"]);
    await act(async () => fireEvent.click(close[0]!));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("speaks pt-br, as short as the English", () => {
    const keys = [
      "thread.publishPopover.discardBlocked.title",
      "thread.publishPopover.discardBlocked.usesTest",
      "thread.publishPopover.discardBlocked.usesCampaign",
      "thread.publishPopover.discardBlocked.returns",
      "thread.publishPopover.discardBlocked.close",
    ] as const;
    for (const key of keys) {
      expect(ptBR[key]).toBeTruthy();
      expect(ptBR[key]).not.toBe(en[key]);
    }
    expect(ptBR["thread.publishPopover.discardBlocked.title"]).toBe(
      "Altere estas páginas primeiro.",
    );
    expect(ptBR["thread.publishPopover.discardBlocked.usesTest"]).toBe(
      "Elas usam o teste “{name}”.",
    );
    expect(ptBR["thread.publishPopover.discardBlocked.usesCampaign"]).toBe(
      "Elas usam a campanha “{name}”.",
    );
    // One short line each: no "first … then" instructions.
    for (const key of keys) {
      expect(en[key]).not.toContain("then you can");
      expect(ptBR[key]).not.toContain("depois você pode");
    }
  });
});
