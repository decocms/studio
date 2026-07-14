import { useState } from "react";
import {
  AppProductCardBlock,
  AppProductShelfBlock,
} from "@/web/components/sandbox/content/blog/blocks/product-string-blocks";
import type { SandboxConfig } from "@/web/components/sections-editor/fields/field-props";

const SANDBOX: SandboxConfig = {
  orgSlug: "acme",
  virtualMcpId: "vmcp-1",
  branch: "main",
  previewUrl: "https://ct-preview.example",
};

/**
 * CT surface for the app-block product-ref editors (studio PR #4302 fix):
 * these must render the shared `DynamicOptionsField` picker — a searchable
 * combobox backed by the `productsByTerm` loader — instead of a raw text
 * input, matching the admin's loader-ref editor UX.
 */
export function AppProductCardBlockHarness({
  initialProduct = "",
}: {
  initialProduct?: string;
}) {
  const [block, setBlock] = useState<Record<string, unknown>>({
    product: initialProduct,
    cta: "Comprar",
  });
  return (
    <div data-testid="harness" className="max-w-sm p-4">
      <AppProductCardBlock
        block={block}
        onChange={setBlock}
        sandbox={SANDBOX}
      />
      <pre data-testid="form-value">{JSON.stringify(block)}</pre>
    </div>
  );
}

export function AppProductShelfBlockHarness({
  initialProducts = [],
}: {
  initialProducts?: string[];
}) {
  const [block, setBlock] = useState<Record<string, unknown>>({
    title: "Shelf title",
    products: initialProducts,
  });
  return (
    <div data-testid="harness" className="max-w-sm p-4">
      <AppProductShelfBlock
        block={block}
        onChange={setBlock}
        sandbox={SANDBOX}
      />
      <pre data-testid="form-value">{JSON.stringify(block)}</pre>
    </div>
  );
}
