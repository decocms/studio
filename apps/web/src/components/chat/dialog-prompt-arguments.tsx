import {
  displayToolName,
  getGatewayClientId,
} from "@decocms/mcp-utils/aggregate";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@decocms/ui/components/form.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { zodResolver } from "@hookform/resolvers/zod";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useId } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useT } from "@/i18n/use-t.ts";

export type PromptArgumentValues = Record<string, string>;

interface PromptArgsDialogProps {
  prompt: Prompt | null;
  setPrompt: (prompt: Prompt | null) => void;
  onSubmit: (values: PromptArgumentValues) => Promise<void>;
  /** Pre-fill the form (e.g., when editing an existing prompt chip). */
  defaultValues?: PromptArgumentValues;
}

function buildArgumentSchema(prompt: Prompt | null, requiredMessage: string) {
  const shape: Record<string, z.ZodString> = {};

  for (const arg of prompt?.arguments ?? []) {
    shape[arg.name] = arg.required
      ? z.string().min(1, requiredMessage)
      : z.string();
  }

  return z.object(shape);
}

function buildDefaultValues(
  prompt: Prompt,
  overrides?: PromptArgumentValues,
): PromptArgumentValues {
  const defaults: PromptArgumentValues = {};
  for (const arg of prompt.arguments ?? []) {
    defaults[arg.name] = overrides?.[arg.name] ?? "";
  }
  return defaults;
}

export function PromptArgsDialog({
  prompt,
  setPrompt,
  onSubmit,
  defaultValues,
}: PromptArgsDialogProps) {
  const id = useId();
  const t = useT();
  const schema = buildArgumentSchema(
    prompt,
    t("chat.dialogPromptArguments.required"),
  );
  const form = useForm<PromptArgumentValues>({
    resolver: zodResolver(schema),
    defaultValues: prompt ? buildDefaultValues(prompt, defaultValues) : {},
    mode: "onChange",
  });

  const argumentsList = prompt?.arguments ?? [];

  const handleSubmit = async (values: PromptArgumentValues) => {
    await onSubmit(values);
    setPrompt(null);
    form.reset();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      form.reset();
      setPrompt(null);
    }
  };

  if (!prompt) return null;

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            <span className="capitalize">
              {prompt.title ||
                displayToolName(prompt.name, getGatewayClientId(prompt._meta))}
            </span>
          </DialogTitle>
          {prompt.description && (
            <p className="text-sm text-muted-foreground">
              {prompt.description}
            </p>
          )}
        </DialogHeader>

        <Form {...form}>
          <form
            id={id}
            className="space-y-4 py-4"
            autoComplete="off"
            onSubmit={(e) => {
              e.stopPropagation();
              form.handleSubmit(handleSubmit)(e);
            }}
          >
            {argumentsList.map((arg) => (
              <FormField
                key={arg.name}
                control={form.control}
                name={arg.name}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">
                      {arg.name}
                      {arg.required ? null : (
                        <span className="text-muted-foreground font-normal">
                          {" "}
                          {t("chat.dialogPromptArguments.optional")}
                        </span>
                      )}
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        required={arg.required}
                        placeholder={arg.description ?? ""}
                        className="h-9"
                        disabled={form.formState.isSubmitting}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleOpenChange(false)}
                disabled={form.formState.isSubmitting}
              >
                {t("chat.dialogPromptArguments.cancel")}
              </Button>
              <Button
                type="submit"
                form={id}
                disabled={form.formState.isSubmitting}
              >
                {form.formState.isSubmitting ? (
                  <span className="flex items-center gap-2">
                    <Spinner size="xs" />
                    {t("chat.dialogPromptArguments.loading")}
                  </span>
                ) : (
                  t("chat.dialogPromptArguments.usePrompt")
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
