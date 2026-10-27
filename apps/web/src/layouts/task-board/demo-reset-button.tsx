/**
 * "Reset demo board" for admins of a demo org, the same reset the daily job
 * runs. Shown only while the board has frozen cards, which the server reports
 * only when the org's flag is on and a board was captured.
 */

import { useCapabilities } from "@/hooks/use-capability";
import { useT } from "@/i18n/use-t";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
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
import { cn } from "@decocms/ui/lib/utils.ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCcw01 } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";
import { useBoardOrgSlug } from "./board-org";

export function DemoBoardResetButton({
  isDemoBoard,
}: {
  isDemoBoard: boolean;
}) {
  const t = useT();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const { locator } = useProjectContext();
  const { isPrivileged } = useCapabilities();
  const viewingOtherOrg = useBoardOrgSlug();
  const [open, setOpen] = useState(false);

  const reset = useMutation({
    mutationFn: () => studio.call("DEMO_BOARD_RESET", {}),
    onSuccess: (result) => {
      const issues = result.problems.length + result.deadPreviewUrls.length;
      if (issues > 0) {
        toast.warning(
          t("taskBoard.demoReset.doneWithIssues", { count: issues }),
        );
      } else {
        toast.success(t("taskBoard.demoReset.done"));
      }
    },
    onError: (err) =>
      toast.error(t("taskBoard.demoReset.failed"), {
        description: err instanceof Error ? err.message : undefined,
      }),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardItems(locator),
      }),
  });

  if (!isDemoBoard || !isPrivileged || viewingOtherOrg) return null;

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="hidden sm:inline-flex"
        disabled={reset.isPending}
        onClick={() => setOpen(true)}
      >
        <RefreshCcw01
          size={16}
          className={cn(reset.isPending && "animate-spin")}
        />
        {t("taskBoard.demoReset.button")}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("taskBoard.demoReset.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("taskBoard.demoReset.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("taskBoard.demoReset.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => reset.mutate()}
            >
              {t("taskBoard.demoReset.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
