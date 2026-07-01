import { CheckCircle, Loading01 } from "@untitledui/icons";
import { useState } from "react";
import type { CompanionConfigEntry } from "./companion-config-registry.ts";
import type { CompanionCardModel } from "./companions-core.ts";
import { useCompanionConfig } from "./use-companion-config.ts";

/** Rendered under a connected + registered companion card. Shows the saved
 * value with an Edit escape hatch, or the config form when unconfigured. The
 * root's callback ref drives the one-shot GSC auto-resolve after commit. */
export function CompanionConfigSection({
  entry,
  card,
  orgId,
  orgSlug,
  siteHost,
}: {
  entry: CompanionConfigEntry;
  card: CompanionCardModel & { linkedConnectionId: string };
  orgId: string;
  orgSlug: string;
  siteHost: string | null;
}) {
  const {
    configured,
    currentValue,
    gaGroups,
    gaError,
    verifiedSites,
    saving,
    error,
    save,
    maybeAutoResolve,
    isLoading,
  } = useCompanionConfig({
    entry,
    connectionId: card.linkedConnectionId,
    orgId,
    orgSlug,
    siteHost,
  });
  const [editing, setEditing] = useState(false);

  const { Renderer } = entry;

  return (
    <div ref={maybeAutoResolve} className="px-1 pt-1">
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loading01 size={14} className="animate-spin" /> Loading setup…
        </div>
      ) : configured && !editing ? (
        <div className="flex items-center gap-2">
          <CheckCircle size={14} className="shrink-0 text-blue-500" />
          <p className="flex-1 truncate text-sm text-muted-foreground">
            {(currentValue[entry.anchorField] as string) ?? ""}
          </p>
          <button
            type="button"
            className="text-sm text-muted-foreground underline underline-offset-2"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        </div>
      ) : (
        <Renderer
          currentValue={currentValue}
          gaGroups={gaGroups}
          gaError={gaError}
          verifiedSites={verifiedSites}
          saving={saving}
          error={error}
          onSave={(patch) => {
            // Collapse the form only after the write is durably persisted;
            // on failure keep it open so the inline error stays visible.
            void save(patch).then((ok) => {
              if (ok) setEditing(false);
            });
          }}
        />
      )}
    </div>
  );
}
