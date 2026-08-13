import { useT } from "@/i18n/use-t.ts";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { createReferencedBlockSaver } from "@/components/sections-editor/save-referenced-block";
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { RunnableBlockEditor } from "@/components/sandbox/content/runnable-block-editor";
import { readSavedRunnableBlock } from "@/components/sandbox/content/runnable-catalog";

/**
 * Renders the loader editor (form + JSON) for a saved global loader, inline in
 * the Blocks panel next to the preview. This mirrors the "saved" branch of
 * {@link RunnableBlocksBrowser}: a saved block autosaves on change, so
 * `onCreate` (available-only) is never reached here, and the Run button is
 * hidden (`showRun={false}`) on this edit-only surface.
 */
export function GlobalLoaderEditor({
  orgSlug,
  virtualMcpId,
  branch,
  previewUrl,
  meta,
  decofile,
  blockKey,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl: string | null;
  meta: LiveMeta;
  decofile: Record<string, unknown>;
  blockKey: string;
}) {
  const t = useT();
  const saveBlock = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const saveReferencedBlock = createReferencedBlockSaver((key, data) =>
    saveBlock.mutate({ blockKey: key, data }),
  );

  const { resolveType, props, title } = readSavedRunnableBlock(
    decofile,
    blockKey,
  );
  if (!resolveType) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t("sandbox.preview.loaderNoLongerExists")}
      </div>
    );
  }

  return (
    <RunnableBlockEditor
      key={`loader:${blockKey}`}
      orgSlug={orgSlug}
      virtualMcpId={virtualMcpId}
      branch={branch}
      previewUrl={previewUrl}
      meta={meta}
      decofile={decofile}
      kind="loaders"
      target={{ mode: "saved", blockKey, resolveType, title }}
      initialValue={props}
      isCreating={saveBlock.isPending}
      onCreate={async () => {}}
      onSaveReferencedBlock={saveReferencedBlock}
      showRun={false}
    />
  );
}
