import { EmptyState } from "@/web/components/empty-state";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  useCollectionActions,
  useCollectionItem,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
} from "@deco/ui/components/form.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { PromptSchema } from "@decocms/bindings/prompt";
import { Suspense } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { ViewActions, ViewLayout, ViewTabs } from "../layout";
import { SaveActions } from "@/web/components/save-actions";

type Prompt = z.infer<typeof PromptSchema>;

const PromptEditorSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable(),
  body: z.string(),
});
type PromptEditor = z.infer<typeof PromptEditorSchema>;
type PromptForm = UseFormReturn<PromptEditor>;

function getFirstUserText(prompt: Prompt): string {
  for (const message of prompt.messages ?? []) {
    if (message.role !== "user") continue;
    if (message.content?.type !== "text") continue;
    return message.content.text ?? "";
  }
  return "";
}

function getConnectionIdFromPathname(): string | undefined {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const mcpsIndex = parts.findIndex((p) => p === "mcps");
  const connectionId = mcpsIndex >= 0 ? parts[mcpsIndex + 1] : undefined;
  return connectionId ? decodeURIComponent(connectionId) : undefined;
}

function PromptEditForm({ form }: { form: PromptForm }) {
  return (
    <Form {...form}>
      <div className="h-full py-6 flex flex-col max-w-3xl mx-auto w-full min-w-0 gap-8 overflow-y-auto px-4">
        <div className="flex flex-col gap-4">
          <div className="text-sm font-medium text-foreground">Details</div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <div className="text-xs text-muted-foreground">Title</div>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="Untitled prompt"
                      className="h-9 rounded-lg border border-border bg-muted/20 shadow-none focus-visible:ring-0"
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <div className="text-xs text-muted-foreground">
                    Description
                  </div>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ""}
                      placeholder="Add a description…"
                      className="h-9 rounded-lg border border-border bg-muted/20 shadow-none focus-visible:ring-0"
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium text-foreground">Message</div>
          <div className="text-xs text-muted-foreground">
            This becomes the user message in the prompt.
          </div>
          <FormField
            control={form.control}
            name="body"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Textarea
                    {...field}
                    value={field.value ?? ""}
                    placeholder="Write the prompt message…"
                    className="min-h-[240px] resize-none text-base leading-relaxed font-normal rounded-xl border border-border bg-muted/20 px-4 py-3 shadow-none focus-visible:ring-0"
                  />
                </FormControl>
              </FormItem>
            )}
          />
        </div>
      </div>
    </Form>
  );
}

function PromptDetailContent({
  providerId,
  promptId,
}: {
  providerId: string;
  promptId: string;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: providerId || null,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const prompt = useCollectionItem<Prompt>(
    providerId,
    "PROMPT",
    promptId,
    client,
  );

  const actions = useCollectionActions<Prompt>(providerId, "PROMPT", client);
  const isSaving = actions.update.isPending;

  const form = useForm<PromptEditor>({
    values: prompt
      ? {
          title: prompt.title,
          description: prompt.description ?? null,
          body: getFirstUserText(prompt),
        }
      : undefined,
  });

  const resetToInitial = () => {
    if (!prompt) return;
    form.reset({
      title: prompt.title,
      description: prompt.description ?? null,
      body: getFirstUserText(prompt),
    });
  };

  const saveAndLock = form.handleSubmit(async (data: PromptEditor) => {
    const updated = await actions.update.mutateAsync({
      id: promptId,
      data: {
        title: data.title,
        description: data.description,
        arguments: [],
        icons: [],
        messages: [
          {
            role: "user",
            content: { type: "text", text: data.body },
          },
        ],
      } satisfies Partial<Prompt>,
    });

    form.reset({
      title: updated.title,
      description: updated.description ?? null,
      body: getFirstUserText(updated),
    });
  });

  if (!prompt) {
    return (
      <div className="flex h-full w-full bg-background">
        <EmptyState
          title="Prompt not found"
          description="This prompt may have been deleted or you may not have access to it."
        />
      </div>
    );
  }

  return (
    <ViewLayout>
      <ViewTabs>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-foreground truncate">
            {prompt.title}
          </span>
          {prompt.description ? (
            <>
              <span className="text-xs text-muted-foreground font-normal">
                •
              </span>
              <span className="text-xs text-muted-foreground font-normal truncate min-w-0 max-w-[20ch]">
                {prompt.description}
              </span>
            </>
          ) : null}
        </div>
      </ViewTabs>

      <ViewActions>
        <SaveActions
          onSave={() => void saveAndLock()}
          onUndo={resetToInitial}
          isDirty={form.formState.isDirty}
          isSaving={isSaving}
        />
      </ViewActions>

      <div className="h-full">
        <PromptEditForm form={form} />
      </div>
    </ViewLayout>
  );
}

export interface PromptDetailsViewProps {
  itemId: string;
  onUpdate: (updates: Record<string, unknown>) => Promise<void>;
}

export function PromptDetailsView({
  itemId,
}: Omit<PromptDetailsViewProps, "onUpdate">) {
  const connectionId = getConnectionIdFromPathname();

  if (!connectionId) {
    return (
      <div className="flex h-full w-full bg-background">
        <EmptyState
          title="Prompt not found"
          description="Missing connection information in the current route."
        />
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <Suspense fallback={null}>
        <PromptDetailContent providerId={connectionId} promptId={itemId} />
      </Suspense>
    </ErrorBoundary>
  );
}
