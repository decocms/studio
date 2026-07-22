import { EnvVarsEditor } from "@/web/components/env-vars-editor";
import { useAuthConfig } from "@/web/providers/auth-config-provider";
import { useT } from "@/web/i18n/use-t.ts";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
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
import { type ConnectionEntity, parseVirtualUrl } from "@decocms/mesh-sdk";
import {
  CheckCircle,
  ChevronDown,
  Container,
  Users03,
  Globe02,
  RefreshCcw01,
  Terminal,
  Trash01,
  XClose,
} from "@untitledui/icons";
import { useForm, useWatch } from "react-hook-form";
import type { ConnectionFormData } from "./settings-tab/schema";

export function ConnectionFields({
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
  const t = useT();
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
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <span className="text-xs text-muted-foreground font-medium">
            {t("details.connectionSidebar.type")}
          </span>
          <div className="flex items-center gap-2 h-10 px-3 border border-border rounded-lg bg-muted/50">
            <Users03 className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm">
              {t("details.connectionSidebar.virtualMcp")}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("details.connectionSidebar.virtualMcpDescription")}
          </p>
        </div>
        {virtualMcpId && (
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground font-medium">
              {t("details.connectionSidebar.virtualMcpId")}
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
    <div className="flex flex-col gap-4">
      <FormField
        control={form.control}
        name="ui_type"
        render={({ field }) => (
          <FormItem className="flex flex-col gap-3">
            <FormLabel className="text-xs text-muted-foreground font-medium">
              {t("details.connectionSidebar.connection")}
            </FormLabel>
            {/* Unified container for HTTP/SSE/Websocket */}
            {uiType !== "NPX" && uiType !== "STDIO" ? (
              <div className="flex items-stretch rounded-lg border border-border overflow-hidden">
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="h-full! w-auto min-w-[90px] border-0 rounded-none bg-muted/50 focus:ring-0 focus:ring-offset-0">
                      <Globe02 className="w-4 h-4 text-muted-foreground shrink-0" />
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="HTTP">
                      {t("details.connectionSidebar.http")}
                    </SelectItem>
                    <SelectItem value="SSE">
                      {t("details.connectionSidebar.sse")}
                    </SelectItem>
                    <SelectItem value="Websocket">
                      {t("details.connectionSidebar.websocket")}
                    </SelectItem>
                    {showStdioOptions && (
                      <>
                        <SelectItem value="NPX">
                          {t("details.connectionSidebar.npxPackage")}
                        </SelectItem>
                        <SelectItem value="STDIO">
                          {t("details.connectionSidebar.customCommand")}
                        </SelectItem>
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
                          placeholder={t(
                            "details.connectionSidebar.urlPlaceholder",
                          )}
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
                      {t("details.connectionSidebar.http")}
                    </span>
                  </SelectItem>
                  <SelectItem value="SSE">
                    <span className="flex items-center gap-2">
                      <Globe02 className="w-4 h-4" />
                      {t("details.connectionSidebar.sse")}
                    </span>
                  </SelectItem>
                  <SelectItem value="Websocket">
                    <span className="flex items-center gap-2">
                      <Globe02 className="w-4 h-4" />
                      {t("details.connectionSidebar.websocket")}
                    </span>
                  </SelectItem>
                  {showStdioOptions && (
                    <>
                      <SelectItem value="NPX">
                        <span className="flex items-center gap-2">
                          <Container className="w-4 h-4" />
                          {t("details.connectionSidebar.npxPackage")}
                        </span>
                      </SelectItem>
                      <SelectItem value="STDIO">
                        <span className="flex items-center gap-2">
                          <Terminal className="w-4 h-4" />
                          {t("details.connectionSidebar.customCommand")}
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
                {t("details.connectionSidebar.npmPackage")}
              </FormLabel>
              <FormControl>
                <Input
                  placeholder={t(
                    "details.connectionSidebar.npmPackagePlaceholder",
                  )}
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
                    {t("details.connectionSidebar.command")}
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t(
                        "details.connectionSidebar.commandPlaceholder",
                      )}
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
                    {t("details.connectionSidebar.arguments")}
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t(
                        "details.connectionSidebar.argumentsPlaceholder",
                      )}
                      {...field}
                      value={field.value || ""}
                      className="h-10 rounded-lg"
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    {t("details.connectionSidebar.spaceSeparatedArguments")}
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
                  {t("details.connectionSidebar.workingDirectory")}
                </FormLabel>
                <FormControl>
                  <Input
                    placeholder={t(
                      "details.connectionSidebar.workingDirectoryPlaceholder",
                    )}
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
                {t("details.connectionSidebar.environmentVariables")}
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
                {isGitHubCopilotMcp
                  ? t("details.connectionSidebar.githubPersonalAccessToken")
                  : t("details.connectionSidebar.token")}
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
                          {t("details.connectionSidebar.authenticatedViaOAuth")}
                          <ChevronDown size={12} />
                        </Badge>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={onReauthenticate}>
                        <RefreshCcw01 size={16} />
                        {t("details.connectionSidebar.reauthenticate")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={onRemoveOAuth}
                      >
                        <Trash01 size={16} />
                        {t("details.connectionSidebar.removeOAuth")}
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
                    title={t("details.connectionSidebar.clearAndReplaceToken")}
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
                          ? t("details.connectionSidebar.pasteYourGitHubPat")
                          : t("details.connectionSidebar.enterAccessToken")
                      }
                      {...field}
                      value={field.value || ""}
                      className="h-10 rounded-lg"
                    />
                  </FormControl>
                  {isGitHubCopilotMcp && (
                    <FormDescription>
                      {t("details.connectionSidebar.createAPatAt")}{" "}
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
