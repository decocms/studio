import { useState } from "react";
import { BlockImageBlock } from "@/components/sandbox/content/blog/blocks/image-block";

/**
 * CT surface for the blog post's BlockImage editor: the block itself plus the
 * serialized value it produces, so specs assert what lands in the decofile
 * rather than the markup.
 */
export function BlockImageHarness({
  initial = {},
}: {
  initial?: Record<string, unknown>;
}) {
  const [block, setBlock] = useState<Record<string, unknown>>(initial);
  return (
    <div data-testid="harness" className="w-[640px] p-4">
      <BlockImageBlock block={block} onChange={setBlock} />
      <pre data-testid="block-value">{JSON.stringify(block)}</pre>
    </div>
  );
}
