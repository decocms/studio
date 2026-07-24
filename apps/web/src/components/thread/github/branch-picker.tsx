import { type UIEvent, useRef, useState } from "react";
import type { SandboxMap } from "@/sdk";
import { useMembersQuery } from "@/hooks/use-members";
import { getInitials } from "@/lib/get-initials";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@deco/ui/components/command.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Tabs, TabsList, TabsTrigger } from "@deco/ui/components/tabs.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { ChevronDown, GitBranch01, GitPullRequest } from "@untitledui/icons";
import { generateBranchName } from "@decocms/shared/branch-name";
import { decodeHtmlEntities } from "./decode-html-entities.ts";
import { useBranches } from "./use-branches";
import { useT } from "@/i18n/use-t.ts";
import { useOpenPrs } from "./use-pr-data.ts";
import { TOUR_ANCHORS } from "@/components/cms-tour/anchors";

interface Props {
  orgId: string;
  orgSlug: string;
  userId: string;
  /** Human-readable creator label (display name, else email local-part) used to
   *  seed generated branch names. */
  userLabel: string | null | undefined;
  virtualMcpId: string;
  connectionId: string | null;
  owner: string;
  repo: string;
  sandboxMap: SandboxMap | undefined;
  value: string | null | undefined;
  onChange: (branch: string) => void;
  /** When true, the trigger is disabled — the user can't open the
   *  picker. The tooltip still surfaces the current branch on hover. */
  disabled?: boolean;
  /** Chat input uses responsive label collapse; header always shows the name. */
  placement?: "chat" | "header";
}

/**
 * Grouped branch picker: "Your branches" (from sandboxMap) + "Other branches in
 * repo" (from github-mcp-server.list_branches).
 */
