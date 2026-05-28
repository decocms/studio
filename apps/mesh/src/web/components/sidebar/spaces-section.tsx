import { Suspense, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@deco/ui/components/collapsible.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { ChevronDown, DotsHorizontal, Plus } from "@untitledui/icons";
import {
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { useSpaces } from "@/web/hooks/use-spaces";
import { AgentAvatar } from "@/web/components/agent-icon";
import { cn } from "@deco/ui/lib/utils.ts";

function SpaceListItem({
  space,
  org,
}: {
  space: VirtualMCPEntity;
  org: string;
}) {
  const navigate = useNavigate();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={space.title}
        className="h-9"
        onClick={() =>
          navigate({
            to: "/$org/spaces/$virtualMcpId",
            params: { org, virtualMcpId: space.id },
          })
        }
      >
        <AgentAvatar icon={space.icon} name={space.title} size="xs" />
        <span className="truncate flex-1 group-data-[collapsible=icon]:hidden">
          {space.title}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function PinSpacePopover() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const allSpaces = useVirtualMCPs();
  const actions = useVirtualMCPActions();

  const unpinnedSpaces = allSpaces
    .filter((s) => !s.pinned)
    .filter(
      (s) => !search || s.title.toLowerCase().includes(search.toLowerCase()),
    );

  const handlePin = async (space: VirtualMCPEntity) => {
    await actions.update.mutateAsync({
      id: space.id,
      data: { pinned: true },
    });
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Pin a space"
          className="opacity-0 group-hover/spaces-section:opacity-100 transition-opacity text-muted-foreground hover:text-foreground flex items-center justify-center size-6 rounded shrink-0"
        >
          <Plus size={18} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" side="right" align="start">
        <Input
          placeholder="Search spaces..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-2 h-8 text-sm"
          autoFocus
        />
        <div className="max-h-48 overflow-y-auto flex flex-col gap-0.5">
          {unpinnedSpaces.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {search ? "No matches" : "No unpinned spaces"}
            </div>
          ) : (
            unpinnedSpaces.map((space) => (
              <button
                key={space.id}
                type="button"
                className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent text-sm w-full text-left"
                onClick={() => handlePin(space)}
              >
                <AgentAvatar icon={space.icon} name={space.title} size="xs" />
                <span className="truncate">{space.title}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SpacesSectionContent() {
  const spaces = useSpaces({ pinnedOnly: true });
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(true);
  return (
    <>
      <div className="group/spaces-section mt-2">
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <SidebarGroup className="py-0 px-0">
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
                  <div className="flex h-8 w-full items-center gap-1 rounded-md pl-2 pr-1">
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="flex flex-1 items-center gap-1 cursor-pointer min-w-0"
                      >
                        <span className="text-xs font-medium text-muted-foreground">
                          Spaces
                        </span>
                        <ChevronDown
                          size={12}
                          className={cn(
                            "text-muted-foreground shrink-0 transition-transform duration-200",
                            !isOpen && "-rotate-90",
                          )}
                        />
                      </button>
                    </CollapsibleTrigger>
                    <button
                      type="button"
                      onClick={() =>
                        navigate({
                          to: "/$org/spaces",
                          params: { org: org.slug },
                        })
                      }
                      title="View all spaces"
                      className="opacity-0 group-hover/spaces-section:opacity-100 transition-opacity text-muted-foreground hover:text-foreground flex items-center justify-center size-6 rounded shrink-0"
                    >
                      <DotsHorizontal size={16} />
                    </button>
                    <Suspense
                      fallback={
                        <div className="size-6 flex items-center justify-center">
                          <Plus
                            size={18}
                            className="text-muted-foreground opacity-50"
                          />
                        </div>
                      }
                    >
                      <PinSpacePopover />
                    </Suspense>
                  </div>
                </SidebarMenuItem>

                <CollapsibleContent>
                  {spaces.length === 0 ? (
                    <SidebarMenuItem>
                      <div className="px-2 py-2 text-xs text-muted-foreground">
                        No pinned spaces yet
                      </div>
                    </SidebarMenuItem>
                  ) : (
                    spaces.map((space) => (
                      <SpaceListItem
                        key={space.id}
                        space={space}
                        org={org.slug}
                      />
                    ))
                  )}
                </CollapsibleContent>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </Collapsible>
      </div>
    </>
  );
}

export function SidebarSpacesSection() {
  return (
    <Suspense
      fallback={
        <SidebarGroup className="py-0 px-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              <SidebarMenuItem>
                <div className="flex items-center gap-2 px-2 py-2">
                  <Skeleton className="h-4 w-4 rounded" />
                  <Skeleton className="h-4 flex-1" />
                </div>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      }
    >
      <SpacesSectionContent />
    </Suspense>
  );
}
