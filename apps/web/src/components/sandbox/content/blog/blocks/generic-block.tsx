import { useState } from "react";
import {
  resolveSchema,
  type LiveMeta,
} from "@/components/sections-editor/resolve-schema";
import type { Crumb } from "@/components/sections-editor/schema-form-breadcrumb";
import { InlineBreadcrumb } from "@/components/sections-editor/inline-breadcrumb";
import type { SandboxConfig } from "@/components/sections-editor/fields/field-props";
import type { ReferencedBlockSaveFn } from "@/components/sections-editor/save-referenced-block";
import { useT } from "@/i18n/use-t.ts";
import { blogBlockTypeFor } from "../blog-data";
import { SchemaFormWithoutDefaultSeeding } from "../schema-form-without-default-seeding";
import { BlockIcon } from "./block-icon";
import type { RawBlock } from "./block-registry";

/**
 * The editor for a block with no bespoke UI: the block's own schema rendered
 * by the same form the CMS section editor uses, so the site's JSDoc
 * annotations (`@title`, `@description`, `@format`, `@options`, `@titleBy`…)
 * behave identically here.
 *
 * It must therefore be handed the SAME context the section editor passes —
 * `meta` for nested block refs and array item schemas, `sandbox` for uploads,
 * the icon picker and `@options` loaders, `decofile` for link pickers, and a
 * breadcrumb pair so arrays and objects stay drillable. Dropping any of them
 * silently degrades a field to a plain text input.
 *
 * Unlike the bespoke blocks, which render as their own content and so name
 * themselves, this one gets a header: `__resolveType` is hidden from the form
 * (see `HIDDEN_PROPS`), leaving the fields otherwise unattributed.
 */
export function GenericBlockEditor({
  block,
  meta,
  onChange,
  decofile,
  sandbox,
  previewBaseUrl,
  onSaveReferencedBlock,
}: {
  block: RawBlock;
  meta: LiveMeta;
  onChange: (next: RawBlock) => void;
  decofile?: Record<string, unknown>;
  sandbox?: SandboxConfig | null;
  previewBaseUrl?: string | null;
  onSaveReferencedBlock?: ReferencedBlockSaveFn;
}) {
  const t = useT();
  const [breadcrumb, setBreadcrumb] = useState<Crumb[]>([]);
  const resolveType = block.__resolveType ?? "";
  const schema = resolveType ? resolveSchema(resolveType, meta) : null;

  if (!schema) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("sandbox.blockRegistry.unknownBlockType", { type: resolveType })}
      </p>
    );
  }

  const blockType = blogBlockTypeFor(resolveType, meta);

  return (
    <div className="space-y-3 rounded-lg border bg-background p-3">
      <div className="flex items-center gap-2.5">
        <BlockIcon
          iconName={blockType.iconName}
          iconUrl={blockType.iconUrl}
          alt={blockType.title}
          className="size-7"
          size={14}
        />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">
            {blockType.title}
          </span>
          {blockType.description && (
            <span className="truncate text-xs text-muted-foreground">
              {blockType.description}
            </span>
          )}
        </div>
      </div>
      <InlineBreadcrumb
        path={breadcrumb}
        onNavigate={setBreadcrumb}
        label={t("sandbox.blockRegistry.breadcrumbLabel")}
        backTitle={t("sandbox.blockRegistry.backToFields")}
      />
      <SchemaFormWithoutDefaultSeeding
        schema={schema}
        value={block}
        onChange={(next) => onChange(next as RawBlock)}
        basePath=""
        breadcrumbPath={breadcrumb}
        onBreadcrumbChange={setBreadcrumb}
        meta={meta}
        decofile={decofile}
        sandbox={sandbox}
        previewBaseUrl={previewBaseUrl}
        onSaveReferencedBlock={onSaveReferencedBlock}
      />
    </div>
  );
}
