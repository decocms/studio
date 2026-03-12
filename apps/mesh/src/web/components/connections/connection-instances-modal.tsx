import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { formatTimeAgo } from "@/web/lib/format-time";
import {
  ORG_ADMIN_PROJECT_SLUG,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { ChevronRight, Container, Plus, Tool01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";

interface ConnectionInstancesModalProps {
  open: boolean;
  onClose: () => void;
  appName: string;
  appIcon?: string | null;
  appDescription?: string | null;
  instances: ConnectionEntity[];
  onDelete?: (connection: ConnectionEntity) => void;
}

export function ConnectionInstancesModal({
  open,
  onClose,
  appName,
  appIcon,
  appDescription,
  instances,
}: ConnectionInstancesModalProps) {
  const { locator } = useProjectContext();
  const navigate = useNavigate();
  const org = locator.split("/")[0];

  function openInstance(connectionId: string) {
    navigate({
      to: "/$org/$project/mcps/$connectionId",
      params: {
        org,
        project: ORG_ADMIN_PROJECT_SLUG,
        connectionId,
      },
    });
    onClose();
  }

  function addConnection() {
    navigate({
      to: "/$org/$project/mcps",
      params: { org, project: ORG_ADMIN_PROJECT_SLUG },
      search: { install: appName } as Record<string, string>,
    });
    onClose();
  }

  // Collect unique tools from instances (deduplicated by name)
  const seen = new Set<string>();
  const tools: { name: string; description?: string }[] = [];
  for (const inst of instances) {
    for (const t of inst.tools ?? []) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        tools.push({ name: t.name, description: t.description });
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-xl p-0 gap-0 overflow-hidden flex flex-col max-h-[80vh]">
        {/* App header */}
        <DialogHeader className="px-6 pt-6 pb-5 shrink-0">
          <div className="flex items-start gap-4">
            <IntegrationIcon
              icon={appIcon}
              name={appName}
              size="md"
              className="shrink-0 shadow-sm mt-0.5"
              fallbackIcon={<Container />}
            />
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold leading-snug">
                {appName}
              </DialogTitle>
              {appDescription && (
                <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">
                  {appDescription}
                </p>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto divide-y divide-border">
          {/* Connections section */}
          <div>
            <div className="flex items-center justify-between px-6 py-3">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Connection{instances.length !== 1 ? "s" : ""}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={addConnection}
              >
                <Plus size={14} />
                Add connection
              </Button>
            </div>
            <div className="pb-2">
              {instances.map((instance) => (
                <button
                  key={instance.id}
                  type="button"
                  className="w-full flex items-center gap-3 px-6 py-3 hover:bg-muted/40 transition-colors text-left"
                  onClick={() => openInstance(instance.id)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {instance.title}
                    </p>
                    {(instance.updated_at || instance.created_at) && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Last updated{" "}
                        {formatTimeAgo(
                          new Date(
                            (instance.updated_at ?? instance.created_at)!,
                          ),
                        )}
                      </p>
                    )}
                  </div>
                  <ChevronRight
                    size={16}
                    className="text-muted-foreground shrink-0"
                  />
                </button>
              ))}
            </div>
          </div>

          {/* Tools section */}
          {tools.length > 0 && (
            <div>
              <div className="flex items-center gap-2 px-6 py-3">
                <Tool01 size={14} className="text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Actions ({tools.length})
                </span>
              </div>
              <div className="pb-2">
                {tools.map((tool) => (
                  <div
                    key={tool.name}
                    className="flex items-start gap-3 px-6 py-2.5"
                  >
                    <IntegrationIcon
                      icon={appIcon}
                      name={tool.name}
                      size="xs"
                      className="shrink-0 mt-0.5"
                      fallbackIcon={<Tool01 size={12} />}
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {tool.name}
                      </p>
                      {tool.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {tool.description}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
