import { AlertCircle, InfoCircle } from "@untitledui/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { decofileWriteMutationKey } from "@/components/sections-editor/decofile-api";
import { useDecofileCacheKey } from "@/components/sections-editor/use-decofile";
import type { SaveGuard } from "@/components/sections-editor/use-save-block";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import { AppEditor } from "./app-editor";
import { CMS_SETTINGS_BLOCK_KEY, readCmsSettingsBlock } from "./cms-settings";
import { EmptyMessage } from "./empty-message";

/**
 * Settings: the form of the site's `CMS` block (type `cms-settings`), from the
 * schema. With no block yet the form shows the defaults, and the first change
 * creates `CMS.json` with one `blocks.apply` guarded by `ifMatch: { CMS: null }`,
 * so a `CMS` created meanwhile (of any type) is never replaced: the guard
 * fails, the content is read again and the editor shows what's there.
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
  const queryClient = useQueryClient();
  const cacheKey = useDecofileCacheKey({ orgSlug, virtualMcpId, branch });
  const target = readCmsSettingsBlock(decofile);
  /**
   * The create-only guard: "create" while the block is absent (every save
   * sends `ifMatch: { CMS: null }`), "off" once a guarded save lands or the
   * block was there already. A refused save moves to "reread": saves queued
   * behind it stay create-only (and fail), and the guard turns off only once
   * the content has been read again, so the editor shows the block someone
   * else saved (or explains one of another type) before any edit replaces it.
   */
  const guardState = useRef<"create" | "reread" | "off">(
    target.kind === "absent" ? "create" : "off",
  );
  const [guard] = useState<SaveGuard>(() => ({
    ifMatch: (blockKey) =>
      blockKey === CMS_SETTINGS_BLOCK_KEY && guardState.current !== "off"
        ? { [CMS_SETTINGS_BLOCK_KEY]: null }
        : undefined,
    onApplied: () => {
      guardState.current = "off";
    },
    onRejected: () => {
      if (guardState.current !== "create") return;
      guardState.current = "reread";
      // A read merges around blocks still being saved, so it waits until this
      // branch's writes (the refused one and any queued behind it) settle.
      const writes = {
        mutationKey: decofileWriteMutationKey(orgSlug, virtualMcpId, branch),
      };
      const reread = () => {
        if (queryClient.isMutating(writes) > 0) {
          setTimeout(reread, 100);
          return;
        }
        void queryClient
          .invalidateQueries({ queryKey: KEYS.decofile(cacheKey) })
          .finally(() => {
            guardState.current = "off";
          });
      };
      setTimeout(reread, 0);
    },
  }));
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
      saveGuard={guard}
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
