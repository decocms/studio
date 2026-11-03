/**
 * Where a campaign or a post sits: what it answers to, as a column of cards
 * joined by a line, from the goals down to the thing on the page.
 */

import type { ComponentType, ReactNode } from "react";
import { ArrowRight, File06, Flag05, Target04 } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { CampaignGoal } from "@/components/sandbox/content/blog/blog-data";
import { goalMeasure } from "@/components/sandbox/content/blog/campaign-goal";
import type { TFunction } from "@/i18n/use-t.ts";

type Icon = ComponentType<{ size?: number; className?: string }>;

const KIND_ICON = {
  goal: Target04,
  campaign: Flag05,
  post: File06,
} as const satisfies Record<string, Icon>;

export interface SitsNode {
  key: string;
  kind: keyof typeof KIND_ICON;
  title: string;
  /** A longer line under the title, such as a post's objective. */
  body?: string;
  /** Short facts, shown joined by "·". */
  meta?: string[];
  /** The card opens something, and shows an arrow. */
  onOpen?: () => void;
  /** Nothing here yet: drawn quieter. */
  muted?: boolean;
  /** The thing on the page itself. */
  onPage?: boolean;
}

function HereIcon({ kind }: { kind: keyof typeof KIND_ICON }) {
  const Icon = KIND_ICON[kind];
  return <Icon size={14} className="shrink-0" />;
}

/** A campaign's goals as cards: each with its measure, or one quiet card when it has none. */
export function goalNodes(
  goals: readonly CampaignGoal[],
  t: TFunction,
  open: (goal: number) => void,
  empty: { title: string; onOpen?: () => void },
): SitsNode[] {
  if (goals.length === 0) {
    return [
      {
        key: "goals:none",
        kind: "goal",
        muted: true,
        title: empty.title,
        onOpen: empty.onOpen,
      },
    ];
  }
  return goals.map((goal, index) => ({
    key: `goal:${index}`,
    kind: "goal",
    title: goal.text,
    meta: [t("contentTrack.sits.goal"), goalMeasure(goal, t)],
    onOpen: () => open(index),
  }));
}

/** "2 goals you defined": how many goals a campaign answers to. */
export function goalsHint(count: number, t: TFunction): string {
  if (count === 0) return t("contentTrack.sits.goalsNone");
  return count === 1
    ? t("contentTrack.sits.goalsOne")
    : t("contentTrack.sits.goalsMany", { count });
}

/** The line between two cards, under their icons. */
function Joint() {
  return <span aria-hidden className="ml-[29px] block h-3 w-px bg-border" />;
}

function NodeCard({ node }: { node: SitsNode }) {
  const Icon = KIND_ICON[node.kind];
  const meta = node.meta?.filter(Boolean) ?? [];
  const body = (
    <>
      <span
        className={cn(
          "grid size-[34px] shrink-0 place-items-center rounded-lg bg-muted",
          node.muted ? "text-muted-foreground/60" : "text-muted-foreground",
        )}
      >
        <Icon size={16} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "text-[13.5px] font-semibold",
            node.muted ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {node.title}
        </span>
        {node.body && (
          <span className="text-[12.5px] leading-[1.45] text-foreground">
            {node.body}
          </span>
        )}
        {meta.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {meta.join(" · ")}
          </span>
        )}
      </span>
      {node.onOpen && (
        <ArrowRight
          size={16}
          className="mt-[9px] shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        />
      )}
    </>
  );
  const frame = cn(
    "group flex w-full items-start gap-3 rounded-[11px] border px-3 py-2.5 text-left",
    node.onPage ? "border-primary/60 bg-card" : "border-border bg-card",
    node.muted && "border-dashed bg-transparent",
  );
  return node.onOpen ? (
    <button
      type="button"
      onClick={node.onOpen}
      className={cn(frame, "transition-colors hover:bg-accent/40")}
    >
      {body}
    </button>
  ) : (
    <div className={frame}>{body}</div>
  );
}

export function WhereItSits({
  title,
  hint,
  nodes,
  action,
  here,
}: {
  title: string;
  /** Beside the title, such as how many goals there are. */
  hint?: string;
  /** Top to bottom. */
  nodes: readonly SitsNode[];
  /** Under the cards, such as "Add goal". */
  action?: ReactNode;
  /** Where the column ends, when it is not a card of its own. */
  here?: { kind: keyof typeof KIND_ICON; label: string; meta?: string[] };
}) {
  const items = [
    ...nodes.map((node) => ({ key: node.key, view: <NodeCard node={node} /> })),
    ...(action ? [{ key: "action", view: action }] : []),
  ];
  return (
    <section className="flex flex-col gap-[9px]">
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] font-medium text-muted-foreground">
        {title}
        {hint && <span className="font-normal">· {hint}</span>}
      </h3>
      <ol className="flex flex-col">
        {items.map((item, index) => (
          <li key={item.key}>
            {item.view}
            {(index < items.length - 1 || here) && <Joint />}
          </li>
        ))}
        {here && (
          <li className="flex items-center gap-2 pl-[22px] text-[12.5px] text-muted-foreground">
            <HereIcon kind={here.kind} />
            <span className="font-medium text-foreground">{here.label}</span>
            {here.meta?.filter(Boolean).map((fact) => (
              <span key={fact}>· {fact}</span>
            ))}
          </li>
        )}
      </ol>
    </section>
  );
}
