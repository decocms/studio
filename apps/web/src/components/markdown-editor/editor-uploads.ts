import { useRef, useState } from "react";
import { toast } from "sonner";
import { Selection } from "@tiptap/pm/state";
import type { EditorProps, EditorView } from "@tiptap/pm/view";
// Aliased rather than `./`, so component tests can swap the network out.
import { useEditorFileUpload } from "@/components/markdown-editor/use-file-upload";
import { useT } from "@/i18n/use-t.ts";
import { placeUploadSlot, uploadSlotPos } from "./upload-slots";
import { isImageFile } from "./uploads";

/**
 * Insert an uploaded file's node at `pos`; `slot`, and a caret still waiting there, move past it.
 *
 * The node is found in the new document rather than `pos` mapped through the
 * insert: a block image splits the paragraph it lands in, a mapped position
 * snaps back above it, and the next file then went in before the image.
 */
function insertUpload(
  view: EditorView,
  pos: number,
  typeName: "image" | "attachment",
  attrs: Record<string, string>,
  slot?: symbol,
): void {
  const { schema } = view.state;
  const type = schema.nodes[typeName];
  if (!type) return;
  const node = type.create(attrs);
  const following = view.state.selection.to === pos;
  const $pos = view.state.doc.resolve(pos);
  const charBefore = $pos.parent.textBetween(
    Math.max(0, $pos.parentOffset - 1),
    $pos.parentOffset,
    undefined,
    "￼",
  );
  // A chip is set off by spaces, so neither the word before it nor what's typed next runs into its link.
  const space = () => schema.text(" ");
  const content = node.isInline
    ? [
        ...(charBefore && !/\s/.test(charBefore) ? [space()] : []),
        node,
        space(),
      ]
    : node;
  const tr = view.state.tr.replaceWith(pos, pos, content);
  let from = pos;
  let to = pos;
  tr.mapping.maps.at(-1)?.forEach((_from, _to, newFrom, newTo) => {
    from = newFrom;
    to = newTo;
  });
  let after: number | undefined;
  tr.doc.nodesBetween(from, to, (child, at) => {
    if (child === node) after = at + child.nodeSize;
  });
  let caret = after ?? to;
  if (after !== undefined && node.isInline) caret += 1;
  const paragraph = schema.nodes.paragraph;
  if (after !== undefined && node.isBlock && paragraph) {
    // ProseMirror's own trailing paragraph is only added after this transaction.
    if (!tr.doc.resolve(after).nodeAfter?.isTextblock) {
      tr.insert(after, paragraph.create());
    }
    caret = after + 1;
  }
  const next = Selection.near(tr.doc.resolve(caret));
  if (following) tr.setSelection(next);
  if (slot) placeUploadSlot(tr, slot, next.to);
  view.dispatch(tr);
}

/**
 * The files a paste attaches. A spreadsheet or document copy carries a picture
 * of the selection beside its text and markup: the text is what was copied, so
 * none of its files are. A copied file or image comes without both.
 */
function pastedAttachments(
  data: { files: ArrayLike<File>; getData(format: string): string } | null,
): File[] {
  if (!data || data.files.length === 0) return [];
  const copiedText =
    data.getData("text/html") !== "" &&
    data.getData("text/plain").trim() !== "";
  return copiedText ? [] : Array.from(data.files);
}

/**
 * Paste, drop and pick for a TipTap field whose uploads render as an image
 * preview or an attachment chip. The description editor and the comment
 * composer share it, so a file becomes the same markdown in either.
 *
 * The handlers read refs, not render state: an editor created once can capture
 * them at creation and still reach the current upload. `enabled` is read at
 * creation too, the same as the editor's other options.
 */
export function useEditorUploads(enabled = true) {
  const t = useT();
  const { uploadFile } = useEditorFileUpload();
  const uploadRef = useRef(uploadFile);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside editor callbacks, never during render
  uploadRef.current = uploadFile;

  /** Files picked but not yet in the document, across every batch: pasting
   *  three screenshots keeps the indicator up until the last one lands. */
  const [pending, setPending] = useState(0);
  const inFlight = useRef(0);
  const track = (delta: number) => {
    inFlight.current += delta;
    setPending(inFlight.current);
  };

  const uploadInto = (view: EditorView, files: File[], at: number) => {
    if (!enabled || files.length === 0) return false;
    track(files.length);
    const slot = Symbol("upload");
    view.dispatch(placeUploadSlot(view.state.tr, slot, at));
    void (async () => {
      for (const file of files) {
        try {
          const url = await uploadRef.current(file);
          // The field can unmount while the bytes are in flight.
          if (!url || view.isDestroyed) continue;
          const image = isImageFile(file);
          insertUpload(
            view,
            uploadSlotPos(view.state, slot) ?? view.state.selection.to,
            image ? "image" : "attachment",
            // The file name is the only description there is: it becomes the alt text or the chip's link text.
            image
              ? { src: url, alt: file.name }
              : { href: url, name: file.name },
            slot,
          );
        } catch {
          // Uploaded, but not in the field: as good as a failed upload. The rest of the batch still lands.
          toast.error(t("markdownEditor.uploadFailed", { name: file.name }));
        } finally {
          track(-1);
        }
      }
      if (!view.isDestroyed) {
        view.dispatch(placeUploadSlot(view.state.tr, slot, null));
      }
    })();
    return true;
  };

  /** Pasted and dropped files stop here: the chat composer's window-level
   *  listener (`useWindowFileDrop` in chat/input.tsx) would upload them again. */
  const handlePaste: NonNullable<EditorProps["handlePaste"]> = (
    view,
    event,
  ) => {
    const files = pastedAttachments(event.clipboardData);
    if (files.length === 0) return false;
    event.stopPropagation();
    return uploadInto(view, files, view.state.selection.to);
  };

  const handleDrop: NonNullable<EditorProps["handleDrop"]> = (
    view,
    event,
    _slice,
    moved,
  ) => {
    // A drag within the editor is a move, not an upload.
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
  };

  return {
    pending,
    /** For callbacks the editor captured once, where `pending` would be stale. */
    uploading: () => inFlight.current > 0,
    uploadInto,
    handlePaste,
    handleDrop,
  };
}

export type EditorUploads = ReturnType<typeof useEditorUploads>;
