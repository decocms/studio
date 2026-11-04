import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render as renderBare } from "@testing-library/react";
import type { ReactNode } from "react";
import "@testing-library/jest-dom";
import { en } from "@/i18n/en/index.ts";
import { rememberConflictEditor } from "./conflict-author";
import { conflictFields, planFormConflict } from "./form-conflict";
import {
  askDeletedConflict,
  askNamedRuleConflict,
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

describe("askNamedRuleConflict on a hosted v8 draft", () => {
  test('names who changed it from the refusal: their name from the start, never "Someone else"', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["acme", "members"], {
      data: {
        members: [
          { userId: "u-demo", user: { name: "Demo" } },
          { userId: "u-demo2", user: { name: "Demo 2" } },
        ],
      },
    });
    const theirs = { experiments: { hero: 10 } };
    // The refused save carried the block's editor (`draft[name].editor`).
    rememberConflictEditor(queryClient, "experiments", {
      block: theirs,
      editor: { userId: "u-demo2", at: Math.floor(Date.now() / 1000) },
    });
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetched.push(String(input));
      return Promise.reject(new Error("no read"));
    }) as unknown as typeof fetch;
    try {
      const screen = renderBare(<NamedRuleConflictHost />, {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      });
      const plan = planFormConflict({
        ancestor: { experiments: { hero: 50 } },
        mine: { experiments: { hero: 60 } },
        theirs,
      });
      act(() => {
        void askNamedRuleConflict(
          plan,
          conflictFields(plan).map((field) => ({
            ...field,
            phrase: 'the A/B test "hero"',
          })),
          {
            author: {
              draft: { orgSlug: "acme", virtualMcpId: "p1", branch: "main" },
              blockKey: "experiments",
            },
          },
        );
      });
      expect(
        await screen.findByText(
          'Demo 2 changed the A/B test "hero" while you were editing',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Someone else/)).toBeNull();
      // Nothing was read to say who.
      expect(fetched).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
