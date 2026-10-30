/**
 * Starting a campaign, wherever someone does it: on the campaigns board, or in
 * the new blogpost dialog, where a post needs a campaign to belong to.
 */

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { CatalogSource } from "./blocks/catalog-source";
import { str } from "./blocks/primitives";
import {
  buildCampaignBlock,
  emptyCampaign,
  newCampaignKey,
  readBlogContext,
} from "./blog-data";
import { CampaignEditor } from "./campaign-editor";
import type { BlogState } from "./use-blog-state";

export function useCampaignCreate(blog: BlogState) {
  const { save } = blog;

  /** An empty campaign. Its key comes back at once: the write shows it before it lands. */
  const addCampaign = (): string => {
    const blockKey = newCampaignKey();
    save.mutate({
      blockKey,
      data: buildCampaignBlock(emptyCampaign(new Date())),
    });
    return blockKey;
  };

  return { addCampaign };
}

/** One campaign's editor, docked at the right edge, the way the Posts board edits. */
export function CampaignEditorSheet({
  blockKey,
  blog,
  catalog,
  onClose,
  onRemove,
}: {
  /** The campaign to edit; null keeps the sheet closed. */
  blockKey: string | null;
  blog: BlogState;
  /** The store's catalog, for the product and category pickers. */
  catalog: CatalogSource | null;
  onClose: () => void;
  onRemove: (blockKey: string) => void;
}) {
  const t = useT();
  const block = blockKey
    ? (blog.blocks[blockKey] as Record<string, unknown> | undefined)
    : undefined;
  /** Where the store actually lives, so picked links are not platform hosts. */
  const storeUrl = str(readBlogContext(blog.blocks).merged.storeUrl);

  return (
    <Dialog
      open={!!blockKey && block !== undefined}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        closeButtonClassName="hidden"
        className="left-auto right-4 top-4 bottom-4 flex h-auto translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto p-0 sm:max-w-2xl"
      >
        <DialogTitle className="sr-only">
          {t("sandbox.blogContext.tabCampaigns")}
        </DialogTitle>
        {blockKey && block !== undefined && (
          <CampaignEditor
            key={blockKey}
            blockKey={blockKey}
            block={block}
            onSave={(data) => blog.save.mutate({ blockKey, data })}
            onRemove={() => onRemove(blockKey)}
            onClose={onClose}
            isSaving={blog.save.isPending}
            catalog={catalog}
            storeUrl={storeUrl}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
