import { authClient } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@deco/ui/components/card.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogoUpload } from "@/web/components/logo-upload";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

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

export function OrganizationForm() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);

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

      if (data?.data?.slug && data.data.slug !== org.slug) {
        navigate({
          to: "/$org/settings/general",
          params: { org: data.data.slug },
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
  const errors = form.formState.errors;

  return (
    <form
      onSubmit={form.handleSubmit(onSubmit)}
      className="flex flex-col gap-6"
    >
      <Card className="p-6">
        <CardHeader className="p-0">
          <CardTitle className="text-sm">Overview</CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-6 p-0">
          {/* Logo */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Logo</Label>
            <LogoUpload
              value={form.watch("logo")}
              onChange={(val) =>
                form.setValue("logo", val ?? "", { shouldDirty: true })
              }
              name={form.watch("name")}
              disabled={isSaving}
            />
            {errors.logo && (
              <p className="text-xs text-destructive">{errors.logo.message}</p>
            )}
          </div>

          {/* Name + Slug side by side */}
          <div className="grid grid-cols-2 gap-5">
            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="org-name"
                className="text-xs text-muted-foreground"
              >
                Organization name
              </Label>
              <Input
                id="org-name"
                {...form.register("name")}
                placeholder="Organization name"
                disabled={isSaving}
              />
              {errors.name && (
                <p className="text-xs text-destructive">
                  {errors.name.message}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="org-slug"
                className="text-xs text-muted-foreground"
              >
                Slug
              </Label>
              <Input
                id="org-slug"
                {...form.register("slug")}
                placeholder="my-organization"
                disabled={isSaving}
                onChange={(e) => {
                  const sanitized = e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, "");
                  form.setValue("slug", sanitized, {
                    shouldDirty: true,
                    shouldTouch: true,
                    shouldValidate: true,
                  });
                }}
              />
              <p className="text-xs text-muted-foreground">
                Only lowercase letters, numbers, and hyphens.
              </p>
              {errors.slug && (
                <p className="text-xs text-destructive">
                  {errors.slug.message}
                </p>
              )}
            </div>
          </div>
        </CardContent>

        {hasChanges && (
          <CardFooter className="p-0 pt-2 gap-2">
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => form.reset()}
              disabled={isSaving}
            >
              Cancel
            </Button>
          </CardFooter>
        )}
      </Card>
    </form>
  );
}
