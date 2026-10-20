import { Extension } from "@tiptap/core";
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";

type Slots = ReadonlyMap<symbol, number>;

const key = new PluginKey<Slots>("uploadSlots");

/**
 * Where each batch of uploads in flight puts its next file, mapped through
 * every edit made while the bytes upload: an offset held across the await
 * would land the file wherever that offset points by then.
 */
export const UploadSlots = Extension.create({
  name: "uploadSlots",
  addProseMirrorPlugins() {
    return [
      new Plugin<Slots>({
        key,
        state: {
          init: () => new Map(),
          apply(tr, slots) {
            // Only `placeUploadSlot` sets this meta.
            const moved: [symbol, number | null] | undefined = tr.getMeta(key);
            if (!tr.docChanged && !moved) return slots;
            const next = new Map<symbol, number>();
            for (const [slot, pos] of slots) {
              next.set(slot, tr.mapping.map(pos));
            }
            if (moved) {
              const [slot, pos] = moved;
              if (pos === null) next.delete(slot);
              else next.set(slot, pos);
            }
            return next;
          },
        },
      }),
    ];
  },
});

/** Puts `slot` at `pos` in the document `tr` produces; null removes it. */
export function placeUploadSlot(
  tr: Transaction,
  slot: symbol,
  pos: number | null,
): Transaction {
  return tr.setMeta(key, [slot, pos]);
}

/** Undefined once the slot is removed, or in an editor without `UploadSlots`. */
export function uploadSlotPos(
  state: EditorState,
  slot: symbol,
): number | undefined {
  return key.getState(state)?.get(slot);
}
