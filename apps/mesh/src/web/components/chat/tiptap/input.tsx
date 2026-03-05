import { cn } from "@deco/ui/lib/utils.ts";
import Placeholder from "@tiptap/extension-placeholder";
import type { EditorView } from "@tiptap/pm/view";
import {
  EditorContent,
  EditorContext,
  useCurrentEditor,
  useEditor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { Ref } from "react";
import { Suspense, useEffect, useImperativeHandle, useRef } from "react";
import type { SelectedModelState } from "../select-model";
import type { VirtualMCPInfo } from "../select-virtual-mcp";
import type { Metadata } from "../types.ts";
import { FileNode, FileUploader } from "./file";
import { MentionNode } from "./mention";
import { PromptsMention } from "./mention-prompts.tsx";
import { ResourcesMention } from "./mention-resources.tsx";

const GLOBAL_EXTENSIONS = [
  StarterKit.configure({
    heading: false,
    blockquote: false,
    codeBlock: false,
    horizontalRule: false,
  }),
  Placeholder.configure({
    placeholder: "Ask anything, / for prompts, @ for resources...",
    showOnlyWhenEditable: false,
  }),
  MentionNode,
  FileNode,
];

export interface TiptapInputHandle {
  focus: () => void;
  clear: () => void;
}

interface TiptapProviderProps {
  tiptapDoc: Metadata["tiptapDoc"];
  setTiptapDoc: (doc: Metadata["tiptapDoc"]) => void;
  selectedModel: SelectedModelState | null;
  isStreaming: boolean;
  onSubmit?: () => void;
  children: React.ReactNode;
}

/**
 * Provider component that creates the Tiptap editor and provides it via EditorContext.
 * This allows child components to access the editor without prop drilling.
 */
export function TiptapProvider({
  tiptapDoc,
  setTiptapDoc,
  selectedModel,
  isStreaming,
  onSubmit,
  children,
}: TiptapProviderProps) {
  const isDisabled = isStreaming || !selectedModel;

  // Store callbacks in refs to avoid recreating the editor on every render
  const onSubmitRef = useRef(onSubmit);
  const setTiptapDocRef = useRef(setTiptapDoc);

  // Initialize Tiptap editor
  const editor = useEditor(
    {
      extensions: GLOBAL_EXTENSIONS,
      content: tiptapDoc || "",
      editable: !isDisabled,
      editorProps: {
        attributes: {
          class:
            "prose prose-sm max-w-none focus:outline-none w-full h-full text-[15px] p-[18px]",
        },
        handleKeyDown: (_view: EditorView, event: KeyboardEvent) => {
          // Handle Enter key: submit on Enter, new line on Shift+Enter
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmitRef.current?.();
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor }: { editor: ReturnType<typeof useEditor> }) => {
        // Update tiptapDoc in context whenever editor changes
        setTiptapDocRef.current(editor?.getJSON());
      },
    },
    [isDisabled],
  );

  // Keep the refs up to date
  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    setTiptapDocRef.current = setTiptapDoc;
  }, [setTiptapDoc]);

  // Sync editor content when tiptapDoc changes externally
  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (editor?.isDestroyed) return;

    // Only update if the content is different to avoid unnecessary updates
    const currentJson = JSON.stringify(editor?.getJSON());
    const newJson = JSON.stringify(tiptapDoc || { type: "doc", content: [] });

    if (currentJson !== newJson) {
      editor.commands.setContent(tiptapDoc || { type: "doc", content: [] });
    }
  }, [editor, tiptapDoc]);

  return (
    <EditorContext.Provider value={{ editor }}>
      {children}
    </EditorContext.Provider>
  );
}

interface TiptapInputProps {
  selectedModel: SelectedModelState | null;
  isStreaming: boolean;
  selectedVirtualMcp: VirtualMCPInfo | null;
  ref?: Ref<TiptapInputHandle>;
}

/**
 * Input component that renders the editor content and mentions.
 * Uses the editor from EditorContext provided by TiptapProvider.
 */
export function TiptapInput({
  selectedModel,
  isStreaming,
  selectedVirtualMcp,
  ref,
}: TiptapInputProps) {
  const { editor } = useCurrentEditor();
  const virtualMcpId = selectedVirtualMcp?.id ?? null;
  const isDisabled = isStreaming || !selectedModel;

  useImperativeHandle(
    ref ?? null,
    () => ({
      focus: () => {
        editor?.commands.focus();
      },
      clear: () => {
        editor?.commands.clearContent(true);
      },
    }),
    [editor],
  );

  if (!editor) {
    return null;
  }

  return (
    <>
      <EditorContent
        editor={editor}
        className={cn(
          "overflow-y-auto relative flex-1 max-h-[164px] min-h-[20px] w-full flex flex-col",
          "[&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[20px] [&_.ProseMirror]:flex-1",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:text-muted-foreground",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:opacity-50",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0",
          isDisabled && "cursor-not-allowed opacity-70",
          isDisabled && "[&_.ProseMirror]:cursor-not-allowed",
        )}
      />

      {/* Render prompts dropdown menu (includes dialog) */}
      <Suspense fallback={null}>
        <PromptsMention editor={editor} virtualMcpId={virtualMcpId} />
      </Suspense>

      {/* Render resources dropdown menu */}
      <Suspense fallback={null}>
        <ResourcesMention editor={editor} virtualMcpId={virtualMcpId} />
      </Suspense>

      {/* Render file upload handler */}
      <FileUploader editor={editor} selectedModel={selectedModel} />
    </>
  );
}
