import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { DialogFooter } from "@deco/ui/components/dialog.tsx";
import { KEYS } from "@/lib/query-keys";
import { unwrapToolResult, matchGscSite } from "../companions-core.ts";
import { useSaveCompanionConfig } from "./use-save-companion-config.ts";
import { SelectableList } from "./selectable-list.tsx";
import { LoadingIndicator } from "../loading-indicator.tsx";
import type { CompanionFormProps } from "./types.ts";
import { useT, type TFunction } from "@/i18n/use-t.ts";

const makeSchema = (t: TFunction) =>
  z.object({
    siteUrl: z
      .string()
      .min(
        1,
        t("commerceOnboarding.googleSearchConsoleConfigForm.siteRequired"),
      ),
  });

type FormData = z.infer<ReturnType<typeof makeSchema>>;

export function GoogleSearchConsoleConfigForm({
  card,
  connectionId,
  companionClient,
  selfClient,
  org,
  contextSiteUrl,
  onDone,
  onIsPendingChange,
}: CompanionFormProps) {
  const t = useT();
  const sitesQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryCompanionGscSites(org.id, connectionId),
    queryFn: async () => {
      const result = await companionClient.callTool({
        name: "list_sites",
        arguments: {},
      });
      const data = unwrapToolResult<{ sites?: Array<{ siteUrl: string }> }>(
        result,
      );
      return data.sites || [];
    },
  });

  const form = useForm<FormData>({
    resolver: zodResolver(makeSchema(t)),
    defaultValues: {
      siteUrl: (card.configurationState?.siteUrl as string) || "",
    },
  });

  const { save, isPending, error } = useSaveCompanionConfig({
    card,
    selfClient,
    org,
    onDone,
  });

  // Applies the persisted/auto-matched site to the form ONCE. Without this
  // guard, every render caused by the user picking a different site would
  // see `card.configurationState` (only refreshed after a successful save)
  // still holding the old value and immediately revert the selection to it.
  const prefilledRef = useRef(false);
  const savedSiteUrl = card.configurationState?.siteUrl as string | undefined;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- notify parent of save pending state
  useEffect(() => {
    onIsPendingChange?.(isPending);
  }, [isPending, onIsPendingChange]);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- prefill the form once from the persisted/auto-matched site (async query result), not on every render
  useEffect(() => {
    if (prefilledRef.current || !sitesQuery.isSuccess) return;
    prefilledRef.current = true;
    if (savedSiteUrl) {
      if (form.getValues("siteUrl") !== savedSiteUrl) {
        form.setValue("siteUrl", savedSiteUrl);
      }
      return;
    }
    if (!form.getValues("siteUrl")) {
      const matchedSite = matchGscSite(contextSiteUrl, sitesQuery.data ?? []);
      if (matchedSite) form.setValue("siteUrl", matchedSite);
    }
  }, [
    sitesQuery.isSuccess,
    sitesQuery.data,
    savedSiteUrl,
    contextSiteUrl,
    form,
  ]);

  const handleSubmit = form.handleSubmit(async (data) => {
    save(data);
  });

  if (sitesQuery.isLoading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <LoadingIndicator
          label={t(
            "commerceOnboarding.googleSearchConsoleConfigForm.loadingSites",
          )}
        />
      </div>
    );
  }

  if (sitesQuery.isError) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">
          {t("commerceOnboarding.googleSearchConsoleConfigForm.loadSitesError")}
        </p>
      </div>
    );
  }

  const sites = sitesQuery.data || [];

  if (sites.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("commerceOnboarding.googleSearchConsoleConfigForm.noSitesFound")}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Form {...form}>
        <FormField
          control={form.control}
          name="siteUrl"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <SelectableList
                  options={sites.map((site) => ({
                    value: site.siteUrl,
                    label: site.siteUrl,
                  }))}
                  value={field.value}
                  onChange={field.onChange}
                  disabled={isPending}
                  ariaLabel={t(
                    "commerceOnboarding.googleSearchConsoleConfigForm.siteAriaLabel",
                  )}
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
            : t("commerceOnboarding.googleSearchConsoleConfigForm.savingError")}
        </p>
      )}

      <DialogFooter className="pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={isPending}
        >
          {t("commerceOnboarding.googleSearchConsoleConfigForm.cancelButton")}
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending
            ? t("commerceOnboarding.googleSearchConsoleConfigForm.savingButton")
            : t("commerceOnboarding.googleSearchConsoleConfigForm.saveButton")}
        </Button>
      </DialogFooter>
    </form>
  );
}
