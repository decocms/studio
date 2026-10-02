/**
 * Settings → Build → Memory: the two `MEMORY.md` indexes every chat starts
 * with (see `loadMemoryBlock` in the API's system prompt builder). One is
 * shared org-wide, one belongs to the signed-in user. Both live on the org
 * filesystem's home volume, so this page is a markdown editor over two files.
 *
 * Deco writes these files from inside chats, so a save checks the file is
 * still the version the edit started from, and asks before overwriting.
 */

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Building02, User01 } from "@untitledui/icons";
import { Alert, AlertDescription } from "@decocms/ui/components/alert.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Page } from "@/components/page";
import { CollectionTabs } from "@/components/collections/collection-tabs.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { MarkdownEditor } from "@/components/markdown-editor";
import { useProjectContext } from "@/sdk";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { type TFunction, useT } from "@/i18n/use-t.ts";
import {
  entryMarker,
  fetchOrgFsStat,
  useOrgFsDownloadUrl,
  useOrgFsStat,
  useOrgFsWriteText,
} from "@/hooks/use-org-fs";

type Scope = "organization" | "user";

const VOLUME = "home";

/** Mirrors the API's `MEMORY_INJECT_CAP`: past this, chats see a truncated index. */
const PROMPT_CAP = 16_000;

/** Quiet time after the last keystroke before the draft is written. */
const SAVE_DELAY_MS = 800;

/** Version marker for "no file yet", so a first write still has something to check. */
const ABSENT = "absent";

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "conflict" | "error";

function memoryPath(scope: Scope, userId: string): string {
  return scope === "organization" ? "MEMORY.md" : `users/${userId}/MEMORY.md`;
}

function relativeTime(iso: string, locale: string): string {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
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
  updatedAt: string | undefined,
  locale: string,
): string {
  switch (status) {
    case "dirty":
    case "saving":
      return t("settings.memory.saving");
    case "saved":
      return t("settings.memory.saved");
    case "conflict":
      return t("settings.memory.notSaved");
    case "error":
      return t("settings.memory.saveError");
    case "idle":
      return updatedAt
        ? t("settings.memory.updated", {
            time: relativeTime(updatedAt, locale),
          })
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
  const ratio = length / PROMPT_CAP;
  if (ratio < 0.5) return null;
  const over = ratio > 1;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2",
        over ? "text-destructive" : ratio > 0.8 && "text-warning",
      )}
      title={t("settings.memory.budgetHint")}
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
  );
}

/**
 * One memory file. Keyed by scope at the call site, so switching tabs never
 * carries a draft, a timer or a version across files.
 *
 * `editorKey` pins the editor to the version it was seeded from while a draft
 * is open (null follows the file); `base` is the version the next save must
 * still find on the server, a ref because saves read it after awaits.
 */
