import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { DialogFooter } from "@deco/ui/components/dialog.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { KEYS } from "@/web/lib/query-keys";
import { unwrapToolResult, matchGscSite } from "../companions-core.ts";
import { useSaveCompanionConfig } from "./use-save-companion-config.ts";
import type { CompanionFormProps } from "./types.ts";

const schema = z.object({
  siteUrl: z.string().min(1, "Site is required"),
});

type FormData = z.infer<typeof schema>;

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
    resolver: zodResolver(schema),
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

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- notify parent of save pending state
  useEffect(() => {
    onIsPendingChange?.(isPending);
  }, [isPending, onIsPendingChange]);

  const handleSubmit = form.handleSubmit(async (data) => {
    save(data);
  });

  if (sitesQuery.isLoading) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Loading sites...</p>
      </div>
    );
  }

  if (sitesQuery.isError) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">
          Failed to load Google Search Console sites.
        </p>
      </div>
    );
  }

  const sites = sitesQuery.data || [];

  if (sites.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          No verified sites found. Please verify a site in Google Search
          Console.
        </p>
      </div>
    );
  }

  const savedSiteUrl = card.configurationState?.siteUrl as string | undefined;
  if (savedSiteUrl && form.getValues("siteUrl") !== savedSiteUrl) {
    form.setValue("siteUrl", savedSiteUrl);
  } else if (!savedSiteUrl && !form.getValues("siteUrl")) {
    const matchedSite = matchGscSite(contextSiteUrl, sites);
    if (matchedSite) {
      form.setValue("siteUrl", matchedSite);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Form {...form}>
        <FormField
          control={form.control}
          name="siteUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Verified Site</FormLabel>
              <FormControl>
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={isPending}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a site" />
                  </SelectTrigger>
                  <SelectContent>
                    {sites.map((site) => (
                      <SelectItem key={site.siteUrl} value={site.siteUrl}>
                        {site.siteUrl}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
            : "Failed to save configuration"}
        </p>
      )}

      <DialogFooter className="pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving..." : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
