import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect } from "react";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { PasswordInput } from "@deco/ui/components/password-input.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { DialogFooter } from "@deco/ui/components/dialog.tsx";
import { useT } from "@/i18n/use-t.ts";
import { useSaveCompanionConfig } from "./use-save-companion-config.ts";
import type { CompanionFormProps } from "./types.ts";

const schema = z.object({
  accountName: z.string().min(1, "Informe o nome da conta"),
  appKey: z.string().optional(),
  appToken: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

export function VtexConfigForm({
  card,
  companionClient: _companionClient,
  selfClient,
  org,
  onDone,
  onIsPendingChange,
}: CompanionFormProps) {
  const t = useT();
  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      accountName: (card.configurationState?.accountName as string) || "",
      appKey: (card.configurationState?.appKey as string) || "",
      appToken: (card.configurationState?.appToken as string) || "",
    },
  });

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- sync form when config changes from server
  useEffect(() => {
    form.reset({
      accountName: (card.configurationState?.accountName as string) || "",
      appKey: (card.configurationState?.appKey as string) || "",
      appToken: (card.configurationState?.appToken as string) || "",
    });
  }, [card.configurationState, form]);

  const { save, isPending, error } = useSaveCompanionConfig({
    card,
    selfClient,
    org,
    onDone,
  });

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- notify parent of save pending state
  useEffect(() => {
    onIsPendingChange?.(isPending);
  }, [isPending, onIsPendingChange]);

  const handleSubmit = form.handleSubmit(async (data) => {
    save(data);
  });

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Form {...form}>
        <FormField
          control={form.control}
          name="accountName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("commerceOnboarding.vtexConfigForm.accountNameLabel")}
              </FormLabel>
              <FormControl>
                <Input
                  placeholder={t(
                    "commerceOnboarding.vtexConfigForm.accountNamePlaceholder",
                  )}
                  {...field}
                  disabled={isPending}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="appKey"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("commerceOnboarding.vtexConfigForm.appKeyLabel")}
              </FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder={t(
                    "commerceOnboarding.vtexConfigForm.appKeyPlaceholder",
                  )}
                  {...field}
                  disabled={isPending}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="appToken"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("commerceOnboarding.vtexConfigForm.appTokenLabel")}
              </FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder={t(
                    "commerceOnboarding.vtexConfigForm.appTokenPlaceholder",
                  )}
                  {...field}
                  disabled={isPending}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </Form>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error
            ? error.message
            : t("commerceOnboarding.vtexConfigForm.savingError")}
        </p>
      )}

      <DialogFooter className="pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={isPending}
        >
          {t("commerceOnboarding.vtexConfigForm.cancelButton")}
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending
            ? t("commerceOnboarding.vtexConfigForm.savingButton")
            : t("commerceOnboarding.vtexConfigForm.saveButton")}
        </Button>
      </DialogFooter>
    </form>
  );
}
