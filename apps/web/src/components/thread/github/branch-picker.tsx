import { useState } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import { Tabs, TabsList, TabsTrigger } from "@decocms/ui/components/tabs.tsx";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  DotsVertical,
  Edit01,
  GitBranch01,
  GitPullRequest,
  Plus,
  Trash01,
} from "@untitledui/icons";
import { generateBranchName } from "@decocms/shared/branch-name";
import type { Release } from "@decocms/shared/sdk/types";
import type { SandboxMap } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { TOUR_ANCHORS } from "@/components/cms-tour/anchors";
import { decodeHtmlEntities } from "./decode-html-entities.ts";
import { matchesBranchSearch, useBranches } from "./use-branches";
import { useOpenPrs } from "./use-pr-data.ts";
import { nextReleaseColor, releaseDotClass, useReleases } from "./use-releases";

interface Props {
  virtualMcpId: string;
  /** Human-readable creator label used to seed the generated branch name. */
  userLabel: string | null | undefined;
  /** The current branch (a release's branch, or the base). */
  value: string | null | undefined;
  /** The project's production branch — shown as "No ar" (Live). */
  baseBranch?: string | null;
  /** Repo scope for the "Advanced" flow (adopt an existing branch/PR as a draft). */
  orgId: string;
  orgSlug: string;
  userId: string;
  connectionId: string | null;
  owner: string;
  repo: string;
  sandboxMap: SandboxMap | undefined;
  onChange: (branch: string) => void;
  /** Called instead of `onChange` when a brand-new release is created, so CMS
   *  projects can start a fresh thread on the new branch. Falls back to
   *  `onChange`. */
  onCreateBranch?: (branch: string) => void;
  disabled?: boolean;
  /** When true, picking/creating opens a *new* chat on the branch rather than
   *  switching in place (the current thread's branch is fixed). */
  spawnsNewChat?: boolean;
  /** Chat input collapses the label responsively; header always shows it. */
  placement?: "chat" | "header";
}

/** Version switcher over {@link useReleases}: a pinned "No ar" (the published
 *  base) plus the curated list of named, color-coded releases, and an inline
 *  "Nova versão" create. It is NOT a branch list — only versions people named
 *  appear here; each is backed by a git branch under the hood. */
