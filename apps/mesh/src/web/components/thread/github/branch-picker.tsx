import { useState } from "react";
import type { VmMap } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
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
import { GitBranch01 } from "@untitledui/icons";
import { generateBranchName } from "@/shared/branch-name";
import { useBranches } from "./use-branches";

interface Props {
  orgId: string;
  orgSlug: string;
  userId: string;
  connectionId: string;
  owner: string;
  repo: string;
  vmMap: VmMap | undefined;
  value: string | null | undefined;
  onChange: (branch: string) => void;
}

/**
 * Grouped branch picker: "Your branches" (from vmMap) + "Other branches in
 * repo" (from github-mcp-server.list_branches).
 */
export function BranchPicker({
  orgId,
  orgSlug,
  userId,
  connectionId,
  owner,
  repo,
  vmMap,
  value,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);

  const { yours, others, isLoading, isError } = useBranches({
    orgId,
    orgSlug,
    userId,
    connectionId,
    vmMap,
    owner,
    repo,
    enabled: open,
  });

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  const label = value ?? "Select branch…";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 font-mono text-xs"
        >
          <GitBranch01 className="h-3.5 w-3.5" />
          <span className="max-w-[200px] truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(420px,calc(100vw-2rem))] p-0"
        align="start"
      >
        <Command>
          <div className="flex items-center border-b pr-2 [&>[data-slot=command-input-wrapper]]:flex-1 [&>[data-slot=command-input-wrapper]]:border-b-0">
            <CommandInput placeholder="Search branches…" />
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0"
              onClick={() => pick(generateBranchName())}
            >
              New
            </Button>
          </div>
          <CommandList>
            {isError && (
              <div className="p-3 text-xs text-muted-foreground">
                Couldn't load branches from GitHub. You can still pick from your
                branches.
              </div>
            )}
            {!isError &&
              !isLoading &&
              yours.length === 0 &&
              others.length === 0 && (
                <CommandEmpty>No branches found.</CommandEmpty>
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
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
