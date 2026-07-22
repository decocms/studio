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
import { insertMention, isMentionNodeAt, MentionNode } from "./node.tsx";

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

describe("isMentionNodeAt", () => {
  test("is true right after inserting a mention at that position", () => {
    const editor = new Editor({
      extensions: [StarterKit, MentionNode],
      content: { type: "doc", content: [{ type: "paragraph", content: [] }] },
    });
    insertMention(
      editor,
      { from: 1, to: 1 },
      {
        id: "1",
        name: "my_prompt",
        metadata: null,
        char: "/",
        kind: "prompt",
      },
    );

    expect(isMentionNodeAt(editor, 1, "1")).toBe(true);
  });

  // The edit dialog captures `pos` when a chip is clicked, then resolves
  // later (after an async prompt fetch). If the chip was deleted or the doc
  // shifted in the meantime, `pos` no longer points at that mention node —
  // this must be detected so the caller can bail instead of calling
  // `setNodeSelection(pos)`, which throws on a stale/empty position.
  test("is false once the doc changes and the position no longer holds that mention", () => {
    const editor = new Editor({
      extensions: [StarterKit, MentionNode],
      content: { type: "doc", content: [{ type: "paragraph", content: [] }] },
    });
    insertMention(
      editor,
      { from: 1, to: 1 },
      {
        id: "1",
        name: "my_prompt",
        metadata: null,
        char: "/",
        kind: "prompt",
      },
    );

    editor.chain().selectAll().deleteSelection().run();

    expect(isMentionNodeAt(editor, 1, "1")).toBe(false);
  });
});
