import type { ConnectionEntity } from "@/tools/connection/schema";
import { parseVirtualUrl } from "@/tools/connection/schema";
import { EnvVarsEditor } from "@/web/components/env-vars-editor";
import { IconPicker } from "@/web/components/icon-picker.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { useAuthConfig } from "@/web/providers/auth-config-provider";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import {
  CheckCircle,
  ChevronDown,
  Container,
  Globe02,
  Key01,
  RefreshCcw01,
  Terminal,
  Trash01,
  Users03,
  XClose,
} from "@untitledui/icons";
import { formatDistanceToNow } from "date-fns";
import { Controller, useForm, useWatch } from "react-hook-form";
import { User } from "@/web/components/user/user.tsx";
import { ConnectionVirtualMCPsSection } from "./settings-tab/connection-virtual-mcps-section";
import type { ConnectionFormData } from "./settings-tab/schema";

interface ConnectionSidebarProps {
  form: ReturnType<typeof useForm<ConnectionFormData>>;
  connection: ConnectionEntity;
  isMCPAuthenticated: boolean;
  hasOAuthToken?: boolean;
  onReauthenticate?: () => void | Promise<void>;
  onRemoveOAuth?: () => void | Promise<void>;
}

function ConnectionFields({
  form,
  connection,
  hasOAuthToken,
  onReauthenticate,
  onRemoveOAuth,
}: {
  form: ReturnType<typeof useForm<ConnectionFormData>>;
  connection: ConnectionEntity;
  hasOAuthToken?: boolean;
  onReauthenticate?: () => void | Promise<void>;
  onRemoveOAuth?: () => void | Promise<void>;
}) {
  const uiType = useWatch({ control: form.control, name: "ui_type" });
  const connectionUrl = useWatch({
    control: form.control,
    name: "connection_url",
  });
  const { stdioEnabled } = useAuthConfig();

  const isGitHubCopilotMcp = (() => {
    if (typeof connectionUrl !== "string" || !connectionUrl) return false;
    try {
      const url = new URL(connectionUrl);
      return (
        url.hostname === "api.githubcopilot.com" &&
        url.pathname.replace(/\/+$/, "") === "/mcp"
      );
    } catch {
      return false;
    }
  })();

  const showStdioOptions =
    stdioEnabled || connection.connection_type === "STDIO";

  const isVirtualConnection = connection.connection_type === "VIRTUAL";
  const virtualMcpId = isVirtualConnection
    ? parseVirtualUrl(connection.connection_url)
    : null;

  if (isVirtualConnection) {
    return (
      <div className="flex flex-col gap-4 p-5 border-b border-border">
        <div className="flex flex-col gap-3">
          <span className="text-xs text-muted-foreground font-medium">
            Type
          </span>
          <div className="flex items-center gap-2 h-10 px-3 border border-border rounded-lg bg-muted/50">
            <Users03 className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm">Virtual MCP</span>
          </div>
          <p className="text-xs text-muted-foreground">
            This connection references a Virtual MCP. Tools and resources are
            aggregated dynamically from the Virtual MCP&apos;s underlying
            connections.
          </p>
        </div>
        {virtualMcpId && (
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground font-medium">
              Virtual MCP ID
            </span>
            <div className="flex items-center gap-2 h-10 px-3 border border-border rounded-lg bg-muted/50">
              <code className="text-sm text-muted-foreground">
                {virtualMcpId}
              </code>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-5 border-b border-border">
      <FormField
        control={form.control}
        name="ui_type"
        render={({ field }) => (
          <FormItem className="flex flex-col gap-3">
            <FormLabel className="text-xs text-muted-foreground font-medium">
              Connection
            </FormLabel>
            {/* Unified container for HTTP/SSE/Websocket */}
            {uiType !== "NPX" && uiType !== "STDIO" ? (
              <div className="flex items-stretch rounded-lg border border-border overflow-hidden">
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="h-10 w-auto min-w-[90px] border-0 rounded-none bg-muted/50 focus:ring-0 focus:ring-offset-0">
                      <Globe02 className="w-4 h-4 text-muted-foreground shrink-0" />
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="HTTP">HTTP</SelectItem>
                    <SelectItem value="SSE">SSE</SelectItem>
                    <SelectItem value="Websocket">Websocket</SelectItem>
                    {showStdioOptions && (
                      <>
                        <SelectItem value="NPX">NPX Package</SelectItem>
                        <SelectItem value="STDIO">Custom Command</SelectItem>
                      </>
                    )}
                  </SelectContent>
                </Select>
                <div className="w-px bg-border" />
                <FormField
                  control={form.control}
                  name="connection_url"
                  render={({ field: urlField }) => (
                    <FormItem className="flex-1 min-w-0">
                      <FormControl>
                        <Input
                          placeholder="https://example.com/mcp"
                          {...urlField}
                          value={urlField.value ?? ""}
                          className="h-10 border-0 rounded-none focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
            ) : (
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="HTTP">
                    <span className="flex items-center gap-2">
                      <Globe02 className="w-4 h-4" />
                      HTTP
                    </span>
                  </SelectItem>
                  <SelectItem value="SSE">
                    <span className="flex items-center gap-2">
                      <Globe02 className="w-4 h-4" />
                      SSE
                    </span>
                  </SelectItem>
                  <SelectItem value="Websocket">
                    <span className="flex items-center gap-2">
                      <Globe02 className="w-4 h-4" />
                      Websocket
                    </span>
                  </SelectItem>
                  {showStdioOptions && (
                    <>
                      <SelectItem value="NPX">
                        <span className="flex items-center gap-2">
                          <Container className="w-4 h-4" />
                          NPX Package
                        </span>
                      </SelectItem>
                      <SelectItem value="STDIO">
                        <span className="flex items-center gap-2">
                          <Terminal className="w-4 h-4" />
                          Custom Command
                        </span>
                      </SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            )}
            <FormMessage />
          </FormItem>
        )}
      />

      {/* NPX-specific fields */}
      {uiType === "NPX" && (
        <FormField
          control={form.control}
          name="npx_package"
          render={({ field }) => (
            <FormItem className="flex flex-col gap-3">
              <FormLabel className="text-xs text-muted-foreground font-medium">
                NPM Package
              </FormLabel>
              <FormControl>
                <Input
                  placeholder="@perplexity-ai/mcp-server"
                  {...field}
                  value={field.value || ""}
                  className="h-10 rounded-lg"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      {/* STDIO/Custom Command fields */}
      {uiType === "STDIO" && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="stdio_command"
              render={({ field }) => (
                <FormItem className="flex flex-col gap-3">
                  <FormLabel className="text-xs text-muted-foreground font-medium">
                    Command
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="node, bun, python..."
                      {...field}
                      value={field.value || ""}
                      className="h-10 rounded-lg"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="stdio_args"
              render={({ field }) => (
                <FormItem className="flex flex-col gap-3">
                  <FormLabel className="text-xs text-muted-foreground font-medium">
                    Arguments
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="arg1 arg2 --flag value"
                      {...field}
                      value={field.value || ""}
                      className="h-10 rounded-lg"
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    Space-separated arguments
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="stdio_cwd"
            render={({ field }) => (
              <FormItem className="flex flex-col gap-3">
                <FormLabel className="text-xs text-muted-foreground font-medium">
                  Working Directory
                </FormLabel>
                <FormControl>
                  <Input
                    placeholder="/path/to/project (optional)"
                    {...field}
                    value={field.value || ""}
                    className="h-10 rounded-lg"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      )}

      {/* Shared: Environment Variables for NPX and STDIO */}
      {(uiType === "NPX" || uiType === "STDIO") && (
        <FormField
          control={form.control}
          name="env_vars"
          render={({ field }) => (
            <FormItem className="flex flex-col gap-3">
              <FormLabel className="text-xs text-muted-foreground font-medium">
                Environment Variables
              </FormLabel>
              <FormControl>
                <EnvVarsEditor
                  value={field.value ?? []}
                  onChange={field.onChange}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      {/* Token field for HTTP/SSE/Websocket */}
      {uiType !== "NPX" && uiType !== "STDIO" && (
        <FormField
          control={form.control}
          name="connection_token"
          render={({ field }) => (
            <FormItem className="flex flex-col gap-3">
              <FormLabel className="text-xs text-muted-foreground font-medium">
                {isGitHubCopilotMcp ? "GitHub Personal Access Token" : "Token"}
              </FormLabel>
              {/* Authentication status badge */}
              {hasOAuthToken ? (
                <div className="flex items-center gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <Badge variant="success" className="gap-1.5">
                          <CheckCircle size={12} />
                          Authenticated via OAuth
                          <ChevronDown size={12} />
                        </Badge>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={onReauthenticate}>
                        <RefreshCcw01 size={16} />
                        Re-authenticate
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={onRemoveOAuth}
                      >
                        <Trash01 size={16} />
                        Remove OAuth
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : connection.connection_token && field.value === null ? (
                <div className="relative group">
                  <div className="h-10 px-3 flex items-center rounded-lg border border-border bg-muted/50 text-muted-foreground font-mono text-sm">
                    ••••••••••••••••
                  </div>
                  <button
                    type="button"
                    onClick={() => field.onChange("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Clear and replace token"
                  >
                    <XClose size={14} className="text-muted-foreground" />
                  </button>
                </div>
              ) : (
                <>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder={
                        isGitHubCopilotMcp
                          ? "Paste your GitHub PAT"
                          : "Enter access token..."
                      }
                      {...field}
                      value={field.value || ""}
                      className="h-10 rounded-lg"
                    />
                  </FormControl>
                  {isGitHubCopilotMcp && (
                    <FormDescription>
                      Create a PAT at{" "}
                      <a
                        href="https://github.com/settings/personal-access-tokens"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        github.com/settings/personal-access-tokens
                      </a>
                    </FormDescription>
                  )}
                </>
              )}
              <FormMessage />
            </FormItem>
          )}
        />
      )}
    </div>
  );
}

export function ConnectionSidebar({
  form,
  connection,
  isMCPAuthenticated,
  hasOAuthToken,
  onReauthenticate,
  onRemoveOAuth,
}: ConnectionSidebarProps) {
  const { org } = useProjectContext();

  return (
    <Form {...form}>
      <div className="flex flex-col h-full overflow-auto">
        {/* Header section - Icon, Title, Description */}
        <div className="flex flex-col gap-4 p-5 border-b border-border">
          {connection.app_name && connection.icon ? (
            <IntegrationIcon
              icon={connection.icon}
              name={connection.title}
              size="lg"
              className="shadow-sm"
            />
          ) : (
            <Controller
              control={form.control}
              name="icon"
              render={({ field }) => (
                <IconPicker
                  value={field.value}
                  onChange={field.onChange}
                  name={connection.title}
                  size="lg"
                  className="shadow-sm"
                />
              )}
            />
          )}
          <div className="flex flex-col">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem className="flex-1 space-y-0">
                  <FormControl>
                    <Input
                      {...field}
                      className="h-auto py-0.5 text-lg! font-medium leading-7 px-2 -mx-2 border-transparent hover:bg-input/25 focus:border-input bg-transparent transition-all"
                      placeholder="Connection Name"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem className="w-full space-y-0">
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value || ""}
                      className="h-auto py-0.5 text-base text-muted-foreground leading-6 px-2 -mx-2 border-transparent hover:bg-input/25 focus:border-input bg-transparent transition-all"
                      placeholder="Add a description..."
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Connection section */}
        <ConnectionFields
          form={form}
          connection={connection}
          hasOAuthToken={hasOAuthToken}
          onReauthenticate={onReauthenticate}
          onRemoveOAuth={onRemoveOAuth}
        />

        {/* Connection Info section */}
        <div className="flex flex-col gap-2 p-5 border-b border-border">
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground font-medium">
              Status
            </span>
            {(connection.metadata as Record<string, unknown> | null)
              ?.needs_auth && !connection.connection_token ? (
              <Badge
                variant="outline"
                className="gap-1.5 text-amber-600 border-amber-400/40 bg-background"
              >
                <Key01 size={12} />
                Needs API Key
              </Badge>
            ) : isMCPAuthenticated ? (
              <Badge
                variant="success"
                className="gap-1.5 bg-success-foreground text-success"
              >
                <CheckCircle size={12} />
                Connected
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                Not connected
              </Badge>
            )}
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground font-medium">
              Created by
            </span>
            <User id={connection.created_by} size="2xs" />
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground font-medium">
              Updated
            </span>
            <span className="text-sm text-foreground">
              {connection.updated_at
                ? formatDistanceToNow(new Date(connection.updated_at), {
                    addSuffix: true,
                  })
                : "Unknown"}
            </span>
          </div>
        </div>

        {/* Agents section */}
        <ConnectionVirtualMCPsSection
          connectionId={connection.id}
          connectionTitle={connection.title}
          connectionDescription={connection.description}
          connectionIcon={connection.icon}
          org={org.slug}
        />
      </div>
    </Form>
  );
}
