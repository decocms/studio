/**
 * Settings → Build → Memory: the two `MEMORY.md` indexes every chat starts
 * with (see `loadMemoryBlock` in the API's system prompt builder). One is
 * shared org-wide, one belongs to the signed-in user. Both live on the org
 * filesystem's home volume, so this page is a text editor over two files.
 *
 * A plain textarea, not the WYSIWYG editor: that one re-serializes the whole
 * document on the first keystroke, escaping the paths and wiki-links the agent
 * writes. Saves are conditional on the version the edit started from, so a
 * write by Deco in between asks before it is overwritten.
 */

import { useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { AlertTriangle, Building02, User01 } from "@untitledui/icons";
import { Alert, AlertDescription } from "@decocms/ui/components/alert.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  MEMORY_INJECT_CAP,
  type MemoryScope,
  memoryPath,
  memoryTemplate,
} from "@decocms/shared/memory";
import { Page } from "@/components/page";
import { CollectionTabs } from "@/components/collections/collection-tabs.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { useProjectContext } from "@/sdk";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";
import { useClockTick } from "@/lib/use-clock-tick.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { type TFunction, useT } from "@/i18n/use-t.ts";
import {
  fetchOrgFsText,
  useOrgFsStat,
  writeOrgFsTextIf,
} from "@/hooks/use-org-fs";
import {
  ABSENT,
  DraftSaver,
  type SaveStatus,
  type Version,
  versionOf,
} from "./memory-draft.ts";

const VOLUME = "home";

const noSnapshot = () => 0;

function relativeTime(iso: string, now: number, locale: string): string {
  const secs = Math.round((now - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(secs) >= size)
      return rtf.format(-Math.round(secs / size), unit);
  }
  return rtf.format(0, "second");
}

function statusLabel(
  t: TFunction,
  status: SaveStatus,
  updated: string | null,
): string {
  switch (status) {
    case "dirty":
      return "";
    case "saving":
      return t("settings.memory.saving");
    case "saved":
      return t("settings.memory.saved");
    case "conflict":
      return t("settings.memory.notSaved");
    case "forbidden":
      return t("settings.memory.readOnly");
    case "error":
      return t("settings.memory.saveError");
    case "idle":
      return updated
        ? t("settings.memory.updated", { time: updated })
        : t("settings.memory.notStarted");
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** How full the index is against what a chat actually reads. Silent until it matters. */
function PromptBudget({ length }: { length: number }) {
  const t = useT();
  const ratio = length / MEMORY_INJECT_CAP;
  if (ratio < 0.5) return null;
  const over = ratio > 1;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "inline-flex items-center gap-2 rounded-sm",
            over ? "text-destructive" : ratio > 0.8 && "text-warning",
          )}
        >
          <span className="h-1 w-16 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-current transition-[width]"
              style={{ width: `${Math.min(ratio, 1) * 100}%` }}
            />
          </span>
          {over
            ? t("settings.memory.budgetOver")
            : t("settings.memory.budget", {
                percent: String(Math.round(ratio * 100)),
              })}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {t("settings.memory.budgetHint")}
      </TooltipContent>
    </Tooltip>
  );
}

function EditorSkeleton() {
  return (
    <Card className="gap-3 px-6 py-5">
      <div className="flex min-h-[320px] flex-col gap-3">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </Card>
  );
}

/**
 * One memory file. Keyed by scope at the call site, so a draft never carries
 * across files; a pending save still lands after the switch.
 */
