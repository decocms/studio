import { useT } from "@/i18n/use-t.ts";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import type { SandboxConfig } from "@/components/sections-editor/fields/field-props";
import type { ReferencedBlockSaveFn } from "@/components/sections-editor/save-referenced-block";
import { RichTextBlock } from "./rich-text-block";
import { CodeBlock, HeadingBlock, ListBlock, QuoteBlock } from "./plain-blocks";
import {
  CalloutBlock,
  CtaBlock,
  DividerBlock,
  StatBlock,
  VideoBlock,
} from "./media-blocks";
import { BlockImageBlock } from "./image-block";
import {
  CardGroupBlock,
  ChecklistBlock,
  ComparisonBlock,
  StatGroupBlock,
  StepsBlock,
} from "./list-blocks";
import { ProductCardBlock, ProductShelfBlock } from "./product-blocks";
import { TableBlock } from "./table-block";
import { blockComponentName, isBlogPostBlockResolveType } from "../blog-data";
import { GenericBlockEditor } from "./generic-block";
import { jsonField, str } from "./primitives";

export type RawBlock = { __resolveType?: string } & Record<string, unknown>;

/**
 * Render a single block as its native, inline-editable representation
 * (Notion-style). Common blocks get bespoke editors matched by component
 * filename (e.g. Paragraph.tsx), regardless of resolveType path prefix;
 * anything else falls back to the schema-driven form so it stays editable.
 */
export function BlockEditor({
  block,
  meta,
  onChange,
  decofile,
  sandboxRef,
  previewBaseUrl,
  onSaveReferencedBlock,
}: {
  block: RawBlock;
  meta: LiveMeta;
  onChange: (next: RawBlock) => void;
  /** The site's blocks — enables linking to another post from rich text. */
  decofile?: Record<string, unknown>;
  /**
   * Running sandbox coords — enables the VTEX product picker, and in the
   * generic editor the uploads, icon picker and `@options` loaders.
   */
  sandboxRef?: SandboxConfig | null;
  /** Section previews in the generic editor's array fields. */
  previewBaseUrl?: string | null;
  /** Where the generic editor persists edits to a field pointing at a saved block. */
  onSaveReferencedBlock?: ReferencedBlockSaveFn;
}) {
  const t = useT();
  const resolveType = block.__resolveType ?? "";
  const componentName = blockComponentName(resolveType);
  const bespoke = isBlogPostBlockResolveType(resolveType);

  if (bespoke) {
    switch (componentName) {
      case "Paragraph":
        return (
          <RichTextBlock
            html={str(block.html)}
            placeholder={t("sandbox.blockRegistry.writeSomethingPlaceholder")}
            onChange={(html) => onChange({ ...block, html })}
            decofile={decofile}
            sandboxRef={sandboxRef}
          />
        );
      case "Heading":
        return (
          <HeadingBlock
            text={str(block.text)}
            level={str(block.level)}
            onChange={(next) => onChange({ ...block, ...next })}
          />
        );
      case "Quote":
        return (
          <QuoteBlock
            quote={str(block.quote)}
            onChange={(quote) => onChange({ ...block, quote })}
          />
        );
      case "Code":
        return (
          <CodeBlock
            code={str(block.code)}
            language={str(block.language)}
            onChange={(next) => onChange({ ...block, ...next })}
          />
        );
      case "List":
        return (
          <ListBlock
            items={str(block.items)}
            style={str(block.style)}
            onChange={(next) => onChange({ ...block, ...next })}
            decofile={decofile}
            sandboxRef={sandboxRef}
          />
        );
      case "BlockImage":
        return <BlockImageBlock block={block} onChange={onChange} />;
      case "Video":
        return (
          <VideoBlock
            url={str(block.url)}
            caption={str(block.caption)}
            onChange={(next) => onChange({ ...block, ...next })}
          />
        );
      case "Divider":
        return <DividerBlock />;
      case "Cta":
        return (
          <CtaBlock
            text={str(block.text)}
            href={str(block.href)}
            onChange={(next) => onChange({ ...block, ...next })}
          />
        );
      case "Callout":
        return (
          <CalloutBlock
            title={str(block.title)}
            body={str(block.body)}
            variant={str(block.variant)}
            onChange={(next) => onChange({ ...block, ...next })}
          />
        );
      case "Stat":
        return (
          <StatBlock
            value={str(block.value)}
            label={str(block.label)}
            description={str(block.description)}
            onChange={(next) => onChange({ ...block, ...next })}
          />
        );
      case "StatGroup":
        return (
          <StatGroupBlock
            stats={jsonField(block.stats)}
            onChange={(stats) => onChange({ ...block, stats })}
          />
        );
      case "CardGroup":
        return (
          <CardGroupBlock
            cards={jsonField(block.cards)}
            onChange={(cards) => onChange({ ...block, cards })}
          />
        );
      case "Checklist":
        return (
          <ChecklistBlock
            title={str(block.title)}
            items={jsonField(block.items)}
            onChange={(next) => onChange({ ...block, ...next })}
          />
        );
      case "Steps":
        return (
          <StepsBlock
            title={str(block.title)}
            steps={jsonField(block.steps)}
            onChange={(next) => onChange({ ...block, ...next })}
          />
        );
      case "Comparison":
        return (
          <ComparisonBlock
            left={jsonField(block.left, {})}
            right={jsonField(block.right, {})}
            onChange={(next) => onChange({ ...block, ...next })}
          />
        );
      case "Table":
        return (
          <TableBlock
            headers={jsonField(block.headers)}
            rows={jsonField(block.rows)}
            onChange={(next) => onChange({ ...block, ...next })}
            decofile={decofile}
            sandboxRef={sandboxRef}
          />
        );
      case "ProductCard":
        return (
          <ProductCardBlock
            block={block}
            onChange={onChange}
            sandboxRef={sandboxRef}
          />
        );
      case "ProductShelf":
        return (
          <ProductShelfBlock
            block={block}
            onChange={onChange}
            sandboxRef={sandboxRef}
          />
        );
      default:
        break;
    }
  }

  return (
    <GenericBlockEditor
      block={block}
      meta={meta}
      onChange={onChange}
      decofile={decofile}
      sandbox={sandboxRef}
      previewBaseUrl={previewBaseUrl}
      onSaveReferencedBlock={onSaveReferencedBlock}
    />
  );
}
