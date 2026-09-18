import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@decocms/ui/components/dialog.tsx";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { useDemo } from "@/hooks/use-demo";
import { useT } from "@/i18n/use-t";
import type { DemoRecipe } from "@decocms/shared/demo";

export function DemoControls() {
  const demo = useDemo();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  const reset = useMutation({
    mutationFn: () =>
      studio.call("DEMO_RESET", {
        expectedGeneration: demo!.generation,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      setConfirm(false);
      toast.success(t("demo.ready"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const create = useMutation({
    mutationFn: (recipe: DemoRecipe) =>
      studio.call("DEMO_CREATE_TASK", {
        recipe,
        expectedGeneration: demo!.generation,
      }),
    onSuccess: () => toast.success(t("demo.taskCreated")),
    onError: (error: Error) => toast.error(error.message),
  });
  const reserve = useMutation({
    mutationFn: (active: boolean) => studio.call("DEMO_SESSION", { active }),
    onError: (error: Error) => toast.error(error.message),
  });
  if (!demo) return null;
  const reserved = demo.sessionOwner !== null;
  return (
    <>
      <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
        {t(demo.enabled ? "demo.label" : "demo.suspended")}
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setConfirm(true)}
        disabled={!demo.enabled}
      >
        {t("demo.prepare")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => reserve.mutate(!reserved)}
        disabled={reserve.isPending || !demo.enabled}
      >
        {t(reserved ? "demo.endSession" : "demo.startSession")}
      </Button>
      <select
        aria-label={t("demo.addScenario")}
        className="h-8 max-w-40 rounded border border-border bg-background px-2 text-xs"
        value=""
        disabled={create.isPending || !demo.enabled}
        onChange={(e) => {
          if (e.target.value) create.mutate(e.target.value as DemoRecipe);
        }}
      >
        <option value="">{t("demo.addScenario")}</option>
        <option value="search">{t("demo.search")}</option>
        <option value="promotion">{t("demo.promotion")}</option>
        <option value="diagnostic">{t("demo.diagnostic")}</option>
      </select>
      <a
        className="text-xs underline"
        href={`/api/${encodeURIComponent(org.slug)}/demo/report`}
        target="_blank"
        rel="noreferrer"
      >
        {t("demo.report")}
      </a>
      <a
        className="text-xs underline"
        href={`/api/${encodeURIComponent(org.slug)}/demo/storefront`}
        target="_blank"
        rel="noreferrer"
      >
        {t("demo.storefront")}
      </a>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("demo.prepare")}</DialogTitle>
            <DialogDescription>{t("demo.resetDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              {t("demo.cancel")}
            </Button>
            <Button disabled={reset.isPending} onClick={() => reset.mutate()}>
              {t(reset.isPending ? "demo.preparing" : "demo.restore")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
