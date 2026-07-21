import { authClient } from "@/web/lib/auth-client";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
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
import { Spinner } from "@deco/ui/components/spinner.tsx";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useT } from "@/web/i18n/use-t.ts";

// Simple slugify function for client-side use
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]+/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ponytail: validation strings are not user-facing, they're internal error messages; actual errors will be translated in component below
const createOrgSchema = z.object({
  name: z.string().min(2, "Organization name is required"),
});

type CreateOrgFormData = z.infer<typeof createOrgSchema>;

interface CreateOrganizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateOrganizationDialog({
  open,
  onOpenChange,
}: CreateOrganizationDialogProps) {
  const t = useT();
  const form = useForm<CreateOrgFormData>({
    resolver: zodResolver(createOrgSchema),
    defaultValues: { name: "" },
  });

  const createOrgMutation = useMutation({
    mutationFn: async (data: CreateOrgFormData) => {
      const computedSlug = slugify(data.name);
      if (!computedSlug) {
        throw new Error(t("common.createOrganizationDialog.invalidSlug"));
      }

      const result = await authClient.organization.create({
        name: data.name,
        slug: computedSlug,
      });

      if (result?.error) {
        throw new Error(
          result.error.message ||
            t("common.createOrganizationDialog.failedToCreate"),
        );
      }

      const orgSlug = result?.data?.slug ?? computedSlug;
      if (!orgSlug) {
        throw new Error(t("common.createOrganizationDialog.failedToCreate"));
      }

      return { orgSlug };
    },
    onSuccess: ({ orgSlug }) => {
      window.location.href = `/${orgSlug}`;
    },
  });

  const errorMessage =
    createOrgMutation.error instanceof Error
      ? createOrgMutation.error.message
      : createOrgMutation.error
        ? t("common.createOrganizationDialog.failedToCreateGeneric")
        : null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("common.createOrganizationDialog.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("common.createOrganizationDialog.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Form {...form}>
          <form
            className="space-y-6"
            onSubmit={form.handleSubmit((data) =>
              createOrgMutation.mutateAsync(data),
            )}
            autoComplete="off"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t("common.createOrganizationDialog.nameLabel")}
                  </FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder={t(
                        "common.createOrganizationDialog.namePlaceholder",
                      )}
                      disabled={form.formState.isSubmitting}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("common.createOrganizationDialog.nameDescription")}
                  </FormDescription>
                  {/* Slug preview */}
                  {field.value && (
                    <div className="text-xs text-muted-foreground mt-1">
                      {t("common.createOrganizationDialog.urlLabel")}{" "}
                      <span className="font-mono">
                        {typeof window !== "undefined"
                          ? globalThis.location.origin
                          : ""}
                        /{slugify(field.value)}
                      </span>
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            {errorMessage && (
              <div className="text-destructive text-sm mt-2">
                {errorMessage}
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={form.formState.isSubmitting}
                onClick={() => {
                  createOrgMutation.reset();
                  form.reset();
                }}
              >
                {t("common.createOrganizationDialog.cancel")}
              </AlertDialogCancel>
              <Button
                type="submit"
                variant="default"
                disabled={
                  !form.formState.isValid || form.formState.isSubmitting
                }
              >
                {form.formState.isSubmitting ? (
                  <span className="flex items-center gap-2">
                    <Spinner size="xs" />{" "}
                    {t("common.createOrganizationDialog.creating")}
                  </span>
                ) : (
                  t("common.createOrganizationDialog.createButton")
                )}
              </Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
