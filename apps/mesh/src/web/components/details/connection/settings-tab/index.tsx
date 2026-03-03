import { ErrorBoundary } from "@/web/components/error-boundary.tsx";
import {
  useMCPClient,
  useMCPToolCall,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { Key01, File06, Loading01 } from "@untitledui/icons";
import { Suspense } from "react";
import { useWatch, type useForm } from "react-hook-form";
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
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 max-w-md text-center">
        <div className="flex flex-col gap-2">
          <h3 className="text-lg font-semibold">Authentication Required</h3>
          <p className="text-sm text-muted-foreground max-w-md text-center">
            This connection requires OAuth authentication to access resources.
          </p>
        </div>
        <Button onClick={onAuthenticate} size="lg">
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
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 max-w-md text-center">
        <Key01 size={48} className="text-muted-foreground" />
        <div className="flex flex-col gap-2">
          <h3 className="text-lg font-semibold">
            Manual Authentication Required
          </h3>
          <p className="text-sm text-muted-foreground max-w-md text-center">
            This server requires an API key or token that must be configured
            manually. Check the server's documentation for instructions on
            obtaining credentials.
          </p>
        </div>
        {hasReadme && onViewReadme && (
          <Button onClick={onViewReadme} variant="outline" size="lg">
            <File06 size={18} className="mr-2" />
            View README
          </Button>
        )}
      </div>
    </div>
  );
}

function ServerErrorState() {
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
          <h3 className="text-lg font-semibold">Server Error</h3>
          <p className="text-sm text-muted-foreground max-w-md text-center">
            The MCP server is currently experiencing issues. Please try again
            later or check the server's status.
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
      <div className="flex items-center gap-2 py-1">
        <div className="size-2 rounded-full bg-green-500 shrink-0" />
        <span className="text-sm text-muted-foreground">
          No additional configuration needed
        </span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <McpConfigurationForm
        stateSchema={stateSchema}
        formState={formState ?? {}}
        onFormStateChange={handleFormStateChange}
      />
    </div>
  );
}

function SettingsTabContent(props: SettingsTabProps) {
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

  // Authenticated but no MCP binding - no extra config needed
  if (!hasMcpBinding) {
    return (
      <div className="flex items-center gap-2 py-1">
        <div className="size-2 rounded-full bg-green-500 shrink-0" />
        <span className="text-sm text-muted-foreground">
          No additional configuration needed
        </span>
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
