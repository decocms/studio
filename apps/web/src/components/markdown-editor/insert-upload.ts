import { Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Insert an uploaded file's node and return the position after it, so a batch
 * of pasted files stacks in the order they were picked instead of every insert
 * landing on the same stale offset.
 */
export function insertUpload(
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
