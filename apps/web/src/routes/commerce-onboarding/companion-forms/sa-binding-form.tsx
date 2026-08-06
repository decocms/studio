import { KEYS } from "@/lib/query-keys";
import { Button } from "@deco/ui/components/button.tsx";
import { DialogFooter } from "@deco/ui/components/dialog.tsx";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy01, LinkExternal01 } from "@untitledui/icons";
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
 * The consent-free "connect a Google source" form. Google OAuth is still in
 * review (its login screen warns the app is unverified), so the default lane is
 * a shared service account: the user grants deco-reader@… read access in their
 * own console and pastes the resource id back. Three short steps, the e-mail to
 * copy, the id to paste. The id goes to COMMERCE_DISCOVERY_BIND, which verifies
 * ownership server-side; on failure this renders a reason-specific checklist
 * (e.g. a GA4 property with no web data stream gets the steps to add one). The
 * OAuth route stays available at the bottom, with the reason it is second.
 */
export function SaBindingForm({
  provider,
  siteUrl,
  siteHost,
  selfClient,
  org,
  initialResourceId,
  onDone,
  onIsPendingChange,
  onOAuthInstead,
}: {
  provider: BindProvider;
  siteUrl?: string;
  /** The merchant's domain, woven into the example so it reads as their store. */
  siteHost?: string | null;
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
  const host = siteHost || t("commerceOnboarding.saBinding.sampleDomain");

  const schema = z.object({
    resourceId: z
      .string()
      .trim()
      .min(
        1,
        t("commerceOnboarding.saBindingForm.resourceIdRequired", {
          resourceLabel: t(copy.resourceLabelKey).toLowerCase(),
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

  // Each step owns the control it talks about: step 1 the link out to the
  // console, step 2 the e-mail to paste there, step 3 the id to bring back. The
  // instruction and the thing it refers to never end up in different blocks.
  const controlFor = (index: number) => {
    if (index === 0) {
      return (
        <a
          href={copy.consoleUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          <LinkExternal01 size={14} />
          {t(copy.consoleLinkKey)}
        </a>
      );
    }
    if (index === 1) {
      return (
        <div className="flex w-full items-center gap-2 rounded-lg border border-input bg-muted/40 p-2">
          <code className="min-w-0 flex-1 truncate text-sm text-foreground">
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
      );
    }
    return (
      <Form {...form}>
        <FormField
          control={form.control}
          name="resourceId"
          render={({ field }) => (
            <FormItem className="w-full">
              <FormControl>
                <Input
                  {...field}
                  placeholder={t(copy.resourcePlaceholderKey, { host })}
                  disabled={isPending}
                  autoComplete="off"
                  aria-label={t(copy.resourceLabelKey)}
                />
              </FormControl>
              <FormDescription>
                {t(copy.resourceHintKey, { host })}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </Form>
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* One card per step: the three actions happen in someone else's product,
          so each gets its own bounded block instead of blurring into a list. */}
      <ol className="space-y-2">
        {copy.steps.map((step, i) => (
          <li
            key={step}
            className="flex gap-3 rounded-lg border border-border p-4"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
              <p className="text-sm leading-5 text-foreground">
                {t(step, { host })}
              </p>
              {controlFor(i)}
            </div>
          </li>
        ))}
      </ol>

      {remediation && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
        >
          <p className="text-sm font-medium text-foreground">
            {t(remediation.titleKey, { label: copy.label })}
          </p>
          <ol className="space-y-1 text-sm text-muted-foreground">
            {remediation.stepKeys.map((key) => (
              <li key={key} className="flex gap-2">
                <span aria-hidden>•</span>
                <span>{t(key, { email: SA_EMAIL })}</span>
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

      {onOAuthInstead && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("commerceOnboarding.saBinding.oauthNote")}{" "}
          <button
            type="button"
            onClick={onOAuthInstead}
            disabled={isPending}
            className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
          >
            {t("commerceOnboarding.saBindingForm.googleLoginAlternative")}
          </button>
        </p>
      )}

      <DialogFooter className="gap-2">
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
      </DialogFooter>
    </form>
  );
}
