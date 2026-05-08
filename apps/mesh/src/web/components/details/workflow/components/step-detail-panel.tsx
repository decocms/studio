import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@deco/ui/components/accordion.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { ScrollArea, ScrollBar } from "@deco/ui/components/scroll-area.tsx";
import { toast } from "@deco/ui/components/sonner.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Check, CornerDownRight, Repeat03, XClose } from "@untitledui/icons";
import {
  Box,
  Braces,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  FileText,
  Hash,
  Type,
  X,
} from "lucide-react";
import { IntegrationIcon } from "@/web/components/integration-icon";
import {
  replaceInputInterface,
  useCurrentStep,
  useSelectedVirtualMcpId,
  useTrackingExecutionId,
  useWorkflow,
  useWorkflowActions,
} from "../stores/workflow";
import { ToolInput } from "./tool-selection/components/tool-input";
import type { JsonSchema } from "@/web/utils/constants";
import { MonacoCodeEditor } from "./monaco-editor";
import type {
  CodeAction,
  Step,
  ToolCallAction,
} from "@decocms/bindings/workflow";
import {
  getDecopilotId,
  useMCPClient,
  useMCPToolsListQuery,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  useExecutionCompletedStep,
  usePollingWorkflowExecution,
} from "../hooks";
import { useStepMentions } from "../hooks/derived/use-step-mentions";
import { jsonSchemaToTypeScript } from "../typescript-to-json-schema";
import { useState } from "react";

interface StepDetailPanelProps {
  className?: string;
}

/**
 * Hook to sync step outputSchema from tool outputSchema.
 * If the step has a tool but no outputSchema, set it from the tool.
 */
function useSyncOutputSchema(step: Step | undefined) {
  const { updateStep } = useWorkflowActions();

  const isToolStep = step && "toolName" in step.action;
  const toolName =
    isToolStep && "toolName" in step.action ? step.action.toolName : null;

  const { tool } = useVirtualMCPTool(toolName ?? "");

  // Check if step has a tool but outputSchema is empty or missing
  const hasToolWithNoOutputSchema =
    step &&
    toolName &&
    tool?.outputSchema &&
    (!step.outputSchema || Object.keys(step.outputSchema).length === 0);

  // Sync on first render if needed (runs once when condition is met)
  if (hasToolWithNoOutputSchema) {
    // Use queueMicrotask to avoid updating state during render
    queueMicrotask(() => {
      updateStep(step.name, {
        outputSchema: tool.outputSchema as JsonSchema | undefined,
      });
    });
  }
}

export function StepDetailPanel({ className }: StepDetailPanelProps) {
  const currentStep = useCurrentStep();
  // Sync outputSchema from tool if step has tool but no outputSchema
  useSyncOutputSchema(currentStep);
  const trackingExecutionId = useTrackingExecutionId();
  const { item: executionItem } =
    usePollingWorkflowExecution(trackingExecutionId);

  if (!currentStep) {
    return (
      <div className={cn("flex flex-col h-full bg-sidebar", className)}>
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground gap-2 flex-col">
          Select or create a step to configure
        </div>
      </div>
    );
  }

  const currentStepName = currentStep?.name;
  const errorEntries = executionItem?.completed_steps?.error ?? [];
  const hasStepError = errorEntries.some(
    (entry) =>
      entry === currentStepName || entry.startsWith(`${currentStepName}[`),
  );
  // Also check if execution failed while this step was running
  const executionFailed =
    executionItem?.status === "error" || executionItem?.status === "failed";
  const wasRunningWhenFailed =
    executionFailed &&
    executionItem?.running_steps?.includes(currentStepName ?? "");
  const isCompleted =
    executionItem?.completed_steps?.success?.some(
      (completedStep) => completedStep.name === currentStepName,
    ) ||
    hasStepError ||
    wasRunningWhenFailed
      ? true
      : false;
  const isStepErrored = hasStepError || wasRunningWhenFailed;

  return (
    <div
      className={cn(
        "flex flex-col h-full bg-sidebar overflow-scroll",
        className,
      )}
    >
      <StepHeader step={currentStep} />
      <InputSection step={currentStep} />
      {trackingExecutionId && (
        <OutputSection
          key={`${currentStepName}-${isCompleted ? "open" : "closed"}`}
          step={currentStep}
          defaultOpen={isCompleted}
          isStepErrored={isStepErrored}
          executionError={
            isStepErrored && executionItem?.error != null
              ? typeof executionItem.error === "string"
                ? executionItem.error
                : JSON.stringify(executionItem.error)
              : undefined
          }
        />
      )}
      {!trackingExecutionId && <TransformCodeSection step={currentStep} />}
      {!trackingExecutionId && <StepCodeSection step={currentStep} />}
    </div>
  );
}

