/**
 * The store's domain, which the analysis opens and captures. The engine finds
 * it from the store's site in Studio when it can; otherwise a member sets it
 * from the run the engine refused for lack of one, and changes it here.
 */

import { useId, useState } from "react";
import { Edit03 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useCapability } from "@/hooks/use-capability";
import { useT } from "@/i18n/use-t.ts";
import { errorText } from "./opportunity-view.ts";
import { useSiteProfile, useUpdateStoreDomain } from "./use-plan-diagnosis.ts";

/** The engine's connection is the org's, so editing its setup follows the
 *  same permission as connecting it; if capabilities fail to load, the
 *  engine decides. Null while loading. */
export function useCanEditSetup(): boolean | null {
  const capability = useCapability("connections:manage");
  if (capability.loading) return null;
  return capability.granted || !!capability.error;
}

export function StoreDomainForm({
  initial = "",
  submitLabel,
  onSaved,
  onCancel,
}: {
  initial?: string;
  submitLabel?: string;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const inputId = useId();
  const canEdit = useCanEditSetup();
  const update = useUpdateStoreDomain();
  const [domain, setDomain] = useState(initial);
  const value = domain.trim();

  if (canEdit === null) return null;
  if (!canEdit) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("plan.opportunities.domain.askAdmin")}
      </p>
    );
  }

  const failure = update.isError
    ? (errorText(update.error) ?? t("plan.opportunities.domain.failed"))
    : null;

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value || update.isPending) return;
        update.mutate(value, { onSuccess: () => onSaved?.() });
      }}
    >
      <label htmlFor={inputId} className="text-xs text-muted-foreground">
        {t("plan.opportunities.domain.label")}
      </label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          autoFocus
          inputMode="url"
          autoComplete="off"
          placeholder={t("plan.opportunities.domain.placeholder")}
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          className="shrink-0"
          disabled={!value || update.isPending}
        >
          {update.isPending && <Spinner size="2xs" />}
          {submitLabel ?? t("plan.opportunities.domain.save")}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={onCancel}
          >
            {t("plan.opportunities.domain.cancel")}
          </Button>
        )}
      </div>
      {failure && (
        <p role="alert" className="break-words text-xs text-destructive">
          {failure}
        </p>
      )}
    </form>
  );
}

/** "Store: www.example.com · Change". `known` is the domain from the view's
 *  setup; undefined from an engine without one, which is asked for the
 *  profile instead. With no domain, or a failed read, the row is hidden: the
 *  refused run asks for it, so the page never shows two domain forms. */
export function StoreDomainRow({ known }: { known?: string | null }) {
  const t = useT();
  const profile = useSiteProfile({ enabled: known === undefined });
  const canEdit = useCanEditSetup();
  const [editing, setEditing] = useState(false);

  if (known === undefined && (profile.isPending || profile.isError)) {
    return null;
  }
  const domain = known === undefined ? (profile.data?.domain ?? null) : known;
  if (!domain) return null;

  if (editing) {
    return (
      <div className="max-w-md">
        <StoreDomainForm
          initial={domain}
          onSaved={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="min-w-0 truncate">
        {t("plan.opportunities.domain.current", { domain })}
      </span>
      {canEdit && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2"
          onClick={() => setEditing(true)}
        >
          <Edit03 />
          {t("plan.opportunities.domain.change")}
        </Button>
      )}
    </div>
  );
}
