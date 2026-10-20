import { useState } from "react";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import {
  BlockEditor,
  type RawBlock,
} from "@/components/sandbox/content/blog/blocks/block-registry";

/**
 * Mounts one post block through `BlockEditor`, the same dispatch a post editor
 * uses, with the context a running sandbox supplies. A block with no bespoke
 * UI lands on the generic schema-driven editor, so specs can assert that the
 * site's JSDoc annotations are honored there. The write counter proves that
 * merely opening a post never re-saves it.
 */
export function BlogGenericBlockHarness({
  meta,
  block,
  decofile = {},
}: {
  meta: LiveMeta;
  block: RawBlock;
  decofile?: Record<string, unknown>;
}) {
  const [value, setValue] = useState<RawBlock>(block);
  const [writes, setWrites] = useState(0);

  return (
    <div data-testid="harness">
      <BlockEditor
        block={value}
        meta={meta}
        onChange={(next) => {
          setValue(next);
          setWrites((n) => n + 1);
        }}
        decofile={decofile}
        sandboxRef={{
          orgSlug: "acme",
          virtualMcpId: "vmcp-1",
          branch: "main",
          threadId: null,
        }}
      />
      <pre data-testid="block-value">{JSON.stringify(value)}</pre>
      <pre data-testid="write-count">{writes}</pre>
    </div>
  );
}
