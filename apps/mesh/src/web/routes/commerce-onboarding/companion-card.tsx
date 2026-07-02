import { IntegrationIcon } from "@/web/components/integration-icon";
import { KEYS } from "@/web/lib/query-keys";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useMCPClient } from "@decocms/mesh-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import RjsfForm from "@rjsf/shadcn";
import type { FieldTemplateProps } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";
import { CheckCircle, Edit03, Loading01 } from "@untitledui/icons";
import { useState } from "react";
import type { CompanionCardModel } from "./companions-core.ts";
import {
  getConfigurationSummaryEntries,
  hasConfigurationValues,
  unwrapToolResult,
} from "./companions-core.ts";

/**
 * Loading placeholder that mirrors {@link CompanionCard}'s box model (same
 * wrapper, icon row, and two unlock lines) so its height matches a real card
 * instead of a short generic block.
 */
export function CompanionCardSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <div className="size-9 shrink-0 animate-pulse rounded-lg bg-muted/60" />
        <div className="h-4 w-32 animate-pulse rounded bg-muted/60" />
        <div className="ml-auto h-8 w-20 animate-pulse rounded-lg bg-muted/60" />
      </div>
      <div className="flex flex-col gap-1 px-1 py-2">
        <div className="p-1">
          <div className="h-5 w-40 animate-pulse rounded bg-muted/60" />
        </div>
        <div className="p-1">
          <div className="h-5 w-56 animate-pulse rounded bg-muted/60" />
        </div>
      </div>
    </div>
  );
}

function UnlockLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 p-1">
      <CheckCircle size={14} className="shrink-0 text-blue-500" />
      <p className="text-sm text-foreground">{children}</p>
    </div>
  );
}

export function CompanionCard({
  card,
  connecting,
  disabled,
  onConnect,
  org,
  selfClient,
}: {
  card: CompanionCardModel;
  connecting: boolean;
  disabled: boolean;
  onConnect: () => void;
  org: { id: string; slug: string };
  selfClient: Client;
}) {
  const linkedConnectionId = card.linkedConnectionId;
  const savedConfigEntries = getConfigurationSummaryEntries(
    card.configurationState,
  );

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <IntegrationIcon
          icon={card.icon}
          name={card.title}
          size="sm"
          fit="contain"
          className="p-1.5"
        />
        <p className="flex-1 text-sm text-foreground">{card.title}</p>
        {card.satisfied ? (
          <div className="flex h-8 items-center gap-2 px-3 text-sm text-muted-foreground">
            <CheckCircle size={16} /> Connected
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || connecting}
            onClick={onConnect}
            aria-label={`Connect ${card.title}`}
          >
            {connecting ? (
              <Loading01 size={16} className="animate-spin" />
            ) : (
              "Connect"
            )}
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1 px-1 py-2">
        {card.checks !== null && (
          <UnlockLine>+ {card.checks} checks</UnlockLine>
        )}
        {card.headline && <UnlockLine>{card.headline}</UnlockLine>}
        {card.bullets.map((b) => (
          <UnlockLine key={b}>{b}</UnlockLine>
        ))}
        {!card.satisfied && card.candidateConnectionId && (
          <p className="px-1 text-xs text-muted-foreground">
            Using your existing {card.title}
          </p>
        )}
      </div>
      {card.satisfied && linkedConnectionId && (
        <CompanionConfiguration
          card={card}
          org={org}
          selfClient={selfClient}
          connectionId={linkedConnectionId}
          savedConfigEntries={savedConfigEntries}
        />
      )}
    </div>
  );
}

interface CompanionConfigurationProps {
  card: CompanionCardModel;
  org: { id: string; slug: string };
  selfClient: Client;
  connectionId: string;
  savedConfigEntries: Array<{ key: string; label: string; value: string }>;
}

function hasSchemaProperties(stateSchema: Record<string, unknown> | undefined) {
  const properties = stateSchema?.properties;
  return (
    !!properties &&
    typeof properties === "object" &&
    Object.keys(properties).length > 0
  );
}

function isSensitiveConfigKey(key: string) {
  return /(token|secret|password|appKey|key)$/i.test(key);
}

function maskConfigValue(key: string, value: string) {
  return isSensitiveConfigKey(key) ? "••••••••" : value;
}

