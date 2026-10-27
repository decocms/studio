import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as realMonaco from "@/components/monaco-editor";
import * as realSaveBlock from "./use-save-block";
import * as realSonner from "sonner";

/** How the dialog's save hook was asked for, and what its save answers. */
const saveHook = {
  options: [] as Array<{ holdsCopy?: boolean } | undefined>,
  saved: [] as Array<{ blockKey: string; data: unknown }>,
  answer: {} as unknown,
};
const toasts: string[] = [];

const realMonacoModule = { ...realMonaco };
const realSaveBlockModule = { ...realSaveBlock };
const realSonnerModule = { ...realSonner };
afterAll(() => {
  mock.module("sonner", () => realSonnerModule);
  mock.module("@/components/monaco-editor", () => realMonacoModule);
  mock.module("./use-save-block", () => realSaveBlockModule);
});
// A plain field in place of the code editor: its change is the edit.
mock.module("@/components/monaco-editor", () => ({
  ...realMonacoModule,
  MonacoCodeEditor: (props: {
    code: string;
    onChange?: (value: string) => void;
  }) => (
    <button
      type="button"
      data-testid="edit-json"
      onClick={() => props.onChange?.('{"name":"Home (edited)"}')}
    >
      {props.code}
    </button>
  ),
}));
mock.module("./use-save-block", () => ({
  ...realSaveBlockModule,
  useSaveBlock: (_params: unknown, options?: { holdsCopy?: boolean }) => {
    saveHook.options.push(options);
    return {
      mutateAsync: async (variables: { blockKey: string; data: unknown }) => {
        saveHook.saved.push(variables);
        return saveHook.answer;
      },
    };
  },
}));
mock.module("sonner", () => ({
  ...realSonnerModule,
  toast: Object.assign((message: string) => toasts.push(message), {
    ...realSonnerModule.toast,
    success: (message: string) => toasts.push(message),
    error: (message: string) => toasts.push(message),
  }),
}));

const { SavedPageJsonDialog } = await import("./page-json-dialog");

beforeEach(() => {
  saveHook.options = [];
  saveHook.saved = [];
  saveHook.answer = { revision: "r1", versions: {}, written: {} };
  toasts.length = 0;
});

function open() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SavedPageJsonDialog
        open
        onOpenChange={() => {}}
        pageKey="home"
        decofile={{ home: { name: "Home" } }}
        params={{ orgSlug: "acme", virtualMcpId: "vm-1", branch: "draft-1" }}
      />
    </QueryClientProvider>,
  );
}

describe("a page's JSON, saved from the content browser", () => {
  test("keeps the copy it opened with, so a hosted save is guarded by it", async () => {
    open();
    act(() => within(document.body).getByTestId("edit-json").click());
    await act(async () =>
      within(document.body).getByRole("button", { name: "Save" }).click(),
    );
    expect(saveHook.options.every((o) => o?.holdsCopy === true)).toBe(true);
    expect(saveHook.saved).toEqual([
      { blockKey: "home", data: { name: "Home (edited)" } },
    ]);
    expect(toasts).toEqual(["Page JSON saved."]);
  });

  test('"Keep their version" says only that, never "saved"', async () => {
    saveHook.answer = { keptTheirs: true, deleted: false };
    open();
    act(() => within(document.body).getByTestId("edit-json").click());
    await act(async () =>
      within(document.body).getByRole("button", { name: "Save" }).click(),
    );
    expect(toasts).toEqual([]);
  });
});
