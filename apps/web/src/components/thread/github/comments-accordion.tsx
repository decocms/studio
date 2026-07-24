import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@deco/ui/components/accordion.tsx";
import { MemoizedMarkdown } from "../../chat/markdown.tsx";
import { decodeHtmlEntities } from "./decode-html-entities.ts";
import type { PrComment } from "./use-pr-data.ts";

interface Props {
  comments: PrComment[];
  isLoading: boolean;
  isError: boolean;
}

/**
 * Collapsible panel listing issue-level PR comments. Collapsed by default;
 * opens on click. Renders author, relative timestamp, and body (markdown).
 *
 * Hidden when loading / error / empty — the Description tab shouldn't
 * show an empty "0 comments" accordion.
 */
export function CommentsAccordion({ comments, isLoading, isError }: Props) {
  if (isLoading || isError) return null;
  if (!comments || comments.length === 0) return null;

  return (
    <Accordion type="single" collapsible className="border-t border-border">
      <AccordionItem value="comments" className="border-b-0">
        <AccordionTrigger className="py-3 text-sm font-medium">
          {comments.length} comment{comments.length === 1 ? "" : "s"}
        </AccordionTrigger>
        <AccordionContent className="space-y-3 pb-3">
          {comments.map((c) => (
            <div key={c.id} className="rounded-md border border-border p-3">
              <div className="mb-1 text-xs text-muted-foreground">
                @{c.author} · {formatRelative(c.createdAt)}
              </div>
              <MemoizedMarkdown
                id={`pr-comment-${c.id}`}
                text={decodeHtmlEntities(c.body)}
              />
            </div>
          ))}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function formatRelative(iso: string): string {
  if (!iso) return "";
  const when = new Date(iso).getTime();
  if (!Number.isFinite(when)) return "";
  const diff = Date.now() - when;
  if (diff < 0) return "just now";
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(diff / 60_000);
  return `${Math.max(1, mins)}m ago`;
}
