import { EmptyState } from "@/components/empty-state.tsx";
import { ErrorBoundary } from "@/components/error-boundary.tsx";
import {
  useMCPClient,
  useMCPToolCall,
  useProjectContext,
  type ConnectionEntity,
} from "@/sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { Key01, File06, Loading01 } from "@untitledui/icons";
import { Suspense } from "react";
import { useWatch, type useForm } from "react-hook-form";
import { useT } from "@/i18n/use-t.ts";
import { McpConfigurationForm } from "./mcp-configuration-form";
import type { ConnectionFormData } from "./schema";

interface SettingsTabProps {
  connection: ConnectionEntity;
  form: ReturnType<typeof useForm<ConnectionFormData>>;
  hasMcpBinding: boolean;
  isMCPAuthenticated: boolean;
  supportsOAuth: boolean;
  isServerError?: boolean;
  onAuthenticate: () => void | Promise<void>;
  onViewReadme?: () => void;
}

interface McpConfigurationResult {
  stateSchema: Record<string, unknown>;
  scopes?: string[];
}

function useMcpConfiguration(connectionId: string) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data: configResult } = useMCPToolCall<McpConfigurationResult>({
    client,
    toolName: "MCP_CONFIGURATION",
    toolArguments: {},
    select: (result) =>
      ((result as { structuredContent?: unknown }).structuredContent ??
        result) as McpConfigurationResult,
  });

  const stateSchema = configResult.stateSchema ?? {
    type: "object",
    properties: {},
  };

  const scopes = configResult.scopes ?? [];

  return { stateSchema, scopes };
}

interface OAuthAuthenticationStateProps {
  onAuthenticate: () => void | Promise<void>;
  buttonText?: string;
}

export function OAuthAuthenticationState({
  onAuthenticate,
  buttonText = "Authenticate",
}: OAuthAuthenticationStateProps) {
  const t = useT();
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 max-w-md text-center">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">
            {t("details.settingsTab.authenticationRequired")}
          </h3>
          <p className="text-xs text-muted-foreground max-w-md text-center">
            {t("details.settingsTab.oauthAuthenticationDescription")}
          </p>
        </div>
        <Button onClick={onAuthenticate} size="default">
          {buttonText}
        </Button>
      </div>
    </div>
  );
}

interface ManualAuthRequiredStateProps {
  hasReadme: boolean;
  onViewReadme?: () => void;
}

export function ManualAuthRequiredState({
  hasReadme,
  onViewReadme,
}: ManualAuthRequiredStateProps) {
  const t = useT();
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 max-w-md text-center">
        <Key01 size={36} className="text-muted-foreground" />
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">
            {t("details.settingsTab.manualAuthenticationRequired")}
          </h3>
          <p className="text-xs text-muted-foreground max-w-md text-center">
            {t("details.settingsTab.manualAuthenticationDescription")}
          </p>
        </div>
        {hasReadme && onViewReadme && (
          <Button onClick={onViewReadme} variant="outline" size="lg">
            <File06 size={18} className="mr-2" />
            {t("details.settingsTab.viewReadme")}
          </Button>
        )}
      </div>
    </div>
  );
}

function ServerErrorState() {
  const t = useT();
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 max-w-md text-center">
        <img
          src="/empty-state-error.svg"
          alt=""
          width={160}
          height={160}
          aria-hidden="true"
        />
        <div className="flex flex-col gap-2">
          <h3 className="text-lg font-semibold">
            {t("details.settingsTab.serverError")}
          </h3>
          <p className="text-sm text-muted-foreground max-w-md text-center">
            {t("details.settingsTab.serverErrorDescription")}
          </p>
        </div>
      </div>
    </div>
  );
}

function McpConfigurationContent({
  connection,
  form,
}: {
  connection: ConnectionEntity;
  form: ReturnType<typeof useForm<ConnectionFormData>>;
}) {
  const t = useT();
  const { stateSchema } = useMcpConfiguration(connection.id);

  // useWatch is more reliable for triggering re-renders than form.watch()
  const formState = useWatch({
    control: form.control,
    name: "configuration_state",
  });

  const handleFormStateChange = (state: Record<string, unknown>) => {
    form.setValue("configuration_state", state, { shouldDirty: true });
  };

  const hasProperties =
    stateSchema &&
    stateSchema.properties &&
    typeof stateSchema.properties === "object" &&
    Object.keys(stateSchema.properties).length > 0;

  if (!hasProperties) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          image={
            <img
              src="/empty-state-success-muted.svg"
              alt=""
              width={220}
              height={200}
              aria-hidden="true"
            />
          }
          title={t("details.settingsTab.serverAllSet")}
          description={t("details.settingsTab.noAdditionalConfigurationNeeded")}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <McpConfigurationForm
        formKey={connection.id}
        stateSchema={stateSchema}
        formState={formState ?? {}}
        onFormStateChange={handleFormStateChange}
      />
    </div>
  );
}

function SettingsTabContent(props: SettingsTabProps) {
  const t = useT();
  const {
    connection,
    form,
    hasMcpBinding,
    isMCPAuthenticated,
    supportsOAuth,
    isServerError,
    onAuthenticate,
    onViewReadme,
  } = props;

  // Check if connection has README
  const repository = connection?.metadata?.repository as
    | { url?: string }
    | undefined;
  const hasReadme = !!repository?.url;

  // Not authenticated states
  if (!isMCPAuthenticated) {
    if (isServerError) {
      return <ServerErrorState />;
    }
    if (supportsOAuth) {
      return <OAuthAuthenticationState onAuthenticate={onAuthenticate} />;
    }
    return (
      <ManualAuthRequiredState
        hasReadme={hasReadme}
        onViewReadme={onViewReadme}
      />
    );
  }

  // Authenticated but no MCP binding - show success state
  if (!hasMcpBinding) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          image={
            <img
              src="/empty-state-success-muted.svg"
              alt=""
              width={220}
              height={200}
              aria-hidden="true"
            />
          }
          title={t("details.settingsTab.serverAllSet")}
          description={t("details.settingsTab.noAdditionalConfigurationNeeded")}
        />
      </div>
    );
  }

  // Has MCP binding - show configuration form
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex-1 flex items-center justify-center">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <McpConfigurationContent connection={connection} form={form} />
      </Suspense>
    </ErrorBoundary>
  );
}

export function SettingsTab(props: SettingsTabProps) {
  return (
    <div className="flex-1 flex h-full">
      <SettingsTabContent {...props} />
    </div>
  );
}
