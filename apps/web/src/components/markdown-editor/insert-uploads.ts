/**
 * Uploading dropped/pasted/picked files into an editor document.
 *
 * Shared by the full `MarkdownEditor` and the one-field `MentionInput` the task
 * comment composer uses — a screenshot pasted into a comment has to become the
 * same `![alt](/api/:org/fs/uploads/read?…)` markdown a description's does, or
 * the agent reading the comment gets prose where the user meant a picture.
 */

import { Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { isImageFile } from "./use-file-upload";

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
 * Upload each file and insert it at `at`, images as previews and everything
 * else as a download chip. The file name rides along as the image's alt text or
 * the chip's label — it is the only description available, and it survives into
 * the markdown an agent reads. Returns `true` when it took the files, so a
 * paste or drop handler can report the event as handled.
 */
export function uploadFilesInto(
  view: EditorView,
  files: File[],
  at: number,
  uploadFile: (file: File) => Promise<string | null>,
): boolean {
  if (files.length === 0) return false;
  void (async () => {
    let pos = at;
    for (const file of files) {
      const url = await uploadFile(file);
      if (!url) continue;
      pos = isImageFile(file)
        ? insertUpload(view, pos, "image", { src: url, alt: file.name })
        : insertUpload(view, pos, "attachment", { href: url, name: file.name });
    }
  })();
  return true;
}
