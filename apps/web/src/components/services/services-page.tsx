import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { taskKey } from "@decocms/shared/task-key";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { PasswordInput } from "@decocms/ui/components/password-input.tsx";
import { Page } from "@/components/page";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { useCreateSecret } from "@/hooks/use-secrets";
import { useTaskBoardItemActions } from "@/hooks/use-task-board-items";
import { useT } from "@/i18n/use-t.ts";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { track } from "@/lib/posthog-client";
import { useProjectContext } from "@/sdk";
import {
  kickoffDescription,
  PARTNER_SERVICES,
  type PartnerService,
} from "./catalog";

const brl = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function ServicesPage() {
  const t = useT();
  const [hiring, setHiring] = useState<PartnerService | null>(null);

  return (
    <Page>
      <Page.Content>
        <Page.Container width="standard">
          <Page.Title>{t("services.title")}</Page.Title>
          <p className="mb-6 text-sm text-muted-foreground">
            {t("services.subtitle")}
          </p>
          <ul className="grid gap-4 sm:grid-cols-2">
            {PARTNER_SERVICES.map((service) => (
              <li key={service.id} className="flex flex-col gap-4 surface p-5">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">
                    {t("services.offeredBy", { partner: service.partner })}
                  </span>
                  <h2 className="text-base font-medium text-foreground">
                    {t(service.nameKey)}
                  </h2>
                  <p className="text-sm text-pretty text-muted-foreground">
                    {t(service.descriptionKey)}
                  </p>
                </div>
                <div className="mt-auto flex items-center justify-between gap-3">
                  <div className="flex items-baseline gap-2">
                    <s className="text-sm text-muted-foreground">
                      {brl(service.listPrice)}
                    </s>
                    <span className="text-lg font-medium text-foreground">
                      {brl(service.price)}
                    </span>
                    {service.price === 0 && (
                      <Badge variant="lime" size="sm">
                        {t("services.free")}
                      </Badge>
                    )}
                  </div>
                  <Button
                    onClick={() => {
                      track("partner_service_opened", { service: service.id });
                      setHiring(service);
                    }}
                  >
                    {t("services.hire")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Page.Container>
      </Page.Content>
      {hiring && (
        <HireDialog
          key={hiring.id}
          service={hiring}
          onClose={() => setHiring(null)}
        />
      )}
    </Page>
  );
}

function HireDialog({
  service,
  onClose,
}: {
  service: PartnerService;
  onClose: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const virtualMcpId = useRouteVirtualMcpId();
  const navigate = useNavigate();
  const { create } = useTaskBoardItemActions();
  const createSecret = useCreateSecret();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  const missing = service.fields.some(
    (field) => !field.optional && !answers[field.id]?.trim(),
  );

  const hire = async () => {
    setPending(true);
    try {
      // Credentials go to the vault; the card only names the secret.
      const given: Record<string, string> = {};
      for (const field of service.fields) {
        const value = answers[field.id]?.trim();
        if (!value) continue;
        if (!field.secret) {
          given[field.id] = value;
          continue;
        }
        // Secrets can't be overwritten, so each hire gets its own name.
        const name = `${service.id}_${field.id}_${Date.now()}`
          .replace(/[^A-Za-z0-9_]/g, "_")
          .toUpperCase();
        await createSecret.mutateAsync({
          scope: "organization",
          name,
          value,
          description: `${service.partner} — ${field.id}`,
        });
        given[field.id] = name;
      }

      const { item: epic } = await create.mutateAsync({
        title: `${service.partner}: ${t(service.nameKey)}`,
        description: t(service.descriptionKey),
        isEpic: true,
        virtualMcpId,
      });
      await create.mutateAsync({
        title: t("services.kickoffTitle", { service: t(service.nameKey) }),
        description: kickoffDescription(service, given),
        parentId: epic.id,
        assigneeId: SUPER_AGENT_ASSIGNEE_ID,
        virtualMcpId,
      });
      track("partner_service_hired", { service: service.id });
      onClose();
      navigate({
        to: PROJECT_ROUTE.tasks,
        params: {
          org: org.slug,
          agentId: virtualMcpId,
          taskKey: taskKey(org.slug, epic.keySeq) ?? undefined,
        },
      });
    } catch (error) {
      toast.error(t("services.hireFailed"), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(service.nameKey)}</DialogTitle>
          <DialogDescription>
            {t("services.onboarding", { partner: service.partner })}
          </DialogDescription>
        </DialogHeader>
        <form
          id="hire-service"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!missing) void hire();
          }}
        >
          {service.fields.map((field) => {
            const id = `service-${field.id}`;
            const props = {
              id,
              value: answers[field.id] ?? "",
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                setAnswers({ ...answers, [field.id]: event.target.value }),
            };
            return (
              <div key={field.id} className="flex flex-col gap-1.5">
                <Label htmlFor={id}>
                  {t(field.labelKey)}
                  {field.optional && (
                    <span className="text-muted-foreground">
                      {" "}
                      {t("services.optional")}
                    </span>
                  )}
                </Label>
                {field.secret ? (
                  <PasswordInput {...props} autoComplete="off" />
                ) : (
                  <Input {...props} />
                )}
              </div>
            );
          })}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t("services.cancel")}
          </Button>
          <Button
            type="submit"
            form="hire-service"
            disabled={missing || pending}
          >
            {pending ? t("services.hiring") : t("services.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
