import { useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Attachment01, Loading02 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { BubbleToolbar } from "./bubble-toolbar";
import { markdownEditorExtensions } from "./extensions";
import { unwrapListContinuations } from "./unwrap-list-continuations";
import { isImageFile, useEditorFileUpload } from "./use-file-upload";

/**
 * Block styling for the editor surface. Explicit rather than `prose`:
 * `@tailwindcss/typography` isn't installed in this app, and the design system
 * owns these sizes anyway.
 */
const CONTENT_CLASS = [
  "outline-none",
  // On the editable element, not the wrapper: the whole area has to be
  // click-to-place-caret, the way the plain textarea it replaced was.
  "min-h-[200px] sm:min-h-[320px]",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_p]:my-3 [&_p]:leading-[1.5]",
  // 20/18/16, all under the card's own 24px title, which outranks them.
  "[&_h1]:my-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:leading-[1.5] [&_h1]:text-foreground",
  "[&_h2]:my-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:leading-[1.5] [&_h2]:text-foreground",
  "[&_h3]:my-3 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:leading-[1.5] [&_h3]:text-foreground",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5 [&_li>p]:my-0",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[13px]",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_hr]:my-4 [&_hr]:border-border",
  "[&_strong]:font-semibold [&_strong]:text-foreground",
].join(" ");

/** Tailwind can't reach a pseudo-element on a child node without this dance. */
const PLACEHOLDER_CLASS = [
  "[&_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
  "[&_p.is-editor-empty:first-child::before]:text-muted-foreground/50",
  "[&_p.is-editor-empty:first-child::before]:float-left",
  "[&_p.is-editor-empty:first-child::before]:h-0",
  "[&_p.is-editor-empty:first-child::before]:pointer-events-none",
].join(" ");

/**
 * Insert an uploaded file's node and return the position after it, so a batch
 * of pasted files stacks in the order they were picked instead of every insert
 * landing on the same stale offset.
 */
function insertUpload(
  view: EditorView,
  pos: number,
  typeName: "image" | "attachment",
  attrs: Record<string, string>,
): number {
  const type = view.state.schema.nodes[typeName];
  if (!type) return pos;
  const tr = view.state.tr.replaceWith(pos, pos, type.create(attrs));
  const after = tr.mapping.map(pos, 1);
  tr.setSelection(Selection.near(tr.doc.resolve(after)));
  view.dispatch(tr);
  return view.state.selection.to;
}

/**
 * WYSIWYG editor that reads and writes plain markdown.
 *
 * Markdown, not HTML, is the value: descriptions are fed to agents as prompt
 * context, plain-text values written before this editor existed still parse,
 * and the string stays legible wherever it's read outside the editor.
 *
 * Uncontrolled by design — the initial markdown seeds the document and
 * `onChange` reports every edit. Remount (via `key`) to load a different value.
 */
export function MarkdownEditor({
  defaultValue,
  onChange,
  placeholder,
  editable = true,
}: {
  defaultValue: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  /** Read at creation time only — remount (via `key`) to change it, same as
   *  `defaultValue`. */
  editable?: boolean;
}) {
  const t = useT();
  const { uploadFile, pending } = useEditorFileUpload();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The editor is created once, so its handlers would close over the first
  // render's props. Refs keep them current without re-creating the editor.
  const onChangeRef = useRef(onChange);
  const uploadRef = useRef(uploadFile);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside editor callbacks, never during render
  onChangeRef.current = onChange;
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside editor callbacks, never during render
  uploadRef.current = uploadFile;

  const uploadInto = (view: EditorView, files: File[], at: number) => {
    if (files.length === 0) return false;
    void (async () => {
      let pos = at;
      for (const file of files) {
        const url = await uploadRef.current(file);
        if (!url) continue;
        // The original file name is the only description available, and it
        // survives into the markdown the agent reads as task context — as an
        // image's alt text, or as an attachment link's text.
        pos = isImageFile(file)
          ? insertUpload(view, pos, "image", { src: url, alt: file.name })
          : insertUpload(view, pos, "attachment", {
              href: url,
              name: file.name,
            });
      }
    })();
    return true;
  };

  const editor = useEditor({
    extensions: markdownEditorExtensions(placeholder),
    content: unwrapListContinuations(defaultValue),
    contentType: "markdown",
    editable,
    editorProps: {
      attributes: {
        class: cn(CONTENT_CLASS, PLACEHOLDER_CLASS),
      },
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return false;
        // We own this file. Stop it bubbling to the chat composer's
        // window-level drop/paste listener (input.tsx `useWindowFileDrop`),
        // which would otherwise upload the same file into the chat input.
        event.stopPropagation();
        return uploadInto(view, files, view.state.selection.to);
      },
      handleDrop: (view, event, _slice, moved) => {
        // A drag within the editor is a move, not an upload.
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return false;
        const at = view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        })?.pos;
        if (at === undefined) return false;
        // We own this file. Stop it bubbling to the chat composer's
        // window-level drop listener (input.tsx `useWindowFileDrop`), which
        // would otherwise upload the same file into the chat input too.
        event.stopPropagation();
        return uploadInto(view, files, at);
      },
    },
    onUpdate: ({ editor }) => onChangeRef.current(editor.getMarkdown()),
  });

  if (!editor) return null;

  const pickFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    uploadInto(editor.view, Array.from(files), editor.state.selection.to);
  };

  return (
    <div className="flex flex-col">
      <BubbleToolbar editor={editor} />
      <EditorContent
        editor={editor}
        className="text-[15px] text-muted-foreground"
      />
      {/* Sits clear of the description body so it reads as a control on the
          editor, not as the last line of the text. Hidden when read-only —
          nothing here would do anything. */}
      <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        {editable && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            // Icon-only, so the label has to live on the control itself.
            aria-label={t("markdownEditor.attachFile")}
            onClick={() => fileInputRef.current?.click()}
          >
            <Attachment01 size={14} />
          </Button>
        )}
        {pending > 0 && (
          <span
            className="inline-flex items-center gap-1.5"
            aria-live="polite"
            role="status"
          >
            <Loading02 size={12} className="animate-spin" />
            {pending === 1
              ? t("markdownEditor.uploading")
              : t("markdownEditor.uploadingCount", { count: String(pending) })}
          </span>
        )}
      </div>
      {/* No `accept`: images become previews, everything else a download chip,
          so there's nothing to exclude. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          pickFiles(e.target.files);
          // Let the same file be picked again after a failed upload.
          e.target.value = "";
        }}
      />
    </div>
  );
}
