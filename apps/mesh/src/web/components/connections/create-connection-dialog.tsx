import { generatePrefixedId } from "@/shared/utils/generate-id";
import { useEnabledRegistries } from "@/web/hooks/use-enabled-registries";
import { useMergedStoreDiscovery } from "@/web/hooks/use-merged-store-discovery";
import { authClient } from "@/web/lib/auth-client";
import { useAuthConfig } from "@/web/providers/auth-config-provider";
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
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import {
  Form,
  FormControl,
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
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { useConnectionActions, useProjectContext } from "@decocms/mesh-sdk";
import { toast } from "sonner";
import { zodResolver } from "@hookform/resolvers/zod";
import { Container, Globe02, Terminal, XClose } from "@untitledui/icons";
import { useForm } from "react-hook-form";
import {
  connectionFormSchema,
  type ConnectionFormData,
} from "@/web/components/details/connection/settings-tab/schema";
import type {
  HttpConnectionParameters,
  StdioConnectionParameters,
} from "@/tools/connection/schema";
import { EnvVarsEditor } from "@/web/components/env-vars-editor";
import {
  type ConnectionProviderHint,
  buildCustomStdioParameters,
  buildNpxParameters,
  inferHardcodedProviderHint,
  inferRegistryProviderHint,
  parseNpxLikeCommand,
} from "@/web/utils/connection-form-helpers";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CreateConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new connection id after successful creation. */
  onCreated?: (id: string) => void;
}

