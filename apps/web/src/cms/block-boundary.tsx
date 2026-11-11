import { Fragment, useState, type ReactNode } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useCmsBlocks } from "./use-blocks";
import { useT } from "@/i18n/use-t";

interface EditorView {
  key: string;
  opened: boolean;
}

/** Reset on every destination transition, even one that never became ready. */
export function nextEditorView(
  current: EditorView,
  key: string,
  ready: boolean,
): EditorView {
  return current.key !== key || (!current.opened && ready)
    ? { key, opened: ready }
    : current;
}

/** Mount editors only after their bodies load; absent names may be created.
 * useCmsBlocks selects hosted storage only through the v8 gate.
 */
export function CmsBlockBoundary({
  scope,
  names,
  listing,
  children,
}: {
  scope: { orgSlug: string; virtualMcpId: string; branch: string } | null;
  names: readonly string[];
  listing: Record<string, unknown>;
  children: ReactNode;
}) {
  const t = useT();
  const load = useCmsBlocks(scope, names, { listing });
  const key = JSON.stringify([load.scopeKey, [...new Set(names)].sort()]);
  const [view, setView] = useState({ key, opened: load.ready });
  const showing = view.key === key && view.opened;
  const next = nextEditorView(view, key, load.ready);
  if (next !== view) setView(next);
  // A refresh must not unmount an open form and its pending keystrokes.
  if (!showing && load.failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p>{t("sectionsEditor.hosted.blockLoadFailed")}</p>
        <p className="text-sm text-muted-foreground">
          {t("sectionsEditor.hosted.blockLoadFailedHint")}
        </p>
        <Button variant="outline" size="sm" onClick={load.retry}>
          {t("sectionsEditor.namedRules.tryAgain")}
        </Button>
      </div>
    );
  }
  if (!showing && !load.ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }
  return <Fragment key={load.scopeKey}>{children}</Fragment>;
}
