import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
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
   * answered, flush the per-part `onSubmit` loop; otherwise advance to
   * the next unanswered item. While the assistant is still streaming
   * the flush is deferred — once `isStreaming` flips to false (and the
   * form is still fully answered) the flush fires automatically.
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
  const [pendingFlush, setPendingFlush] = useState(false);

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
    setPendingFlush(false);
    flush();
  };

  const submitOrAdvance = () => {
    const latest = form.getValues() as Record<string, unknown>;
    if (isAllAnswered(parts, partKey, latest, hasAnswer)) {
      if (isStreaming) {
        // Stream still in flight — record the intent; the effect below
        // fires the flush once `isStreaming` flips to false.
        setPendingFlush(true);
        return;
      }
      setPendingFlush(false);
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

  // Auto-flush deferred submissions when the stream finishes. The
  // streaming-finished transition is an external event, so this is a
  // legitimate effect. `flush` is in deps so the latest closure (with
  // current `parts` / `onSubmit`) fires when `isStreaming` flips false;
  // `pendingFlush` gates one-shot semantics so spurious re-runs from
  // `flush` identity changes short-circuit at the first guard.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- streaming-finished is an external event
  useEffect(() => {
    if (!pendingFlush) return;
    if (isStreaming) return;
    if (!allAnswered) {
      setPendingFlush(false);
      return;
    }
    setPendingFlush(false);
    flush();
  }, [pendingFlush, isStreaming, allAnswered, flush]);

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
