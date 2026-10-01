/**
 * A one-field composer that understands `@`-mentions and, when asked, files.
 *
 * Tiptap, not a textarea, because a mention needs a chip and an id — so
 * this stays as close to the textarea it replaced as it can: no toolbar, no
 * headings, no lists, Enter submits and Shift+Enter breaks the line. Its value
 * is markdown, like `MarkdownEditor`'s, because that's what a comment body is.
 * An attached file stays a local `blob:` preview until the draft is sent.
 */

import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { cn } from "@decocms/ui/lib/utils.ts";
import { MarkdownAttachment } from "./attachment-node";
import { MarkdownImage } from "./image-node";
import { insertUpload } from "./insert-upload";
import { MarkdownMention } from "./mention-node";
import {
  MENTION_SUGGESTION_KEY,
  MentionMenu,
  MentionMenuStore,
  mentionSuggestionExtension,
} from "./mention-suggestion";
import { isImageFile, useUploadSizeCheck } from "./use-file-upload";

/** What the composer around this field drives from its own chrome. */
export interface MentionInputHandle {
  submit: () => void;
  focus: () => void;
  /** Add files to the draft at the caret, as an attach button does. */
  attach: (files: File[]) => void;
}

/** A file in the draft, linked from the markdown by its local preview `url`. */
export interface DraftAttachment {
  url: string;
  file: File;
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
  attachments = false,
  ref,
  className,
}: {
  placeholder: string;
  /** Clear only after a successful send; false keeps the draft for retry.
   *  `attached` is every draft file the markdown still links to. */
  onSubmit: (
    markdown: string,
    attached: DraftAttachment[],
  ) => void | boolean | Promise<void | boolean>;
  /** Drives the send button's disabled state. */
  onEmptyChange: (empty: boolean) => void;
  /** Accept pasted, dropped and `attach`ed files. Read at creation time. */
  attachments?: boolean;
  /** Submit and focus, for the send button and the click-anywhere-to-type
   *  surface the composer wraps this in. */
  ref?: Ref<MentionInputHandle>;
  className?: string;
}) {
  const fitsSizeLimit = useUploadSizeCheck();
  const [mentionStore] = useState(() => new MentionMenuStore());
  // Local preview URL → the file it shows, until the draft is sent.
  const [drafts] = useState(() => new Map<string, File>());
  // One identity for the composer's life, so its cleanup runs only on unmount.
  const [freeDraftsOnUnmount] = useState(() => () => () => {
    for (const url of drafts.keys()) URL.revokeObjectURL(url);
  });
  const sending = useRef(false);

  const attachAt = (view: EditorView, files: File[], at: number) => {
    // The draft being sent is already counted; a file added now would be lost.
    if (sending.current) return;
    let pos = at;
    for (const file of files) {
      if (!fitsSizeLimit(file)) continue;
      const url = URL.createObjectURL(file);
      drafts.set(url, file);
      pos = isImageFile(file)
        ? insertUpload(view, pos, "image", { src: url, alt: file.name })
        : insertUpload(view, pos, "attachment", { href: url, name: file.name });
    }
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
      MarkdownMention,
      mentionSuggestionExtension(mentionStore),
      Placeholder.configure({ placeholder }),
      Markdown,
      ...(attachments ? [MarkdownImage, MarkdownAttachment] : []),
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
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!attachments || files.length === 0) return false;
        // Ours, not the chat composer's window-level listener (`useWindowFileDrop`).
        event.stopPropagation();
        attachAt(view, files, view.state.selection.to);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        // A drag within the editor is a move, not an attachment.
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!attachments || files.length === 0) return false;
        const at = view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        })?.pos;
        if (at === undefined) return false;
        // Ours, not the chat composer's window-level listener (`useWindowFileDrop`).
        event.stopPropagation();
        attachAt(view, files, at);
        return true;
      },
    },
    onUpdate: ({ editor }) => onEmptyChange(editor.isEmpty),
  });

  async function submit() {
    if (!editor || sending.current) return;
    const markdown = editor.getMarkdown().trim();
    if (!markdown) return;
    const attached = [...drafts]
      .filter(([url]) => markdown.includes(url))
      .map(([url, file]) => ({ url, file }));
    sending.current = true;
    editor.setEditable(false);
    try {
      if ((await onSubmit(markdown, attached)) !== false) {
        // Out of undo history: undoing a send would bring back dead previews.
        editor.chain().setMeta("addToHistory", false).clearContent().run();
        for (const url of drafts.keys()) URL.revokeObjectURL(url);
        drafts.clear();
        onEmptyChange(true);
      }
    } finally {
      sending.current = false;
      if (!editor.isDestroyed) editor.setEditable(true);
    }
  }

  useImperativeHandle(ref, () => ({
    submit,
    focus: () => editor?.commands.focus(),
    attach: (files) => {
      if (!editor || !attachments) return;
      attachAt(editor.view, files, editor.state.selection.to);
      editor.commands.focus();
    },
  }));

  return (
    <>
      <EditorContent editor={editor} className={className} />
      <MentionMenu store={mentionStore} />
      {/* An unsent draft's previews go with the composer, not the session. */}
      <span hidden ref={freeDraftsOnUnmount} />
    </>
  );
}
