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
  FormMessage,
} from "@decocms/ui/components/form.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { DialogFooter } from "@decocms/ui/components/dialog.tsx";
import { KEYS } from "@/lib/query-keys";
import { unwrapToolResult, toPropertyOptions } from "../companions-core.ts";
import { useSaveCompanionConfig } from "./use-save-companion-config.ts";
import { SelectableList } from "./selectable-list.tsx";
import { LoadingIndicator } from "../loading-indicator.tsx";
import type { CompanionFormProps } from "./types.ts";

const schema = z.object({
  propertyId: z.string().min(1, "Selecione uma propriedade"),
});

type FormData = z.infer<typeof schema>;

export function GoogleAnalyticsConfigForm({
  card,
  connectionId,
  companionClient,
  selfClient,
  org,
  onDone,
  onDisconnect,
  onIsPendingChange,
}: CompanionFormProps) {
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

  if (propertiesQuery.isLoading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <LoadingIndicator label="Carregando propriedades..." />
      </div>
    );
  }

  if (propertiesQuery.isError) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">
          Não foi possível carregar as propriedades do Google Analytics.
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
          Nenhuma propriedade do Google Analytics foi encontrada. Conecte uma
          conta do Google Analytics com propriedades.
        </p>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {onDisconnect ? (
            <button
              type="button"
              onClick={onDisconnect}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-destructive"
            >
              Desconectar conta
            </button>
          ) : (
            <span />
          )}
          <Button type="button" variant="outline" onClick={onDone}>
            Fechar
          </Button>
        </DialogFooter>
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
              <FormControl>
                <SelectableList
                  options={options.flatMap((group) => group.options)}
                  value={field.value}
                  onChange={field.onChange}
                  disabled={isPending}
                  ariaLabel="Propriedade do Google Analytics"
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
            : "Não foi possível salvar a configuração"}
        </p>
      )}

      <DialogFooter className="flex-col gap-2 pt-4 sm:flex-row sm:items-center sm:justify-between">
        {onDisconnect ? (
          <button
            type="button"
            onClick={onDisconnect}
            disabled={isPending}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-destructive disabled:opacity-50"
          >
            Desconectar conta
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onDone}
            disabled={isPending}
          >
            Cancelar
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}
