import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { authClient } from "@/web/lib/auth-client";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { toast } from "sonner";

export function OrgDangerZone() {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmName, setConfirmName] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const { data: activeMember } = useQuery({
    queryKey: [org.id, "active-member"],
    queryFn: () => authClient.organization.getActiveMember(),
  });
  const isOwner = activeMember?.data?.role === "owner";

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await authClient.organization.delete({
        organizationId: org.id,
      });
      if (result?.error) {
        throw new Error(
          result.error.message || "Failed to delete organization",
        );
      }
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.organizations() });
      toast.success("Organization deleted");
      navigate({ to: "/" });
    },
    onError: (error) => {
      toast.error(
        "Failed to delete organization: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });

  const canDelete = confirmName === org.name;

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
          <p className="text-sm font-medium text-foreground">
            Delete Organization
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Permanently delete this organization and all its data. This action
            cannot be undone.
          </p>
        </div>

        <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0">
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    disabled={!isOwner}
                    className="bg-destructive/10 text-destructive border-0 hover:bg-destructive/15 hover:text-destructive disabled:pointer-events-none"
                  >
                    Delete Organization
                  </Button>
                </AlertDialogTrigger>
              </span>
            </TooltipTrigger>
            {!isOwner && (
              <TooltipContent>
                Only owners can delete the organization
              </TooltipContent>
            )}
          </Tooltip>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete "{org.name}"?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. All organization data, projects,
                and members will be permanently deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="py-4">
              <p className="text-sm mb-2">
                Type <strong>{org.name}</strong> to confirm:
              </p>
              <Input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={org.name}
              />
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                disabled={!canDelete || mutation.isPending}
                className="bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive border-0"
              >
                {mutation.isPending ? "Deleting..." : "Delete Organization"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
