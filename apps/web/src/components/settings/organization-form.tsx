import { useOrgAuthClient } from "@/hooks/use-org-auth-client";
import { useDebouncedAutosave } from "@/hooks/use-debounced-autosave.ts";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { track } from "@/lib/posthog-client";

// TODO(i18n): validation messages at module scope, move schema into component if needed
const organizationSettingsSchema = z.object({
  name: z.string().min(1, "Name is required").max(255, "Name is too long"),
  logo: z.string().optional(),
});

type OrganizationSettingsFormValues = z.infer<
  typeof organizationSettingsSchema
>;

function CompactLogoUpload({
  value,
  onChange,
  name,
  disabled,
}: {
  value?: string | null;
  onChange: (value: string) => void;
  name?: string;
  disabled?: boolean;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePick = () => inputRef.current?.click();

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error(t("settings.organizationForm.imageTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () =>
      toast.error(t("settings.organizationForm.failedToReadImage"));
    reader.onloadend = () => {
      if (reader.result) onChange(reader.result as string);
      if (inputRef.current) inputRef.current.value = "";
    };
    reader.readAsDataURL(file);
  };

  return (
    <button
      type="button"
      onClick={handlePick}
      disabled={disabled}
      className="rounded-lg overflow-hidden hover:ring-2 hover:ring-border transition-all disabled:opacity-50"
      aria-label={t("settings.organizationForm.uploadLogoLabel")}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleFile}
        className="hidden"
        disabled={disabled}
      />
      <Avatar
        url={value || undefined}
        fallback={name ?? "?"}
        shape="square"
        size="base"
      />
    </button>
  );
}

export function OrganizationForm() {
  const t = useT();
  const { org } = useProjectContext();
  const orgAuth = useOrgAuthClient();
  const queryClient = useQueryClient();

  const form = useForm<OrganizationSettingsFormValues>({
    resolver: zodResolver(organizationSettingsSchema),
    values: {
      name: org.name ?? "",
      logo: org.logo ?? "",
    },
  });

  const updateOrgMutation = useMutation({
    mutationFn: async (data: OrganizationSettingsFormValues) => {
      const updateData: Record<string, unknown> = {
        name: data.name,
      };

      if (data.logo) {
        updateData.logo = data.logo;
      }

      const result = await orgAuth.organization.update({
        data: updateData,
      });

      if (result?.error) {
        throw new Error(
          result.error.message ||
            t("settings.organizationForm.failedToUpdateOrg"),
        );
      }

      return result;
    },
    onSuccess: (_data, variables) => {
      track("organization_settings_updated", {
        organization_id: org.id,
        fields: Object.keys(variables),
      });
      queryClient.invalidateQueries({ queryKey: KEYS.organizations() });
      queryClient.invalidateQueries({
        queryKey: KEYS.activeOrganization(org.slug),
      });
      toast.success(t("settings.organizationForm.updateSuccess"));
    },
    onError: (error, variables) => {
      track("organization_settings_update_failed", {
        organization_id: org.id,
        fields: Object.keys(variables),
        error: error instanceof Error ? error.message : String(error),
      });
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings.organizationForm.failedToUpdateOrg"),
      );
    },
  });

  const { schedule: scheduleSave, flush: flushAndSave } = useDebouncedAutosave({
    save: async () => {
      // Read live dirty state from control._formState (Proxy lag workaround).
      const liveDirtyFields = (
        form.control as unknown as {
          _formState: { dirtyFields: Record<string, unknown> };
        }
      )._formState.dirtyFields;
      if (Object.keys(liveDirtyFields).length === 0) return;
      const valid = await form.trigger();
      if (!valid) return;

      const values = form.getValues();
      const previousDefaults = (
        form.control as unknown as {
          _defaultValues: OrganizationSettingsFormValues;
        }
      )._defaultValues;

      // Rebase pre-mutate so edits during the in-flight save are tracked
      // against the snapshot we're sending, not the pre-save baseline.
      form.reset(values, { keepValues: true });

      try {
        await updateOrgMutation.mutateAsync(values);
      } catch {
        form.reset(previousDefaults, { keepValues: true });
      }
    },
  });

  const errors = form.formState.errors;
  const urlOrigin =
    typeof window !== "undefined" ? `${window.location.host}/` : "";

  return (
    <SettingsSection>
      <SettingsCard>
        <SettingsCardItem
          title={t("settings.organizationForm.logoTitle")}
          description={t("settings.organizationForm.logoDescription")}
          action={
            <CompactLogoUpload
              value={form.watch("logo")}
              onChange={(val) => {
                form.setValue("logo", val ?? "", { shouldDirty: true });
                flushAndSave();
              }}
              name={form.watch("name")}
            />
          }
        />
        <SettingsCardItem
          title={t("settings.organizationForm.nameTitle")}
          action={
            <Controller
              control={form.control}
              name="name"
              render={({ field }) => (
                <Input
                  id="org-name"
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    scheduleSave();
                  }}
                  onBlur={() => {
                    field.onBlur();
                    flushAndSave();
                  }}
                  placeholder={t("settings.organizationForm.namePlaceholder")}
                  className="w-[280px]"
                />
              )}
            />
          }
        />
        <SettingsCardItem
          title={t("settings.organizationForm.urlTitle")}
          description={t("settings.organizationForm.urlDescription")}
          action={
            // Read-only: the slug anchors org URLs (/api/:org/..., /$org/...);
            // renaming it would silently break every saved link and API
            // integration, so it can't be edited from here (see
            // ORGANIZATION_UPDATE, which rejects slug changes for the same
            // reason).
            <div className="flex items-center w-[280px] rounded-md border border-input bg-muted/40 overflow-hidden">
              {urlOrigin && (
                <span className="pl-3 text-sm text-muted-foreground select-none">
                  {urlOrigin}
                </span>
              )}
              <span className="flex-1 min-w-0 px-2 py-1.5 text-sm text-foreground truncate">
                {org.slug}
              </span>
            </div>
          }
        />
        {(errors.name || errors.logo) && (
          <div className="px-5 pb-3 flex flex-col gap-1">
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
            {errors.logo && (
              <p className="text-xs text-destructive">{errors.logo.message}</p>
            )}
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
