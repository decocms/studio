import { invalidateOrganizationListCache } from "@/lib/auth-client";
import { clearLastLocation, readLastLocation } from "@/lib/last-location";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { track } from "@/lib/posthog-client";
import { useStudioTools } from "@/lib/studio-tools";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { useMutation } from "@tanstack/react-query";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useState } from "react";
import { toast } from "sonner";

export function DeleteOrganizationSection() {
  const t = useT();
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

      // homeRoute reads lastLocation *before* lastOrgSlug, so drop it too or the
      // loader redirects straight back to the just-deleted org's slug.
      if (readLastLocation()?.org === org.slug) {
        clearLastLocation();
      }

      // Drop the TTL-cached org list so the homeRoute loader doesn't redirect
      // back to the just-deleted org.
      invalidateOrganizationListCache();

      toast.success(
        t("settings.deleteOrganizationSection.organizationDeleted"),
      );
      // Hard redirect — clears Better Auth nanostores atoms (useListOrganizations)
      // which can't be invalidated via TanStack Query. Full reload is fine for
      // a destructive org-delete action.
      window.location.href = "/";
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings.deleteOrganizationSection.failedToDeleteOrganization"),
      );
    },
  });

  return (
    <>
      <SettingsSection
        title={t("settings.deleteOrganizationSection.dangerZone")}
        description={t(
          "settings.deleteOrganizationSection.irreversibleActionsDescription",
        )}
      >
        <SettingsCard className="border-destructive/40">
          <SettingsCardItem
            title={t(
              "settings.deleteOrganizationSection.deleteOrganizationTitle",
            )}
            description={t(
              "settings.deleteOrganizationSection.deleteOrganizationDescription",
            )}
            action={
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmOpen(true)}
                disabled={deleteMutation.isPending}
              >
                {t("settings.deleteOrganizationSection.deleteButton")}
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
            <AlertDialogTitle>
              {t(
                "settings.deleteOrganizationSection.deleteOrganizationQuestion",
              )}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  {t("settings.deleteOrganizationSection.deleteWarning", {
                    organizationName: org.name,
                  })}
                </p>
                <p className="mt-3 mb-1.5">
                  {t("settings.deleteOrganizationSection.typeToConfirm", {
                    organizationName: org.name,
                  })}
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
            <AlertDialogCancel>
              {t("settings.deleteOrganizationSection.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              disabled={confirmName !== org.name || deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {deleteMutation.isPending
                ? t("settings.deleteOrganizationSection.deleting")
                : t(
                    "settings.deleteOrganizationSection.deleteOrganizationAction",
                  )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
