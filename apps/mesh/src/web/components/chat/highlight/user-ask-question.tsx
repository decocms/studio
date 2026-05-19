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
import { Edit02, MessageQuestionCircle } from "@untitledui/icons";
import { useEffect, useRef } from "react";
import { type Control, type FieldValues, useController } from "react-hook-form";
import type { UserAskToolPart } from "../types";
import { CollapsibleHighlight } from "./collapsible-highlight";
import {
  PaginatedFormFooterLeft,
  PaginatedFormSubmitButton,
} from "./common/paginated-form-footer";
import { useMultiPartDecisionForm } from "./common/use-multipart-decision-form";
import {
  getUserAskResponse,
  type UserAskQuestionValue,
} from "./get-user-ask-response";
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
  isStreaming: boolean;
  onSubmit: (part: UserAskToolPart, response: string) => void;
}

function UserAskPrompt({ parts, isStreaming, onSubmit }: UserAskPromptProps) {
  const schema = buildCombinedSchema(
    parts.map((p) => ({
      toolCallId: p.toolCallId,
      input: p.input as UserAskInput,
    })),
  );

  const defaultValues: CombinedFormValues = Object.fromEntries(
    parts.map((p) => {
      const input = p.input as UserAskInput | undefined;
      if (input?.type === "choice") {
        return [p.toolCallId, { option: null, draft: "" }];
      }
      return [p.toolCallId, { response: "" }];
    }),
  );

  const decisionForm = useMultiPartDecisionForm<
    UserAskToolPart,
    CombinedFormValues
  >({
    parts,
    partKey: (p) => p.toolCallId,
    schema,
    defaultValues,
    isStreaming,
    hasAnswer: (value) =>
      !!getUserAskResponse(value as UserAskQuestionValue | undefined),
    onSubmit: (part, value) => {
      const response = getUserAskResponse(
        value as UserAskQuestionValue | undefined,
      );
      if (response) onSubmit(part, response);
    },
  });

  const current = decisionForm.currentPart;

  const handleSkip = () => {
    const activePart = current;
    if (!activePart) return;
    const skipText = "user has skip this question";
    const key = activePart.toolCallId;
    if (activePart.input?.type === "choice") {
      decisionForm.form.setValue(`${key}.option` as never, null as never);
      decisionForm.form.setValue(`${key}.draft` as never, skipText as never);
    } else {
      decisionForm.form.setValue(`${key}.response` as never, skipText as never);
    }
    decisionForm.advanceToNextUnanswered();
  };

  const footerLeft = (
    <PaginatedFormFooterLeft
      currentIndex={decisionForm.currentIndex}
      total={parts.length}
      onPrev={decisionForm.goPrev}
      onNext={decisionForm.goNext}
    />
  );

  const footerRight = (
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
      <PaginatedFormSubmitButton
        isStreaming={isStreaming}
        isAllAnswered={decisionForm.isAllAnswered}
        isCurrentAnswered={decisionForm.isCurrentAnswered}
        onAdvanceOrSubmit={decisionForm.submitOrAdvance}
      />
    </>
  );

  // Single question — no Tabs needed
  if (parts.length === 1) {
    const part = parts[0];
    if (!part?.input) return null;
    return (
      <Form {...decisionForm.form}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            decisionForm.submit();
          }}
          autoComplete="off"
        >
          <CollapsibleHighlight
            icon={<MessageQuestionCircle size={14} />}
            label="Question pending"
            title={part.input?.prompt ?? "Question"}
            defaultExpanded={true}
            footerRight={footerRight}
          >
            <QuestionInput
              input={part.input as UserAskInput}
              control={decisionForm.form.control}
              toolCallId={part.toolCallId}
            />
          </CollapsibleHighlight>
        </form>
      </Form>
    );
  }

  // Multiple questions — Tabs + shared footer
  return (
    <Form {...decisionForm.form}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          decisionForm.submit();
        }}
        autoComplete="off"
      >
        <CollapsibleHighlight
          icon={<MessageQuestionCircle size={14} />}
          label="Question pending"
          count={`${decisionForm.currentIndex + 1} of ${parts.length}`}
          title={current?.input?.prompt ?? "Question"}
          defaultExpanded={true}
          footerLeft={footerLeft}
          footerRight={footerRight}
        >
          <Tabs
            value={decisionForm.activeKey}
            onValueChange={decisionForm.setActiveKey}
          >
            {parts.map((part) => (
              <TabsContent
                key={part.toolCallId}
                value={part.toolCallId}
                className="mt-0"
              >
                <QuestionInput
                  input={part.input as UserAskInput}
                  control={decisionForm.form.control}
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

  if (pendingParts.length === 0) {
    if (isStreaming) return <UserAskLoadingUI />;
    return null;
  }

  return (
    <UserAskPrompt
      parts={pendingParts}
      isStreaming={isStreaming}
      onSubmit={onSubmit}
    />
  );
}
