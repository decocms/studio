import { setupComponentTest } from "../../../../../test/setup";
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Editor } from "@tiptap/core";
import { EditorContent, EditorContext } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { insertMention, MentionNode } from "./node.tsx";

// useT() reads the language preference via TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("mention chip aria-label", () => {
  test("matches the title-cased text shown on screen, not the raw name", async () => {
    const editor = new Editor({
      extensions: [StarterKit, MentionNode],
      content: { type: "doc", content: [{ type: "paragraph", content: [] }] },
    });
    insertMention(
      editor,
      { from: 1, to: 1 },
      {
        id: "1",
        name: "my_prompt_name",
        metadata: null,
        char: "/",
        kind: "prompt",
      },
    );

    const { container } = render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
      { wrapper },
    );

    await waitFor(() => {
      expect(container.querySelector('[role="button"]')).toBeInTheDocument();
    });
    const chip = container.querySelector('[role="button"]');

    expect(chip?.textContent).toBe("/My Prompt Name");
    expect(chip?.getAttribute("aria-label")).toBe(
      "Edit My Prompt Name prompt arguments",
    );
  });
});
