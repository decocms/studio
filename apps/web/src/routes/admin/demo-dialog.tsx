import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@decocms/ui/components/dialog.tsx";
import type { DemoStatus } from "@decocms/shared/demo";
import { adminFetch } from "@/lib/admin-fetch";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t";

export function DemoDialog({ orgId }: { orgId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: KEYS.deploymentAdminOrgDemo(orgId),
    queryFn: () =>
      adminFetch<{
        demo: DemoStatus | null;
        source: {
          repository: string;
          commit: string;
          capturedAt: string;
        } | null;
      }>(`/api/_admin/orgs/${orgId}/demo`),
    enabled: open,
  });
  const reset = useMutation({
    mutationFn: () =>
      adminFetch(`/api/_admin/orgs/${orgId}/demo/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedGeneration: query.data!.demo!.generation,
          idempotencyKey: crypto.randomUUID(),
        }),
      }),
    onSuccess: () => {
      toast.success(t("demo.ready"));
      void queryClient.invalidateQueries({
        queryKey: KEYS.deploymentAdminOrgDemo(orgId),
      });
      setOpen(false);
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {t("demo.label")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("demo.prepare")}</DialogTitle>
          <DialogDescription>{t("demo.resetDescription")}</DialogDescription>
        </DialogHeader>
        {query.error ? (
          <p role="alert">{query.error.message}</p>
        ) : query.isPending ? (
          <p>{t("demo.loading")}</p>
        ) : !query.data.demo ? (
          <p>{t("demo.unregistered")}</p>
        ) : (
          <p>
            {query.data.source?.repository} ·{" "}
            {query.data.source?.commit.slice(0, 12)}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("demo.cancel")}
          </Button>
          <Button
            disabled={!query.data?.demo?.enabled || reset.isPending}
            onClick={() => reset.mutate()}
          >
            {t(reset.isPending ? "demo.preparing" : "demo.restore")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
