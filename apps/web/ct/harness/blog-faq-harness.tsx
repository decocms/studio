import { useState } from "react";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { BlockDocument } from "@/components/sandbox/content/blog/block-document";
import type { RawBlock } from "@/components/sandbox/content/blog/blocks/block-registry";

/**
 * Mounts a post body the way the post editor does, so an FAQ block sits in a
 * block document of its own row and its answers are documents nested in it.
 * The serialized body is exposed so specs assert what lands in the decofile.
 */
export function BlogFaqHarness({
  meta,
  initial,
}: {
  meta: LiveMeta;
  initial: RawBlock[];
}) {
  const [value, setValue] = useState<RawBlock[]>(initial);
  return (
    <div data-testid="harness" className="w-[720px] p-4">
      <BlockDocument
        value={value}
        onChange={setValue}
        meta={meta}
        decofile={{}}
      />
      <pre data-testid="doc-value" className="hidden">
        {JSON.stringify(value)}
      </pre>
    </div>
  );
}