function MemoryDocument({
  scope,
  userId,
  label,
}: {
  scope: MemoryScope;
  userId: string;
  label: string;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const [{ language }] = usePreferences();
  const queryClient = useQueryClient();
  const now = useClockTick(60_000);
  const path = memoryPath(scope, userId);
  const folder = scope === "organization" ? "" : `users/${userId}`;

  // Deco writes from chats in other tabs; recheck whenever this tab regains focus.
  const stat = useOrgFsStat(VOLUME, path, { staleTime: 0 });
  const remote =
    stat.data === undefined
      ? undefined
      : stat.data
        ? versionOf(stat.data)
        : ABSENT;
  const text = useQuery({
    queryKey: KEYS.orgFsText(org.id, VOLUME, path, remote?.marker ?? ""),
    enabled: stat.data != null,
    // Keyed by content hash, so a cached body never goes stale.
    staleTime: Infinity,
    queryFn: () => fetchOrgFsText(org.slug, VOLUME, path),
  });
  const remoteBody = remote === ABSENT ? "" : text.data;

  const [status, setStatus] = useState<SaveStatus>("idle");
  // What the editor was loaded with; a new `generation` remounts it.
  const [shown, setShown] = useState<{
    version: Version;
    body: string;
    generation: number;
  } | null>(null);
  const [length, setLength] = useState<number | null>(null);
  const [saver] = useState(
    () =>
      new DraftSaver(
        (body, expect) =>
          writeOrgFsTextIf(org.slug, VOLUME, path, body, expect),
        setStatus,
        (entry, body) => {
          const version = versionOf(entry);
          // Seeded so our own write never reads as Deco changing the file.
          queryClient.setQueryData(
            KEYS.orgFsText(org.id, VOLUME, path, version.marker),
            body,
          );
          queryClient.setQueryData(KEYS.orgFsStat(org.id, VOLUME, path), entry);
          void queryClient.invalidateQueries({
            queryKey: KEYS.orgFsList(org.id, VOLUME, folder),
          });
          void queryClient.invalidateQueries({
            queryKey: KEYS.orgFsRecent(org.id),
          });
          setShown((s) => s && { ...s, version, body });
        },
      ),
  );
  useSyncExternalStore(saver.subscribe, noSnapshot, noSnapshot);

  // A clean editor follows the file, so Deco's writes between edits show up.
  // It keeps showing the old text until the new one has loaded.
  if (
    remote &&
    remoteBody !== undefined &&
    (status === "idle" || status === "saved") &&
    remote.marker !== shown?.version.marker
  ) {
    setShown({
      version: remote,
      body: remoteBody,
      generation: (shown?.generation ?? 0) + 1,
    });
    setLength(null);
    if (status === "saved") setStatus("idle");
  }

  const loadLatest = () => {
    saver.discard();
    setStatus("idle");
    setLength(null);
    // Forget the loaded version, so the file reloads as a new editor generation.
    setShown((s) => s && { ...s, version: { marker: "", expect: null } });
    void stat.refetch();
  };

  if (!shown && (stat.isError || text.isError)) {
    return (
      <div className="flex items-center justify-center py-20">
        <EmptyState
          image={<AlertTriangle size={48} className="text-muted-foreground" />}
          title={t("settings.memory.errorTitle")}
          description={t("settings.memory.errorDescription")}
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void stat.refetch();
                void text.refetch();
              }}
            >
              {t("settings.memory.retry")}
            </Button>
          }
        />
      </div>
    );
  }

  if (!shown) return <EditorSkeleton />;

  // The template the API seeds on first load is not something Deco remembered.
  const untouched = shown.body.trim() === memoryTemplate(scope).trim();
  const value = untouched ? "" : shown.body;
  const updated =
    !untouched && stat.data
      ? relativeTime(stat.data.updatedAt, now, language)
      : null;

  return (
    <div className="flex flex-col gap-4">
      {status === "conflict" && (
        <Alert variant="info" className="border-warning">
          <AlertTriangle className="text-warning" />
          <AlertDescription className="flex flex-1 flex-wrap items-center justify-between gap-3">
            {t("settings.memory.conflict")}
            <span className="flex gap-2">
              <Button size="sm" variant="outline" onClick={loadLatest}>
                {t("settings.memory.loadLatest")}
              </Button>
              <Button size="sm" onClick={() => saver.flush(true)}>
                {t("settings.memory.keepMine")}
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      )}

      <Card className="gap-0 px-6 py-5">
        <textarea
          key={shown.generation}
          defaultValue={value}
          readOnly={status === "forbidden"}
          aria-label={label}
          placeholder={
            scope === "organization"
              ? t("settings.memory.orgPlaceholder")
              : t("settings.memory.userPlaceholder")
          }
          onChange={(e) => {
            setLength(e.target.value.trim().length);
            saver.change(e.target.value, shown);
          }}
          className="field-sizing-content min-h-[320px] w-full resize-none bg-transparent font-mono text-[13px] leading-6 text-foreground outline-none placeholder:text-muted-foreground"
        />
      </Card>

      <div className="flex min-h-5 items-center justify-between gap-3 text-meta">
        <span
          className={cn(
            "inline-flex items-center gap-1.5",
            status === "error" && "text-destructive",
          )}
          aria-live="polite"
        >
          {status === "saving" && <Spinner className="size-3" />}
          {statusLabel(t, status, updated)}
        </span>
        <PromptBudget length={length ?? value.trim().length} />
      </div>
    </div>
  );
}

export default function SettingsMemoryPage() {
  const t = useT();
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const scope: MemoryScope = search.scope === "user" ? "user" : "organization";
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const ScopeIcon = scope === "organization" ? Building02 : User01;
  const heading =
    scope === "organization"
      ? t("settings.memory.orgHeading", { org: org.name })
      : t("settings.memory.userHeading");

  return (
    <Page>
      <Page.Content>
        <Page.Container width="reading">
          <div className="flex flex-col gap-6">
            <Page.Title>{t("settings.memory.pageTitle")}</Page.Title>
            <CollectionTabs
              placement="page"
              tabs={[
                { id: "organization", label: t("settings.memory.tabOrg") },
                { id: "user", label: t("settings.memory.tabUser") },
              ]}
              activeTab={scope}
              onTabChange={(id) =>
                navigate({
                  to: "/$org/settings/memory",
                  params: { org: org.slug },
                  search: id === "user" ? { scope: "user" } : {},
                  replace: true,
                })
              }
            />
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground">
                  <ScopeIcon size={16} />
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="text-sm font-medium text-foreground">
                    {heading}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {scope === "organization"
                      ? t("settings.memory.orgDescription")
                      : t("settings.memory.userDescription")}
                  </p>
                </div>
              </div>
              {userId ? (
                <MemoryDocument
                  key={scope}
                  scope={scope}
                  userId={userId}
                  label={heading}
                />
              ) : (
                <EditorSkeleton />
              )}
            </div>
          </div>
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
