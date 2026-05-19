import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { type FieldValues, type UseFormReturn, useForm } from "react-hook-form";
import type { ZodTypeAny } from "zod";
import {
  canSubmit as computeCanSubmit,
  findIndexByKey,
  findNextUnansweredKey,
  isAllAnswered,
} from "./multipart-decision-form-helpers";

export interface UseMultiPartDecisionFormOptions<
  TPart,
  TValues extends FieldValues,
> {
  parts: TPart[];
  partKey: (p: TPart) => string;
  schema: ZodTypeAny;
  defaultValues: TValues;
  isStreaming: boolean;
  hasAnswer: (value: unknown) => boolean;
  onSubmit: (part: TPart, value: unknown) => void;
}

export interface MultiPartDecisionForm<TPart, TValues extends FieldValues> {
  form: UseFormReturn<TValues>;
  activeKey: string;
  setActiveKey: (k: string) => void;
  currentIndex: number;
  currentPart: TPart | undefined;
  isCurrentAnswered: boolean;
  isAllAnswered: boolean;
  canSubmit: boolean;
  goPrev: () => void;
  goNext: () => void;
  advanceToNextUnanswered: () => void;
  submit: () => void;
  /**
   * Auto-action for per-item button decisions: if every item is now
   * answered, flush the per-part `onSubmit` loop immediately; otherwise
   * advance to the next unanswered item. Bypasses the `!isStreaming`
   * gate in `canSubmit` — the data-layer deferred-POST check is the
   * actual safety net for in-flight runs.
   */
  submitOrAdvance: () => void;
}

/**
 * Generic hook for multi-part decision prompts (approvals, user_asks).
 * Per-item decisions buffer in react-hook-form state; `submit()` only
 * flushes to `onSubmit` when `canSubmit` (no streaming + all answered).
 */
export function useMultiPartDecisionForm<TPart, TValues extends FieldValues>(
  opts: UseMultiPartDecisionFormOptions<TPart, TValues>,
): MultiPartDecisionForm<TPart, TValues> {
  const {
    parts,
    partKey,
    schema,
    defaultValues,
    isStreaming,
    hasAnswer,
    onSubmit,
  } = opts;

  const initialKey = parts[0] ? partKey(parts[0]) : "";
  const [activeKey, setActiveKey] = useState(initialKey);

  const form = useForm<TValues>({
    resolver: zodResolver(schema as never) as never,
    defaultValues: defaultValues as never,
  });

  const values = form.watch() as Record<string, unknown>;
  const currentIndex = findIndexByKey(parts, partKey, activeKey);
  const currentPart = currentIndex >= 0 ? parts[currentIndex] : undefined;
  const isCurrentAnswered = hasAnswer(values[activeKey]);
  const allAnswered = isAllAnswered(parts, partKey, values, hasAnswer);
  const canSubmit = computeCanSubmit({ isStreaming, allAnswered });

  const goPrev = () => {
    if (currentIndex > 0) {
      const prev = parts[currentIndex - 1];
      if (prev) setActiveKey(partKey(prev));
    }
  };

  const goNext = () => {
    if (currentIndex >= 0 && currentIndex < parts.length - 1) {
      const next = parts[currentIndex + 1];
      if (next) setActiveKey(partKey(next));
    }
  };

  const advanceToNextUnanswered = () => {
    const latest = form.getValues() as Record<string, unknown>;
    const nextKey = findNextUnansweredKey(
      parts,
      partKey,
      latest,
      hasAnswer,
      activeKey,
    );
    if (nextKey) setActiveKey(nextKey);
  };

  const flush = () => {
    void form.handleSubmit((data) => {
      const map = data as Record<string, unknown>;
      for (const part of parts) {
        onSubmit(part, map[partKey(part)]);
      }
    })();
  };

  const submit = () => {
    if (!canSubmit) return;
    flush();
  };

  const submitOrAdvance = () => {
    const latest = form.getValues() as Record<string, unknown>;
    if (isAllAnswered(parts, partKey, latest, hasAnswer)) {
      flush();
    } else {
      const nextKey = findNextUnansweredKey(
        parts,
        partKey,
        latest,
        hasAnswer,
        activeKey,
      );
      if (nextKey) setActiveKey(nextKey);
    }
  };

  return {
    form,
    activeKey,
    setActiveKey,
    currentIndex,
    currentPart,
    isCurrentAnswered,
    isAllAnswered: allAnswered,
    canSubmit,
    goPrev,
    goNext,
    advanceToNextUnanswered,
    submit,
    submitOrAdvance,
  };
}
