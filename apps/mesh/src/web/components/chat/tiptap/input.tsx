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
import type { Metadata } from "../types.ts";
import { FileNode, FileUploader, type UnsupportedFileInfo } from "./file";
import { MentionNode } from "./mention";
import { AtMention } from "./mention-at.tsx";
import { SlashMention } from "./mention-slash.tsx";
import { AiProviderModel } from "@/web/hooks/collections/use-ai-providers.ts";

function buildExtensions(placeholderRef: React.RefObject<string | undefined>) {
  return [
    StarterKit.configure({
      heading: false,
      blockquote: false,
      codeBlock: false,
      horizontalRule: false,
      dropcursor: false,
    }),
    Placeholder.configure({
      placeholder: () =>
        placeholderRef.current ??
        "Ask anything, / for prompts, @ for agents & resources...",
      showOnlyWhenEditable: false,
    }),
    MentionNode,
    FileNode,
  ];
}

export interface TiptapInputHandle {
  focus: () => void;
  clear: () => void;
  appendText: (text: string) => void;
  syncVoiceText: (baseline: Metadata["tiptapDoc"], voiceText: string) => void;
  restoreContent: (baseline: Metadata["tiptapDoc"]) => void;
}

interface TiptapProviderProps {
  tiptapDoc: Metadata["tiptapDoc"];
  setTiptapDoc: (doc: Metadata["tiptapDoc"]) => void;
  disabled?: boolean;
  enterToSubmit?: boolean;
  placeholder?: string;
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
  disabled = false,
  enterToSubmit = false,
  placeholder,
  onSubmit,
  children,
}: TiptapProviderProps) {
  // Store callbacks and config in refs to avoid recreating the editor on every render
  const onSubmitRef = useRef(onSubmit);
  const setTiptapDocRef = useRef(setTiptapDoc);
  const enterToSubmitRef = useRef(enterToSubmit);
  const placeholderRef = useRef(placeholder);

  // Initialize Tiptap editor
  const editor = useEditor({
    extensions: buildExtensions(placeholderRef),
    content: tiptapDoc || "",
    editorProps: {
      attributes: {
        "data-chat-input": "true",
        class:
          "prose prose-sm max-w-none focus:outline-none w-full h-full text-[15px] p-[18px]",
      },
      handleKeyDown: (_view: EditorView, event: KeyboardEvent) => {
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          enterToSubmitRef.current
        ) {
          event.preventDefault();
          onSubmitRef.current?.();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }: { editor: ReturnType<typeof useEditor> }) => {
      setTiptapDocRef.current(editor?.getJSON());
    },
  });

  // Sync editable via setEditable (preserves undo history, selection, mention state)
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  // Keep the refs up to date
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    setTiptapDocRef.current = setTiptapDoc;
  }, [setTiptapDoc]);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    enterToSubmitRef.current = enterToSubmit;
  }, [enterToSubmit]);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    placeholderRef.current = placeholder;
  }, [placeholder]);

  // Sync editor content when tiptapDoc changes externally
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
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
  disabled?: boolean;
  virtualMcpId?: string | null;
  showFileUploader?: boolean;
  selectedModel?: AiProviderModel | null;
  onUnsupportedFile?: (info: UnsupportedFileInfo) => void;
  ref?: Ref<TiptapInputHandle>;
  className?: string;
}

/**
 * Input component that renders the editor content and mentions.
 * Uses the editor from EditorContext provided by TiptapProvider.
 */
export function TiptapInput({
  disabled = false,
  virtualMcpId,
  showFileUploader = false,
  selectedModel,
  onUnsupportedFile,
  ref,
  className,
}: TiptapInputProps) {
  const { editor } = useCurrentEditor();

  useImperativeHandle(
    ref ?? null,
    () => ({
      focus: () => {
        editor?.commands.focus();
      },
      clear: () => {
        editor?.commands.clearContent(true);
      },
      appendText: (text: string) => {
        if (!editor) return;
        const isEmpty = editor.state.doc.textContent.trim() === "";
        editor.commands.focus("end");
        if (!isEmpty) {
          editor.commands.insertContent(" ");
        }
        editor.commands.insertContent(text);
      },
      syncVoiceText: (baseline: Metadata["tiptapDoc"], voiceText: string) => {
        if (!editor) return;
        editor.commands.setContent(baseline || { type: "doc", content: [] });
        if (voiceText) {
          editor.commands.focus("end");
          const hasBaseline = editor.state.doc.textContent.trim().length > 0;
          editor.commands.insertContent(
            hasBaseline ? " " + voiceText : voiceText,
          );
        }
      },
      restoreContent: (baseline: Metadata["tiptapDoc"]) => {
        if (!editor) return;
        editor.commands.setContent(baseline || { type: "doc", content: [] });
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
          className,
          "[&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[20px] [&_.ProseMirror]:flex-1",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:text-muted-foreground",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:opacity-50",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0",
          disabled && "cursor-not-allowed opacity-70",
          disabled && "[&_.ProseMirror]:cursor-not-allowed",
        )}
      />

      {/* Render slash dropdown menu for prompts + resources (/) */}
      <Suspense fallback={null}>
        <SlashMention editor={editor} virtualMcpId={virtualMcpId ?? null} />
      </Suspense>

      {/* Render @ dropdown menu (agents + resources) */}
      <Suspense fallback={null}>
        <AtMention editor={editor} virtualMcpId={virtualMcpId ?? null} />
      </Suspense>

      {/* Render file upload handler */}
      {showFileUploader && selectedModel ? (
        <FileUploader
          editor={editor}
          selectedModel={selectedModel}
          onUnsupportedFile={onUnsupportedFile}
        />
      ) : null}
    </>
  );
}
