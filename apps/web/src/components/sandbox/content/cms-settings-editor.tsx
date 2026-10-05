import { AlertCircle, InfoCircle } from "@untitledui/icons";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { useT } from "@/i18n/use-t.ts";
import { AppEditor } from "./app-editor";
import { CMS_SETTINGS_BLOCK_KEY, readCmsSettingsBlock } from "./cms-settings";
import { EmptyMessage } from "./empty-message";

/**
 * Settings: the form of the site's `CMS` block (type `cms-settings`), from the
 * schema. With no block yet the form shows the defaults, and the first change
 * creates `CMS.json` (one `blocks.apply`, like any other save).
 *
 * The site reads these settings from its published release, never from a
 * draft, so the intro says when they take effect.
 */
export function CmsSettingsEditor({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  meta,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
}) {
  const t = useT();
  const target = readCmsSettingsBlock(decofile);
  if (target.kind === "conflict") {
    return (
      <EmptyMessage
        icon={AlertCircle}
        title={t("sandbox.cmsSettingsBlock.conflictTitle")}
        description={t("sandbox.cmsSettingsBlock.conflictDescription", {
          type: target.resolveType || "?",
        })}
      />
    );
  }
  return (
    <AppEditor
      // One key across "absent" and "saved": the first save must not reset
      // the form under the user.
      key={`settings:${CMS_SETTINGS_BLOCK_KEY}`}
      orgSlug={orgSlug}
      virtualMcpId={virtualMcpId}
      branch={branch}
      blockKey={CMS_SETTINGS_BLOCK_KEY}
      block={target.block}
      decofile={decofile}
      meta={meta}
      title={t("sandbox.collectionsSidebar.settings")}
      notice={
        <div className="mb-6 flex flex-col gap-2 text-xs text-muted-foreground">
          <p>{t("sandbox.cmsSettingsBlock.description")}</p>
          {target.kind === "absent" && (
            <p
              data-testid="cms-settings-defaults-notice"
              className="flex items-start gap-1.5 rounded-lg border bg-muted/40 px-3 py-2"
            >
              <InfoCircle size={14} className="mt-px shrink-0" />
              <span>{t("sandbox.cmsSettingsBlock.defaultsNotice")}</span>
            </p>
          )}
        </div>
      }
    />
  );
}
