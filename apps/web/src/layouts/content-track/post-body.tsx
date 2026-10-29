/** A drafted post's body, drawn from {@link bodyBlocks} as plain elements. */

import { Fragment } from "react";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { CampaignProduct } from "@/components/sandbox/content/blog/blog-data";
import { useT } from "@/i18n/use-t.ts";
import { shelfProducts } from "./card-model";
import { RoleAtWork } from "./newsroom";
import { type BodyBlock, bodyBlocks, type InlineNode } from "./post-body-model";

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return nodes.map((node, index) => {
    if (node.kind === "text")
      return <Fragment key={index}>{node.text}</Fragment>;
    if (node.kind === "break") return <br key={index} />;
    const content = <Inline nodes={node.children} />;
    switch (node.tag) {
      case "a":
        return node.href ? (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2"
          >
            {content}
          </a>
        ) : (
          <span key={index}>{content}</span>
        );
      case "b":
      case "strong":
        return <strong key={index}>{content}</strong>;
      case "i":
      case "em":
        return <em key={index}>{content}</em>;
      case "u":
        return <u key={index}>{content}</u>;
      case "s":
        return <s key={index}>{content}</s>;
      case "code":
        return (
          <code key={index} className="rounded bg-muted px-1 text-sm">
            {content}
          </code>
        );
      case "sub":
        return <sub key={index}>{content}</sub>;
      case "sup":
        return <sup key={index}>{content}</sup>;
      default:
        return <span key={index}>{content}</span>;
    }
  });
}

/** A product block as the shelf a reader sees: the campaign's products it names. */
function Shelf({
  block,
  products,
}: {
  block: Extract<BodyBlock, { kind: "component" }>;
  products: CampaignProduct[];
}) {
  const t = useT();
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="mb-[11px] flex items-baseline justify-between gap-3">
        <span className="text-[13.5px] font-semibold text-foreground">
          {block.title.length > 0 ? (
            <Inline nodes={block.title} />
          ) : (
            t("contentTrack.card.shopTheLook")
          )}
        </span>
        <span className="shrink-0 text-[11.5px] text-muted-foreground">
          {t("contentTrack.card.shelfCount", { count: products.length })}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {products.map((product) => (
          <div
            key={product.id}
            className="flex flex-col overflow-hidden rounded-[10px] border border-border bg-card"
          >
            {product.images[0] ? (
              <img
                src={product.images[0]}
                alt={product.name}
                className="aspect-square w-full object-cover"
              />
            ) : (
              <div className="aspect-square w-full bg-muted" />
            )}
            <span className="line-clamp-2 px-[9px] pt-2 pb-[9px] text-xs font-medium text-foreground">
              {product.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Block({
  block,
  products,
}: {
  block: BodyBlock;
  products: readonly CampaignProduct[];
}) {
  const t = useT();
  switch (block.kind) {
    case "heading": {
      const Heading = `h${block.level}` as const;
      return (
        <Heading className="text-lg font-semibold text-foreground">
          {block.text}
        </Heading>
      );
    }
    case "paragraph":
      return (
        <p className="text-sm leading-relaxed text-foreground">
          <Inline nodes={block.content} />
        </p>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List
          className={cn(
            "space-y-1 pl-5 text-sm",
            block.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {block.items.map((item, index) => (
            <li key={index}>
              <Inline nodes={item} />
            </li>
          ))}
        </List>
      );
    }
    case "quote":
      return (
        <blockquote className="border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
          {block.text}
        </blockquote>
      );
    case "image":
      return block.url ? (
        <img
          src={block.url}
          alt={block.alt}
          className="w-full rounded-xl object-cover"
        />
      ) : (
        <div className="relative">
          <Skeleton className="aspect-video w-full rounded-xl" />
          <span className="absolute top-3 right-3">
            <RoleAtWork
              role="creator"
              activity={t("contentTrack.card.activity.drawing")}
            />
          </span>
        </div>
      );
    case "component": {
      const shelf = shelfProducts(block.productIds, products);
      if (shelf.length > 0) return <Shelf block={block} products={shelf} />;
      const name = (
        <Badge variant="muted" className="w-fit max-w-full truncate">
          {block.name}
        </Badge>
      );
      if (!block.title.length && !block.lines.length && !block.items.length) {
        return name;
      }
      return (
        <div className="flex flex-col gap-2 rounded-xl bg-card p-3 shadow-edge">
          {name}
          {block.title.length > 0 && (
            <p className="text-sm font-semibold text-foreground">
              <Inline nodes={block.title} />
            </p>
          )}
          {block.lines.map((line, index) => (
            <p key={index} className="text-sm leading-relaxed text-foreground">
              <Inline nodes={line} />
            </p>
          ))}
          {block.items.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {block.items.map((item, index) => (
                <li key={index}>
                  <Inline nodes={item} />
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
  }
}

export function PostBody({
  sections,
  products,
}: {
  sections: readonly unknown[];
  /** The campaign's products, which a product block's shelf is drawn from. */
  products: readonly CampaignProduct[];
}) {
  return (
    <div className="flex flex-col gap-4">
      {bodyBlocks(sections).map((block, index) => (
        <Block key={index} block={block} products={products} />
      ))}
    </div>
  );
}
