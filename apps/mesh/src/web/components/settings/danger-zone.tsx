import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useProjectContext,
  useIsOrgAdmin,
  useMCPClient,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@deco/ui/components/alert-dialog.tsx";
import { toast } from "sonner";

export function DangerZone() {
  const { org, project } = useProjectContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmName, setConfirmName] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const isOrgAdmin = useIsOrgAdmin();

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const result = (await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_DELETE",
        arguments: {
          id: project.id,
        },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as { item: unknown };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.projects(org.id),
      });
      toast.success("Project deleted");
      navigate({
        to: "/$org/projects",
        params: { org: org.slug },
      });
    },
    onError: (error) => {
      toast.error(
        "Failed to delete project: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });

  // Don't show danger zone for org-admin
  if (isOrgAdmin) {
    return null;
  }

  const canDelete = confirmName === project.name;

  const handleDelete = () => {
    mutation.mutate();
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setConfirmName("");
    }
  };

  return (
    <div className="flex flex-col">
      <p className="py-4 text-base font-semibold text-foreground border-b border-border">
        Danger Zone
      </p>

      <div className="flex items-center justify-between gap-6 py-4">
        <div className="flex flex-col gap-1 min-w-0">
          <p className="text-sm font-medium text-foreground">Delete Project</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Permanently delete this project and all its data. This action cannot
            be undone.
          </p>
        </div>

        <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              className="shrink-0 bg-destructive/10 text-destructive border-0 hover:bg-destructive/15 hover:text-destructive"
            >
              Delete Project
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete "{project.name}"?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. All project data will be
                permanently deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="py-4">
              <p className="text-sm mb-2">
                Type <strong>{project.name}</strong> to confirm:
              </p>
              <Input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={project.name}
              />
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                disabled={!canDelete || mutation.isPending}
                className="bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive border-0"
              >
                {mutation.isPending ? "Deleting..." : "Delete Project"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
