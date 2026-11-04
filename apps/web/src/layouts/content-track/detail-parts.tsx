/**
 * The pieces a content track page is built from: a card's and a campaign's.
 * Steps across the top, sections down the main column, properties beside it.
 */

import type { ReactNode } from "react";
import { Check } from "@untitledui/icons";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { type TranslationKey, useT } from "@/i18n/use-t.ts";

/** A page's phases as steps: the ones it has passed are done. */
export function PhaseSteps<P extends string>({
  steps,
  labels,
  phase,
  reached,
  onSelect,
}: {
  steps: readonly P[];
  labels: Record<P, TranslationKey>;
  phase: P;
  reached: P;
  onSelect: (phase: P) => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-1">
      {steps.map((entry, index) => {
        const active = entry === phase;
        const done = index < steps.indexOf(reached);
        return (
          <button
            key={entry}
            type="button"
            onClick={() => onSelect(entry)}
            className={cn(
              "flex items-center gap-[7px] rounded-full px-[13px] py-[5px] text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted",
              active && "bg-muted font-semibold text-foreground",
            )}
          >
            <span
              className={cn(
                "grid size-[15px] place-items-center rounded-full border-[1.5px] border-current",
                done && "border-foreground bg-foreground text-background",
                active && !done && "border-foreground",
              )}
            >
              {done ? (
                <Check size={10} />
              ) : active ? (
                <span className="size-1.5 rounded-full bg-foreground" />
              ) : null}
            </span>
            {t(labels[entry])}
          </button>
        );
      })}
    </div>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-[9px]">
      <h3 className="text-[12.5px] font-medium text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Lines of text that are not there yet, with the role writing them. */
export function Pending({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3">
      {children}
      <div className="flex w-full flex-col gap-2">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  );
}

export function FrameLine({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-px grid w-3.5 shrink-0 place-items-center text-muted-foreground">
        {icon}
      </span>
      <p className="min-w-0 flex-1 text-muted-foreground">
        <span className="font-semibold text-foreground">{label}</span>{" "}
        {children}
      </p>
    </div>
  );
}

/** Search terms as chips, with their monthly volume when a system reported it. */
export function KeywordChips({
  keywords,
}: {
  keywords: readonly { term: string; volume?: number }[];
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-[7px]">
      {keywords.map((keyword) => (
        <span
          key={keyword.term}
          className="inline-flex items-center gap-[7px] rounded-[9px] border border-border bg-card px-[11px] py-1.5 text-[12.5px] text-foreground"
        >
          {keyword.term}
          {keyword.volume !== undefined && (
            <span className="text-[11px] text-muted-foreground">
              {t("contentTrack.card.perMonth", {
                volume: keyword.volume.toLocaleString(),
              })}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

/** The properties box beside a page's main column. */
export function PropertiesPanel({
  title,
  children,
}: {
  /** A heading, or a row of its own such as tabs. */
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-edge">
      {typeof title === "string" ? (
        <span className="border-b border-border pb-2 text-[13px] font-semibold text-foreground">
          {title}
        </span>
      ) : (
        title
      )}
      {children}
    </div>
  );
}

export function Row({
  icon,
  children,
  trail,
}: {
  icon: ReactNode;
  children: ReactNode;
  trail?: ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-center gap-2 text-[13px] text-foreground">
      <span className="grid w-4 shrink-0 place-items-center text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1 truncate">{children}</div>
      {trail && (
        <span className="shrink-0 text-xs text-muted-foreground">{trail}</span>
      )}
    </div>
  );
}

export function Group({
  caption,
  children,
}: {
  caption?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {caption && (
        <span className="pb-1 text-xs font-medium text-muted-foreground">
          {caption}
        </span>
      )}
      {children}
    </div>
  );
}
