import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { useState } from "react";
import { useT } from "@/i18n/use-t.ts";
import type {
  BlockDeletedOnBase,
  DeletedBlockResolution,
} from "./sandbox-git-api.ts";

/**
 * Asks, per block, whether a block this draft edited comes back after the base
 * deleted (or renamed) it — the answer to a sync stopped by
 * `BlocksDeletedOnBaseError`. Every block needs a choice before the sync runs
 * again; Cancel leaves the draft as it was. Mount it per conflict (a `key`)
 * so its choices start empty.
 */
export function DeletedBlocksDialog({
  blocks,
  base,
  pending,
  onCancel,
  onConfirm,
}: {
  blocks: BlockDeletedOnBase[];
  base: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (resolutions: Record<string, DeletedBlockResolution>) => void;
}) {
  const t = useT();
  const [choices, setChoices] = useState<
    Record<string, DeletedBlockResolution>
  >({});
  const restored = new Set(
    blocks
      .filter((block) => choices[block.path] === "restore")
      .map((block) => block.key),
  );
  const decided = blocks.every((block) => choices[block.path]);

  return (
    <AlertDialog open>
      <AlertDialogContent
        className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg"
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <AlertDialogHeader className="text-left">
          <AlertDialogTitle>
            {t("thread.deletedBlocks.title", { base })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("thread.deletedBlocks.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {blocks.map((block) => {
            // A reference the dialog brings back too is not broken.
            const missing = block.missingRefs.filter(
              (ref) => !restored.has(ref),
            );
            return (
              <li key={block.path} className="flex flex-col gap-2">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">
                    {block.key}
                  </span>
                  {block.renamedTo && (
                    <span className="text-meta">
                      {t("thread.deletedBlocks.renamed", {
                        name: block.renamedTo,
                      })}
                    </span>
                  )}
                  {choices[block.path] === "restore" && missing.length > 0 && (
                    <span className="text-meta text-warning">
                      {t("thread.deletedBlocks.missingRefs", {
                        names: missing.join(", "),
                      })}
                    </span>
                  )}
                </div>
                <ToggleGroup
                  type="single"
                  variant="segmented"
                  size="sm"
                  value={choices[block.path] ?? ""}
                  disabled={pending}
                  onValueChange={(value) => {
                    if (value !== "restore" && value !== "drop") return;
                    setChoices((current) => ({
                      ...current,
                      [block.path]: value,
                    }));
                  }}
                >
                  <ToggleGroupItem value="drop">
                    {t("thread.deletedBlocks.drop")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="restore">
                    {t("thread.deletedBlocks.restore")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </li>
            );
          })}
        </ul>
        <AlertDialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            {t("thread.deletedBlocks.cancel")}
          </Button>
          <Button
            onClick={() => onConfirm(choices)}
            disabled={!decided || pending}
          >
            {t("thread.deletedBlocks.continue")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
