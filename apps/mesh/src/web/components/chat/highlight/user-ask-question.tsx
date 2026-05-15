import { Button } from "@deco/ui/components/button.tsx";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Tabs, TabsContent } from "@deco/ui/components/tabs.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { zodResolver } from "@hookform/resolvers/zod";
import { Edit02, MessageQuestionCircle } from "@untitledui/icons";
import { useEffect, useRef, useState } from "react";
import {
  type Control,
  type FieldValues,
  useController,
  useForm,
} from "react-hook-form";
import type { UserAskToolPart } from "../types";
import {
  getUserAskResponse,
  type UserAskQuestionValue,
} from "./get-user-ask-response";
import { Pagination } from "./pagination";
import { CollapsibleHighlight } from "./collapsible-highlight";
import { buildCombinedSchema } from "./user-ask-schemas";

/** Inferred from UserAskToolPart so we don't import the backend module directly. */
type UserAskInput = NonNullable<UserAskToolPart["input"]>;

// A loose shape — each question's value is one of the UserAskQuestionValue
// variants. We use a loose record type here because react-hook-form's generic
// inference doesn't play well with discriminated unions at nested paths.
type CombinedFormValues = Record<
  string,
  { response?: string; option?: string | null; draft?: string }
>;

// Shared props for all question input field components
interface FieldInputProps {
  control: Control<FieldValues>;
  name: string;
}

// ============================================================================
// TextInput - text field question (styled like the choice rows)
// ============================================================================

