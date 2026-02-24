import { MeshUserMenu } from "@/web/components/user-menu";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";
import { Inbox01 } from "@untitledui/icons";

export function SidebarInboxFooter() {
  return (
    <SidebarFooter className="px-3.5 pb-3 group-data-[collapsible=icon]:px-2">
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="flex items-center justify-between w-full px-1">
            <MeshUserMenu />
            <div className="group-data-[collapsible=icon]:hidden">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                    aria-label="Open inbox"
                  >
                    <Inbox01 size={16} />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="end"
                  sideOffset={8}
                  className="w-[380px] p-0"
                >
                  <Tabs defaultValue="inbox">
                    <TabsList
                      variant="underline"
                      className="w-full justify-start px-4 gap-4"
                    >
                      <TabsTrigger variant="underline" value="inbox">
                        Inbox
                      </TabsTrigger>
                      <TabsTrigger variant="underline" value="whats-new">
                        What's new
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="inbox">
                      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                        No messages
                      </div>
                    </TabsContent>
                    <TabsContent value="whats-new">
                      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                        No updates yet
                      </div>
                    </TabsContent>
                  </Tabs>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}
