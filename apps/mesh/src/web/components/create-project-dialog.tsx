import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ORG_ADMIN_PROJECT_SLUG,
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
import { Badge } from "@deco/ui/components/badge.tsx";
import { KEYS } from "@/web/lib/query-keys";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { generateSlug, isValidSlug } from "@/web/lib/slug";
import { ColorPicker } from "./color-picker";
import type { Project } from "@/web/hooks/use-project";
import type { PublicConfig } from "@/api/routes/public-config";

// ---- Types ----

export type Step = "select" | "folder" | "blank";

interface PickFolderResult {
  path?: string;
  cancelled?: boolean;
  error?: string;
}

interface ValidateResult {
  valid: boolean;
  name?: string;
  slug?: string;
  folderPath?: string;
  existingProjectSlug?: string;
  error?: string;
}

interface CreateFromFolderResult {
  project: { id: string; slug: string; name: string };
  connectionId: string;
  virtualMcpId?: string;
  existing?: boolean;
}

// ---- Blank Project Form Schema ----

const formSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  slug: z.string().min(1, "Slug is required").max(100),
  description: z.string().max(1000).optional(),
  bannerColor: z.string().nullable().optional(),
});

type FormData = z.infer<typeof formSchema>;
type ProjectCreateOutput = { project: Project };

