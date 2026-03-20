import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { KEYS } from "@/web/lib/query-keys";
import { generateSlug, isValidSlug } from "@/web/lib/slug";
import { ColorPicker } from "./color-picker";

const formSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  slug: z.string().min(1, "Slug is required").max(100),
  description: z.string().max(1000).optional(),
  bannerColor: z.string().nullable().optional(),
});

type FormData = z.infer<typeof formSchema>;

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type VirtualMCPCreateOutput = {
  item: {
    id: string;
    title: string;
    metadata?: {
      ui?: { slug?: string } | null;
      migrated_project_slug?: string;
    } | null;
  };
};

export function CreateProjectDialog({
  open,
  onOpenChange,
}: CreateProjectDialogProps) {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const form = useForm<FormData>({
    mode: "onChange",
    defaultValues: {
      name: "",
      slug: "",
      description: "",
      bannerColor: "#3B82F6",
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: FormData) => {
      const result = (await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_CREATE",
        arguments: {
          data: {
            title: data.name,
            description: data.description || null,
            subtype: "project",
            metadata: {
              instructions: null,
              enabled_plugins: [],
              ui: {
                banner: null,
                bannerColor: data.bannerColor ?? null,
                icon: null,
                themeColor: data.bannerColor ?? null,
                slug: data.slug,
              },
            },
            connections: [],
          },
        },
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ??
        result) as VirtualMCPCreateOutput;
      return { slug: data.slug, item: payload.item };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: KEYS.projects(org.id) });
      toast.success("Project created successfully");
      onOpenChange(false);
      form.reset({
        name: "",
        slug: "",
        description: "",
        bannerColor: "#3B82F6",
      });
      setSlugManuallyEdited(false);
      // Navigate to the new project
      navigate({
        to: "/$org/$project",
        params: { org: org.slug, project: result.slug },
      });
    },
    onError: (error) => {
      toast.error(
        "Failed to create project: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });

  const onSubmit = async (data: FormData) => {
    // Validate slug before submitting
    if (!isValidSlug(data.slug)) {
      form.setError("slug", {
        message: "Slug must be lowercase alphanumeric with hyphens only",
      });
      return;
    }
    if (data.slug === "org-admin") {
      form.setError("slug", {
        message: '"org-admin" is a reserved slug',
      });
      return;
    }
    await mutation.mutateAsync(data);
  };

  // Auto-generate slug from name
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    form.setValue("name", name);

    if (!slugManuallyEdited) {
      const slug = generateSlug(name);
      form.setValue("slug", slug);
    }
  };

  const handleSlugChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSlugManuallyEdited(true);
    form.setValue(
      "slug",
      e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
    );
  };

  const bannerColor = form.watch("bannerColor");
  const slug = form.watch("slug");
  const name = form.watch("name");

  const isSlugReserved = slug === "org-admin";
  const isSlugInvalid = slug.length > 0 && !isValidSlug(slug);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
          <DialogDescription>
            Set up a new project in {org.name}. You can configure plugins and
            settings after creation.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Banner Preview */}
            <div
              className="h-20 rounded-lg relative"
              style={{ backgroundColor: bannerColor ?? "#3B82F6" }}
            >
              <div className="absolute -bottom-4 left-4">
                <div
                  className="size-12 rounded-lg border-2 border-background flex items-center justify-center text-lg font-semibold text-white"
                  style={{ backgroundColor: bannerColor ?? "#3B82F6" }}
                >
                  {name?.charAt(0)?.toUpperCase() || "P"}
                </div>
              </div>
            </div>

            {/* Banner Color */}
            <div className="space-y-2 pt-4">
              <Label>Banner Color</Label>
              <ColorPicker
                value={bannerColor ?? null}
                onChange={(color) => form.setValue("bannerColor", color)}
              />
            </div>

            {/* Name */}
            <FormField
              control={form.control}
              name="name"
              render={() => (
                <FormItem>
                  <FormLabel>Project Name *</FormLabel>
                  <FormControl>
                    <Input
                      value={name}
                      onChange={handleNameChange}
                      placeholder="My Awesome Project"
                      autoFocus
                      disabled={mutation.isPending}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Slug */}
            <FormField
              control={form.control}
              name="slug"
              render={() => (
                <FormItem>
                  <FormLabel>Slug *</FormLabel>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      /{org.slug}/
                    </span>
                    <FormControl>
                      <Input
                        value={slug}
                        onChange={handleSlugChange}
                        placeholder="my-awesome-project"
                        className="flex-1"
                        disabled={mutation.isPending}
                      />
                    </FormControl>
                  </div>
                  {isSlugReserved && (
                    <p className="text-xs text-destructive">
                      "org-admin" is a reserved slug
                    </p>
                  )}
                  {isSlugInvalid && !isSlugReserved && (
                    <p className="text-xs text-destructive">
                      Slug must be lowercase alphanumeric with hyphens only
                    </p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Description */}
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="What is this project for?"
                      rows={2}
                      disabled={mutation.isPending}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  mutation.isPending ||
                  isSlugReserved ||
                  isSlugInvalid ||
                  !name ||
                  !slug
                }
              >
                {mutation.isPending ? "Creating..." : "Create Project"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
