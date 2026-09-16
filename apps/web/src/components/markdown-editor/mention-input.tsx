/**
 * A one-field composer that understands `@`-mentions and pasted files, and
 * nothing else.
 *
 * Tiptap, not a textarea, only because a mention needs a chip and an id — so
 * this stays as close to the textarea it replaced as it can: no toolbar, no
 * headings, no lists, Enter submits and Shift+Enter breaks the line. Its value
 * is markdown, like `MarkdownEditor`'s, because that's what a comment body is.
 *
 * Images and attachments are the one addition: "make the spacing match this
 * image" is a comment, not a description, so the composer has to take a pasted
 * screenshot — and store it as the same org-fs markdown a description uses.
 */

import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { cn } from "@decocms/ui/lib/utils.ts";
import { MarkdownImage } from "./image-node";
import { MarkdownAttachment } from "./attachment-node";
import { uploadFilesInto } from "./insert-uploads";
import { MarkdownMention } from "./mention-node";
import {
  MENTION_SUGGESTION_KEY,
  MentionMenu,
  MentionMenuStore,
  mentionSuggestionExtension,
} from "./mention-suggestion";

/** What the composer around this field drives from its own chrome. */
export interface MentionInputHandle {
  submit: () => void;
  focus: () => void;
  /** Upload and insert files picked from the composer's own attach button. */
  insertFiles: (files: File[]) => void;
}

const PLACEHOLDER_CLASS = [
  "[&_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
  "[&_p.is-editor-empty:first-child::before]:text-muted-foreground",
  "[&_p.is-editor-empty:first-child::before]:float-left",
  "[&_p.is-editor-empty:first-child::before]:h-0",
  "[&_p.is-editor-empty:first-child::before]:pointer-events-none",
].join(" ");

export function MentionInput({
  placeholder,
  onSubmit,
  onEmptyChange,
  uploadFile,
  ref,
  className,
}: {
  placeholder: string;
  /** Called with the markdown body. Returning clears the field. */
  onSubmit: (markdown: string) => void;
  /** Drives the send button's disabled state. */
  onEmptyChange: (empty: boolean) => void;
  /** Uploads a pasted, dropped or picked file and returns its URL. Without it
   *  the field takes text only. */
  uploadFile?: (file: File) => Promise<string | null>;
  /** Submit and focus, for the send button and the click-anywhere-to-type
   *  surface the composer wraps this in. */
  ref?: Ref<MentionInputHandle>;
  className?: string;
}) {
  const [mentionStore] = useState(() => new MentionMenuStore());
  // The editor is created once, so a handler would close over the first prop.
  const uploadRef = useRef(uploadFile);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside editor callbacks, never during render
  uploadRef.current = uploadFile;

  const uploadInto = (view: EditorView, files: File[], at: number) => {
    const upload = uploadRef.current;
    if (!upload) return false;
    return uploadFilesInto(view, files, at, upload);
  };

  const editor = useEditor({
    extensions: [
      // Everything block-level is off: this is one field in a comment card,
      // and a heading or a code block inside it would be a formatting surface
      // with no way to see or undo it. Inline marks stay — `**bold**` typed
      // into the old textarea already rendered as bold in the posted comment.
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        link: false,
        underline: false,
      }),
      MarkdownImage,
      MarkdownAttachment,
      MarkdownMention,
      mentionSuggestionExtension(mentionStore),
      Placeholder.configure({ placeholder }),
      Markdown,
    ],
    editorProps: {
      attributes: {
        // A contenteditable is not a `<textarea>`: without these it has no
        // role and no name, so nothing — a screen reader or a test — can
        // address it by the label the user can see.
        role: "textbox",
        "aria-label": placeholder,
        "aria-multiline": "true",
        class: cn(
          "outline-none text-sm leading-relaxed text-foreground",
          PLACEHOLDER_CLASS,
        ),
      },
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return false;
        // We own this file: stop it reaching a window-level drop/paste listener.
        event.stopPropagation();
        return uploadInto(view, files, view.state.selection.to);
      },
      handleDrop: (view, event, _slice, moved) => {
        // A drag within the field is a move, not an upload.
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return false;
        const at = view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        })?.pos;
        if (at === undefined) return false;
        event.stopPropagation();
        return uploadInto(view, files, at);
      },
      handleKeyDown: (view, event) => {
        if (event.key !== "Enter" || event.shiftKey) return false;
        // The picker owns Enter while it's open — it's choosing a member, not
        // sending. Asked of the plugin directly rather than relying on which
        // handler ProseMirror happens to run first.
        if (MENTION_SUGGESTION_KEY.getState(view.state)?.active) return false;
        event.preventDefault();
        submit();
        return true;
      },
    },
    onUpdate: ({ editor }) => onEmptyChange(editor.isEmpty),
  });

  function submit() {
    if (!editor) return;
    const markdown = editor.getMarkdown().trim();
    if (!markdown) return;
    onSubmit(markdown);
    editor.commands.clearContent();
    onEmptyChange(true);
  }

  useImperativeHandle(ref, () => ({
    submit,
    focus: () => editor?.commands.focus(),
    insertFiles: (files: File[]) => {
      if (!editor) return;
      uploadInto(editor.view, files, editor.state.selection.to);
    },
  }));

  return (
    <>
      <EditorContent editor={editor} className={className} />
      <MentionMenu store={mentionStore} />
    </>
  );
}