export function BranchPicker({
  virtualMcpId,
  userLabel,
  value,
  baseBranch,
  orgId,
  orgSlug,
  userId,
  connectionId,
  owner,
  repo,
  sandboxMap,
  onChange,
  onCreateBranch,
  disabled = false,
  spawnsNewChat = false,
  placement = "chat",
}: Props) {
  const t = useT();
  const isHeader = placement === "header";
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Release | null>(null);
  const { releases, createRelease, renameRelease, deleteRelease } =
    useReleases(virtualMcpId);

  const isBase = !!value && value === baseBranch;
  const current = releases.find((r) => r.branch === value);
  // Current branch that is neither base nor a stored release: show as a draft.
  const unlisted = !isBase && !current && !!value;

  const currentLabel = isBase
    ? t("thread.branchPicker.live")
    : (current?.name ?? t("thread.branchPicker.defaultVersionName"));
  const label = value ? currentLabel : t("thread.branchPicker.selectVersion");
  const currentDot = isBase
    ? "bg-success"
    : releaseDotClass(current?.color ?? "orange");

  const pick = (branch: string) => {
    onChange(branch);
    setOpen(false);
  };

  // Advanced: adopt an existing branch/PR head as a named draft, then switch.
  const adoptBranch = (branch: string, name: string) => {
    if (!releases.some((r) => r.branch === branch)) {
      void createRelease({
        branch,
        name: name.trim() || branch,
        color: nextReleaseColor(releases.length),
        createdAt: new Date().toISOString(),
      });
    }
    onChange(branch);
    setAdvanced(false);
    setOpen(false);
  };

  // One above the highest existing "Rascunho N" — renamed releases don't count.
  const nextDraftName = () => {
    const base = t("thread.branchPicker.defaultVersionName");
    const prefix = `${base} `;
    const max = releases.reduce((m, r) => {
      if (!r.name.startsWith(prefix)) return m;
      const n = Number(r.name.slice(prefix.length));
      return Number.isInteger(n) && n > m ? n : m;
    }, 0);
    return `${base} ${max + 1}`;
  };

  const create = () => {
    const branch = generateBranchName(userLabel);
    void createRelease({
      branch,
      name: nextDraftName(),
      color: nextReleaseColor(releases.length),
      createdAt: new Date().toISOString(),
    });
    (onCreateBranch ?? onChange)(branch);
    setOpen(false);
  };

  const resetTransient = () => {
    setEditing(null);
    setEditName("");
    setAdvanced(false);
  };

  const startRename = (r: Release) => {
    setEditing(r.branch);
    setEditName(r.name);
  };

  const saveRename = (branch: string) => {
    const next = editName.trim();
    if (next) void renameRelease(branch, next);
    setEditing(null);
    setEditName("");
  };

  const confirmDelete = () => {
    const r = pendingDelete;
    setPendingDelete(null);
    if (!r) return;
    // Land on production before the deleted draft vanishes from the list.
    if (r.branch === value && baseBranch) pick(baseBranch);
    else setOpen(false);
    void deleteRelease(r.branch);
  };

  const popover = (
    <Popover
      open={open}
      onOpenChange={
        disabled
          ? undefined
          : (next) => {
              if (!next) resetTransient();
              setOpen(next);
            }
      }
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex min-w-0 shrink"
            data-tour={TOUR_ANCHORS.branches}
          >
            <PopoverTrigger asChild>
              <Button
                variant={isHeader ? "outline" : "ghost"}
                size={isHeader ? "sm" : "default"}
                aria-label={label}
                disabled={disabled}
                className={cn(
                  "shrink min-w-0 max-w-[220px] gap-2",
                  isHeader
                    ? "text-xs"
                    : "text-xs text-muted-foreground hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    value ? currentDot : "bg-muted-foreground",
                  )}
                />
                <span className="min-w-0 truncate @max-3xl/panel-header:hidden">
                  {label}
                </span>
                {!disabled && (
                  <ChevronDown size={12} className="opacity-60 shrink-0" />
                )}
              </Button>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        className="w-[min(300px,calc(100vw-2rem))] p-1.5"
        align="start"
      >
        {spawnsNewChat && (
          <p className="px-2 pb-1.5 pt-1 text-xs text-muted-foreground">
            {t("thread.branchPicker.newChatHint")}
          </p>
        )}
        {advanced ? (
          <AdvancedPicker
            orgId={orgId}
            orgSlug={orgSlug}
            userId={userId}
            connectionId={connectionId}
            owner={owner}
            repo={repo}
            sandboxMap={sandboxMap}
            enabled={open}
            onBack={() => setAdvanced(false)}
            onAdopt={adoptBranch}
          />
        ) : (
          <>
            <div className="flex flex-col">
              <VersionRow
                dot="bg-success"
                label={t("thread.branchPicker.live")}
                branch={baseBranch}
                selected={isBase}
                disabled={!baseBranch}
                onSelect={() => baseBranch && pick(baseBranch)}
              />
              {(unlisted || releases.length > 0) && (
                <div className="my-1 border-t" />
              )}
              {unlisted && (
                <VersionRow
                  dot={releaseDotClass("orange")}
                  label={t("thread.branchPicker.defaultVersionName")}
                  branch={value}
                  selected
                  onSelect={() => value && pick(value)}
                />
              )}
              {releases.map((r) =>
                editing === r.branch ? (
                  <div key={r.branch} className="flex items-center gap-1.5 p-1">
                    <input
                      // biome-ignore lint/a11y/noAutofocus: opened by an explicit click
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveRename(r.branch);
                        if (e.key === "Escape") setEditing(null);
                      }}
                      className="h-8 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                    />
                    <Button size="sm" onClick={() => void saveRename(r.branch)}>
                      {t("thread.branchPicker.save")}
                    </Button>
                  </div>
                ) : (
                  <ReleaseRow
                    key={r.branch}
                    release={r}
                    selected={r.branch === value}
                    onSelect={() => pick(r.branch)}
                    onRename={() => startRename(r)}
                    onDelete={() => setPendingDelete(r)}
                  />
                ),
              )}
            </div>
            <div className="my-1 border-t" />
            <button
              type="button"
              onClick={() => void create()}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-4 w-4 shrink-0" />
              {t("thread.branchPicker.newVersion")}
            </button>
            <button
              type="button"
              onClick={() => setAdvanced(true)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {t("thread.branchPicker.advanced")}
              <ChevronRight className="h-4 w-4 shrink-0" />
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );

  return (
    <>
      {popover}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("thread.branchPicker.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete &&
                t("thread.branchPicker.deleteConfirm", {
                  name: pendingDelete.name,
                })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("thread.branchPicker.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("thread.branchPicker.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function VersionRow({
  dot,
  label,
  branch,
  selected = false,
  disabled = false,
  onSelect,
}: {
  dot: string;
  label: string;
  branch?: string | null;
  selected?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const row = (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/60",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className={cn("h-2 w-2 shrink-0 rounded-full", dot)} />
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
  if (!branch) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono text-xs">
        {branch}
      </TooltipContent>
    </Tooltip>
  );
}

/** A named release row: click to switch, with a ⋯ menu to rename or discard. */
function ReleaseRow({
  release,
  selected,
  onSelect,
  onRename,
  onDelete,
}: {
  release: Release;
  selected: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <div
      className={cn(
        "group flex items-center rounded-md",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onSelect}
            className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 text-left text-sm"
          >
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                releaseDotClass(release.color),
              )}
            />
            <span className="flex-1 truncate">{release.name}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="font-mono text-xs">
          {release.branch}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("thread.branchPicker.moreActions")}
            className="mr-1 h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <DotsVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRename}>
            <Edit01 className="h-4 w-4" />
            {t("thread.branchPicker.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash01 className="h-4 w-4" />
            {t("thread.branchPicker.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** "Advanced": adopt an existing branch or open PR as a named draft. Reuses the
 *  classic branch/PR listing ({@link useBranches} + {@link useOpenPrs}). */
function AdvancedPicker({
  orgId,
  orgSlug,
  userId,
  connectionId,
  owner,
  repo,
  sandboxMap,
  enabled,
  onBack,
  onAdopt,
}: {
  orgId: string;
  orgSlug: string;
  userId: string;
  connectionId: string | null;
  owner: string;
  repo: string;
  sandboxMap: SandboxMap | undefined;
  enabled: boolean;
  onBack: () => void;
  onAdopt: (branch: string, name: string) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<"branches" | "prs">("branches");
  const [search, setSearch] = useState("");
  const {
    recent,
    yours,
    others,
    isLoading,
    hasMore,
    isFetchingMore,
    fetchMore,
  } = useBranches({
    orgId,
    orgSlug,
    userId,
    connectionId,
    sandboxMap,
    owner,
    repo,
    search: tab === "branches" ? search : "",
    enabled: enabled && tab === "branches",
  });
  const { data: prs = [], isLoading: prsLoading } = useOpenPrs({
    orgId,
    orgSlug,
    connectionId: connectionId ?? "",
    owner,
    repo,
    enabled: enabled && tab === "prs",
  });

  const repoFullName = `${owner}/${repo}`.toLowerCase();
  const openablePrs = prs.filter(
    (pr) => pr.headRepoFullName?.toLowerCase() === repoFullName,
  );

  const seen = new Set<string>();
  const branches = [...recent, ...yours, ...others].filter((b) => {
    if (seen.has(b.name)) return false;
    seen.add(b.name);
    return true;
  });

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4 shrink-0" />
        {t("thread.branchPicker.advancedBack")}
      </button>
      <Command
        filter={
          tab === "branches"
            ? (v, s) => (matchesBranchSearch(v, s) ? 1 : 0)
            : undefined
        }
      >
        <CommandInput
          placeholder={
            tab === "branches"
              ? t("thread.branchPicker.searchBranches")
              : t("thread.branchPicker.searchPullRequests")
          }
          value={search}
          onValueChange={setSearch}
        />
        <Tabs
          className="px-2 pt-2 pb-1"
          value={tab}
          onValueChange={(v) => {
            setTab(v as "branches" | "prs");
            setSearch("");
          }}
        >
          <TabsList
            className="h-auto w-fit justify-start gap-1 bg-accent p-1"
            variant="pill"
          >
            <TabsTrigger value="branches" className="h-6 px-2.5 text-xs">
              {t("thread.branchPicker.branchesTab")}
            </TabsTrigger>
            <TabsTrigger value="prs" className="h-6 px-2.5 text-xs">
              {t("thread.branchPicker.prsTab")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <CommandList
          onScroll={(e) => {
            const el = e.currentTarget;
            if (
              tab === "branches" &&
              el.scrollHeight - el.scrollTop - el.clientHeight < 48
            ) {
              fetchMore();
            }
          }}
        >
          {tab === "branches" ? (
            <>
              {isLoading && (
                <div className="p-3 text-xs text-muted-foreground">
                  {t("thread.branchPicker.loadingMore")}
                </div>
              )}
              {!isLoading && branches.length === 0 && (
                <CommandEmpty>
                  {t("thread.branchPicker.noBranchesFound")}
                </CommandEmpty>
              )}
              {branches.length > 0 && (
                <CommandGroup>
                  {branches.map((b) => (
                    <CommandItem
                      key={b.name}
                      value={b.name}
                      className="cursor-pointer"
                      onSelect={() => onAdopt(b.name, b.name)}
                    >
                      <GitBranch01 className="mr-2 h-4 w-4 shrink-0" />
                      <span className="flex-1 truncate">{b.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {hasMore && (
                <div className="p-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full text-xs"
                    disabled={isFetchingMore}
                    onClick={fetchMore}
                  >
                    {isFetchingMore
                      ? t("thread.branchPicker.loadingMore")
                      : t("thread.branchPicker.loadMoreBranches")}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              {prsLoading && (
                <div className="p-3 text-xs text-muted-foreground">
                  {t("thread.branchPicker.loadingPullRequests")}
                </div>
              )}
              {!prsLoading && openablePrs.length === 0 && (
                <CommandEmpty>
                  {t("thread.branchPicker.noOpenPullRequests")}
                </CommandEmpty>
              )}
              {openablePrs.length > 0 && (
                <CommandGroup>
                  {openablePrs.map((pr) => (
                    <CommandItem
                      key={pr.number}
                      value={`#${pr.number} ${pr.title} ${pr.head}`}
                      className="cursor-pointer"
                      onSelect={() =>
                        onAdopt(pr.head, decodeHtmlEntities(pr.title))
                      }
                    >
                      <GitPullRequest className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">
                          {decodeHtmlEntities(pr.title)}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          #{pr.number} · {pr.head}
                        </span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </>
          )}
        </CommandList>
      </Command>
    </div>
  );
}
