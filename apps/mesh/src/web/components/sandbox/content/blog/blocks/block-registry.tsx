import { SchemaForm } from "@/web/components/sections-editor/schema-form";
import {
  resolveSchema,
  type LiveMeta,
} from "@/web/components/sections-editor/resolve-schema";
import { RichTextBlock } from "./rich-text-block";
import { CodeBlock, HeadingBlock, ListBlock, QuoteBlock } from "./plain-blocks";
import {
  BlockImageBlock,
  CalloutBlock,
  CtaBlock,
  DividerBlock,
  StatBlock,
  VideoBlock,
} from "./media-blocks";
import {
  CardGroupBlock,
  ChecklistBlock,
  ComparisonBlock,
  StatGroupBlock,
  StepsBlock,
} from "./list-blocks";
import { str } from "./primitives";

export type RawBlock = { __resolveType?: string } & Record<string, unknown>;

/**
 * Render a single block as its native, inline-editable representation
 * (Notion-style). Common blocks get bespoke editors; anything else falls
 * back to the schema-driven form so it stays editable.
 */
export function BlockEditor({
  block,
  meta,
  onChange,
}: {
  block: RawBlock;
  meta: LiveMeta;
  onChange: (next: RawBlock) => void;
}) {
  const resolveType = block.__resolveType ?? "";

  switch (resolveType) {
    case "blog/sections/blocks/Paragraph.tsx":
      return (
        <RichTextBlock
          html={str(block.html)}
          placeholder="Write something…"
          onChange={(html) => onChange({ ...block, html })}
        />
      );
    case "blog/sections/blocks/Heading.tsx":
      return (
        <HeadingBlock
          text={str(block.text)}
          level={str(block.level)}
          onChange={(next) => onChange({ ...block, ...next })}
        />
      );
    case "blog/sections/blocks/Quote.tsx":
      return (
        <QuoteBlock
          quote={str(block.quote)}
          onChange={(quote) => onChange({ ...block, quote })}
        />
      );
    case "blog/sections/blocks/Code.tsx":
      return (
        <CodeBlock
          code={str(block.code)}
          language={str(block.language)}
          onChange={(next) => onChange({ ...block, ...next })}
        />
      );
    case "blog/sections/blocks/List.tsx":
      return (
        <ListBlock
          items={str(block.items)}
          style={str(block.style)}
          onChange={(next) => onChange({ ...block, ...next })}
        />
      );
    case "blog/sections/blocks/BlockImage.tsx":
      return <BlockImageBlock block={block} onChange={onChange} />;
    case "blog/sections/blocks/Video.tsx":
      return (
        <VideoBlock
          url={str(block.url)}
          caption={str(block.caption)}
          onChange={(next) => onChange({ ...block, ...next })}
        />
      );
    case "blog/sections/blocks/Divider.tsx":
      return <DividerBlock />;
    case "blog/sections/blocks/Cta.tsx":
      return (
        <CtaBlock
          text={str(block.text)}
          href={str(block.href)}
          onChange={(next) => onChange({ ...block, ...next })}
        />
      );
    case "blog/sections/blocks/Callout.tsx":
      return (
        <CalloutBlock
          title={str(block.title)}
          body={str(block.body)}
          variant={str(block.variant)}
          onChange={(next) => onChange({ ...block, ...next })}
        />
      );
    case "blog/sections/blocks/Stat.tsx":
      return (
        <StatBlock
          value={str(block.value)}
          label={str(block.label)}
          description={str(block.description)}
          onChange={(next) => onChange({ ...block, ...next })}
        />
      );
    case "blog/sections/blocks/StatGroup.tsx":
      return (
        <StatGroupBlock
          stats={str(block.stats)}
          onChange={(stats) => onChange({ ...block, stats })}
        />
      );
    case "blog/sections/blocks/CardGroup.tsx":
      return (
        <CardGroupBlock
          cards={
            typeof block.cards === "string"
              ? block.cards
              : JSON.stringify(block.cards ?? [])
          }
          onChange={(cards) => onChange({ ...block, cards })}
        />
      );
    case "blog/sections/blocks/Checklist.tsx":
      return (
        <ChecklistBlock
          title={str(block.title)}
          items={str(block.items)}
          onChange={(next) => onChange({ ...block, ...next })}
        />
      );
    case "blog/sections/blocks/Steps.tsx":
      return (
        <StepsBlock
          title={str(block.title)}
          steps={str(block.steps)}
          onChange={(next) => onChange({ ...block, ...next })}
        />
      );
    case "blog/sections/blocks/Comparison.tsx":
      return (
        <ComparisonBlock
          left={str(block.left)}
          right={str(block.right)}
          onChange={(next) => onChange({ ...block, ...next })}
        />
      );
    default: {
      const schema = resolveType ? resolveSchema(resolveType, meta) : null;
      if (!schema) {
        return (
          <p className="text-xs text-muted-foreground">
            Unknown block type{resolveType ? ` (${resolveType})` : ""}.
          </p>
        );
      }
      return (
        <SchemaForm
          schema={schema}
          value={block}
          onChange={(v) => onChange(v as RawBlock)}
          basePath=""
        />
      );
    }
  }
}
