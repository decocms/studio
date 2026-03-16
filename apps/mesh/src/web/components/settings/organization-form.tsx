import { authClient } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogoUpload } from "@/web/components/logo-upload";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useSettingsFooterEl } from "@/web/components/settings/settings-footer-context";

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

function OrganizationFormFooter({
  hasChanges,
  isSaving,
  onCancel,
  footerEl,
}: {
  hasChanges: boolean;
  isSaving: boolean;
  onCancel: () => void;
  footerEl: HTMLDivElement;
}) {
  if (!hasChanges) return null;
  return createPortal(
    <div className="border-t border-border bg-background px-8 py-4 flex items-center justify-end gap-3">
      <Button
        type="button"
        variant="outline"
        onClick={onCancel}
        disabled={isSaving}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        form="organization-settings-form"
        disabled={isSaving}
        className="min-w-24"
      >
        {isSaving ? "Saving..." : "Save Changes"}
      </Button>
    </div>,
    footerEl,
  );
}

export function OrganizationForm() {
  const navigate = useNavigate();
  const { org, project } = useProjectContext();
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const footerEl = useSettingsFooterEl();

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

      // Include logo if it has a value (Better Auth expects string or undefined, not null)
      if (data.logo) {
        updateData.logo = data.logo;
      }

      const result = await authClient.organization.update({
        organizationId: org.id,
        data: updateData,
      });

      if (result?.error) {
        throw new Error(
          result.error.message || "Failed to update organization",
        );
      }

      return result;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: KEYS.organizations() });
      queryClient.invalidateQueries({
        queryKey: KEYS.activeOrganization(org.slug),
      });
      toast.success("Organization settings updated successfully");

      // If slug changed, navigate to new slug
      if (data?.data?.slug && data.data.slug !== org.slug) {
        navigate({
          to: "/$org/$project/settings",
          params: { org: data.data.slug, project: project.slug },
        });
      }
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update organization",
      );
    },
    onSettled: () => {
      setIsSaving(false);
    },
  });

  const onSubmit = (data: OrganizationSettingsFormValues) => {
    setIsSaving(true);
    updateOrgMutation.mutate(data);
  };

  const hasChanges = form.formState.isDirty;

  return (
    <>
      <Form {...form}>
        <form
          id="organization-settings-form"
          onSubmit={form.handleSubmit(onSubmit)}
          className="space-y-6"
        >
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Organization Name</FormLabel>
                <FormControl>
                  <Input
                    placeholder="My Organization"
                    {...field}
                    disabled={isSaving}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="slug"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Organization Slug</FormLabel>
                <FormControl>
                  <Input
                    placeholder="my-organization"
                    {...field}
                    disabled={isSaving}
                    onChange={(e) => {
                      // Convert to lowercase and remove invalid chars
                      const sanitized = e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, "");
                      field.onChange(sanitized);
                    }}
                  />
                </FormControl>
                <FormDescription>
                  Used in URLs. Only lowercase letters, numbers, and hyphens are
                  allowed.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="logo"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Logo</FormLabel>
                <FormControl>
                  <LogoUpload
                    value={field.value}
                    onChange={field.onChange}
                    name={form.watch("name")}
                    disabled={isSaving}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </form>
      </Form>
      {footerEl && (
        <OrganizationFormFooter
          hasChanges={hasChanges}
          isSaving={isSaving}
          onCancel={() => form.reset()}
          footerEl={footerEl}
        />
      )}
    </>
  );
}
