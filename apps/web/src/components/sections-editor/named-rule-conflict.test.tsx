import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render as renderBare } from "@testing-library/react";
import type { ReactNode } from "react";
import "@testing-library/jest-dom";
import { en } from "@/i18n/en/index.ts";
import {
  askDeletedConflict,
  NamedRuleConflictHost,
} from "./named-rule-conflict";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

describe("askDeletedConflict", () => {
  for (const [label, answer] of [
    ["sectionsEditor.deletedConflict.keepMine", "mine"],
    ["sectionsEditor.deletedConflict.leaveDeleted", "theirs"],
  ] as const) {
    test(`"they deleted it" offers calm choices; ${en[label]} answers ${answer}`, async () => {
      const screen = render(<NamedRuleConflictHost />);
      let asked!: Promise<string>;
      act(() => {
        asked = askDeletedConflict({ kind: "theyDeleted", label: "Home" });
      });
      expect(
        await screen.findByText('"Home" was deleted while you were editing'),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: en[label] }));
      expect(await asked).toBe(answer);
      expect(screen.queryByTestId("deleted-conflict-dialog")).toBeNull();
    });
  }

  test('"you deleted it" offers "Delete anyway" / "Keep their version"', async () => {
    const screen = render(<NamedRuleConflictHost />);
    let asked!: Promise<string>;
    act(() => {
      asked = askDeletedConflict({ kind: "youDeleted", label: "Promo" });
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: en["sectionsEditor.deletedConflict.keepTheirs"],
      }),
    );
    expect(await asked).toBe("theirs");
  });
});
