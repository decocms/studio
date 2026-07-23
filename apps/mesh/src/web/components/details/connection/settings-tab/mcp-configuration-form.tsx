import {
  useConnection,
  useConnections,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { resolveBindingType } from "@/web/hooks/use-binding";
import { useInstallFromRegistry } from "@/web/hooks/use-install-from-registry";
import { Loading01, Plus } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import RjsfForm from "@rjsf/shadcn";
import type { FieldTemplateProps, ObjectFieldTemplateProps } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { VirtualMCPSelector } from "@/web/components/chat/select-virtual-mcp";
import { useT } from "@/web/i18n/use-t.ts";

interface McpConfigurationFormProps {
  formKey: string;
  formState: Record<string, unknown>;
  onFormStateChange: (state: Record<string, unknown>) => void;
  stateSchema: Record<string, unknown>;
}

interface FormContext {
  onFieldChange: (fieldPath: string, value: unknown) => void;
  formData: Record<string, unknown>;
  onAddNew: () => void;
}

/**
 * Check if a schema property represents a binding field.
 */
function isBindingField(schema: Record<string, unknown>): boolean {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) return false;

  const typeProperty = properties.__type as Record<string, unknown> | undefined;
  const bindingProperty = properties.__binding as
    | Record<string, unknown>
    | undefined;

  return !!(typeProperty?.const || bindingProperty?.const);
}

/**
 * Extract binding info from schema.
 */
function getBindingInfo(schema: Record<string, unknown>): {
  bindingType?: string;
  bindingSchema?: unknown;
} {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) return {};

  const typeProperty = properties.__type as Record<string, unknown> | undefined;
  const bindingProperty = properties.__binding as
    | Record<string, unknown>
    | undefined;

  return {
    bindingType: typeProperty?.const as string | undefined,
    bindingSchema: bindingProperty?.const,
  };
}

interface BindingFieldWithDynamicSchemaProps {
  bindingSchema: unknown;
  bindingType?: string;
  currentValue: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  onAddNew: () => void;
  className?: string;
}

/**
 * Resolves the binding filter for BindingSelector.
 *
 * Resolution order:
 * 1. Builtin binding: "@deco/llm" → "LLMS" (matched by tool capabilities)
 * 2. Dynamic registry: "@scope/app" → fetch tools from registry
 * 3. Inline schema: [{ name: "TOOL", inputSchema: {...} }] → used directly
 * 4. String passthrough: well-known name like "LLMS" → passed through
 */
function BindingFieldWithDynamicSchema({
  bindingSchema,
  bindingType,
  currentValue,
  onValueChange,
  placeholder,
  onAddNew,
  className,
}: BindingFieldWithDynamicSchemaProps) {
  // Resolve binding to a server-side filter.
  // builtinBinding: "@deco/llm" → "LLMS"
  // string bindingSchema: well-known name like "LLMS" → passed through
  // array/object bindingSchema: custom binding schema → passed as object for server-side filtering
  const builtinBinding = resolveBindingType(bindingType);
  const resolvedBinding:
    | string
    | Record<string, unknown>
    | Record<string, unknown>[]
    | undefined =
    builtinBinding ??
    (typeof bindingSchema === "string"
      ? bindingSchema
      : bindingSchema != null
        ? (bindingSchema as Record<string, unknown> | Record<string, unknown>[])
        : undefined);

  return (
    <BindingSelector
      value={currentValue}
      onValueChange={onValueChange}
      placeholder={placeholder}
      binding={resolvedBinding}
      bindingType={bindingType}
      onAddNew={onAddNew}
      className={className}
    />
  );
}

interface BindingSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  binding?: string | Record<string, unknown> | Record<string, unknown>[];
  bindingType?: string;
  onAddNew?: () => void;
  className?: string;
}