// ---- Dialog Props ----

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Override the initial step (e.g. "folder" to skip mode selection) */
  initialStep?: Step;
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  initialStep,
}: CreateProjectDialogProps) {
  const { org } = useProjectContext();

  // Check if local mode
  const { data: publicConfig } = useQuery<PublicConfig>({
    queryKey: KEYS.publicConfig(),
  });
  const isLocal = publicConfig?.localMode === true;

  const getDefaultStep = () => initialStep ?? (isLocal ? "select" : "blank");
  const [step, setStep] = useState<Step>(getDefaultStep());

  // Reset step when dialog opens/closes
  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      setStep(getDefaultStep());
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        {step === "select" && (
          <ModeSelectionInDialog
            onSelectFolder={() => setStep("folder")}
            onSelectBlank={() => setStep("blank")}
          />
        )}
        {step === "folder" && (
          <FolderStep
            org={org}
            onBack={() => setStep("select")}
            onClose={() => handleOpenChange(false)}
          />
        )}
        {step === "blank" && (
          <BlankStep
            org={org}
            onBack={isLocal ? () => setStep("select") : undefined}
            onClose={() => handleOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- Mode Selection Step ----

function ModeSelectionInDialog({
  onSelectFolder,
  onSelectBlank,
}: {
  onSelectFolder: () => void;
  onSelectBlank: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>New Project</DialogTitle>
        <DialogDescription>
          Choose how to create your project.
        </DialogDescription>
      </DialogHeader>
      <ModeSelectionCards
        onSelectFolder={onSelectFolder}
        onSelectBlank={onSelectBlank}
      />
    </>
  );
}

export function ModeSelectionCards({
  onSelectFolder,
  onSelectBlank,
}: {
  onSelectFolder: () => void;
  onSelectBlank: () => void;
}) {
  return (
    <div className="grid gap-3">
      <button
        type="button"
        onClick={onSelectFolder}
        className="flex items-center gap-4 p-4 rounded-lg border border-border hover:border-foreground/20 hover:bg-accent/50 transition-colors text-left"
      >
        <div className="flex items-center justify-center size-10 rounded-lg bg-emerald-500/10 text-emerald-600 shrink-0">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
          </svg>
        </div>
        <div>
          <div className="text-sm font-medium">From Folder</div>
          <div className="text-xs text-muted-foreground">
            Connect a local directory
          </div>
        </div>
      </button>

      <button
        type="button"
        disabled
        className="flex items-center gap-4 p-4 rounded-lg border border-border opacity-50 cursor-not-allowed text-left"
      >
        <div className="flex items-center justify-center size-10 rounded-lg bg-muted text-muted-foreground shrink-0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
          </svg>
        </div>
        <div className="flex items-center gap-2">
          <div>
            <div className="text-sm font-medium">From GitHub</div>
            <div className="text-xs text-muted-foreground">
              Import from repository
            </div>
          </div>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            Soon
          </Badge>
        </div>
      </button>

      <button
        type="button"
        onClick={onSelectBlank}
        className="flex items-center gap-4 p-4 rounded-lg border border-border hover:border-foreground/20 hover:bg-accent/50 transition-colors text-left"
      >
        <div className="flex items-center justify-center size-10 rounded-lg bg-muted text-muted-foreground shrink-0">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </div>
        <div>
          <div className="text-sm font-medium">Blank Project</div>
          <div className="text-xs text-muted-foreground">
            Start from scratch
          </div>
        </div>
      </button>
    </div>
  );
}

// ---- Folder Step ----

function FolderStep({
  org,
  onBack,
  onClose,
}: {
  org: { id: string; slug: string; name: string };
  onBack: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [folderSlug, setFolderSlug] = useState("");
  const [bannerColor, setBannerColor] = useState("#10B981");
  const [picking, setPicking] = useState(false);

  // Validate selected folder
  const { data: validation } = useQuery<ValidateResult>({
    queryKey: ["local-dev", "validate", selectedPath],
    queryFn: async () => {
      const res = await fetch("/api/local-dev/validate-folder", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath: selectedPath }),
      });
      return res.json();
    },
    enabled: !!selectedPath,
  });

  // Auto-fill name/slug when validation succeeds
  const validationName = validation?.name;
  const validationSlug = validation?.slug;
  if (validationName && !folderName) {
    setFolderName(validationName);
  }
  if (validationSlug && !folderSlug) {
    setFolderSlug(validationSlug);
  }

  // Open native folder picker
  const pickFolder = async () => {
    setPicking(true);
    try {
      const res = await fetch("/api/local-dev/pick-folder", {
        method: "POST",
        credentials: "include",
      });
      const data: PickFolderResult = await res.json();
      if (data.path) {
        setSelectedPath(data.path);
        setFolderName("");
        setFolderSlug("");
      }
    } catch {
      toast.error("Failed to open folder picker");
    } finally {
      setPicking(false);
    }
  };

  // Create project mutation
  const createMutation = useMutation({
    mutationFn: async (): Promise<CreateFromFolderResult> => {
      const res = await fetch("/api/local-dev/create-project", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folderPath: selectedPath,
          name: folderName,
          slug: folderSlug,
          bannerColor,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: async (result) => {
      const locator =
        `${org.slug}/${result.project.slug}` as `${string}/${string}`;
      if (result.virtualMcpId) {
        localStorage.setItem(
          `${locator}:selected-virtual-mcp-id`,
          JSON.stringify(result.virtualMcpId),
        );
      }
      localStorage.setItem(
        LOCALSTORAGE_KEYS.chatSelectedMode(locator),
        JSON.stringify("passthrough"),
      );

      toast.success(`Project "${result.project.name}" created`);
      await queryClient.invalidateQueries();
      onClose();
      navigate({
        to: "/$org/$project",
        params: { org: org.slug, project: result.project.slug },
      });
    },
    onError: (error) => {
      toast.error(
        `Failed to create project: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    },
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center justify-center size-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          From Folder
        </DialogTitle>
        <DialogDescription>
          Select a local directory to create your project.
        </DialogDescription>
      </DialogHeader>

      {/* Folder picker card */}
      <button
        type="button"
        onClick={pickFolder}
        disabled={picking}
        className="flex flex-col items-center justify-center gap-3 w-full rounded-lg border-2 border-dashed border-border py-8 px-4 text-muted-foreground hover:border-foreground/20 hover:bg-accent/30 hover:text-foreground transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="text-amber-500"
        >
          <path d="M2 6a2 2 0 0 1 2-2h4.586a1 1 0 0 1 .707.293L11 6h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6Z" />
        </svg>
        <span className="text-sm font-medium">
          {picking ? "Opening picker…" : "Click to select a folder"}
        </span>
      </button>

      {/* Selected folder display */}
      {selectedPath && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="shrink-0 text-amber-500"
            >
              <path d="M2 6a2 2 0 0 1 2-2h4.586a1 1 0 0 1 .707.293L11 6h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6Z" />
            </svg>
            <span className="text-sm font-mono truncate flex-1">
              {selectedPath}
            </span>
            <button
              type="button"
              onClick={pickFolder}
              className="text-xs text-muted-foreground hover:text-foreground underline shrink-0"
            >
              Change
            </button>
          </div>

          {validation?.existingProjectSlug && (
            <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 rounded-md">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="shrink-0"
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span className="flex-1">
                Project already exists.{" "}
                <button
                  type="button"
                  className="underline font-medium"
                  onClick={() => {
                    onClose();
                    navigate({
                      to: "/$org/$project",
                      params: {
                        org: org.slug,
                        project: validation.existingProjectSlug!,
                      },
                    });
                  }}
                >
                  Open it
                </button>
              </span>
            </div>
          )}

          {validation?.valid && !validation.existingProjectSlug && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Name</Label>
                  <Input
                    value={folderName}
                    onChange={(e) => setFolderName(e.target.value)}
                    disabled={createMutation.isPending}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Slug</Label>
                  <Input
                    value={folderSlug}
                    onChange={(e) =>
                      setFolderSlug(
                        e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                      )
                    }
                    disabled={createMutation.isPending}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Color</Label>
                <ColorPicker
                  value={bannerColor}
                  onChange={(c) => setBannerColor(c ?? "#10B981")}
                />
              </div>
            </>
          )}
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        {validation?.existingProjectSlug ? (
          <Button
            onClick={() => {
              onClose();
              navigate({
                to: "/$org/$project",
                params: {
                  org: org.slug,
                  project: validation.existingProjectSlug!,
                },
              });
            }}
          >
            Open Project
          </Button>
        ) : (
          <Button
            onClick={() => createMutation.mutate()}
            disabled={
              !selectedPath ||
              !validation?.valid ||
              !folderName ||
              !folderSlug ||
              createMutation.isPending
            }
          >
            {createMutation.isPending ? "Creating…" : "Create Project"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

// ---- Blank Step (existing form) ----

function BlankStep({
  org,
  onBack,
  onClose,
}: {
  org: { id: string; slug: string; name: string };
  onBack?: () => void;
  onClose: () => void;
}) {
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
        name: "PROJECT_CREATE",
        arguments: {
          organizationId: org.id,
          slug: data.slug,
          name: data.name,
          description: data.description || null,
          enabledPlugins: [],
          ui: {
            banner: null,
            bannerColor: data.bannerColor ?? null,
            icon: null,
            themeColor: data.bannerColor ?? null,
          },
        },
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ??
        result) as ProjectCreateOutput;
      return payload;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: KEYS.projects(org.id) });
      toast.success("Project created successfully");
      onClose();
      form.reset();
      setSlugManuallyEdited(false);
      navigate({
        to: "/$org/$project",
        params: { org: org.slug, project: result.project.slug },
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
    if (!isValidSlug(data.slug)) {
      form.setError("slug", {
        message: "Slug must be lowercase alphanumeric with hyphens only",
      });
      return;
    }
    if (data.slug === ORG_ADMIN_PROJECT_SLUG) {
      form.setError("slug", {
        message: `"${ORG_ADMIN_PROJECT_SLUG}" is a reserved slug`,
      });
      return;
    }
    await mutation.mutateAsync(data);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    form.setValue("name", name);
    if (!slugManuallyEdited) {
      form.setValue("slug", generateSlug(name));
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
  const isSlugReserved = slug === ORG_ADMIN_PROJECT_SLUG;
  const isSlugInvalid = slug.length > 0 && !isValidSlug(slug);

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground mr-2"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          Create New Project
        </DialogTitle>
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

          <div className="space-y-2 pt-4">
            <Label>Banner Color</Label>
            <ColorPicker
              value={bannerColor ?? null}
              onChange={(color) => form.setValue("bannerColor", color)}
            />
          </div>

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
                    &quot;{ORG_ADMIN_PROJECT_SLUG}&quot; is a reserved slug
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
            {onBack && (
              <Button
                type="button"
                variant="outline"
                onClick={onBack}
                disabled={mutation.isPending}
              >
                Back
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
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
    </>
  );
}
