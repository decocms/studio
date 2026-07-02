import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState } from "react";
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
import { unwrapToolResult, toPropertyOptions } from "../companions-core.ts";
import { useSaveCompanionConfig } from "./use-save-companion-config.ts";
import type { CompanionFormProps } from "./types.ts";

const schema = z.object({
  propertyId: z.string().min(1, "Property is required"),
});

type FormData = z.infer<typeof schema>;

export function GoogleAnalyticsConfigForm({
  card,
  connectionId,
  companionClient,
  selfClient,
  org,
  onDone,
}: CompanionFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const propertiesQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryCompanionGaProperties(org.id, connectionId),
    queryFn: async () => {
      const result = await companionClient.callTool({
        name: "get-account-summaries",
        arguments: {},
      });
      const data = unwrapToolResult(result);
      return toPropertyOptions(data);
    },
  });

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      propertyId: (card.configurationState?.propertyId as string) || "",
    },
  });

  const { save } = useSaveCompanionConfig({
    card,
    selfClient,
    org,
    onDone: () => {
      setIsSubmitting(false);
      onDone();
    },
  });

  const handleSubmit = form.handleSubmit(async (data) => {
    setIsSubmitting(true);
    save(data);
  });

  if (propertiesQuery.isLoading) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Loading properties...</p>
      </div>
    );
  }

  if (propertiesQuery.isError) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">
          Failed to load Google Analytics properties.
        </p>
      </div>
    );
  }

  const options = propertiesQuery.data || [];
  const allProperties = options.flatMap((group) => group.options);

  if (allProperties.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          No Google Analytics properties found. Please connect a Google
          Analytics account with properties.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Form {...form}>
        <FormField
          control={form.control}
          name="propertyId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Google Analytics Property</FormLabel>
              <FormControl>
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={isSubmitting}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a property" />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((group) => (
                      <div key={group.account}>
                        {group.options.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </div>
                    ))}
                  </SelectContent>
                </Select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </Form>

      <DialogFooter className="pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting} onClick={handleSubmit}>
          {isSubmitting ? "Saving..." : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
