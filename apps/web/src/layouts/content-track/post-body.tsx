/** A drafted post's body, drawn from {@link bodyBlocks} as plain elements. */

import { Fragment } from "react";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
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

function Block({ block }: { block: BodyBlock }) {
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
        <div className="flex flex-col gap-1">
          <Skeleton className="aspect-video w-full rounded-xl" />
          <span className="text-xs text-muted-foreground">
            {t("contentTrack.card.creatorDrawing")}
          </span>
        </div>
      );
    case "component":
      return (
        <Badge variant="muted" className="max-w-full truncate">
          {block.name}
        </Badge>
      );
  }
}

export function PostBody({ sections }: { sections: readonly unknown[] }) {
  return (
    <div className="flex flex-col gap-4">
      {bodyBlocks(sections).map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}
