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
import {
  ArrowLeft,
  ArrowRight,
  Edit02,
  MessageQuestionCircle,
} from "@untitledui/icons";
import { useEffect, useRef, useState } from "react";
import { type Control, type FieldValues, useForm } from "react-hook-form";
import type { UserAskToolPart } from "../types";
import { buildCombinedSchema } from "./user-ask-schemas";

/** Inferred from UserAskToolPart so we don't import the backend module directly. */
type UserAskInput = NonNullable<UserAskToolPart["input"]>;

// Type for the combined form values: { [toolCallId]: { response: string } }
type CombinedFormValues = Record<string, { response: string }>;

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
  const [isCustom, setIsCustom] = useState(false);
  const customInputRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<{ onChange: (v: string) => void } | null>(null);

  useNumberKeyShortcut(options.length, (index) => {
    fieldRef.current?.onChange(options[index] ?? "");
    setIsCustom(false);
  });

  if (options.length === 0) return null;

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        fieldRef.current = field;
        const isCustomValue =
          isCustom || (!!field.value && !options.includes(field.value));

        return (
          <FormItem>
            <FormControl>
              <div
                className="flex flex-col px-2"
                role="group"
                aria-label="Choice options"
              >
                {options.map((option, index) => {
                  const isSelected = field.value === option;
                  return (
                    <button
                      key={`${index}-${option}`}
                      type="button"
                      onClick={() => {
                        field.onChange(option ?? "");
                        setIsCustom(false);
                      }}
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

                {/* "Something else..." — this IS the input */}
                <div
                  className={cn(
                    "flex items-center gap-3 px-2 py-3 rounded-lg transition-colors w-full cursor-text",
                    isCustomValue && "bg-accent/50",
                    !isCustomValue && "hover:bg-accent/30",
                  )}
                  onClick={() => {
                    setIsCustom(true);
                    // Clear value if it was a predefined option
                    if (options.includes(field.value)) {
                      field.onChange("");
                    }
                    // Focus the hidden input
                    setTimeout(() => customInputRef.current?.focus(), 0);
                  }}
                >
                  <span className="flex items-center justify-center size-6 rounded-md bg-muted shrink-0">
                    <Edit02 size={16} className="text-muted-foreground" />
                  </span>
                  {isCustomValue ? (
                    <input
                      ref={customInputRef}
                      type="text"
                      value={field.value}
                      onChange={(e) => field.onChange(e.target.value)}
                      placeholder="Something else..."
                      autoFocus
                      aria-label="Custom choice input"
                      className="flex-1 text-sm bg-transparent outline-none placeholder:text-foreground/25 text-foreground min-w-0"
                    />
                  ) : (
                    <span className="text-sm text-foreground/25">
                      Something else...
                    </span>
                  )}
                </div>
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
  name: string;
}

function QuestionInput({ input, control, name }: QuestionInputProps) {
  switch (input.type) {
    case "text":
      return (
        <TextInput control={control} name={name} placeholder={input.default} />
      );
    case "choice":
      return (
        <ChoiceInput
          control={control}
          name={name}
          options={(input.options?.filter(Boolean) ?? []) as string[]}
        />
      );
    case "confirm":
      return <ConfirmInput control={control} name={name} />;
    default:
      return null;
  }
}

// ============================================================================
// Pagination - "← 1 of 4 →" control
// ============================================================================

interface PaginationProps {
  current: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

function Pagination({ current, total, onPrev, onNext }: PaginationProps) {
  if (total <= 1) return null;
  return (
    <div className="flex items-center gap-1 text-sm text-muted-foreground">
      <button
        type="button"
        onClick={onPrev}
        disabled={current === 0}
        className={cn(
          "p-0.5 rounded transition-colors",
          current === 0
            ? "opacity-30 cursor-not-allowed"
            : "hover:text-foreground cursor-pointer",
        )}
        aria-label="Previous question"
      >
        <ArrowLeft size={14} />
      </button>
      <span className="tabular-nums text-xs">
        {current + 1} of {total}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={current === total - 1}
        className={cn(
          "p-0.5 rounded transition-colors",
          current === total - 1
            ? "opacity-30 cursor-not-allowed"
            : "hover:text-foreground cursor-pointer",
        )}
        aria-label="Next question"
      >
        <ArrowRight size={14} />
      </button>
    </div>
  );
}

// ============================================================================
// UserAskCard - the card chrome wrapping question content
// ============================================================================

interface UserAskCardProps {
  title: string;
  children: React.ReactNode;
  footerLeft?: React.ReactNode;
  footerRight: React.ReactNode;
}

function UserAskCard({
  title,
  children,
  footerLeft,
  footerRight,
}: UserAskCardProps) {
  return (
    <div className="flex flex-col rounded-xl bg-background border border-border shadow-md w-[calc(100%-16px)] max-w-[584px] mx-auto mb-[-16px]">
      {/* Header */}
      <div className="flex items-center gap-2 p-4">
        <p className="flex-1 text-base font-medium text-foreground min-w-0">
          {title}
        </p>
      </div>

      {/* Options / Content */}
      <div className="overflow-clip pb-4">{children}</div>

      {/* Footer with border-t */}
      <div className="border-t border-border px-3 py-3 pb-6">
        <div className="flex items-center justify-between">
          <div>{footerLeft}</div>
          <div className="flex items-center gap-2">{footerRight}</div>
        </div>
      </div>
    </div>
  );
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
      parts.map((p) => [p.toolCallId, { response: "" }]),
    ),
  });

  const values = form.watch();
  const currentIndex = parts.findIndex((p) => p.toolCallId === activeTab);
  const currentAnswered = !!values[activeTab]?.response;
  const allAnswered = parts.every((p) => !!values[p.toolCallId]?.response);

  const submitAll = (data: CombinedFormValues) => {
    for (const part of parts) {
      const response = data[part.toolCallId]?.response;
      if (response) {
        onSubmit(part, response);
      }
    }
  };

  /** Find the first unanswered part (excluding current), or null if all filled. */
  const findNextUnanswered = (formValues: CombinedFormValues) =>
    parts.find(
      (p) => !formValues[p.toolCallId]?.response && p.toolCallId !== activeTab,
    ) ?? null;

  /**
   * Shared logic for both Skip and the primary button:
   * if all questions are answered → submit the form, otherwise go to next unanswered tab.
   */
  const advanceOrSubmit = () => {
    const latest = form.getValues();
    const everyAnswered = parts.every((p) => !!latest[p.toolCallId]?.response);
    if (everyAnswered) {
      form.handleSubmit(submitAll)();
    } else {
      const next = findNextUnanswered(latest);
      if (next) setActiveTab(next.toolCallId);
    }
  };

  const handleSkip = () => {
    // Fill the current question with the skip sentence
    form.setValue(`${activeTab}.response`, "user has skip this question");
    // Then advance or submit
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
          <UserAskCard
            title={part.input?.prompt ?? "Question"}
            footerRight={footerButtons}
          >
            <QuestionInput
              input={part.input as UserAskInput}
              control={form.control}
              name={`${part.toolCallId}.response`}
            />
          </UserAskCard>
        </form>
      </Form>
    );
  }

  // Multiple questions — tabbed layout with unified submit
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submitAll)} autoComplete="off">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          {parts.map((part) => (
            <TabsContent
              key={part.toolCallId}
              value={part.toolCallId}
              className="mt-0"
            >
              <UserAskCard
                title={part.input?.prompt ?? "Question"}
                footerLeft={pagination}
                footerRight={footerButtons}
              >
                <QuestionInput
                  input={part.input as UserAskInput}
                  control={form.control}
                  name={`${part.toolCallId}.response`}
                />
              </UserAskCard>
            </TabsContent>
          ))}
        </Tabs>
      </form>
    </Form>
  );
}

// ============================================================================
// Loading UI for UserAskQuestion when streaming
// ============================================================================

function UserAskLoadingUI() {
  return (
    <div className="flex items-center gap-2 p-4 border border-dashed rounded-lg bg-accent/50 w-[calc(100%-16px)] max-w-[584px] mx-auto mb-2">
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
