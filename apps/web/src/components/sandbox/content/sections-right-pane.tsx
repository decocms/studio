import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import { suggestBlockId } from "@/components/sections-editor/page-sections";
import { AvailableSectionEditor } from "./available-section-editor";
import { SavedSectionEditor } from "./saved-section-editor";
import { EmptyMessage } from "./empty-message";
import { useT } from "@/i18n/use-t.ts";

export function SectionsRightPane({
  selection,
  orgSlug,
  virtualMcpId,
  branch,
  previewUrl,
  meta,
  decofile,
  isCreating,
  onCreateAvailable,
  onSaveReferencedBlock,
}: {
  selection:
    | { collection: "sections"; key: string }
    | {
        collection: "available-section";
        resolveType: string;
        title: string;
      }
    | null;
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl: string | null;
  meta: LiveMeta;
  decofile: Record<string, unknown>;
  isCreating: boolean;
  onCreateAvailable: (
    resolveType: string,
    blockId: string,
    data: Record<string, unknown>,
  ) => Promise<void>;
  onSaveReferencedBlock: (
    blockKey: string,
    data: Record<string, unknown>,
  ) => void;
}) {
  const t = useT();

  if (!selection) {
    return (
      <EmptyMessage
        title={t("sandbox.sectionsRightPane.selectSectionTitle")}
        description={t("sandbox.sectionsRightPane.selectSectionDescription")}
      />
    );
  }

  if (selection.collection === "available-section") {
    return (
      <AvailableSectionEditor
        key={`available:${selection.resolveType}`}
        orgSlug={orgSlug}
        virtualMcpId={virtualMcpId}
        branch={branch}
        previewUrl={previewUrl}
        meta={meta}
        decofile={decofile}
        resolveType={selection.resolveType}
        title={selection.title}
        defaultBlockId={suggestBlockId(selection.title)}
        isCreating={isCreating}
        onCreate={(blockId, data) =>
          onCreateAvailable(selection.resolveType, blockId, data)
        }
        onSaveReferencedBlock={onSaveReferencedBlock}
      />
    );
  }

  return (
    <SavedSectionEditor
      key={`saved:${selection.key}`}
      orgSlug={orgSlug}
      virtualMcpId={virtualMcpId}
      branch={branch}
      previewUrl={previewUrl}
      meta={meta}
      decofile={decofile}
      blockKey={selection.key}
      onSaveReferencedBlock={onSaveReferencedBlock}
    />
  );
}
