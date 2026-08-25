/**
 * A one-field composer that understands `@`-mentions and nothing else.
 *
 * Tiptap, not a textarea, only because a mention needs a chip and an id — so
 * this stays as close to the textarea it replaced as it can: no toolbar, no
 * headings, no lists, Enter submits and Shift+Enter breaks the line. Its value
 * is markdown, like `MarkdownEditor`'s, because that's what a comment body is.
 */

import { useImperativeHandle, useState, type Ref } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { cn } from "@decocms/ui/lib/utils.ts";
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
  ref,
  className,
}: {
  placeholder: string;
  /** Called with the markdown body. Returning clears the field. */
  onSubmit: (markdown: string) => void;
  /** Drives the send button's disabled state. */
  onEmptyChange: (empty: boolean) => void;
  /** Submit and focus, for the send button and the click-anywhere-to-type
   *  surface the composer wraps this in. */
  ref?: Ref<MentionInputHandle>;
  className?: string;
}) {
  const [mentionStore] = useState(() => new MentionMenuStore());

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
  }));

  return (
    <>
      <EditorContent editor={editor} className={className} />
      <MentionMenu store={mentionStore} />
    </>
  );
}