function CompactFieldTemplate({
  id,
  label,
  description,
  children,
}: FieldTemplateProps) {
  if (id.includes("__type") || id.includes("__binding")) return null;

  return (
    <div className="grid gap-1.5">
      {label && (
        <label className="text-sm font-medium text-foreground" htmlFor={id}>
          {label}
        </label>
      )}
      {children}
      {description && (
        <div className="text-xs leading-4 text-muted-foreground">
          {description}
        </div>
      )}
    </div>
  );
}

function CompanionConfiguration({
  card,
  org,
  selfClient,
  connectionId,
  savedConfigEntries,
}: CompanionConfigurationProps) {
  const queryClient = useQueryClient();
  const companionClient = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const [formState, setFormState] = useState<Record<string, unknown>>(
    card.configurationState ?? {},
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [prevDialogOpen, setPrevDialogOpen] = useState(dialogOpen);

  if (dialogOpen !== prevDialogOpen) {
    setPrevDialogOpen(dialogOpen);
    if (dialogOpen) {
      setFormState(card.configurationState ?? {});
      setValidationError(null);
    }
  }

  const schemaQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryCompanionConnectionSchema(
      org.id,
      connectionId,
    ),
    queryFn: async () => {
      const result = await companionClient.callTool({
        name: "MCP_CONFIGURATION",
        arguments: {},
      });
      return unwrapToolResult<{ stateSchema?: Record<string, unknown> }>(
        result,
      );
    },
    retry: false,
  });

  const saveMutation = useMutation({
    mutationFn: async (state: Record<string, unknown>) => {
      const result = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_UPDATE",
        arguments: {
          id: connectionId,
          data: { configuration_state: state },
        },
      });
      return unwrapToolResult<{ item: unknown }>(result);
    },
    onSuccess: async () => {
      setValidationError(null);
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryCompanionConnections(org.id),
      });
      setDialogOpen(false);
    },
  });

  const stateSchema = schemaQuery.data?.stateSchema;
  const shouldRenderConfiguration = hasSchemaProperties(stateSchema);

  if (schemaQuery.isPending) {
    return (
      <div className="flex items-center gap-2 border-t border-border pt-3 text-sm text-muted-foreground">
        <Loading01 size={14} className="animate-spin" />
        Loading configuration...
      </div>
    );
  }

  if (schemaQuery.error || !shouldRenderConfiguration || !stateSchema) {
    return null;
  }

  const handleSave = () => {
    if (!hasConfigurationValues(formState)) {
      setValidationError("Enter at least one configuration value.");
      return;
    }
    const result = validator.validateFormData(formState, stateSchema);
    if (result.errors.length > 0) {
      setValidationError(result.errors[0]?.stack ?? "Invalid configuration.");
      return;
    }
    setValidationError(null);
    saveMutation.mutate(formState);
  };

  const handleDialogOpenChange = (open: boolean) => {
    if (saveMutation.isPending) return;
    setDialogOpen(open);
    if (!open) {
      setValidationError(null);
      setFormState(card.configurationState ?? {});
    }
  };

  return (
    <>
      <div className="grid gap-3 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="grid gap-1">
            <p className="text-sm font-medium text-foreground">Configuration</p>
            {savedConfigEntries.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No configuration values saved yet.
              </p>
            )}
          </div>
          {savedConfigEntries.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDialogOpen(true)}
                  aria-label={`Edit ${card.title} configuration`}
                >
                  <Edit03 size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit configuration</TooltipContent>
            </Tooltip>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDialogOpen(true)}
            >
              Configure
            </Button>
          )}
        </div>
        {savedConfigEntries.length > 0 && (
          <dl className="grid gap-2">
            {savedConfigEntries.map((entry) => (
              <div
                key={entry.key}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <dt className="text-muted-foreground">{entry.label}</dt>
                <dd className="truncate text-foreground">
                  {maskConfigValue(entry.key, entry.value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Configure {card.title}</DialogTitle>
            <DialogDescription>
              Update the values this companion uses for Commerce Discovery.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <RjsfForm
              key={`${connectionId}:configuration`}
              schema={stateSchema}
              validator={validator}
              formData={formState}
              onChange={(data) => setFormState(data.formData ?? {})}
              liveValidate={false}
              showErrorList={false}
              templates={{ FieldTemplate: CompactFieldTemplate }}
            >
              <></>
            </RjsfForm>
            {(validationError || saveMutation.error) && (
              <p role="alert" className="text-sm text-destructive">
                {validationError ??
                  (saveMutation.error instanceof Error
                    ? saveMutation.error.message
                    : "Could not save configuration.")}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handleDialogOpenChange(false)}
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? (
                <>
                  <Loading01 size={14} className="animate-spin" />
                  Saving
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
