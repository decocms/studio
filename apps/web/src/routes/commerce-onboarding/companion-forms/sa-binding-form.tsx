import { KEYS } from "@/lib/query-keys";
import { Button } from "@deco/ui/components/button.tsx";
import { DialogFooter } from "@deco/ui/components/dialog.tsx";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy01 } from "@untitledui/icons";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useT } from "@/i18n/use-t.ts";
import { unwrapToolResult } from "../companions-core.ts";
import {
  type BindProvider,
  BIND_PROVIDER_COPY,
  type RemediationCopy,
  remediationFor,
  SA_EMAIL,
} from "./sa-binding-copy.ts";

interface SaFormValues {
  resourceId: string;
}

interface SaBindResult {
  ok: boolean;
  reason?: string;
  detail?: string;
  resourceId?: string;
}

/**
 * The consent-free "connect a Google source" form: it tells the user exactly
 * what to do (grant the shared SA access + where to find the id), sends the id
 * to COMMERCE_DISCOVERY_BIND (which verifies ownership server-side), and on
 * failure renders a reason-specific checklist — e.g. a GA4 property with no web
 * data stream gets the steps to add one. Optionally offers the old OAuth flow
 * behind a low-key link.
 */
export function SaBindingForm({
  provider,
  siteUrl,
  selfClient,
  org,
  initialResourceId,
  onDone,
  onIsPendingChange,
  onOAuthInstead,
}: {
  provider: BindProvider;
  siteUrl?: string;
  selfClient: Client;
  org: { id: string };
  initialResourceId?: string;
  onDone: () => void;
  onIsPendingChange?: (isPending: boolean) => void;
  onOAuthInstead?: () => void;
}) {
  const t = useT();
  const copy = BIND_PROVIDER_COPY[provider];
  const queryClient = useQueryClient();
  const [remediation, setRemediation] = useState<
    (RemediationCopy & { detail?: string }) | null
  >(null);

  const schema = z.object({
    resourceId: z
      .string()
      .trim()
      .min(
        1,
        t("commerceOnboarding.saBindingForm.resourceIdRequired", {
          resourceLabel: copy.resourceLabel.toLowerCase(),
        }),
      ),
  });

  const form = useForm<SaFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { resourceId: initialResourceId ?? "" },
  });

  const mutation = useMutation({
    mutationFn: async (values: SaFormValues): Promise<SaBindResult> => {
      if (!siteUrl) {
        throw new Error(
          t("commerceOnboarding.saBindingForm.storeUrlUnavailable"),
        );
      }
      const result = await selfClient.callTool({
        name: "COMMERCE_DISCOVERY_BIND",
        arguments: { siteUrl, provider, resourceId: values.resourceId },
      });
      return unwrapToolResult<SaBindResult>(result);
    },
    // Notify the parent dialog directly (no useEffect — banned in this repo).
    onMutate: () => onIsPendingChange?.(true),
    onSettled: () => onIsPendingChange?.(false),
    onSuccess: async (res) => {
      if (res.ok) {
        setRemediation(null);
        toast.success(
          t("commerceOnboarding.saBindingForm.connectedSuccess", {
            label: copy.label,
          }),
        );
        if (siteUrl) {
          await queryClient.invalidateQueries({
            queryKey: KEYS.commerceDiscoveryConnectionStatus(org.id, siteUrl),
          });
        }
        onDone();
        return;
      }
      setRemediation({
        ...remediationFor(provider, res.reason ?? "unknown"),
        detail: res.detail,
      });
    },
  });

  const handleSubmit = form.handleSubmit((data) => mutation.mutate(data));
  const isPending = mutation.isPending;

  const copyEmail = () => {
    navigator.clipboard?.writeText(SA_EMAIL);
    toast.success(t("commerceOnboarding.saBindingForm.emailCopied"));
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <ol className="space-y-2 text-sm text-muted-foreground">
        {copy.connectSteps.map((step, i) => (
          <li key={step} className="flex gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>

      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-2">
        <code className="min-w-0 flex-1 truncate text-xs text-foreground">
          {SA_EMAIL}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={copyEmail}
          aria-label={t("commerceOnboarding.saBindingForm.copyEmailLabel")}
        >
          <Copy01 size={16} />
        </Button>
      </div>

      <Form {...form}>
        <FormField
          control={form.control}
          name="resourceId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{copy.resourceLabel}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder={copy.resourcePlaceholder}
                  disabled={isPending}
                  autoComplete="off"
                />
              </FormControl>
              <FormDescription>{copy.resourceHint}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </Form>

      {remediation && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
        >
          <p className="text-sm font-medium text-foreground">
            {remediation.title}
          </p>
          <ol className="space-y-1 text-sm text-muted-foreground">
            {remediation.steps.map((step) => (
              <li key={step} className="flex gap-2">
                <span aria-hidden>•</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {mutation.isError && (
        <p role="alert" className="text-sm text-destructive">
          {mutation.error instanceof Error
            ? mutation.error.message
            : t("commerceOnboarding.saBindingForm.bindError")}
        </p>
      )}

      <DialogFooter className="flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
        {onOAuthInstead ? (
          <button
            type="button"
            onClick={onOAuthInstead}
            disabled={isPending}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
          >
            {t("commerceOnboarding.saBindingForm.googleLoginAlternative")}
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
            {t("commerceOnboarding.saBindingForm.cancel")}
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending
              ? t("commerceOnboarding.saBindingForm.verifying")
              : t("commerceOnboarding.saBindingForm.bind")}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}
