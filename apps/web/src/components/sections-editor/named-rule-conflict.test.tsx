import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render as renderBare } from "@testing-library/react";
import type { ReactNode } from "react";
import "@testing-library/jest-dom";
import { en } from "@/i18n/en/index.ts";
import { authClient } from "@/lib/auth-client";
import { rememberConflictEditor } from "./conflict-author";
import { conflictFields, planFormConflict } from "./form-conflict";
import { askHostedConflict } from "./hosted-reconcile";
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

describe("askHostedConflict: an A/B test or campaign window names who made it", () => {
  const draft = { orgSlug: "acme", virtualMcpId: "p1", branch: "main" };
  const members = [
    { userId: "u-ana", user: { name: "Ana Souza" } },
    { userId: "u-me", user: { name: "Bea Lima" } },
    { userId: "u-nameless", user: { name: null } },
  ];
  // A hosted refusal carries the draft's copy of each refused block, and who
  // last changed it (`draft[name].editor`), recorded as the refusal is read.
  const refused = (
    queryClient: QueryClient,
    blockKey: string,
    block: unknown,
    userId?: string,
  ) =>
    rememberConflictEditor(queryClient, blockKey, {
      block,
      ...(userId
        ? { editor: { userId, at: Math.floor(Date.now() / 1000) - 120 } }
        : {}),
    });

  /** The window use-apply-named-rule.ts asks: one record keyed by block. */
  const ask = (
    blockKey: "experiments" | "campaigns",
    ancestor: Record<string, unknown>,
    mine: Record<string, unknown>,
    theirs: Record<string, unknown>,
    phrase: string,
  ) => {
    const plan = planFormConflict({
      ancestor: { [blockKey]: ancestor },
      mine: { [blockKey]: mine },
      theirs: { [blockKey]: theirs },
    });
    act(() => {
      void askHostedConflict(
        plan,
        null,
        { author: { draft, blockKey } },
        (field) => ({ ...field, label: phrase, phrase }),
      );
    });
  };

  const host = (queryClient: QueryClient, viewerId: string | null = null) => {
    queryClient.setQueryData(["acme", "members"], { data: { members } });
    // The viewer, as the session store holds them once signed in.
    const sessionAtom = authClient.$store.atoms.session;
    const realSession = sessionAtom?.get();
    const signedIn = {
      ...realSession,
      data: viewerId
        ? { session: { id: "s1", userId: viewerId }, user: { id: viewerId } }
        : null,
      isPending: false,
      error: null,
    };
    sessionAtom?.set(signedIn);
    // A session read still out (there is no server) lands as signed out:
    // the viewer stays signed in for the test.
    const unlisten = sessionAtom?.listen((now: { data?: unknown }) => {
      if (now.data !== signedIn.data) sessionAtom.set(signedIn);
    });
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      return Promise.reject(new Error("no read"));
    }) as unknown as typeof fetch;
    const screen = renderBare(<NamedRuleConflictHost />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });
    // Answers what is asked (an earlier test's question first, so each test
    // sees its own).
    const answerAll = () => {
      for (
        let ok = screen.queryByTestId("form-conflict-primary");
        ok;
        ok = screen.queryByTestId("form-conflict-primary")
      ) {
        fireEvent.click(ok);
      }
    };
    answerAll();
    return {
      screen,
      fetched,
      done: () => {
        answerAll();
        screen.unmount();
        globalThis.fetch = realFetch;
        unlisten?.();
        sessionAtom?.set(realSession);
      },
    };
  };

  test("their copy of the A/B test names Ana, in the title and on their card", async () => {
    const queryClient = new QueryClient();
    const theirs = { hero: { share: 10 } };
    refused(queryClient, "experiments", theirs, "u-ana");
    const { screen, fetched, done } = host(queryClient);
    try {
      ask(
        "experiments",
        { hero: { share: 50 } },
        { hero: { share: 60 } },
        theirs,
        'the A/B test "Hero test"',
      );
      expect(
        await screen.findByText(
          'Ana changed the A/B test "Hero test" while you were editing',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("radio", { name: "Ana Souza" }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Someone else/)).toBeNull();
      // Nothing was read to say who.
      expect(fetched).toEqual([]);
    } finally {
      done();
    }
  });

  test('the viewer\'s own change to a campaign: "You … in another tab or window"', async () => {
    const queryClient = new QueryClient();
    const theirs = { "black-friday": { start: "2026-11-27" } };
    refused(queryClient, "campaigns", theirs, "u-me");
    const { screen, done } = host(queryClient, "u-me");
    try {
      ask(
        "campaigns",
        { "black-friday": { start: "2026-11-20" } },
        { "black-friday": { start: "2026-11-21" } },
        theirs,
        'the dates of the campaign "Black Friday"',
      );
      expect(
        await screen.findByText(
          'You changed the dates of the campaign "Black Friday" in another tab or window',
        ),
      ).toBeInTheDocument();
      expect(
        await screen.findByRole("radio", {
          name: en["sectionsEditor.formConflict.youElsewhere"],
        }),
      ).toBeInTheDocument();
    } finally {
      done();
    }
  });

  for (const [why, userId] of [
    ["the refusal said no one", undefined],
    ["the member has no name", "u-nameless"],
  ] as const) {
    test(`${why}: no one is named`, async () => {
      const queryClient = new QueryClient();
      const theirs = { hero: { share: 10 } };
      refused(queryClient, "experiments", theirs, userId);
      const { screen, done } = host(queryClient);
      try {
        ask(
          "experiments",
          { hero: { share: 50 } },
          { hero: { share: 60 } },
          theirs,
          'the A/B test "Hero test"',
        );
        expect(
          await screen.findByText(
            'Someone else changed the A/B test "Hero test" while you were editing',
          ),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("radio", { name: "Someone else" }),
        ).toBeInTheDocument();
      } finally {
        done();
      }
    });
  }
});
