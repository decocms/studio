import { useBlocker } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";
import {
  useCodeWorkspace,
  type CodeWorkspaceIdentity,
} from "./code-workspace-context";

function threadIdFromSearch(search: unknown): string | null {
  if (typeof search !== "object" || search === null || !("thread" in search)) {
    return null;
  }
  const thread = search.thread;
  return typeof thread === "string" ? thread : null;
}

/**
 * Preview, Content, and Code share one workspace session, so moving between
 * those children is safe. Leaving that route boundary or selecting another
 * thread changes the backing sandbox and must be confirmed while code is
 * dirty.
 */
export function isSameCodeWorkspaceNavigation({
  identity,
  currentPathname,
  nextPathname,
  nextSearch,
}: {
  identity: CodeWorkspaceIdentity;
  currentPathname: string;
  nextPathname: string;
  nextSearch: unknown;
}): boolean {
  const siteEditorRoute = currentPathname.match(
    /^(\/[^/]+\/projects\/[^/]+\/site-editor)(?:\/|$)/,
  );
  const siteEditorRoot = siteEditorRoute?.[1];
  if (!siteEditorRoot) return false;
  const remainsInsideSiteEditor =
    nextPathname === siteEditorRoot ||
    nextPathname.startsWith(`${siteEditorRoot}/`);

  return (
    remainsInsideSiteEditor &&
    threadIdFromSearch(nextSearch) === identity.threadId
  );
}

/** Protects in-memory Monaco buffers at the route boundary and on reload. */
export function CodeWorkspaceNavigationGuard() {
  const t = useT();
  const {
    identity,
    hasUnsavedChanges,
    identityChangePending,
    cancelIdentityChange,
    discardActiveSession,
    discardAndContinueIdentityChange,
  } = useCodeWorkspace();
  const blocker = useBlocker({
    disabled: !hasUnsavedChanges,
    enableBeforeUnload: hasUnsavedChanges,
    withResolver: true,
    shouldBlockFn: ({ current, next }) =>
      hasUnsavedChanges &&
      !isSameCodeWorkspaceNavigation({
        identity,
        currentPathname: current.pathname,
        nextPathname: next.pathname,
        nextSearch: next.search,
      }),
  });

  return (
    <AlertDialog
      open={blocker.status === "blocked" || identityChangePending}
      onOpenChange={(open) => {
        if (open) return;
        if (blocker.status === "blocked") blocker.reset?.();
        if (identityChangePending) cancelIdentityChange();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("sandbox.codeWorkspaceNavigationGuard.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("sandbox.codeWorkspaceNavigationGuard.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => {
              if (blocker.status === "blocked") blocker.reset?.();
              if (identityChangePending) cancelIdentityChange();
            }}
          >
            {t("sandbox.codeWorkspaceNavigationGuard.stay")}
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (blocker.status === "blocked") {
                  discardActiveSession();
                  blocker.proceed?.();
                }
                if (identityChangePending) {
                  discardAndContinueIdentityChange();
                }
              }}
            >
              {t("sandbox.codeWorkspaceNavigationGuard.discard")}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
