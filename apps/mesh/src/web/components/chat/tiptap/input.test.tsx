import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { EditorContent, useCurrentEditor, type Editor } from "@tiptap/react";
import { TiptapProvider } from "./input";
import { FileUploader } from "./file";
import type { AiProviderModel } from "@/web/hooks/collections/use-ai-providers.ts";

// FileUploader uses useT() which reads language preference via TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

function EditableProbe() {
  const { editor } = useCurrentEditor();
  return <EditorContent editor={editor} />;
}

function renderProvider(disabled: boolean) {
  return render(
    <TiptapProvider
      tiptapDoc={undefined}
      setTiptapDoc={() => {}}
      disabled={disabled}
    >
      <EditableProbe />
    </TiptapProvider>,
  );
}

describe("TiptapProvider disabled", () => {
  it("makes the editor's DOM node non-editable when disabled", () => {
    const { container } = renderProvider(true);
    const editable = container.querySelector("[contenteditable]");
    expect(editable?.getAttribute("contenteditable")).toBe("false");
  });

  it("keeps the editor's DOM node editable when not disabled", () => {
    const { container } = renderProvider(false);
    const editable = container.querySelector("[contenteditable]");
    expect(editable?.getAttribute("contenteditable")).toBe("true");
  });
});

const fakeModel = {
  modelId: "m",
  capabilities: [],
} as unknown as AiProviderModel;

function EditorProbe({
  onEditor,
}: {
  onEditor: (editor: Editor | null) => void;
}) {
  const { editor } = useCurrentEditor();
  onEditor(editor ?? null);
  return null;
}

function hasFileDropPlugin(editor: Editor) {
  return editor.state.plugins.some((p) =>
    (p.spec.key as { key?: string } | undefined)?.key?.startsWith(
      "fileDropHandler$",
    ),
  );
}

// TiptapInput only mounts <FileUploader> when `showFileUploader && selectedModel
// && !disabled` (see input.tsx). These tests exercise FileUploader directly —
// mirroring that mount/unmount condition — instead of rendering TiptapInput,
// which would additionally require QueryClientProvider/ProjectContext for its
// SlashMention/AtMention children (per this file's no-stubbed-context policy).
describe("FileUploader mount (mirrors TiptapInput's disabled gate)", () => {
  it("does not register the file-drop/paste handler while unmounted (disabled)", () => {
    let editor: Editor | null = null;
    render(
      <TiptapProvider tiptapDoc={undefined} setTiptapDoc={() => {}}>
        <EditorProbe onEditor={(e) => (editor = e)} />
      </TiptapProvider>,
    );
    expect(editor).not.toBeNull();
    expect(hasFileDropPlugin(editor!)).toBe(false);
  });

  it("registers the file-drop/paste handler when mounted (not disabled)", () => {
    let editor: Editor | null = null;
    function MountedFileUploader() {
      const { editor } = useCurrentEditor();
      if (!editor) return null;
      return <FileUploader editor={editor} selectedModel={fakeModel} />;
    }
    render(
      <TiptapProvider tiptapDoc={undefined} setTiptapDoc={() => {}}>
        <EditorProbe onEditor={(e) => (editor = e)} />
        <MountedFileUploader />
      </TiptapProvider>,
    );
    expect(editor).not.toBeNull();
    expect(hasFileDropPlugin(editor!)).toBe(true);
  });
});
