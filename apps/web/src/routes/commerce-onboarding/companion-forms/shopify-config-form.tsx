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

// storeDomain + apiVersion are the MCP's configuration.state (StateSchema in the
// Shopify MCP); the accessToken is a static bearer that lives on the
// connection's `connection_token`, never in configuration_state. See
// use-save-companion-config.ts for the split.
const schema = z.object({
  storeDomain: z.string().min(1, "Informe o domínio da loja"),
  accessToken: z.string().optional(),
  apiVersion: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

export function ShopifyConfigForm({
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
      storeDomain: (card.configurationState?.storeDomain as string) || "",
      // The token is write-only from the UI (stored on connection_token, not
      // configuration_state) — never prefilled. Left blank on edit preserves it.
      accessToken: "",
      apiVersion: (card.configurationState?.apiVersion as string) || "",
    },
  });

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- sync form when config changes from server
  useEffect(() => {
    form.reset({
      storeDomain: (card.configurationState?.storeDomain as string) || "",
      accessToken: "",
      apiVersion: (card.configurationState?.apiVersion as string) || "",
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
    const apiVersion = data.apiVersion?.trim();
    const accessToken = data.accessToken?.trim();
    save(
      {
        storeDomain: data.storeDomain.trim(),
        // Only persist apiVersion when set — the MCP defaults it otherwise.
        ...(apiVersion ? { apiVersion } : {}),
      },
      // Omit the token when left blank so an existing one survives an edit.
      accessToken ? { connectionToken: accessToken } : undefined,
    );
  });

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Form {...form}>
        <FormField
          control={form.control}
          name="storeDomain"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("commerceOnboarding.shopifyConfigForm.storeDomainLabel")}
              </FormLabel>
              <FormControl>
                <Input
                  placeholder={t(
                    "commerceOnboarding.shopifyConfigForm.storeDomainPlaceholder",
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
          name="accessToken"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("commerceOnboarding.shopifyConfigForm.accessTokenLabel")}
              </FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder={t(
                    "commerceOnboarding.shopifyConfigForm.accessTokenPlaceholder",
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
          name="apiVersion"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("commerceOnboarding.shopifyConfigForm.apiVersionLabel")}
              </FormLabel>
              <FormControl>
                <Input
                  placeholder={t(
                    "commerceOnboarding.shopifyConfigForm.apiVersionPlaceholder",
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
            : t("commerceOnboarding.shopifyConfigForm.savingError")}
        </p>
      )}

      <DialogFooter className="pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={isPending}
        >
          {t("commerceOnboarding.shopifyConfigForm.cancelButton")}
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending
            ? t("commerceOnboarding.shopifyConfigForm.savingButton")
            : t("commerceOnboarding.shopifyConfigForm.saveButton")}
        </Button>
      </DialogFooter>
    </form>
  );
}
