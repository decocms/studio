/**
 * MY deco — the cross-org home at `/`.
 *
 * The center of your work: every thread you own, across every org you belong to,
 * as cards sorted by what needs you next. This is deliberately org-less (no
 * ProjectContextProvider) — data comes from a per-org fan-out (see
 * `useMyThreads`), and each card carries its own org so navigation lands in the
 * right place.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import RequiredAuthLayout from "@/web/layouts/required-auth-layout";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { AccountMenu } from "@/web/layouts/my-deco/account-menu";
import { OrgIcon } from "@/web/components/header/org-switcher";
import { useMyThreads, type MyThreadOrg } from "@/web/hooks/use-my-threads";
import { ThreadCard } from "./thread-card";

function OrgChip({
  label,
  count,
  active,
  onClick,
  org,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  org?: MyThreadOrg;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-foreground/20 bg-foreground text-background"
          : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {org && <OrgIcon org={org} size="xs" />}
      <span className="truncate max-w-[10rem]">{label}</span>
      <span
        className={cn(
          "tabular-nums",
          active ? "text-background/70" : "text-muted-foreground/60",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
      <div className="h-3 w-24 rounded bg-muted animate-pulse" />
      <div className="h-4 w-full rounded bg-muted animate-pulse" />
      <div className="h-3 w-2/3 rounded bg-muted animate-pulse" />
      <div className="mt-2 h-3 w-20 rounded bg-muted animate-pulse" />
    </div>
  );
}

function MyDecoContent() {
  const { threads, isLoading, erroredOrgs, orgs } = useMyThreads();
  const [orgFilter, setOrgFilter] = useState<string | null>(null);

  const visible = orgFilter
    ? threads.filter((t) => t.org.id === orgFilter)
    : threads;

  const countFor = (orgId: string) =>
    threads.filter((t) => t.org.id === orgId).length;

  return (
    <div className="flex flex-col h-dvh overflow-hidden bg-sidebar">
      {/* Header */}
      <header className="shrink-0 flex items-center justify-between gap-2 px-4 h-14 border-b border-border/60">
        <Link
          to="/"
          className="flex items-center gap-2 shrink-0"
          aria-label="MY deco"
        >
          <Toolbar.Logo />
          <span className="text-sm font-semibold tracking-tight">deco</span>
        </Link>
        <AccountMenu />
      </header>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-8 flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">Your work</h1>
            <p className="text-sm text-muted-foreground">
              Everything you're moving, across every org — sorted by what needs
              you next.
            </p>
          </div>

          {/* Org filter chips */}
          {orgs.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              <OrgChip
                label="All"
                count={threads.length}
                active={orgFilter === null}
                onClick={() => setOrgFilter(null)}
              />
              {orgs.map((org) => (
                <OrgChip
                  key={org.id}
                  org={org}
                  label={org.name}
                  count={countFor(org.id)}
                  active={orgFilter === org.id}
                  onClick={() => setOrgFilter(org.id)}
                />
              ))}
            </div>
          )}

          {/* Errored orgs (non-fatal) */}
          {erroredOrgs.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="size-3.5 shrink-0" />
              Couldn't load threads from{" "}
              {erroredOrgs.map((o) => o.name).join(", ")}.
            </div>
          )}

          {/* Grid */}
          {isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
                <CardSkeleton key={i} />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
              <p className="text-sm font-medium">No threads yet</p>
              <p className="text-sm text-muted-foreground max-w-sm">
                Start a conversation in any of your organizations and it'll show
                up here as a card you can track.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((item) => (
                <ThreadCard
                  key={`${item.org.id}:${item.thread.id}`}
                  item={item}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MyDecoPage() {
  return (
    <RequiredAuthLayout>
      <MyDecoContent />
    </RequiredAuthLayout>
  );
}