export function CreateConnectionDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateConnectionDialogProps) {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const { stdioEnabled } = useAuthConfig();
  const isMobile = useIsMobile();
  const actions = useConnectionActions();

  const enabledRegistries = useEnabledRegistries();
  const mergedDiscovery = useMergedStoreDiscovery(enabledRegistries, "");
  const registryItems = mergedDiscovery.items;

  const form = useForm<ConnectionFormData>({
    resolver: zodResolver(connectionFormSchema),
    defaultValues: {
      title: "",
      description: null,
      icon: null,
      ui_type: "HTTP",
      connection_url: "",
      connection_token: null,
      npx_package: "",
      stdio_command: "",
      stdio_args: "",
      stdio_cwd: "",
      env_vars: [],
    },
  });

  const uiType = form.watch("ui_type");
  const connectionUrl = form.watch("connection_url");
  const npxPackage = form.watch("npx_package");

  const providerHint =
    inferHardcodedProviderHint({
      uiType,
      connectionUrl: connectionUrl ?? "",
      npxPackage: npxPackage ?? "",
    }) ??
    inferRegistryProviderHint({
      uiType,
      connectionUrl: connectionUrl ?? "",
      registryItems,
    });

  const applyInferenceFromInput = (rawInput: string) => {
    const raw = rawInput.trim();
    if (!raw) return;

    const titleIsDirty = Boolean(form.formState.dirtyFields.title);
    const descriptionIsDirty = Boolean(form.formState.dirtyFields.description);
    const envVarsIsDirty = Boolean(form.formState.dirtyFields.env_vars);

    const applySuggestedMeta = (hint: ConnectionProviderHint | null) => {
      if (!hint) return;

      if (!titleIsDirty && !form.getValues("title").trim() && hint.title) {
        form.setValue("title", hint.title, { shouldDirty: false });
      }

      if (
        !descriptionIsDirty &&
        !(form.getValues("description") ?? "").trim() &&
        hint.description
      ) {
        form.setValue("description", hint.description, { shouldDirty: false });
      }

      if (!envVarsIsDirty && hint.envVarKeys?.length) {
        const current = form.getValues("env_vars") ?? [];
        const existingKeys = new Set(current.map((v) => v.key));
        const toAdd = hint.envVarKeys.filter((k) => !existingKeys.has(k));
        if (toAdd.length > 0) {
          form.setValue(
            "env_vars",
            [...current, ...toAdd.map((key) => ({ key, value: "" }))],
            { shouldDirty: true },
          );
        }
      }
    };

    const npx = parseNpxLikeCommand(raw);
    if (npx && stdioEnabled) {
      form.setValue("ui_type", "NPX", { shouldDirty: true });
      form.setValue("npx_package", npx.packageName, { shouldDirty: true });
      form.setValue("connection_url", "", { shouldDirty: true });
      form.setValue("connection_token", null, { shouldDirty: true });

      applySuggestedMeta(
        inferHardcodedProviderHint({
          uiType: "NPX",
          npxPackage: npx.packageName,
        }),
      );
      return;
    }

    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const nextUiType =
        uiType === "HTTP" || uiType === "SSE" || uiType === "Websocket"
          ? uiType
          : "HTTP";
      form.setValue("ui_type", nextUiType, { shouldDirty: true });
      form.setValue("connection_url", raw, { shouldDirty: true });

      applySuggestedMeta(
        inferHardcodedProviderHint({
          uiType: nextUiType,
          connectionUrl: raw,
        }) ??
          inferRegistryProviderHint({
            uiType: nextUiType,
            connectionUrl: raw,
            registryItems,
          }),
      );
      return;
    }

    if (uiType === "NPX") {
      applySuggestedMeta(
        inferHardcodedProviderHint({
          uiType: "NPX",
          npxPackage: raw,
        }),
      );
    }
  };

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      form.reset();
    }
    onOpenChange(nextOpen);
  };

  const onSubmit = async (data: ConnectionFormData) => {
    let connectionType: "HTTP" | "SSE" | "Websocket" | "STDIO";
    let connectionUrl: string | null = null;
    let connectionToken: string | null = null;
    let connectionParameters:
      | StdioConnectionParameters
      | HttpConnectionParameters
      | null = null;

    if (data.ui_type === "NPX") {
      connectionType = "STDIO";
      connectionUrl = "";
      connectionParameters = buildNpxParameters(
        data.npx_package || "",
        data.env_vars || [],
      );
    } else if (data.ui_type === "STDIO") {
      connectionType = "STDIO";
      connectionUrl = "";
      connectionParameters = buildCustomStdioParameters(
        data.stdio_command || "",
        data.stdio_args || "",
        data.stdio_cwd,
        data.env_vars || [],
      );
    } else {
      connectionType = data.ui_type;
      connectionUrl = data.connection_url || "";
      connectionToken = data.connection_token || null;
    }

    const newId = generatePrefixedId("conn");
    try {
      await actions.create.mutateAsync({
        id: newId,
        title: data.title,
        description: data.description || null,
        connection_type: connectionType,
        connection_url: connectionUrl,
        connection_token: connectionToken,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        created_by: session?.user?.id || "system",
        organization_id: org.id,
        icon: data.icon ?? null,
        app_name: null,
        app_id: null,
        connection_headers: connectionParameters,
        oauth_config: null,
        configuration_state: null,
        metadata: null,
        tools: null,
        bindings: null,
        status: "inactive",
      });

      form.reset();
      onOpenChange(false);
      onCreated?.(newId);
    } catch {
      toast.error("Failed to create connection");
    }
  };

  const dialogTitle = "Create Connection";
  const dialogDescription =
    "Create a custom connection in your organization. Fill in the details below.";
  const submitLabel = form.formState.isSubmitting
    ? "Saving..."
    : "Create Connection";

  const formFields = (
    <div className="grid gap-4">
      <FormField
        control={form.control}
        name="ui_type"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Type *</FormLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger>
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
                {stdioEnabled && (
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
            <FormItem>
              <FormLabel>NPM Package *</FormLabel>
              <FormControl>
                <Input
                  placeholder="@perplexity-ai/mcp-server"
                  {...field}
                  value={field.value ?? ""}
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData("text");
                    if (!pasted) return;
                    e.preventDefault();
                    form.setValue("npx_package", pasted.trim(), {
                      shouldDirty: true,
                    });
                    applyInferenceFromInput(pasted);
                  }}
                  onBlur={(e) => {
                    applyInferenceFromInput(e.target.value);
                    field.onBlur();
                  }}
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
          <div className="grid grid-cols-2 gap-4 items-start">
            <FormField
              control={form.control}
              name="stdio_command"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Command *</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="node, bun, python..."
                      {...field}
                      value={field.value ?? ""}
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
                <FormItem>
                  <FormLabel>Arguments</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="arg1 arg2 --flag value"
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="stdio_cwd"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Working Directory</FormLabel>
                <FormControl>
                  <Input
                    placeholder="/path/to/project (optional)"
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <p className="text-xs text-muted-foreground">
                  Directory where the command will be executed
                </p>
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
            <FormItem>
              <FormLabel>Environment Variables</FormLabel>
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

      {/* HTTP/SSE/Websocket fields */}
      {uiType !== "NPX" && uiType !== "STDIO" && (
        <>
          <FormField
            control={form.control}
            name="connection_url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>URL *</FormLabel>
                <FormControl>
                  <Input
                    placeholder="https://example.com/mcp"
                    {...field}
                    value={field.value ?? ""}
                    onPaste={(e) => {
                      const pasted = e.clipboardData.getData("text");
                      if (!pasted) return;
                      e.preventDefault();
                      form.setValue("connection_url", pasted.trim(), {
                        shouldDirty: true,
                      });
                      applyInferenceFromInput(pasted);
                    }}
                    onBlur={(e) => {
                      applyInferenceFromInput(e.target.value);
                      field.onBlur();
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="connection_token"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {providerHint?.token?.label ?? "Token (optional)"}
                </FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    placeholder={
                      providerHint?.token?.placeholder ??
                      "Bearer token or API key"
                    }
                    className="ph-no-capture"
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                {providerHint?.token?.helperText && (
                  <p className="text-xs text-muted-foreground">
                    {providerHint.token.helperText}
                    {providerHint.id === "github" && (
                      <>
                        {" "}
                        ·{" "}
                        <a
                          className="text-foreground underline underline-offset-4 hover:text-foreground/80"
                          href="https://github.com/settings/personal-access-tokens"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open GitHub PAT settings
                        </a>
                      </>
                    )}
                  </p>
                )}
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      )}

      {/* Name/description come after connection mode/inputs so we can infer them */}
      <FormField
        control={form.control}
        name="title"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Name *</FormLabel>
            <FormControl>
              <Input placeholder="My Connection" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="description"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Description</FormLabel>
            <FormControl>
              <Textarea
                placeholder="A brief description of this connection"
                rows={3}
                {...field}
                value={field.value ?? ""}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={handleClose}>
        <DrawerContent className="max-h-[90vh]">
          <DrawerHeader className="pb-2">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 text-left">
                <DrawerTitle>{dialogTitle}</DrawerTitle>
                <DrawerDescription className="mt-1">
                  {dialogDescription}
                </DrawerDescription>
              </div>
              <DrawerClose asChild>
                <Button variant="ghost" size="icon" className="shrink-0 -mt-1">
                  <XClose size={16} />
                </Button>
              </DrawerClose>
            </div>
          </DrawerHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)}>
              <div className="overflow-y-auto px-4 pb-4">{formFields}</div>
              <DrawerFooter>
                <Button
                  type="submit"
                  disabled={form.formState.isSubmitting}
                  className="w-full"
                >
                  {submitLabel}
                </Button>
              </DrawerFooter>
            </form>
          </Form>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[525px]">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <div className="py-4">{formFields}</div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleClose(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={form.formState.isSubmitting}
                className="min-w-40"
              >
                {submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