export function BranchPicker({
  orgId,
  orgSlug,
  userId,
  userLabel,
  virtualMcpId,
  connectionId,
  owner,
  repo,
  sandboxMap,
  value,
  onChange,
  disabled = false,
  placement = "chat",
}: Props) {
  const t = useT();
  const isHeader = placement === "header";
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"branches" | "prs">("branches");
  const [search, setSearch] = useState("");
  const [isSearchingRemote, setIsSearchingRemote] = useState(false);
  const searchRequestId = useRef(0);

  const {
    recent,
    yours,
    others,
    isLoading,
    isError,
    hasMore,
    isFetchingMore,
    fetchMore,
    fetchUntilMatch,
  } = useBranches({
    orgId,
    orgSlug,
    virtualMcpId,
    userId,
    connectionId,
    sandboxMap,
    owner,
    repo,
    enabled: open,
  });

  // userId -> { name, image } for contributor avatars on recent branches.
  // Non-suspense variant so the trigger button never blocks on member loading.
  const { data: membersData } = useMembersQuery({ enabled: open });
  const memberById = new Map<string, MemberUser | undefined>(
    ((membersData?.data?.members ?? []) as OrgMember[]).map(
      (m) => [m.userId, m.user] as const,
    ),
  );

  // Open PRs for the repo — a PR is just a branch, so selecting one starts a
  // sandbox on its head branch, exactly like picking a branch.
  const {
    data: prs = [],
    isLoading: prsLoading,
    isError: prsError,
  } = useOpenPrs({
    orgId,
    orgSlug,
    connectionId: connectionId ?? "",
    owner,
    repo,
    enabled: open && tab === "prs",
  });

  // Only same-repo PRs are openable: a fork PR's head.ref names a branch in the
  // fork, not this repo, so picking it would fail or hit a same-named local
  // branch. Hide those, but surface a count so the drop isn't silent.
  const repoFullName = `${owner}/${repo}`.toLowerCase();
  const openablePrs = prs.filter(
    (pr) => pr.headRepoFullName?.toLowerCase() === repoFullName,
  );
  const hiddenForkPrs = prs.length - openablePrs.length;

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  const label = value ?? t("thread.branchPicker.selectBranch");
  const handleSearchChange = (nextSearch: string) => {
    setSearch(nextSearch);
    searchRequestId.current += 1;

    const requestId = searchRequestId.current;
    const trimmedSearch = nextSearch.trim();
    // PRs are all loaded up-front, so only branches need remote search paging.
    if (!trimmedSearch || tab !== "branches") {
      setIsSearchingRemote(false);
      return;
    }

    setIsSearchingRemote(true);
    void fetchUntilMatch(
      trimmedSearch,
      () => requestId === searchRequestId.current,
    ).finally(() => {
      if (requestId === searchRequestId.current) {
        setIsSearchingRemote(false);
      }
    });
  };

  const onListScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const distanceFromBottom =
      target.scrollHeight - target.scrollTop - target.clientHeight;

    if (tab === "branches" && distanceFromBottom < 48) {
      fetchMore();
    }
  };

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
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
                  "font-mono shrink min-w-0 max-w-[200px] gap-1.5",
                  isHeader
                    ? "text-xs"
                    : "text-xs text-muted-foreground hover:text-foreground",
                )}
              >
                <GitBranch01 className="h-3.5 w-3.5 shrink-0" />
                {/* Show the branch name (truncated) so the branch in use is
                    visible at a glance. Below `lg` (< 1024px) collapse to an
                    icon-only button — the name stays available via the tooltip. */}
                <span className="min-w-0 truncate max-lg:hidden">{label}</span>
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
        className="w-[min(420px,calc(100vw-2rem))] p-0"
        align="start"
      >
        <Command>
          <div className="*:data-[slot=command-input-wrapper]:flex-1 *:data-[slot=command-input-wrapper]:border-b-0 flex items-center border-b pr-2">
            <CommandInput
              placeholder={
                tab === "branches"
                  ? t("thread.branchPicker.searchLoadedBranches")
                  : "Search pull requests…"
              }
              value={search}
              onValueChange={handleSearchChange}
            />
            {tab === "branches" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0"
                onClick={() => pick(generateBranchName(userLabel))}
              >
                {t("thread.branchPicker.new")}
              </Button>
            )}
          </div>
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
                Branches
              </TabsTrigger>
              <TabsTrigger value="prs" className="h-6 px-2.5 text-xs">
                PRs
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <CommandList onScroll={onListScroll}>
            {tab === "prs" ? (
              <>
                {prsError && (
                  <div className="p-3 text-xs text-muted-foreground">
                    Couldn't load pull requests from GitHub.
                  </div>
                )}
                {prsLoading && (
                  <div className="p-3 text-xs text-muted-foreground">
                    Loading pull requests…
                  </div>
                )}
                {!prsError && !prsLoading && (
                  <CommandEmpty>
                    {search.trim()
                      ? "No pull requests match your search."
                      : "No open pull requests."}
                  </CommandEmpty>
                )}
                {openablePrs.length > 0 && (
                  <CommandGroup heading="Open pull requests">
                    {openablePrs.map((pr) => (
                      <CommandItem
                        key={pr.number}
                        value={`#${pr.number} ${pr.title} ${pr.head}`}
                        className="cursor-pointer"
                        onSelect={() => pick(pr.head)}
                      >
                        <GitPullRequest className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">
                            {decodeHtmlEntities(pr.title)}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            #{pr.number} · {pr.head}
                            {pr.author ? ` · @${pr.author}` : ""}
                          </span>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {hiddenForkPrs > 0 && (
                  <div className="border-t p-2 text-center text-xs text-muted-foreground">
                    {hiddenForkPrs} PR{hiddenForkPrs > 1 ? "s" : ""} from forks
                    hidden — open on a branch in this repo
                  </div>
                )}
              </>
            ) : (
              <>
                {isError && (
                  <div className="p-3 text-xs text-muted-foreground">
                    {t("thread.branchPicker.couldntLoadBranches")}
                  </div>
                )}
                {!isError && !isLoading && (
                  <CommandEmpty>
                    {hasMore
                      ? t("thread.branchPicker.lookingThroughMoreBranches")
                      : t("thread.branchPicker.noBranchesFound")}
                  </CommandEmpty>
                )}
                {recent.length > 0 && (
                  <CommandGroup heading="Last 7 days">
                    {recent.map((b) => (
                      <CommandItem
                        key={b.name}
                        value={b.name}
                        className="cursor-pointer"
                        onSelect={() => pick(b.name)}
                      >
                        <GitBranch01 className="mr-2 h-4 w-4 shrink-0" />
                        <span className="flex-1 truncate">{b.name}</span>
                        <ContributorAvatars
                          userIds={b.contributors ?? []}
                          memberById={memberById}
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {yours.length > 0 && (
                  <>
                    {recent.length > 0 && <CommandSeparator />}
                    <CommandGroup
                      heading={t("thread.branchPicker.yourBranches")}
                    >
                      {yours.map((b) => (
                        <CommandItem
                          key={b.name}
                          value={b.name}
                          className="cursor-pointer"
                          onSelect={() => pick(b.name)}
                        >
                          <GitBranch01 className="mr-2 h-4 w-4 shrink-0" />
                          <span className="flex-1 truncate">{b.name}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}
                {others.length > 0 && (
                  <>
                    <CommandSeparator />
                    <CommandGroup
                      heading={t("thread.branchPicker.otherBranchesInRepo")}
                    >
                      {others.map((b) => (
                        <CommandItem
                          key={b.name}
                          value={b.name}
                          className="cursor-pointer"
                          onSelect={() => pick(b.name)}
                        >
                          <GitBranch01 className="mr-2 h-4 w-4" />
                          <span className="flex-1 truncate">{b.name}</span>
                          {b.author && (
                            <span className="text-xs text-muted-foreground">
                              @{b.author}
                            </span>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}
                {hasMore && (
                  <div className="border-t p-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-full text-xs"
                      disabled={isFetchingMore}
                      onClick={fetchMore}
                    >
                      {isFetchingMore || isSearchingRemote
                        ? t("thread.branchPicker.loadingMore")
                        : t("thread.branchPicker.loadMoreBranches")}
                    </Button>
                  </div>
                )}
                {!hasMore && others.length > 0 && (
                  <div className="border-t p-2 text-center text-xs text-muted-foreground">
                    {t("thread.branchPicker.allLoaded")}
                  </div>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

type MemberUser = { name?: string | null; image?: string | null };
type OrgMember = { userId: string; user?: MemberUser };

/**
 * Overlapping avatar stack for the people with an active sandbox on a branch.
 * Shows up to 3 faces, then a "+N" chip. Unknown userIds fall back to initials.
 */
function ContributorAvatars({
  userIds,
  memberById,
}: {
  userIds: string[];
  memberById: Map<string, MemberUser | undefined>;
}) {
  if (userIds.length === 0) return null;
  const shown = userIds.slice(0, 3);
  const extra = userIds.length - shown.length;

  return (
    <span className="ml-2 flex shrink-0 items-center -space-x-1.5">
      {shown.map((uid) => {
        const user = memberById.get(uid);
        return (
          <Avatar
            key={uid}
            url={user?.image ?? undefined}
            fallback={getInitials(user?.name ?? undefined)}
            shape="circle"
            size="xs"
            className="ring-2 ring-background"
          />
        );
      })}
      {extra > 0 && (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground ring-2 ring-background">
          +{extra}
        </span>
      )}
    </span>
  );
}
