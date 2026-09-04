import { EmptyState } from "@/components/empty-state";
import { ErrorBoundary } from "@/components/error-boundary";
import { Main } from "@/components/main";
import {
  useCollectionActions,
  useCollectionItem,
  useMCPClient,
  useProjectContext,
  type ConnectionEntity,
} from "@/sdk";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
} from "@decocms/ui/components/form.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { PromptSchema } from "@decocms/bindings/prompt";
import { Suspense } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { SaveActions } from "@/components/save-actions";
import { useT } from "@/i18n/use-t.ts";

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

function PromptEditForm({ form }: { form: PromptForm }) {
  const t = useT();
  return (
    <Form {...form}>
      <div className="h-full py-6 flex flex-col max-w-3xl mx-auto w-full min-w-0 gap-8 overflow-y-auto px-4">
        <div className="flex flex-col gap-4">
          <div className="text-sm font-medium text-foreground">
            {t("details.prompt.details")}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <div className="text-xs text-muted-foreground">
                    {t("details.prompt.title")}
                  </div>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder={t("details.prompt.titlePlaceholder")}
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
                    {t("details.prompt.description")}
                  </div>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ""}
                      placeholder={t("details.prompt.descriptionPlaceholder")}
                      className="h-9 rounded-lg border border-border bg-muted/20 shadow-none focus-visible:ring-0"
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium text-foreground">
            {t("details.prompt.message")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("details.prompt.messageDescription")}
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
                    placeholder={t("details.prompt.bodyPlaceholder")}
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
  connection,
  promptId,
}: {
  connection: ConnectionEntity;
  promptId: string;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const providerId = connection.id;
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
          title={t("details.prompt.notFoundTitle")}
          description={t("details.prompt.notFoundDescription")}
        />
      </div>
    );
  }

  return (
    <>
      <Main.Title.Portal>
        <span title={prompt.title}>{prompt.title}</span>
      </Main.Title.Portal>
      <Main.Topbar.Right.Portal>
        <div className="flex items-center gap-1">
          <SaveActions
            onSave={() => void saveAndLock()}
            onUndo={resetToInitial}
            isDirty={form.formState.isDirty}
            isSaving={isSaving}
          />
        </div>
      </Main.Topbar.Right.Portal>

      <div className="h-full min-h-0">
        <PromptEditForm form={form} />
      </div>
    </>
  );
}

export interface PromptDetailsViewProps {
  appSlug: string;
  connection: ConnectionEntity | null;
  itemId: string;
  onUpdate: (updates: Record<string, unknown>) => Promise<void>;
}

export function PromptDetailsView({
  connection,
  itemId,
}: Omit<PromptDetailsViewProps, "onUpdate">) {
  const t = useT();

  if (!connection) {
    return (
      <div className="flex h-full w-full bg-background">
        <EmptyState
          title={t("details.prompt.notFoundTitle")}
          description={t("details.prompt.missingConnectionDescription")}
        />
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <Suspense fallback={null}>
        <PromptDetailContent connection={connection} promptId={itemId} />
      </Suspense>
    </ErrorBoundary>
  );
}
