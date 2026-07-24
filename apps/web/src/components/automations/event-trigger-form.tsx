import {
  useAutomationActions,
  useTriggerList,
  type TriggerDefinition,
} from "@/hooks/use-automations";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { useConnections } from "@/sdk";
import { Loading01, XClose, Zap } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";

export function EventTriggerForm({
  automationId,
  onDone,
}: {
  automationId: string;
  onDone: () => void;
}) {
  const t = useT();
  const triggerConnections = useConnections({ binding: "TRIGGER" });
  const [connectionId, setConnectionId] = useState<string | undefined>();
  const [eventType, setEventType] = useState<string | undefined>();
  const [params, setParams] = useState<Record<string, string>>({});
  const { triggerAdd: addTrigger } = useAutomationActions();
  const { data: triggerDefs, isLoading: isLoadingTriggers } =
    useTriggerList(connectionId);

  const selectedTrigger = triggerDefs?.find(
    (t: TriggerDefinition) => t.type === eventType,
  );

  const handleSubmit = async () => {
    if (!connectionId || !eventType) return;
    try {
      await addTrigger.mutateAsync({
        automation_id: automationId,
        type: "event",
        event_type: eventType,
        connection_id: connectionId,
        params,
      });
      track("automation_trigger_added", {
        automation_id: automationId,
        trigger_type: "event",
        connection_id: connectionId,
        event_type: eventType,
      });
      toast.success(t("automations.eventTriggerForm.successAdded"));
      onDone();
    } catch {
      toast.error(t("automations.eventTriggerForm.errorFailed"));
    }
  };

  return (
    <div className="flex flex-col gap-3 px-3 py-3 rounded-lg border border-border bg-background">
      <div className="flex items-center gap-2">
        <Zap size={14} className="text-muted-foreground shrink-0" />
        <span className="text-sm font-medium">
          {t("automations.eventTriggerForm.title")}
        </span>
        <button
          type="button"
          className="ml-auto shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground"
          onClick={onDone}
        >
          <XClose size={13} />
        </button>
      </div>

      {/* Step 1: Connection */}
      <Select
        value={connectionId ?? ""}
        onValueChange={(val) => {
          setConnectionId(val);
          setEventType(undefined);
          setParams({});
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue
            placeholder={t(
              "automations.eventTriggerForm.selectConnectionPlaceholder",
            )}
          />
        </SelectTrigger>
        <SelectContent>
          {triggerConnections.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("automations.eventTriggerForm.noConnectionsWithTrigger")}
            </div>
          ) : (
            triggerConnections.map((conn) => (
              <SelectItem key={conn.id} value={conn.id}>
                {conn.title}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>

      {/* Step 2: Event type */}
      {connectionId && (
        <Select
          value={eventType ?? ""}
          onValueChange={(val) => {
            setEventType(val);
            setParams({});
          }}
        >
          <SelectTrigger className="w-full">
            {isLoadingTriggers ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loading01 size={13} className="animate-spin" />
                {t("automations.eventTriggerForm.loadingEvents")}
              </span>
            ) : (
              <SelectValue
                placeholder={t(
                  "automations.eventTriggerForm.selectEventTypePlaceholder",
                )}
              >
                {eventType ??
                  t("automations.eventTriggerForm.selectEventTypePlaceholder")}
              </SelectValue>
            )}
          </SelectTrigger>
          <SelectContent>
            {triggerDefs?.map((t: TriggerDefinition) => (
              <SelectItem key={t.type} value={t.type}>
                <div className="flex flex-col">
                  <span>{t.type}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.description}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Step 3: Params */}
      {selectedTrigger?.paramsSchema &&
        Object.keys(selectedTrigger.paramsSchema).length > 0 && (
          <div className="flex flex-col gap-2">
            {Object.entries(selectedTrigger.paramsSchema).map(
              ([key, schema]) => (
                <div key={key} className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">
                    {key}
                    {schema.description && (
                      <span className="text-muted-foreground/60">
                        {" "}
                        — {schema.description}
                      </span>
                    )}
                  </label>
                  {schema.enum ? (
                    <Select
                      value={params[key] ?? ""}
                      onValueChange={(val) =>
                        setParams((p) => ({ ...p, [key]: val }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue
                          placeholder={t(
                            "automations.eventTriggerForm.selectParamPlaceholder",
                            { key },
                          )}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {schema.enum.map((val) => (
                          <SelectItem key={val} value={val}>
                            {val}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <input
                      type="text"
                      value={params[key] ?? ""}
                      onChange={(e) =>
                        setParams((p) => ({ ...p, [key]: e.target.value }))
                      }
                      placeholder={schema.description ?? key}
                      className="text-sm border border-border rounded-md bg-background px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  )}
                </div>
              ),
            )}
          </div>
        )}

      {/* Submit */}
      {connectionId && eventType && (
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={addTrigger.isPending}
        >
          {addTrigger.isPending ? (
            <Loading01 size={13} className="animate-spin" />
          ) : (
            t("automations.eventTriggerForm.addTriggerButton")
          )}
        </Button>
      )}
    </div>
  );
}
