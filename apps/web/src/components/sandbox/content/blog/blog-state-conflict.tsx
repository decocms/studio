/**
 * The choice offered when a save was refused.
 *
 * The library has no field-level rebase, unlike the decofile — a write either
 * matches the version the edit started from or it is refused. So the editor
 * cannot merge on the person's behalf and does not pretend to: it says what
 * happened and lets them pick which version survives.
 */

import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { BlogState } from "./use-blog-state";

export function BlogStateConflict({ blog }: { blog: BlogState }) {
  const t = useT();
  if (!blog.conflict) return null;
  return (
    <div className="mx-8 my-3 rounded-lg border border-warning bg-warning/5 px-4 py-3">
      <p className="text-sm font-medium">
        {t("sandbox.blogState.conflictTitle")}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("sandbox.blogState.conflictBody")}
      </p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="outline" onClick={blog.reloadTheirs}>
          {t("sandbox.blogState.reloadTheirs")}
        </Button>
        <Button size="sm" onClick={blog.keepMine}>
          {t("sandbox.blogState.keepMine")}
        </Button>
      </div>
    </div>
  );
}