// ============================================================================
// Step Header
// ============================================================================

function StepHeader({ step }: { step: Step }) {
  const isToolStep = "toolName" in step.action;
  const toolName =
    isToolStep && "toolName" in step.action ? step.action.toolName : null;
  const trackingExecutionId = useTrackingExecutionId();

  return (
    <div className="border-b border-border p-5 shrink-0 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <IntegrationIcon
          icon={null}
          name={toolName ?? ""}
          size="xs"
          className="shadow-sm"
        />
        <span className="text-base font-medium text-foreground truncate flex-1">
          {toolName}
        </span>
        {trackingExecutionId ? null : <ReplaceToolButton />}
      </div>
      {step.description && (
        <p className="text-sm text-muted-foreground">{step.description}</p>
      )}
    </div>
  );
}

function ReplaceToolButton() {
  const currentStep = useCurrentStep();
  const { updateStep, startReplacingTool } = useWorkflowActions();
  const trackingExecutionId = useTrackingExecutionId();
  const isToolStep = currentStep && "toolName" in currentStep.action;
  const toolName = isToolStep
    ? (currentStep.action as ToolCallAction).toolName
    : null;

  const handleReplace = () => {
    if (!currentStep) return;
    if (trackingExecutionId) {
      toast.error("You cannot replace a tool while a workflow is executing.");
      return;
    }
    // Store current tool info for back button
    if (toolName) {
      startReplacingTool(toolName);
    }
    // Clear tool selection to show MCP server selector
    updateStep(currentStep.name, {
      action: {
        ...currentStep.action,
        toolName: "",
      },
    });
  };
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      onClick={handleReplace}
      title="Replace tool"
    >
      <Repeat03 size={14} />
    </Button>
  );
}

