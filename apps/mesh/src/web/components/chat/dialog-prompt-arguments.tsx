import {
  displayToolName,
  getGatewayClientId,
} from "@decocms/mcp-utils/aggregate";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import { zodResolver } from "@hookform/resolvers/zod";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useId } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { z } from "zod";

export type PromptArgumentValues = Record<string, string>;

interface PromptArgsDialogProps {
  prompt: Prompt | null;
  setPrompt: (prompt: Prompt | null) => void;
  onSubmit: (values: PromptArgumentValues) => Promise<void>;
}

function buildArgumentSchema(prompt: Prompt) {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const arg of prompt.arguments ?? []) {
    shape[arg.name] = arg.required ? z.string().min(1, "Required") : z.string();
  }

  return z.object(shape);
}

function buildDefaultValues(prompt: Prompt): PromptArgumentValues {
  const defaults: PromptArgumentValues = {};
  for (const arg of prompt.arguments ?? []) {
    defaults[arg.name] = "";
  }
  return defaults;
}

export function PromptArgsDialog({
  prompt,
  setPrompt,
  onSubmit,
}: PromptArgsDialogProps) {
  const id = useId();
  const schema = prompt ? buildArgumentSchema(prompt) : z.object({});
  const resolver = zodResolver(schema as any);
  const form = useForm<PromptArgumentValues>({
    resolver: resolver as unknown as Resolver<PromptArgumentValues>,
    defaultValues: prompt ? buildDefaultValues(prompt) : {},
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
                          (optional)
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
                Cancel
              </Button>
              <Button
                type="submit"
                form={id}
                disabled={
                  !form.formState.isValid || form.formState.isSubmitting
                }
              >
                {form.formState.isSubmitting ? (
                  <span className="flex items-center gap-2">
                    <Spinner size="xs" />
                    Loading...
                  </span>
                ) : (
                  "Use prompt"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