function MemoryDocument({ scope, path }: { scope: Scope; path: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const [{ language }] = usePreferences();
  const queryClient = useQueryClient();
  const fileUrl = useOrgFsDownloadUrl(VOLUME)(path);
  const write = useOrgFsWriteText(VOLUME);

  // Deco writes from chats in other tabs; recheck whenever this tab regains focus.
  const stat = useOrgFsStat(VOLUME, path, { staleTime: 0 });
  const remote =
    stat.data === undefined
      ? undefined
      : stat.data
        ? entryMarker(stat.data)
        : ABSENT;
  const text = useQuery({
    queryKey: KEYS.orgFsText(org.id, VOLUME, path, remote ?? ""),
    enabled: stat.data != null,
    // Keyed by content hash, so a cached body can never go stale.
    staleTime: Infinity,
    queryFn: async () => {
      const res = await fetch(fileUrl, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
  });

  const [editorKey, setEditorKey] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [length, setLength] = useState<number | null>(null);
  const base = useRef(ABSENT);
  const draft = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef(Promise.resolve());

  // A clean editor follows the file, so Deco's writes between edits show up.
  const [seenRemote, setSeenRemote] = useState(remote);
  if (remote !== seenRemote) {
    setSeenRemote(remote);
    if (editorKey !== null && (status === "saved" || status === "idle")) {
      setEditorKey(null);
      setLength(null);
      setStatus("idle");
    }
  }

  const save = (force: boolean) => {
    queue.current = queue.current.then(async () => {
      const body = draft.current;
      if (body === null) return;
      setStatus("saving");
      try {
        if (!force) {
          const current = await fetchOrgFsStat(org.slug, VOLUME, path);
          if ((current ? entryMarker(current) : ABSENT) !== base.current) {
            setStatus("conflict");
            return;
          }
        }
        const entry = await write.mutateAsync({
          path,
          body,
          contentType: "text/markdown; charset=utf-8",
        });
        base.current = entryMarker(entry);
        // Seeded so our own write never reads as Deco changing the file.
        queryClient.setQueryData(
          KEYS.orgFsText(org.id, VOLUME, path, base.current),
          body,
        );
        queryClient.setQueryData(KEYS.orgFsStat(org.id, VOLUME, path), entry);
        setSeenRemote(base.current);
        if (draft.current === body) {
          draft.current = null;
          setStatus("saved");
        }
      } catch {
        setStatus("error");
      }
    });
  };

  const onChange = (markdown: string) => {
    if (editorKey === null) {
      setEditorKey(remote ?? ABSENT);
      base.current = remote ?? ABSENT;
    }
    draft.current = markdown;
    setLength(markdown.length);
    if (status === "conflict") return;
    setStatus("dirty");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(false), SAVE_DELAY_MS);
  };

  const loadLatest = () => {
    clearTimeout(timer.current);
    draft.current = null;
    setEditorKey(null);
    setLength(null);
    setStatus("idle");
    void stat.refetch();
  };

  const keepMine = () => {
    clearTimeout(timer.current);
    save(true);
  };

  if (stat.isError || text.isError) {
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

  const loading =
    editorKey === null &&
    (remote === undefined || (stat.data != null && text.data === undefined));
  const content = remote === ABSENT ? "" : (text.data ?? "");
  const ScopeIcon = scope === "organization" ? Building02 : User01;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground">
          <ScopeIcon size={16} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium text-foreground">
            {scope === "organization"
              ? t("settings.memory.orgHeading", { org: org.name })
              : t("settings.memory.userHeading")}
          </p>
          <p className="text-sm text-muted-foreground">
            {scope === "organization"
              ? t("settings.memory.orgDescription")
              : t("settings.memory.userDescription")}
          </p>
        </div>
      </div>

      {status === "conflict" && (
        <Alert variant="info">
          <AlertTriangle />
          <AlertDescription className="flex flex-1 flex-wrap items-center justify-between gap-3">
            {t("settings.memory.conflict")}
            <span className="flex gap-2">
              <Button size="sm" variant="outline" onClick={loadLatest}>
                {t("settings.memory.loadLatest")}
              </Button>
              <Button size="sm" onClick={keepMine}>
                {t("settings.memory.keepMine")}
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      )}

      <Card className="gap-0 px-6 py-5">
        {loading ? (
          <div className="flex min-h-[200px] flex-col gap-3 sm:min-h-[320px]">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <MarkdownEditor
            key={editorKey ?? remote}
            defaultValue={content}
            onChange={onChange}
            attachments={false}
            placeholder={
              scope === "organization"
                ? t("settings.memory.orgPlaceholder")
                : t("settings.memory.userPlaceholder")
            }
          />
        )}
      </Card>

      <div className="flex min-h-5 items-center justify-between gap-3 text-meta">
        <span
          className={cn(
            "inline-flex items-center gap-1.5",
            status === "error" && "text-destructive",
          )}
          aria-live="polite"
        >
          {(status === "dirty" || status === "saving") && (
            <Spinner className="size-3" />
          )}
          {!loading && statusLabel(t, status, stat.data?.updatedAt, language)}
        </span>
        <PromptBudget length={length ?? content.length} />
      </div>
    </div>
  );
}

export default function SettingsMemoryPage() {
  const t = useT();
  const { data: session } = authClient.useSession();
  const [scope, setScope] = useState<Scope>("organization");
  const userId = session?.user.id;

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
                setScope(id === "user" ? "user" : "organization")
              }
            />
            {userId ? (
              <MemoryDocument
                key={scope}
                scope={scope}
                path={memoryPath(scope, userId)}
              />
            ) : (
              <Skeleton className="h-[360px] rounded-xl" />
            )}
          </div>
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