function useVirtualMCPTool(toolName: string) {
  const { org } = useProjectContext();
  const selectedId = useSelectedVirtualMcpId();
  const virtualMcpId = selectedId ?? getDecopilotId(org.id);

  const client = useMCPClient({
    connectionId: virtualMcpId,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const toolsQuery = useMCPToolsListQuery({ client });

  const tool = toolsQuery.data?.tools?.find((t) => t.name === toolName);

  return {
    tool,
    isLoading: toolsQuery.isLoading,
    isReady: toolsQuery.isSuccess,
    error: toolsQuery.error,
  };
}

// ============================================================================
// Input Section
// ============================================================================

function InputSection({ step }: { step: Step }) {
  const { updateStep } = useWorkflowActions();
  const isToolStep = "toolName" in step.action;
  const toolName =
    isToolStep && "toolName" in step.action ? step.action.toolName : null;
  const trackingExecutionId = useTrackingExecutionId();
  const { tool } = useVirtualMCPTool(toolName ?? "");
  const mentions = useStepMentions(step.name);

  // Prefer tool's inputSchema; fall back to a schema derived from step's input keys
  const stepInput = step.input as Record<string, unknown> | undefined;
  const toolSchema = tool?.inputSchema ?? null;
  const fallbackSchema =
    !toolSchema && stepInput && Object.keys(stepInput).length > 0
      ? buildSchemaFromInput(stepInput)
      : null;
  const baseSchema = toolSchema ?? fallbackSchema;

  if (!baseSchema) {
    return null;
  }

  const handleInputChange = (formData: Record<string, unknown>) => {
    updateStep(step.name, {
      input: formData,
    });
  };

  const usedSchema = trackingExecutionId
    ? filterSchemaByExecutionInput(
        baseSchema,
        step.input as Record<string, unknown>,
      )
    : baseSchema;
  return (
    <Accordion
      type="single"
      collapsible
      defaultValue={trackingExecutionId ? "output" : "input"}
      className="border-b border-border shrink-0"
    >
      <AccordionItem value="input" className="border-b-0">
        <AccordionTrigger className="px-5 py-5">
          <span className="text-sm font-medium text-muted-foreground">
            Input
          </span>
        </AccordionTrigger>
        <AccordionContent className="px-5 pt-2">
          <ToolInput
            key={step.name + trackingExecutionId}
            readOnly={!!trackingExecutionId}
            inputSchema={usedSchema as JsonSchema}
            inputParams={step.input as Record<string, unknown>}
            setInputParams={handleInputChange}
            mentions={mentions}
          />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

/**
 * Build a minimal JSON Schema from a step's existing input keys.
 * All fields are treated as strings since we don't have type info.
 */
function buildSchemaFromInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    properties[key] = { type: "string" };
  }
  return {
    type: "object",
    properties,
  };
}

function filterSchemaByExecutionInput(
  schema: object,
  executionInput: Record<string, unknown>,
) {
  const jsonSchema = structuredClone(schema) as JsonSchema;
  const properties = jsonSchema.properties as
    | Record<string, JsonSchema>
    | undefined;
  if (!properties) {
    return jsonSchema;
  }

  Object.keys(properties).forEach((key) => {
    if (!executionInput[key]) {
      delete properties[key];
    }
  });

  return jsonSchema;
}

// ============================================================================
// Output Section
// ============================================================================

function OutputSection({
  step,
  defaultOpen,
  isStepErrored,
  executionError,
}: {
  step: Step;
  defaultOpen: boolean;
  isStepErrored?: boolean;
  executionError?: string;
}) {
  const outputSchema = step.outputSchema;
  const trackingExecutionId = useTrackingExecutionId();
  const { item: executionItem } =
    usePollingWorkflowExecution(trackingExecutionId);
  const errorEntries = executionItem?.completed_steps?.error ?? [];
  const hasStepError = errorEntries.some(
    (entry) => entry === step.name || entry.startsWith(`${step.name}[`),
  );
  const executionFailed =
    executionItem?.status === "error" || executionItem?.status === "failed";
  const wasRunningWhenFailed =
    executionFailed && executionItem?.running_steps?.includes(step.name);
  const isCompleted =
    executionItem?.completed_steps?.success?.some(
      (completedStep) => completedStep.name === step.name,
    ) ||
    hasStepError ||
    wasRunningWhenFailed
      ? true
      : false;
  const [isOpen, setIsOpen] = useState(defaultOpen);

  // forEach iteration tracking
  const isForEachStep = step.forEach !== undefined;
  // "all" means show aggregated parent output, number means show that iteration
  const [selectedIteration, setSelectedIteration] = useState<"all" | number>(
    "all",
  );

  // Build iteration info for forEach steps
  const forEachRegex = isForEachStep
    ? new RegExp(`^${step.name}\\[(\\d+)\\]$`)
    : null;
  const successIterations = isForEachStep
    ? (executionItem?.completed_steps?.success ?? [])
        .filter((s) => forEachRegex!.test(s.name))
        .map((s) => {
          const match = s.name.match(forEachRegex!);
          return { index: Number(match![1]), status: "success" as const };
        })
    : [];
  const errorIterationNames = isForEachStep
    ? errorEntries.filter((entry) => forEachRegex!.test(entry))
    : [];
  const errorIterations = errorIterationNames.map((entry) => {
    const match = entry.match(forEachRegex!);
    return { index: Number(match![1]), status: "error" as const };
  });
  const allIterations = [...successIterations, ...errorIterations].sort(
    (a, b) => a.index - b.index,
  );
  const hasIterations = allIterations.length > 0;

  // Determine which stepId to fetch
  const iterationStepId =
    isForEachStep && selectedIteration !== "all"
      ? `${step.name}[${selectedIteration}]`
      : undefined;
  const parentStepId = isCompleted ? step.name : undefined;
  const fetchStepId = iterationStepId ?? parentStepId;

  const { output, error } = useExecutionCompletedStep(
    trackingExecutionId,
    fetchStepId,
  );
  const content = output
    ? output
    : error
      ? { error: error }
      : isStepErrored && executionError
        ? { error: executionError }
        : undefined;

  // Always show the Output section (even if empty)
  const properties =
    outputSchema && typeof outputSchema === "object"
      ? ((outputSchema as Record<string, unknown>).properties as
          | Record<string, unknown>
          | undefined)
      : undefined;

  const propertyEntries = properties ? Object.entries(properties) : [];

  // Determine if the selected iteration has an error
  const selectedIterationHasError =
    selectedIteration !== "all" &&
    errorIterations.some((it) => it.index === selectedIteration);
  const showError =
    selectedIteration === "all"
      ? isStepErrored || hasStepError || wasRunningWhenFailed
      : selectedIterationHasError;

  return (
    <div
      className={cn(
        "flex flex-col border-b border-border",
        isOpen ? "flex-1 min-h-0 overflow-hidden" : "shrink-0",
      )}
    >
      <div
        className="p-5 shrink-0 cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center justify-between">
          <h3
            className={cn(
              "text-sm font-medium",
              showError ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {showError ? "Error" : "Output"}
          </h3>
          {isOpen ? (
            <ChevronUp size={14} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={14} className="text-muted-foreground" />
          )}
        </div>
      </div>
      {isOpen && (
        <>
          {/* forEach iteration picker */}
          {trackingExecutionId && isForEachStep && hasIterations && (
            <ForEachIterationPicker
              iterations={allIterations}
              selectedIteration={selectedIteration}
              onSelect={setSelectedIteration}
            />
          )}
          {trackingExecutionId && content ? (
            <div className="flex-1 min-h-0">
              <MonacoCodeEditor
                key={`output-${step.name}-${selectedIteration}`}
                code={JSON.stringify(content, null, 2)}
                language="json"
                height="100%"
                readOnly
              />
            </div>
          ) : null}
          {!trackingExecutionId && propertyEntries.length > 0 && (
            <div className="flex-1 min-h-0 overflow-auto px-5">
              {propertyEntries.map(([key, propSchema]) => (
                <OutputProperty
                  key={key}
                  name={key}
                  schema={propSchema as JsonSchema}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================================
// ForEach Iteration Picker
// ============================================================================

function ForEachIterationPicker({
  iterations,
  selectedIteration,
  onSelect,
}: {
  iterations: { index: number; status: "success" | "error" }[];
  selectedIteration: "all" | number;
  onSelect: (iteration: "all" | number) => void;
}) {
  return (
    <div className="px-5 pb-3 shrink-0 border-b border-border/50">
      <ScrollArea className="w-full whitespace-nowrap">
        <div className="flex w-max items-center gap-2 pb-3">
          <button
            type="button"
            className={cn(
              "h-7 px-3 text-xs font-medium rounded-lg border transition-colors inline-flex gap-1.5 items-center",
              selectedIteration === "all"
                ? "bg-accent border-border text-foreground"
                : "bg-transparent border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
            onClick={() => onSelect("all")}
          >
            All Results
          </button>

          <div className="w-px h-4 bg-border mx-1" />

          {iterations.map((it) => {
            const isActive = selectedIteration === it.index;
            return (
              <button
                key={it.index}
                type="button"
                className={cn(
                  "h-7 px-2.5 text-xs font-medium rounded-lg border transition-colors inline-flex gap-1.5 items-center",
                  isActive
                    ? "bg-accent border-border text-foreground"
                    : "bg-transparent border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
                onClick={() => onSelect(it.index)}
              >
                {it.status === "success" ? (
                  <Check size={12} className="text-success" />
                ) : (
                  <XClose size={12} className="text-destructive" />
                )}
                <span className="font-mono">#{it.index}</span>
              </button>
            );
          })}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}

function getTypeIcon(type: string) {
  switch (type) {
    case "string":
      return { Icon: Type, color: "text-blue-500" };
    case "number":
    case "integer":
      return { Icon: Hash, color: "text-blue-500" };
    case "array":
      return { Icon: Braces, color: "text-purple-500" };
    case "object":
      return { Icon: Box, color: "text-orange-500" };
    case "boolean":
      return { Icon: CheckSquare, color: "text-pink-500" };
    case "null":
      return { Icon: X, color: "text-gray-500" };
    default:
      return { Icon: FileText, color: "text-muted-foreground" };
  }
}

function OutputProperty({
  name,
  schema,
}: {
  name: string;
  schema: JsonSchema;
}) {
  const currentStep = useCurrentStep();
  const type = schema.type ?? "unknown";
  const { Icon, color } = getTypeIcon(type);

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 flex items-center gap-2">
        <Icon size={14} className={cn(color)} />
        <span className="text-sm font-medium text-foreground">{name}</span>
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <CornerDownRight size={14} className="opacity-50" />
        <span className="text-muted-foreground">{currentStep?.name}.</span>
        <div className="bg-blue-500/10 text-blue-500 px-1 py-0.5 rounded">
          {name}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Transform Code Section
// ============================================================================

function TransformCodeSection({ step }: { step: Step }) {
  const { updateStep } = useWorkflowActions();
  const trackingExecutionId = useTrackingExecutionId();
  const [isOpen, setIsOpen] = useState(false);

  const isToolStep = "toolName" in step.action;
  const toolName =
    isToolStep && "toolName" in step.action ? step.action.toolName : null;

  const { tool } = useVirtualMCPTool(toolName ?? "");

  const transformCode =
    isToolStep && "transformCode" in step.action
      ? (step.action.transformCode ?? null)
      : null;

  // Generate Input interface from tool's output schema
  const generateInputInterface = (): string => {
    if (!tool?.outputSchema) {
      return "interface Input {\n  // Tool output schema not available\n}";
    }

    const schema = tool.outputSchema as JsonSchema;
    const properties = schema.properties as
      | Record<string, JsonSchema>
      | undefined;

    if (!properties) {
      return "interface Input {\n  [key: string]: unknown;\n}";
    }

    const fields = Object.entries(properties)
      .map(([key, prop]) => {
        const type = jsonSchemaTypeToTS(prop);
        const optional = !(schema.required as string[] | undefined)?.includes(
          key,
        );
        return `  ${key}${optional ? "?" : ""}: ${type};`;
      })
      .join("\n");

    return `interface Input {\n${fields}\n}`;
  };

  const toggleTransformCodeEditor = () => {
    if ("transformCode" in step.action && step.action.transformCode) {
      setIsOpen((prev) => !prev);
      return;
    }
    const inputInterface = generateInputInterface();
    const defaultCode = `${inputInterface}

interface Output {
  // Define your output type here
  result: unknown;
}

export default async function(stepInput: Input): Promise<Output> {
  // Transform the tool output
  return {
    result: stepInput,
  };
}`;

    updateStep(step.name, {
      action: {
        ...step.action,
        transformCode: defaultCode,
      },
    });
    setIsOpen((prev) => !prev);
  };

  const handleCodeSave = (
    code: string,
    outputSchema: Record<string, unknown> | null,
  ) => {
    // Update both the transform code and the output schema
    updateStep(step.name, {
      action: {
        ...step.action,
        transformCode: code,
      },
      // If we extracted an output schema from the TypeScript, use it
      ...(outputSchema ? { outputSchema } : {}),
    });
  };

  if ("code" in step.action && step.action.code) {
    return null;
  }

  // Has transform code → show editor with Minus to remove
  return (
    <div
      className={cn(
        "flex flex-col flex-1 min-h-0 overflow-hidden border-b border-border",
        isOpen ? "flex-1 min-h-0 overflow-hidden" : "shrink-0",
      )}
    >
      <div
        className="p-5 shrink-0 cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={toggleTransformCodeEditor}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">
            Transform Code
          </h3>
          {isOpen ? (
            <ChevronUp size={14} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={14} className="text-muted-foreground" />
          )}
        </div>
      </div>
      {isOpen && (
        <div className="flex-1 min-h-0">
          <MonacoCodeEditor
            key={`transform-code-${step.name}-${trackingExecutionId}`}
            code={transformCode!}
            language="typescript"
            readOnly={trackingExecutionId !== undefined}
            onSave={handleCodeSave}
            height="100%"
          />
        </div>
      )}
    </div>
  );
}

function StepCodeSection({ step }: { step: Step }) {
  const [isOpen, setIsOpen] = useState(false);
  const { updateStep } = useWorkflowActions();
  const workflow = useWorkflow();
  const code =
    "code" in step.action && step.action.code ? step.action.code : null;
  const trackingExecutionId = useTrackingExecutionId();

  if (!code) {
    return null;
  }

  const handleCodeSave = (
    code: string,
    outputSchema: Record<string, unknown> | null,
  ) => {
    updateStep(step.name, {
      action: {
        ...step.action,
        code: code,
      },
      ...(outputSchema ? { outputSchema } : {}),
    });
  };

  // Collect available variables: workflow input + all preceding steps
  const availableVars: {
    name: string;
    label: string;
    schema: Record<string, unknown> | undefined;
  }[] = [];

  const inputSchema = workflow.input_schema as JsonSchema | undefined;
  if (inputSchema) {
    availableVars.push({
      name: "input",
      label: "Workflow Input",
      schema: inputSchema as Record<string, unknown>,
    });
  }

  for (const s of workflow.steps) {
    if (s.name === step.name) break;
    availableVars.push({
      name: s.name,
      label: s.name,
      schema: s.outputSchema as Record<string, unknown> | undefined,
    });
  }

  // Current step input refs (e.g. { Step_1: "@Step_1", input: "@input" })
  const currentInput = (step.input ?? {}) as Record<string, string>;
  const selectedVars = new Set(
    Object.entries(currentInput)
      .filter(([, v]) => typeof v === "string" && v.startsWith("@"))
      .map(([, v]) => v.slice(1)), // strip leading @
  );

  const toggleVar = (varName: string) => {
    const newInput = { ...currentInput };
    if (selectedVars.has(varName)) {
      // Remove this reference
      const keyToRemove = Object.entries(newInput).find(
        ([, v]) => v === `@${varName}`,
      )?.[0];
      if (keyToRemove) delete newInput[keyToRemove];
    } else {
      newInput[varName] = `@${varName}`;
    }

    // Rebuild Input interface from selected variables' schemas
    const combinedProperties: Record<string, unknown> = {};
    for (const [key, ref] of Object.entries(newInput)) {
      if (typeof ref !== "string" || !ref.startsWith("@")) continue;
      const refName = ref.slice(1);
      const varDef = availableVars.find((v) => v.name === refName);
      if (varDef?.schema) {
        combinedProperties[key] = varDef.schema;
      }
    }

    const combinedSchema =
      Object.keys(combinedProperties).length > 0
        ? {
            type: "object",
            properties: combinedProperties,
            required: Object.keys(combinedProperties),
          }
        : null;

    const inputInterface = combinedSchema
      ? jsonSchemaToTypeScript(combinedSchema, "Input")
      : "interface Input {}";

    const codeAction = step.action as CodeAction;
    const updatedCode = replaceInputInterface(codeAction.code, inputInterface);

    updateStep(step.name, {
      input: newInput,
      action: { ...step.action, code: updatedCode },
    });
  };

  return (
    <div
      className={cn(
        "flex flex-col border-b border-border",
        isOpen ? "flex-1 min-h-0 overflow-hidden" : "shrink-0",
      )}
    >
      <div
        className="p-5 shrink-0 cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">
            Step Code
          </h3>
          {isOpen ? (
            <ChevronUp size={14} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={14} className="text-muted-foreground" />
          )}
        </div>
      </div>
      {isOpen && (
        <>
          {/* Variable picker */}
          {!trackingExecutionId && availableVars.length > 0 && (
            <div className="px-5 pb-3 shrink-0 border-b border-border/50">
              <p className="text-xs text-muted-foreground mb-2">
                Select variables available to your code as{" "}
                <code className="text-[11px] bg-accent px-1 py-0.5 rounded">
                  input
                </code>
                :
              </p>
              <div className="flex flex-wrap gap-1.5">
                {availableVars.map((v) => {
                  const isSelected = selectedVars.has(v.name);
                  return (
                    <button
                      key={v.name}
                      type="button"
                      className={cn(
                        "h-7 px-2.5 text-xs font-medium rounded-lg border transition-colors inline-flex items-center gap-1.5",
                        isSelected
                          ? "bg-accent border-border text-foreground"
                          : "bg-transparent border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                      onClick={() => toggleVar(v.name)}
                    >
                      {isSelected && (
                        <Check size={12} className="text-success" />
                      )}
                      <span className="font-mono">@{v.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="flex-1 min-h-0">
            <MonacoCodeEditor
              onSave={(code, outputSchema) =>
                handleCodeSave(code, outputSchema)
              }
              key={`step-code-${step.name}-${trackingExecutionId}`}
              code={code}
              language="typescript"
              height="100%"
              readOnly={trackingExecutionId !== undefined}
            />
          </div>
        </>
      )}
    </div>
  );
}

// Helper function to convert JSON Schema types to TypeScript types
function jsonSchemaTypeToTS(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) {
    return schema.type
      .map((t) => jsonSchemaTypeToTS({ ...schema, type: t }))
      .join(" | ");
  }

  const type = schema.type as string | undefined;

  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      if (schema.items) {
        const itemType = jsonSchemaTypeToTS(schema.items as JsonSchema);
        return `${itemType}[]`;
      }
      return "unknown[]";
    case "object":
      if (schema.properties) {
        const props = Object.entries(
          schema.properties as Record<string, JsonSchema>,
        )
          .map(([key, prop]) => {
            const propType = jsonSchemaTypeToTS(prop);
            const optional = !(
              schema.required as string[] | undefined
            )?.includes(key);
            return `${key}${optional ? "?" : ""}: ${propType}`;
          })
          .join("; ");
        return `{ ${props} }`;
      }
      return "Record<string, unknown>";
    case "null":
      return "null";
    default:
      return "unknown";
  }
}
