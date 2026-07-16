import { invalidateOrganizationListCache } from "@/web/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { track } from "@/web/lib/posthog-client";
import { useStudioTools } from "@/web/lib/studio-tools";
import { useProjectContext } from "@decocms/studio-sdk";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { useMutation } from "@tanstack/react-query";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import { useState } from "react";
import { toast } from "sonner";

export function DeleteOrganizationSection() {
  const { org } = useProjectContext();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");

  const studio = useStudioTools();

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await studio.call("ORGANIZATION_DELETE", { id: org.id });
    },
    onSuccess: () => {
      track("organization_deleted", { organization_id: org.id });

      // Drop the cached slug so homeRoute doesn't try to redirect us back here
      if (localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug()) === org.slug) {
        localStorage.removeItem(LOCALSTORAGE_KEYS.lastOrgSlug());
      }

      // Drop the TTL-cached org list so the homeRoute loader doesn't redirect
      // back to the just-deleted org.
      invalidateOrganizationListCache();

      toast.success("Organization deleted");
      // Hard redirect — clears Better Auth nanostores atoms (useListOrganizations)
      // which can't be invalidated via TanStack Query. Full reload is fine for
      // a destructive org-delete action.
      window.location.href = "/";
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to delete organization",
      );
    },
  });

  return (
    <>
      <SettingsSection
        title="Danger Zone"
        description="Irreversible actions that affect your entire organization."
      >
        <SettingsCard className="border-destructive/40">
          <SettingsCardItem
            title="Delete organization"
            description="Permanently delete this organization and all of its data. This action cannot be undone."
            action={
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmOpen(true)}
                disabled={deleteMutation.isPending}
              >
                Delete
              </Button>
            }
          />
        </SettingsCard>
      </SettingsSection>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) setConfirmName("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Organization?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  This will permanently delete all data associated with{" "}
                  <span className="font-medium text-foreground">
                    {org.name}
                  </span>
                  . This action cannot be undone.
                </p>
                <p className="mt-3 mb-1.5">
                  Type{" "}
                  <span className="font-medium text-foreground">
                    {org.name}
                  </span>{" "}
                  to confirm:
                </p>
                <Input
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                  placeholder={org.name}
                  autoFocus
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              disabled={confirmName !== org.name || deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete organization"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
