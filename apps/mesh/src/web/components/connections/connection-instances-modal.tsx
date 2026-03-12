import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  ORG_ADMIN_PROJECT_SLUG,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { IntegrationIcon } from "../integration-icon.tsx";
import { ConnectionStatus } from "./connection-status.tsx";

interface ConnectionInstancesModalProps {
  open: boolean;
  onClose: () => void;
  appName: string;
  instances: ConnectionEntity[];
}

export function ConnectionInstancesModal({
  open,
  onClose,
  appName,
  instances,
}: ConnectionInstancesModalProps) {
  const { locator } = useProjectContext();
  const navigate = useNavigate();
  const { org } = { org: locator.split("/")[0] };

  function openConnection(connectionId: string) {
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

  function addAnotherConnection() {
    navigate({
      to: "/$org/$project/mcps",
      params: { org, project: ORG_ADMIN_PROJECT_SLUG },
      search: { install: appName } as Record<string, string>,
    });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{appName}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-2">
          {instances.map((instance) => (
            <div
              key={instance.id}
              className="flex items-center gap-3 rounded-lg border border-border p-3"
            >
              <IntegrationIcon
                icon={instance.icon}
                name={instance.title}
                size="sm"
                className="shrink-0"
              />
              <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                <span className="text-sm font-medium truncate">
                  {instance.title}
                </span>
                <ConnectionStatus status={instance.status} />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => openConnection(instance.id)}
              >
                Open
              </Button>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="w-full"
            onClick={addAnotherConnection}
          >
            Add another connection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