function TextInput({
  control,
  name,
  placeholder,
}: FieldInputProps & { placeholder?: string }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormControl>
            <div className="px-2">
              <div className="flex items-center gap-3 px-2 py-3 rounded-lg bg-accent/50">
                <span className="flex items-center justify-center size-6 rounded-md bg-muted shrink-0">
                  <Edit02 size={16} className="text-muted-foreground" />
                </span>
                <input
                  {...field}
                  type="text"
                  placeholder={placeholder || "Type your response..."}
                  autoFocus
                  aria-label="Text response input"
                  className="flex-1 text-sm bg-transparent outline-none placeholder:text-foreground/25 text-foreground min-w-0"
                />
              </div>
            </div>
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

// ============================================================================
// useNumberKeyShortcut - press 1-9 to trigger a callback by index
// ============================================================================

function useNumberKeyShortcut(
  count: number,
  onSelect: (index: number) => void,
) {
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      // Skip if any modifier key is held (allow browser shortcuts like Cmd+1)
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const num = Number.parseInt(e.key, 10);
      if (num >= 1 && num <= count) {
        e.preventDefault();
        onSelect(num - 1);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [count, onSelect]);
}

// ============================================================================
// ChoiceInput - numbered options with inline "Something else..." input
// ============================================================================

function ChoiceInput({
  control,
  name,
  options,
}: FieldInputProps & { options: string[] }) {
  const { field: optionField } = useController({
    control,
    name: `${name}.option`,
    defaultValue: null,
  });
  const { field: draftField } = useController({
    control,
    name: `${name}.draft`,
    defaultValue: "",
  });

  const optionValue = optionField.value as string | null;
  const draftValue = (draftField.value as string | undefined) ?? "";

  useNumberKeyShortcut(options.length, (index) => {
    const option = options[index];
    if (option != null) optionField.onChange(option);
  });

  if (options.length === 0) return null;

  const isCustomActive = optionValue === null;

  return (
    <FormItem>
      <FormControl>
        <div
          className="flex flex-col px-2"
          role="group"
          aria-label="Choice options"
        >
          {options.map((option, index) => {
            const isSelected = optionValue === option;
            return (
              <button
                key={`${index}-${option}`}
                type="button"
                onClick={() => optionField.onChange(option)}
                className={cn(
                  "flex items-center gap-3 px-2 py-3 rounded-lg text-left transition-colors w-full",
                  isSelected && "bg-accent/50",
                  !isSelected && "hover:bg-accent/30",
                )}
                aria-label={`Select ${option}`}
              >
                <span
                  className={cn(
                    "flex items-center justify-center size-6 rounded-md text-sm shrink-0",
                    isSelected
                      ? "bg-chart-1 text-white"
                      : "bg-muted text-foreground",
                  )}
                >
                  {index + 1}
                </span>
                <span className="text-sm text-foreground truncate">
                  {option}
                </span>
              </button>
            );
          })}

          <label
            className={cn(
              "flex items-center gap-3 px-2 py-3 rounded-lg transition-colors w-full cursor-text",
              isCustomActive && "bg-accent/50",
              !isCustomActive && "hover:bg-accent/30",
            )}
          >
            <span className="flex items-center justify-center size-6 rounded-md bg-muted shrink-0">
              <Edit02 size={16} className="text-muted-foreground" />
            </span>
            <input
              type="text"
              value={isCustomActive ? draftValue : ""}
              onChange={(e) => {
                draftField.onChange(e.target.value);
                if (optionValue !== null) optionField.onChange(null);
              }}
              onFocus={() => {
                if (optionValue !== null) optionField.onChange(null);
              }}
              placeholder="Something else..."
              aria-label="Custom choice input"
              className="flex-1 text-sm bg-transparent outline-none placeholder:text-foreground/25 text-foreground min-w-0"
            />
          </label>
        </div>
      </FormControl>
      <FormMessage />
    </FormItem>
  );
}

// ============================================================================
// ConfirmInput - yes / no buttons
// ============================================================================

function ConfirmInput({ control, name }: FieldInputProps) {
  const confirmOptions = ["yes", "no"] as const;
  const fieldRef = useRef<{ onChange: (v: string) => void } | null>(null);

  useNumberKeyShortcut(confirmOptions.length, (index) => {
    fieldRef.current?.onChange(confirmOptions[index] ?? "");
  });

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        fieldRef.current = field;

        return (
          <FormItem>
            <FormControl>
              <div
                className="flex gap-2 px-2"
                role="group"
                aria-label="Confirmation options"
              >
                {confirmOptions.map((value) => {
                  const isSelected = field.value === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => field.onChange(value)}
                      className={cn(
                        "flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors flex-1",
                        isSelected && "bg-accent/50",
                        !isSelected && "hover:bg-accent/30",
                      )}
                      aria-label={`Confirm ${value}`}
                    >
                      <span
                        className={cn(
                          "flex items-center justify-center size-6 rounded-md text-sm shrink-0",
                          isSelected
                            ? "bg-chart-1 text-white"
                            : "bg-muted text-foreground",
                        )}
                      >
                        {value === "yes" ? 1 : 2}
                      </span>
                      <span className="text-sm text-foreground capitalize">
                        {value}
                      </span>
                    </button>
                  );
                })}
              </div>
            </FormControl>
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

// ============================================================================
// QuestionInput - delegates to the correct field component by input type
// ============================================================================

interface QuestionInputProps {
  input: UserAskInput;
  control: Control<FieldValues>;
  toolCallId: string;
}

function QuestionInput({ input, control, toolCallId }: QuestionInputProps) {
  switch (input.type) {
    case "text":
      return (
        <TextInput
          control={control}
          name={`${toolCallId}.response`}
          placeholder={input.default}
        />
      );
    case "choice":
      return (
        <ChoiceInput
          control={control}
          name={toolCallId}
          options={(input.options?.filter(Boolean) ?? []) as string[]}
        />
      );
    case "confirm":
      return <ConfirmInput control={control} name={`${toolCallId}.response`} />;
    default:
      return null;
  }
}

// ============================================================================
// UserAskPrompt - unified form across all pending questions
// ============================================================================

interface UserAskPromptProps {
  parts: UserAskToolPart[];
  onSubmit: (part: UserAskToolPart, response: string) => void;
}

function UserAskPrompt({ parts, onSubmit }: UserAskPromptProps) {
  const [activeTab, setActiveTab] = useState(parts[0]?.toolCallId ?? "");

  const schema = buildCombinedSchema(
    parts.map((p) => ({
      toolCallId: p.toolCallId,
      input: p.input as UserAskInput,
    })),
  );

  const form = useForm<CombinedFormValues>({
    resolver: zodResolver(schema) as never,
    defaultValues: Object.fromEntries(
      parts.map((p) => {
        const input = p.input as UserAskInput | undefined;
        if (input?.type === "choice") {
          return [p.toolCallId, { option: null, draft: "" }];
        }
        return [p.toolCallId, { response: "" }];
      }),
    ),
  });

  const values = form.watch();
  const currentIndex = parts.findIndex((p) => p.toolCallId === activeTab);
  const currentAnswered = !!getUserAskResponse(
    values[activeTab] as UserAskQuestionValue | undefined,
  );
  const allAnswered = parts.every(
    (p) =>
      !!getUserAskResponse(
        values[p.toolCallId] as UserAskQuestionValue | undefined,
      ),
  );

  const submitAll = (data: CombinedFormValues) => {
    for (const part of parts) {
      const response = getUserAskResponse(
        data[part.toolCallId] as UserAskQuestionValue | undefined,
      );
      if (response) {
        onSubmit(part, response);
      }
    }
  };

  const findNextUnanswered = (formValues: CombinedFormValues) =>
    parts.find(
      (p) =>
        !getUserAskResponse(
          formValues[p.toolCallId] as UserAskQuestionValue | undefined,
        ) && p.toolCallId !== activeTab,
    ) ?? null;

  const advanceOrSubmit = () => {
    const latest = form.getValues();
    const everyAnswered = parts.every(
      (p) =>
        !!getUserAskResponse(
          latest[p.toolCallId] as UserAskQuestionValue | undefined,
        ),
    );
    if (everyAnswered) {
      form.handleSubmit(submitAll)();
    } else {
      const next = findNextUnanswered(latest);
      if (next) setActiveTab(next.toolCallId);
    }
  };

  const handleSkip = () => {
    const activePart = parts.find((p) => p.toolCallId === activeTab);
    const skipText = "user has skip this question";
    if (activePart?.input?.type === "choice") {
      form.setValue(`${activeTab}.option` as never, null as never);
      form.setValue(`${activeTab}.draft` as never, skipText as never);
    } else {
      form.setValue(`${activeTab}.response` as never, skipText as never);
    }
    advanceOrSubmit();
  };

  const goToPrev = () => {
    if (currentIndex > 0) {
      const prev = parts[currentIndex - 1];
      if (prev) setActiveTab(prev.toolCallId);
    }
  };

  const goToNext = () => {
    if (currentIndex < parts.length - 1) {
      const next = parts[currentIndex + 1];
      if (next) setActiveTab(next.toolCallId);
    }
  };

  const footerButtons = (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleSkip}
        className="h-7"
      >
        Skip
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={!currentAnswered}
        onClick={advanceOrSubmit}
        className={cn("h-7", !currentAnswered ? "opacity-50" : "")}
      >
        {allAnswered ? "Submit" : "Next"}
      </Button>
    </>
  );

  const pagination = (
    <Pagination
      current={currentIndex}
      total={parts.length}
      onPrev={goToPrev}
      onNext={goToNext}
    />
  );

  // Single question — no tabs needed
  if (parts.length === 1) {
    const part = parts[0];
    if (!part?.input) return null;

    return (
      <Form {...form}>
        <form onSubmit={form.handleSubmit(submitAll)} autoComplete="off">
          <CollapsibleHighlight
            icon={<MessageQuestionCircle size={14} />}
            label="Question pending"
            title={part.input?.prompt ?? "Question"}
            defaultExpanded={true}
            footerRight={footerButtons}
          >
            <QuestionInput
              input={part.input as UserAskInput}
              control={form.control}
              toolCallId={part.toolCallId}
            />
          </CollapsibleHighlight>
        </form>
      </Form>
    );
  }

  // Multiple questions — tabbed layout with unified submit
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submitAll)} autoComplete="off">
        <CollapsibleHighlight
          icon={<MessageQuestionCircle size={14} />}
          label="Question pending"
          count={`${currentIndex + 1} of ${parts.length}`}
          title={parts[currentIndex]?.input?.prompt ?? "Question"}
          defaultExpanded={true}
          footerLeft={pagination}
          footerRight={footerButtons}
        >
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            {parts.map((part) => (
              <TabsContent
                key={part.toolCallId}
                value={part.toolCallId}
                className="mt-0"
              >
                <QuestionInput
                  input={part.input as UserAskInput}
                  control={form.control}
                  toolCallId={part.toolCallId}
                />
              </TabsContent>
            ))}
          </Tabs>
        </CollapsibleHighlight>
      </form>
    </Form>
  );
}

// ============================================================================
// Loading UI for UserAskQuestion when streaming
// ============================================================================

function UserAskLoadingUI() {
  return (
    <div className="flex items-center gap-2 p-4 border border-dashed rounded-lg bg-accent/50 w-[calc(100%-16px)] max-w-[640px] mx-auto mb-2">
      <MessageQuestionCircle className="size-5 text-muted-foreground shimmer" />
      <span className="text-sm text-muted-foreground shimmer">
        Preparing question...
      </span>
    </div>
  );
}

// ============================================================================
// UserAskQuestionHighlight - wrapper for ChatHighlight
// ============================================================================

export function UserAskQuestionHighlight({
  userAskParts,
  isStreaming,
  onSubmit,
}: {
  userAskParts: UserAskToolPart[];
  isStreaming: boolean;
  onSubmit: (part: UserAskToolPart, response: string) => void;
}) {
  const pendingParts = userAskParts.filter(
    (p) => p.state === "input-available",
  );

  if (isStreaming) {
    return <UserAskLoadingUI />;
  }

  if (pendingParts.length === 0) {
    return null;
  }

  return <UserAskPrompt parts={pendingParts} onSubmit={onSubmit} />;
}
