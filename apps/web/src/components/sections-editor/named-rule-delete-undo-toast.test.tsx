import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import type { TFunction } from "@/i18n/use-t.ts";
import { NamedRuleDeleteButton } from "./named-rule-delete";
import {
  SAVE_TOAST,
  SITE_EDITOR_SAVE_TOAST,
  toastSaveError,
} from "./site-editor-toast";

// Real sonner, no spies: sonner merges a toast into the one with the same id
// (even one already closed), so what the delete toast sets is what a later
// toast with that id would inherit.
//
// The draft holds "spare" when Delete reads it, and no longer when Undo does.
const drafts = [
  { experiments: { __resolveType: "split-traffic", hero: 50, spare: 10 } },
  { experiments: { __resolveType: "split-traffic", hero: 50 } },
];

const saveToast = () =>
  toast.getToasts().find((item) => item.id === SITE_EDITOR_SAVE_TOAST) as
    | {
        action?: unknown;
        cancel?: unknown;
        description?: unknown;
        title?: unknown;
      }
    | undefined;

describe("the delete toast's Undo", () => {
  test("never stays on a later save toast", async () => {
    const onUndo = mock(() => {});
    let reads = 0;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NamedRuleDeleteButton
          kind="experiments"
          name="spare"
          meta={null}
          pending={false}
          apply={async () => ({ ok: true })}
          reread={async () => drafts[Math.min(reads++, 1)]!}
          onDeleted={() => {}}
          onUndo={onUndo}
        />
      </QueryClientProvider>,
    );
    const button = within(document.body).getByRole("button", {
      name: "Delete test",
    });
    await act(async () => fireEvent.click(button));

    const deleted = toast
      .getToasts()
      .find(
        (item) =>
          "title" in item &&
          item.title === "Test “spare” deleted from your draft",
      ) as { action?: { label: string; onClick: (e: unknown) => void } };
    expect(deleted?.action?.label).toBe("Undo");

    // Undo's own outcome, and every later save toast, reuse the save id.
    await act(async () =>
      deleted.action!.onClick({ preventDefault() {}, defaultPrevented: false }),
    );
    expect(onUndo).toHaveBeenCalledTimes(1);
    // As named-rule-view.tsx's save() and sections-editor.tsx's pick do.
    toast.success("Saved in your draft", {
      ...SAVE_TOAST,
      description: "It goes live when you publish.",
    });
    expect(saveToast()?.title).toBe("Saved in your draft");
    expect(saveToast()?.action).toBeUndefined();
    expect(saveToast()?.cancel).toBeUndefined();

    toast.success("Test “hero-test” added", {
      ...SAVE_TOAST,
      description: "Pick it in a section's variants.",
    });
    expect(saveToast()?.action).toBeUndefined();

    toastSaveError(((key: string) => key) as TFunction, new Error("x"), null);
    expect(saveToast()?.action).toBeUndefined();
    expect(saveToast()?.cancel).toBeUndefined();
  });
});

describe("a save toast", () => {
  test("never inherits a description, action or cancel it didn't set", () => {
    // Whatever an earlier toast under the save id carried…
    toast.success("Saved in your draft", {
      id: SITE_EDITOR_SAVE_TOAST,
      description: "It goes live when you publish.",
      action: { label: "Undo", onClick: () => {} },
      cancel: { label: "Close", onClick: () => {} },
    });
    expect(saveToast()?.description).toBe("It goes live when you publish.");
    // …is gone from a toast that sets none of it, as named-rule-view.tsx's
    // "changed meanwhile" and sections-editor.tsx's picker conflict do.
    toast.info("This changed while you were editing", SAVE_TOAST);
    expect(saveToast()?.title).toBe("This changed while you were editing");
    expect(saveToast()?.description).toBeUndefined();
    expect(saveToast()?.action).toBeUndefined();
    expect(saveToast()?.cancel).toBeUndefined();
  });

  test("every caller starts from SAVE_TOAST, never the bare id", () => {
    const dir = import.meta.dir;
    const sources = readdirSync(dir).filter(
      (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
    );
    const bare = sources.filter((file) =>
      /id:\s*SITE_EDITOR_SAVE_TOAST\b/.test(
        readFileSync(join(dir, file), "utf8").replace(
          /export const SAVE_TOAST = \{[^}]*\}/,
          "",
        ),
      ),
    );
    expect(bare).toEqual([]);
    expect(sources).toContain("named-rule-view.tsx");
  });
});
