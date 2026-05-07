import { useOrgAuthClient } from "@/web/hooks/use-org-auth-client";
import { useDebouncedAutosave } from "@/web/hooks/use-debounced-autosave.ts";
import { KEYS } from "@/web/lib/query-keys";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import { useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { track } from "@/web/lib/posthog-client";

const organizationSettingsSchema = z.object({
  name: z.string().min(1, "Name is required").max(255, "Name is too long"),
  slug: z
    .string()
    .min(1, "Slug is required")
    .max(50, "Slug is too long")
    .regex(
      /^[a-z0-9-]+$/,
      "Slug must contain only lowercase letters, numbers, and hyphens",
    ),
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
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePick = () => inputRef.current?.click();

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be smaller than 2MB");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast.error("Failed to read image");
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
      aria-label="Upload organization logo"
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
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const orgAuth = useOrgAuthClient();
  const queryClient = useQueryClient();

  const form = useForm<OrganizationSettingsFormValues>({
    resolver: zodResolver(organizationSettingsSchema),
    values: {
      name: org.name ?? "",
      slug: org.slug ?? "",
      logo: org.logo ?? "",
    },
  });

  const updateOrgMutation = useMutation({
    mutationFn: async (data: OrganizationSettingsFormValues) => {
      const updateData: Record<string, unknown> = {
        name: data.name,
        slug: data.slug,
      };

      if (data.logo) {
        updateData.logo = data.logo;
      }

      const result = await orgAuth.organization.update({
        data: updateData,
      });

      if (result?.error) {
        throw new Error(
          result.error.message || "Failed to update organization",
        );
      }

      return result;
    },
    onSuccess: (data, variables) => {
      track("organization_settings_updated", {
        organization_id: org.id,
        fields: Object.keys(variables),
      });
      queryClient.invalidateQueries({ queryKey: KEYS.organizations() });
      queryClient.invalidateQueries({
        queryKey: KEYS.activeOrganization(org.slug),
      });

      if (data?.data?.slug && data.data.slug !== org.slug) {
        navigate({
          to: "/$org/settings/general",
          params: { org: data.data.slug },
        });
      }
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
          : "Failed to update organization",
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
          title="Logo"
          description="Recommended size is 256x256px"
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
          title="Name"
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
                  placeholder="Organization name"
                  className="w-[280px]"
                />
              )}
            />
          }
        />
        <SettingsCardItem
          title="URL"
          action={
            <div className="flex items-center w-[280px] rounded-md border border-input bg-input/30 focus-within:ring-2 focus-within:ring-ring/50 overflow-hidden">
              {urlOrigin && (
                <span className="pl-3 text-sm text-muted-foreground select-none">
                  {urlOrigin}
                </span>
              )}
              <Controller
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <input
                    id="org-slug"
                    value={field.value ?? ""}
                    name={field.name}
                    ref={field.ref}
                    placeholder="my-organization"
                    className="flex-1 min-w-0 bg-transparent px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60 outline-none"
                    onChange={(e) => {
                      const sanitized = e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, "");
                      form.setValue("slug", sanitized, {
                        shouldDirty: true,
                        shouldTouch: true,
                        shouldValidate: true,
                      });
                      scheduleSave();
                    }}
                    onBlur={() => {
                      field.onBlur();
                      flushAndSave();
                    }}
                  />
                )}
              />
            </div>
          }
        />
        {(errors.name || errors.slug || errors.logo) && (
          <div className="px-5 pb-3 flex flex-col gap-1">
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
            {errors.slug && (
              <p className="text-xs text-destructive">{errors.slug.message}</p>
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
