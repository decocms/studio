/** Set up a daily brief: pick a preset, the connections it may call and what
 *  matters, and Studio creates the automation that writes it every morning
 *  and runs it once now. */

import { Suspense, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { MultiSelect } from "@decocms/ui/components/multi-select.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import {
  BRIEF_PRESETS,
  briefCron,
  briefMessage,
} from "@decocms/shared/daily-brief";
import { getDecopilotId } from "@decocms/shared/sdk";
import { useConnections, useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client";
import { useStudioTools } from "@/lib/studio-tools";
import type { BriefScope } from "./daily-brief";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function ConnectionsPicker({
  onChange,
}: {
  onChange: (titles: string[]) => void;
}) {
  const t = useT();
  const connections = useConnections();
  const [ids, setIds] = useState<string[]>([]);
  // Titles repeat, so pick by id; the run's message names titles.
  const titles = new Map(connections.map((c) => [c.id, c.title]));
  return (
    <MultiSelect
      options={connections.map((c) => ({ label: c.title, value: c.id }))}
      defaultValue={ids}
      onValueChange={(next) => {
        setIds(next);
        onChange([...new Set(next.flatMap((id) => titles.get(id) ?? []))]);
      }}
      placeholder={t("home.dailyBrief.setup.connectionsAll")}
      // Inside a modal dialog, a non-modal popover can't be clicked.
      modalPopover
      className="max-w-none"
    />
  );
}

export function DailyBriefSetupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  const [scope, setScope] = useState<BriefScope>("personal");
  const [preset, setPreset] = useState<string>(BRIEF_PRESETS[0]);
  const [connections, setConnections] = useState<string[]>([]);
  const [focus, setFocus] = useState("");
  const [hour, setHour] = useState(8);

  const setup = useMutation({
    mutationFn: async () => {
      const personal = scope === "personal" && userId ? userId : null;
      const created = (await studio.call("AUTOMATION_CREATE", {
        name: personal
          ? t("home.dailyBrief.setup.namePersonal", {
              name: session?.user?.name ?? "",
            })
          : t("home.dailyBrief.setup.nameOrg"),
        virtual_mcp_id: getDecopilotId(org.id),
        messages: [
          {
            role: "user",
            parts: [
              {
                type: "text",
                text: briefMessage({
                  userId: personal,
                  preset,
                  connections,
                  focus,
                }),
              },
            ],
          },
        ],
        models: { tier: "smart" },
        maxAgentSteps: 50,
        temperature: 0.3,
        active: true,
      })) as { id: string };
      try {
        await studio.call("AUTOMATION_TRIGGER_ADD", {
          automation_id: created.id,
          type: "cron",
          cron_expression: briefCron(hour, new Date()),
        });
      } catch (error) {
        // An automation with no schedule never writes a brief; don't leave it.
        await studio
          .call("AUTOMATION_DELETE", { id: created.id })
          .catch(() => {});
        throw error;
      }
      // First brief now; the schedule stands even when this run fails.
      try {
        await studio.call("AUTOMATION_RUN", { id: created.id });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    onSuccess: (runError) => {
      if (runError) {
        toast.warning(
          t("home.dailyBrief.setup.createdNotRun", { message: runError }),
        );
      } else {
        toast.success(t("home.dailyBrief.setup.created"));
      }
      onOpenChange(false);
    },
    onError: (error: unknown) => {
      toast.error(
        t("home.dailyBrief.setup.failed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("home.dailyBrief.setup.title")}</DialogTitle>
          <DialogDescription>
            {t("home.dailyBrief.setup.subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>{t("home.dailyBrief.setup.scope")}</Label>
            <ToggleGroup
              type="single"
              variant="segmented"
              size="sm"
              value={scope}
              onValueChange={(next) => {
                if (next === "personal" || next === "org") setScope(next);
              }}
            >
              <ToggleGroupItem value="personal" className="px-2.5 text-xs">
                {t("home.dailyBrief.personal")}
              </ToggleGroupItem>
              <ToggleGroupItem value="org" className="px-2.5 text-xs">
                {t("home.dailyBrief.org")}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t("home.dailyBrief.setup.preset")}</Label>
            <Select value={preset} onValueChange={setPreset}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="storefront">
                  {t("home.dailyBrief.setup.preset.storefront")}
                </SelectItem>
                <SelectItem value="custom">
                  {t("home.dailyBrief.setup.preset.custom")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t("home.dailyBrief.setup.connections")}</Label>
            <Suspense fallback={null}>
              <ConnectionsPicker onChange={setConnections} />
            </Suspense>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t("home.dailyBrief.setup.focus")}</Label>
            <Textarea
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
              placeholder={t("home.dailyBrief.setup.focusPlaceholder")}
              rows={3}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t("home.dailyBrief.setup.hour")}</Label>
            <Select
              value={String(hour)}
              onValueChange={(next) => setHour(Number(next))}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOURS.map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {`${String(h).padStart(2, "0")}:00`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("home.dailyBrief.setup.cancel")}
          </Button>
          <Button disabled={setup.isPending} onClick={() => setup.mutate()}>
            {setup.isPending
              ? t("home.dailyBrief.setup.creating")
              : t("home.dailyBrief.setup.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
