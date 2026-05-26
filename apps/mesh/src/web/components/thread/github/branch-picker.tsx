import { type UIEvent, useRef, useState } from "react";
import type { SandboxMap } from "@decocms/mesh-sdk";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { ChevronDown, GitBranch01 } from "@untitledui/icons";
import type { PillPriority } from "@/web/components/chat/pill-priority";
import { generateBranchName } from "@/shared/branch-name";
import { useBranches } from "./use-branches";

interface Props {
  orgId: string;
  orgSlug: string;
  userId: string;
  virtualMcpId: string;
  connectionId: string | null;
  owner: string;
  repo: string;
  sandboxMap: SandboxMap | undefined;
  value: string | null | undefined;
  onChange: (branch: string) => void;
  /** Container-query priority for the closed-pill label / chevron. */
  priority?: PillPriority;
  /** When true, the trigger is disabled — the user can't open the
   *  picker. The tooltip still surfaces the current branch on hover. */
  disabled?: boolean;
}

/**
 * Grouped branch picker: "Your branches" (from sandboxMap) + "Other branches in
 * repo" (from github-mcp-server.list_branches).
 */
export function BranchPicker({
  orgId,
  orgSlug,
  userId,
  // virtualMcpId is consumed by callers via Props (e.g. BranchPill);
  // BranchPicker itself doesn't use it directly. Kept on the Props
  // contract so the pill container can pass it down uniformly.
  virtualMcpId: _virtualMcpId,
  connectionId,
  owner,
  repo,
  sandboxMap,
  value,
  onChange,
  priority = "primary",
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [isSearchingRemote, setIsSearchingRemote] = useState(false);
  const searchRequestId = useRef(0);

  const {
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
    userId,
    connectionId,
    sandboxMap,
    owner,
    repo,
    enabled: open,
  });

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  const label = value ?? "Select branch…";
  const handleSearchChange = (nextSearch: string) => {
    setSearch(nextSearch);
    searchRequestId.current += 1;

    const requestId = searchRequestId.current;
    const trimmedSearch = nextSearch.trim();
    if (!trimmedSearch) {
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

    if (distanceFromBottom < 48) {
      fetchMore();
    }
  };

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="default"
                aria-label={label}
                disabled={disabled}
                className={cn(
                  "font-mono text-xs text-muted-foreground hover:text-foreground transition-[gap] duration-200",
                  priority === "secondary"
                    ? "gap-0 @[628px]/chat-bottom:gap-1.5"
                    : "gap-0 @[320px]/chat-bottom:gap-1.5",
                )}
              >
                <GitBranch01 className="h-3.5 w-3.5" />
                <span
                  className={cn(
                    "inline-block overflow-hidden whitespace-nowrap truncate transition-[max-width,opacity] duration-200 ease-out max-w-0 opacity-0",
                    priority === "secondary"
                      ? "@[628px]/chat-bottom:max-w-[200px] @[628px]/chat-bottom:opacity-100"
                      : "@[320px]/chat-bottom:max-w-[200px] @[320px]/chat-bottom:opacity-100",
                  )}
                >
                  {label}
                </span>
                <ChevronDown
                  size={12}
                  className={cn(
                    "opacity-60 hidden",
                    priority === "secondary"
                      ? "@[628px]/chat-bottom:inline-block"
                      : "@[320px]/chat-bottom:inline-block",
                  )}
                />
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
              placeholder="Search loaded branches…"
              value={search}
              onValueChange={handleSearchChange}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0"
              onClick={() => pick(generateBranchName())}
            >
              New
            </Button>
          </div>
          <CommandList onScroll={onListScroll}>
            {isError && (
              <div className="p-3 text-xs text-muted-foreground">
                Couldn't load branches from GitHub. You can still pick from your
                branches.
              </div>
            )}
            {!isError && !isLoading && (
              <CommandEmpty>
                {hasMore
                  ? "Looking through more branches..."
                  : "No branches found."}
              </CommandEmpty>
            )}
            {yours.length > 0 && (
              <CommandGroup heading="Your branches">
                {yours.map((b) => (
                  <CommandItem
                    key={b.name}
                    value={b.name}
                    onSelect={() => pick(b.name)}
                  >
                    <GitBranch01 className="mr-2 h-4 w-4" />
                    <span className="flex-1 truncate">{b.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {others.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Other branches in repo">
                  {others.map((b) => (
                    <CommandItem
                      key={b.name}
                      value={b.name}
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
                    ? "Loading more…"
                    : "Load more branches"}
                </Button>
              </div>
            )}
            {!hasMore && others.length > 0 && (
              <div className="border-t p-2 text-center text-xs text-muted-foreground">
                All loaded
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