function BindingSelector({
  value,
  onValueChange,
  placeholder = "Select a connection...",
  binding,
  bindingType,
  onAddNew,
  className,
}: BindingSelectorProps) {
  const t = useT();
  const [isLocalInstalling, setIsLocalInstalling] = useState(false);
  const { installByBinding, isInstalling: isGlobalInstalling } =
    useInstallFromRegistry();

  const isInstalling = isLocalInstalling || isGlobalInstalling;

  // Server-side filtering: use binding check when available,
  // fall back to app_name filter using bindingType as-is
  const appName = !binding ? bindingType || undefined : undefined;

  const filteredConnections = useConnections(
    binding
      ? { binding }
      : appName
        ? { filters: [{ column: "app_name" as const, value: appName }] }
        : {},
  );

  // Ensure the currently selected connection always appears in the dropdown,
  // even if the app_name filter didn't match it
  const selectedConnection = useConnection(
    value && !filteredConnections.some((c) => c.id === value)
      ? value
      : undefined,
  );

  const connections = selectedConnection
    ? [selectedConnection, ...filteredConnections]
    : filteredConnections;

  const canInstallInline = bindingType?.startsWith("@");

  const handleCreateConnection = async () => {
    if (canInstallInline && bindingType) {
      setIsLocalInstalling(true);
      try {
        const result = await installByBinding(bindingType);
        if (result) {
          onValueChange(result.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(
          t("details.mcpConfigurationForm.failedToConnectMcp", { message }),
        );
      } finally {
        setIsLocalInstalling(false);
      }
      return;
    }

    onAddNew?.();
  };

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger size="sm" className={cn("w-[200px]", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {connections.length === 0 ? (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">
            {t("details.mcpConfigurationForm.noConnectionsFound")}
          </div>
        ) : (
          connections.map((connection) => (
            <SelectItem key={connection.id} value={connection.id}>
              <div className="flex items-center gap-2">
                {connection.icon ? (
                  <img
                    src={connection.icon}
                    alt={connection.title}
                    className="w-4 h-4 rounded"
                  />
                ) : (
                  <div className="w-4 h-4 rounded bg-linear-to-br from-primary/20 to-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
                    {connection.title.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <span>{connection.title}</span>
              </div>
            </SelectItem>
          ))
        )}
        {(onAddNew || canInstallInline) && (
          <div className="border-t border-border">
            <Button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleCreateConnection();
              }}
              disabled={isInstalling}
              variant="ghost"
              className="w-full justify-start gap-2 px-2 py-2 h-auto hover:bg-muted rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              type="button"
            >
              {isInstalling ? (
                <>
                  <Loading01 size={16} className="animate-spin" />
                  <span>{t("details.mcpConfigurationForm.connecting")}</span>
                </>
              ) : (
                <>
                  <Plus size={16} />
                  <span>
                    {t("details.mcpConfigurationForm.customConnection")}
                  </span>
                </>
              )}
            </Button>
          </div>
        )}
      </SelectContent>
    </Select>
  );
}

function CustomObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const t = useT();
  const { schema, formData, title, description, registry } = props;
  const formContext = registry.formContext as FormContext | undefined;

  // The `title` prop contains the field name (e.g., "LLMS", "DATABASE")
  // This is the key we need for data operations
  const fieldKey = title || "";

  // For display, format the title nicely
  const displayFieldPath = title || "";

  if (isBindingField(schema as Record<string, unknown>)) {
    const { bindingType, bindingSchema } = getBindingInfo(
      schema as Record<string, unknown>,
    );
    // Use formContext.formData (parent's controlled state) as source of truth,
    // falling back to RJSF's internal formData for initial render
    const formContextFieldData = formContext?.formData?.[fieldKey] as
      | Record<string, unknown>
      | undefined;
    const currentValue =
      ((formContextFieldData?.value ?? formData?.value) as string) || "";

    const handleBindingChange = (newValue: string | null) => {
      const newFieldData = {
        ...formData,
        value: newValue ?? "",
        ...(bindingType && { __type: bindingType }),
      };
      formContext?.onFieldChange(fieldKey, newFieldData);
    };

    const formatTitle = (str: string) =>
      str
        .toLowerCase()
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());

    const displayTitle = title
      ? formatTitle(title)
      : formatTitle(displayFieldPath || fieldKey);

    if (bindingType === "@deco/agent") {
      return (
        <div className="flex items-center gap-3 justify-between">
          <div className="flex-1 min-w-0">
            <label className="text-sm font-medium truncate block">
              {displayTitle}
            </label>
            {description && (
              <p className="text-xs text-muted-foreground truncate">
                {description}
              </p>
            )}
          </div>
          <VirtualMCPSelector
            selectedVirtualMcpId={currentValue || undefined}
            onVirtualMcpChange={handleBindingChange}
            variant="bordered"
            placeholder="Select Agent"
            className="w-[200px] shrink-0"
          />
        </div>
      );
    }

    return (
      <div className="flex items-center gap-3 justify-between">
        <div className="flex-1 min-w-0">
          <label className="text-sm font-medium truncate block">
            {displayTitle}
          </label>
          {description && (
            <p className="text-xs text-muted-foreground truncate">
              {description}
            </p>
          )}
        </div>
        <BindingFieldWithDynamicSchema
          bindingSchema={bindingSchema}
          bindingType={bindingType}
          currentValue={currentValue}
          onValueChange={handleBindingChange}
          placeholder={t("details.mcpConfigurationForm.selectPlaceholder", {
            title: displayTitle.toLowerCase(),
          })}
          onAddNew={() => formContext?.onAddNew()}
          className="w-[200px] shrink-0"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {props.properties.map(
        (element: (typeof props.properties)[number]) => element.content,
      )}
    </div>
  );
}

function CustomFieldTemplate(props: FieldTemplateProps) {
  const { label, children, description, id, schema } = props;

  if (id.includes("__type") || id.includes("__binding")) {
    return null;
  }

  if (schema.type === "object") {
    return children;
  }

  return (
    <div className="flex items-center gap-3 justify-between">
      <div className="flex-1 min-w-0">
        {label && (
          <label className="text-sm font-medium truncate block" htmlFor={id}>
            {label}
          </label>
        )}
        {description && (
          <div className="text-xs text-muted-foreground truncate">
            {description}
          </div>
        )}
      </div>
      <div className="w-[200px] shrink-0">{children}</div>
    </div>
  );
}

const TEMPLATES = {
  ObjectFieldTemplate: CustomObjectFieldTemplate,
  FieldTemplate: CustomFieldTemplate,
};

export function McpConfigurationForm({
  formKey,
  formState,
  onFormStateChange,
  stateSchema,
}: McpConfigurationFormProps) {
  const { org } = useProjectContext();
  const navigate = useNavigate();

  const handleChange = (data: { formData?: Record<string, unknown> }) => {
    if (data.formData) {
      onFormStateChange(data.formData);
    }
  };

  const handleFieldChange = (fieldPath: string, value: unknown) => {
    const newFormState = { ...formState, [fieldPath]: value };
    onFormStateChange(newFormState);
  };

  const handleAddNew = () => {
    navigate({
      to: "/$org/settings/connections",
      params: { org: org.slug },
      search: { action: "create" },
    });
  };

  const formContext: FormContext = {
    onFieldChange: handleFieldChange,
    formData: formState,
    onAddNew: handleAddNew,
  };

  return (
    <div className="flex flex-col h-full overflow-auto">
      <RjsfForm
        key={formKey}
        schema={stateSchema}
        validator={validator}
        formData={formState}
        onChange={handleChange}
        formContext={formContext}
        liveValidate={false}
        showErrorList={false}
        templates={TEMPLATES}
      >
        {/* Hide default submit button */}
        <></>
      </RjsfForm>
    </div>
  );
}
