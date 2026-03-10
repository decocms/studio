import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useProjectContext,
  useMCPClient,
  SELF_MCP_ALIAS_ID,
  ORG_ADMIN_PROJECT_SLUG,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { Input } from "@deco/ui/components/input.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Upload01, X } from "@untitledui/icons";
import { useRef } from "react";
import { toast } from "sonner";

const formSchema = z.object({
  name: z.string().min(1, "Name is required").max(200, "Name is too long"),
  description: z.string().max(1000, "Description is too long").nullable(),
  themeColor: z.string().nullable(),
  logo: z.string().nullable().optional(),
});

function LogoUpload({
  value,
  onChange,
  name,
}: {
  value?: string | null;
  onChange: (value: string) => void;
  name?: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) {
        toast.error("Image must be smaller than 2MB");
        return;
      }

      const reader = new FileReader();

      reader.onerror = () => {
        const error = reader.error;
        console.error("FileReader error:", error);
        toast.error(
          error?.message || "Failed to read image file. Please try again.",
        );
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      };

      reader.onloadend = () => {
        if (reader.readyState === FileReader.DONE && reader.result) {
          onChange(reader.result as string);
        }
      };

      reader.readAsDataURL(file);
    }
  };

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange("");
  };

  return (
    <div className="flex items-start gap-4">
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="image/*"
        onChange={handleFileChange}
      />

      {value ? (
        <div className="relative group">
          <div className="h-20 w-20 rounded-lg border border-border bg-muted/20 overflow-hidden">
            <img
              src={value}
              alt={name || "Project logo"}
              className="w-full h-full object-cover"
            />
          </div>
          <button
            type="button"
            onClick={handleRemove}
            className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-destructive text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          className="h-20 w-20 rounded-lg border-2 border-dashed border-border hover:border-foreground/50 hover:bg-accent/50 transition-colors flex flex-col items-center justify-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <Upload01 className="h-5 w-5" />
          <span className="text-xs">Upload</span>
        </button>
      )}

      <div className="flex-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleClick}
          className="mb-2"
        >
          {value ? "Change Logo" : "Upload Logo"}
        </Button>
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            className="ml-2"
          >
            Remove
          </Button>
        )}
        <p className="text-xs text-muted-foreground mt-2">
          Recommended: Square image, at least 200x200px. Max 2MB.
        </p>
      </div>
    </div>
  );
}

type FormData = z.infer<typeof formSchema>;

type ProjectUpdateOutput = {
  project: {
    id: string;
    organizationId: string;
    slug: string;
    name: string;
    description: string | null;
    enabledPlugins: string[] | null;
  } | null;
};

export function ProjectGeneralForm() {
  const { org, project } = useProjectContext();
  const queryClient = useQueryClient();
  const isOrgAdmin = project.slug === ORG_ADMIN_PROJECT_SLUG;

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    values: {
      name: project.name ?? "",
      description: project.description ?? "",
      themeColor: project.ui?.themeColor ?? "#60a5fa",
      logo: project.ui?.icon ?? "",
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: FormData) => {
      const result = (await client.callTool({
        name: "PROJECT_UPDATE",
        arguments: {
          projectId: project.id,
          name: data.name,
          description: data.description || null,
          ui: {
            themeColor: data.themeColor || null,
            banner: project.ui?.banner ?? null,
            bannerColor: project.ui?.bannerColor ?? null,
            icon: data.logo || null,
          },
        },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as ProjectUpdateOutput;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.project(org.id, project.slug),
      });
      queryClient.invalidateQueries({
        queryKey: KEYS.projects(org.id),
      });
      form.reset(form.getValues());
    },
    onError: (error) => {
      toast.error(
        "Failed to update project: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });

  const onSubmit = async (data: FormData) => {
    await mutation.mutateAsync(data);
  };

  const saveOnBlur = (fieldOnBlur: () => void) => {
    fieldOnBlur();
    void form.handleSubmit(onSubmit)();
  };

  return (
    <div className="flex flex-col">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Project Name</FormLabel>
                <FormControl>
                  <Input
                    placeholder="My Project"
                    {...field}
                    onBlur={() => saveOnBlur(field.onBlur)}
                    disabled={isOrgAdmin || mutation.isPending}
                  />
                </FormControl>
                {isOrgAdmin && (
                  <FormDescription>
                    The organization admin project name cannot be changed.
                  </FormDescription>
                )}
                <FormMessage />
              </FormItem>
            )}
          />

          <FormItem>
            <FormLabel>Slug</FormLabel>
            <FormControl>
              <Input value={project.slug} disabled className="bg-muted" />
            </FormControl>
            <FormDescription>
              The project slug cannot be changed after creation.
            </FormDescription>
          </FormItem>

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Optional project description..."
                    rows={3}
                    {...field}
                    value={field.value ?? ""}
                    onBlur={() => saveOnBlur(field.onBlur)}
                    disabled={mutation.isPending}
                  />
                </FormControl>
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
                    onChange={(value) => {
                      field.onChange(value);
                      void form.handleSubmit(onSubmit)();
                    }}
                    name={form.watch("name")}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="themeColor"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Color</FormLabel>
                <FormControl>
                  <div className="flex items-center gap-3">
                    <div
                      className="size-9 rounded-md border border-input overflow-hidden cursor-pointer shrink-0"
                      style={{ backgroundColor: field.value ?? "#60a5fa" }}
                    >
                      <input
                        type="color"
                        value={field.value ?? "#60a5fa"}
                        onChange={(e) => field.onChange(e.target.value)}
                        onBlur={() => saveOnBlur(field.onBlur)}
                        disabled={mutation.isPending}
                        className="opacity-0 w-full h-full cursor-pointer"
                      />
                    </div>
                    <span className="font-mono text-sm text-muted-foreground">
                      {field.value ?? "#60a5fa"}
                    </span>
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </form>
      </Form>
    </div>
  );
}
