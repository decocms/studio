import { useState } from "react";
import { Fingerprint04, Plus, Trash01 } from "@untitledui/icons";
import { useMutation } from "@tanstack/react-query";
import type { Passkey } from "@better-auth/passkey/client";
import { Button } from "@decocms/ui/components/button.tsx";
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
import { toast } from "@decocms/ui/components/sonner.tsx";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { authClient } from "@/lib/auth-client";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

interface PendingDelete {
  id: string;
  name: string;
}

/** Browser and OS, so a list of passkeys tells devices apart. */
function defaultPasskeyName(): string {
  const ua = globalThis.navigator?.userAgent ?? "";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : null;
  return [browser, os].filter(Boolean).join(" on ") || "Passkey";
}

export function PasskeysSection() {
  const t = useT();
  const passkeys = authClient.useListPasskeys();
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const supported = typeof globalThis.PublicKeyCredential !== "undefined";

  const addMutation = useMutation({
    mutationFn: async () => {
      const result = await authClient.passkey.addPasskey({
        name: defaultPasskeyName(),
      });
      if (result?.error) {
        // Closing the browser prompt is a choice, not an error.
        if (result.error.code === "ERROR_CEREMONY_ABORTED") return false;
        throw new Error(
          result.error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"
            ? t("settings.passkeys.alreadyRegistered")
            : result.error.message || t("settings.passkeys.addError"),
        );
      }
      return true;
    },
    onSuccess: (added) => {
      if (!added) return;
      track("passkey_added");
      toast.success(t("settings.passkeys.added"));
    },
    onError: (error) => {
      track("passkey_add_failed", { error: error.message });
      toast.error(error.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const result = await authClient.passkey.deletePasskey({ id });
      if (result.error) {
        throw new Error(
          result.error.message || t("settings.passkeys.deleteError"),
        );
      }
    },
    onSuccess: () => {
      track("passkey_deleted");
      toast.success(t("settings.passkeys.deleted"));
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const list: Passkey[] = passkeys.data ?? [];

  return (
    <SettingsSection
      title={t("settings.passkeys.title")}
      description={t("settings.passkeys.description")}
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={!supported || addMutation.isPending}
          onClick={() => addMutation.mutate()}
        >
          <Plus size={14} />
          {t("settings.passkeys.add")}
        </Button>
      }
    >
      {!supported ? (
        <p className="px-4 text-sm text-muted-foreground">
          {t("settings.passkeys.unsupported")}
        </p>
      ) : passkeys.isPending ? null : list.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">
          {t("settings.passkeys.empty")}
        </p>
      ) : (
        <SettingsCard>
          {list.map((passkey) => {
            const name = passkey.name || t("settings.passkeys.unnamed");
            return (
              <SettingsCardItem
                key={passkey.id}
                icon={<Fingerprint04 size={16} />}
                title={name}
                description={t("settings.passkeys.createdAt", {
                  date: new Date(passkey.createdAt).toLocaleDateString(),
                })}
                action={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("settings.passkeys.delete")}
                    disabled={deleteMutation.isPending}
                    onClick={() => setPendingDelete({ id: passkey.id, name })}
                  >
                    <Trash01 size={14} />
                  </Button>
                }
              />
            );
          })}
        </SettingsCard>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.passkeys.deleteTitle", {
                name: pendingDelete?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.passkeys.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.passkeys.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) deleteMutation.mutate(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              {t("settings.passkeys.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
