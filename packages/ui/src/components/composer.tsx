import type * as React from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  File02,
  StopSquare,
  Upload01,
  X,
} from "@untitledui/icons";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";

/** Where you talk to the agent; `compact` is one line, for side panels and threads. */
const composerVariants = cva(
  "group/composer bg-card text-card-foreground relative z-10 flex w-full rounded-2xl shadow-[inset_0_0_0_1px_var(--hairline),0_4px_16px_0_#0000000d] transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--input),0_6px_20px_0_#00000014]",
  {
    variants: {
      size: {
        full: "min-h-30 flex-col",
        compact: "items-center gap-1 py-1.5 pr-1.5 pl-1",
      },
    },
    defaultVariants: { size: "full" },
  },
);

function Composer({
  className,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof composerVariants>) {
  return (
    <div
      data-slot="composer"
      data-size={size ?? "full"}
      className={cn(composerVariants({ size }), className)}
      {...props}
    />
  );
}

function ComposerInput({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="composer-input"
      rows={1}
      className={cn(
        "placeholder:text-subtle-foreground field-sizing-content max-h-60 min-w-0 flex-1 resize-none bg-transparent px-4 pt-3.5 pb-1 text-sm leading-relaxed outline-none disabled:cursor-not-allowed group-data-[size=compact]/composer:px-2 group-data-[size=compact]/composer:py-1",
        className,
      )}
      {...props}
    />
  );
}

/** Files and images waiting to be sent, above the text. */
function ComposerAttachments({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-attachments"
      className={cn("flex flex-wrap gap-2 px-3 pt-3", className)}
      {...props}
    />
  );
}

function ComposerAttachment({
  name,
  meta,
  src,
  onRemove,
  removeLabel,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  name: string;
  /** Size or type, e.g. "PDF · 2.4 MB". */
  meta?: string;
  /** An image preview; without it the attachment shows as a file. */
  src?: string;
  onRemove?: () => void;
  /** Accessible name of the remove button, translated by the caller. */
  removeLabel?: string;
}) {
  return (
    <div
      data-slot="composer-attachment"
      className={cn("group/attachment relative", className)}
      {...props}
    >
      {src ? (
        <img
          src={src}
          alt={name}
          className="size-11 rounded-[0.625rem] object-cover outline-1 -outline-offset-1 outline-hairline"
        />
      ) : (
        <div className="surface-inset flex h-11 max-w-56 items-center gap-2 rounded-[0.625rem] py-1.5 pr-3 pl-1.5">
          <span className="bg-card text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg shadow-edge">
            <File02 className="size-4 stroke-[1.33]" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-xs font-medium">{name}</span>
            {meta && (
              <span className="text-subtle-foreground truncate text-[0.6875rem]">
                {meta}
              </span>
            )}
          </span>
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="bg-foreground text-background focus-ring absolute -top-1.5 -right-1.5 flex size-[1.125rem] items-center justify-center rounded-full opacity-0 transition-opacity group-hover/attachment:opacity-100 focus-visible:opacity-100"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

/** The bottom row. Put a `ComposerGroup` on each side. */
function ComposerToolbar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-toolbar"
      className={cn(
        "flex items-center justify-between gap-2 p-2 group-data-[size=compact]/composer:p-0 [&_svg]:stroke-[1.33] [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function ComposerGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-group"
      className={cn("flex min-w-0 items-center gap-1", className)}
      {...props}
    />
  );
}

const modeVariants = cva(
  "group/mode focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors [&_svg]:size-3.5",
  {
    variants: {
      tone: {
        /** Plan mode: the agent thinks before it acts. */
        agent:
          "bg-brand-purple-tint text-brand-purple-dark dark:bg-brand-purple/20 dark:text-brand-purple",
        /** Web search, deep research. */
        info: "bg-brand-blue-tint text-brand-blue-dark dark:bg-brand-blue/20 dark:text-brand-blue",
        /** Create image. */
        highlight:
          "bg-brand-yellow-tint text-brand-yellow-dark dark:bg-brand-yellow/20 dark:text-brand-yellow",
      },
    },
    defaultVariants: { tone: "agent" },
  },
);

/** An active mode, e.g. Plan or Web search. Its icon turns into an × on hover. */
function ComposerMode({
  icon,
  tone,
  children,
  dismissLabel,
  className,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof modeVariants> & {
    icon: React.ReactNode;
    /** Accessible name of the dismiss action, translated by the caller. */
    dismissLabel: string;
  }) {
  return (
    <button
      type="button"
      data-slot="composer-mode"
      aria-label={dismissLabel}
      className={cn(modeVariants({ tone }), className)}
      {...props}
    >
      <span className="group-hover/mode:hidden [&_svg]:text-current!">
        {icon}
      </span>
      <X className="hidden text-current! group-hover/mode:block" />
      {children}
    </button>
  );
}

/** How full the context window is, as a ring and a percentage. */
function ComposerContext({
  value,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "value"> & {
  /** From 0 to 1. */
  value: number;
}) {
  const clamped = Math.min(1, Math.max(0, value));
  const tone =
    clamped >= 0.95
      ? "text-destructive"
      : clamped >= 0.8
        ? "text-warning"
        : "text-muted-foreground";
  return (
    <button
      type="button"
      data-slot="composer-context"
      className={cn(
        "hover:bg-accent focus-ring tnum inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-xs transition-colors",
        tone,
        className,
      )}
      {...props}
    >
      <svg viewBox="0 0 16 16" aria-hidden className="size-3.5! -rotate-90">
        <circle
          cx="8"
          cy="8"
          r="6.5"
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.2}
          strokeWidth={2}
        />
        <circle
          cx="8"
          cy="8"
          r="6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${clamped * 100} 100`}
        />
      </svg>
      {Math.round(clamped * 100)}%
    </button>
  );
}

/** The model or tier picker's trigger. Wrap it in a Popover or DropdownMenu trigger. */
function ComposerModel({
  icon,
  children,
  className,
  ...props
}: React.ComponentProps<"button"> & { icon?: React.ReactNode }) {
  return (
    <button
      type="button"
      data-slot="composer-model"
      className={cn(
        "text-muted-foreground hover:bg-accent hover:text-foreground focus-ring data-[state=open]:bg-accent inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors [&_svg]:size-3.5",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="truncate">{children}</span>
      <ChevronDown className="opacity-60" />
    </button>
  );
}

function ComposerSend({
  className,
  label,
  state = "ready",
  children,
  ...props
}: Omit<
  React.ComponentProps<typeof Button>,
  "size" | "variant" | "disabled"
> & {
  /** Accessible name, translated by the caller: "Send", or "Stop" while streaming. */
  label: string;
  /** `idle` with nothing to send, `ready` to send, `streaming` to stop. */
  state?: "idle" | "ready" | "streaming";
}) {
  return (
    <Button
      data-slot="composer-send"
      data-state={state}
      size={children ? "default" : "icon"}
      aria-label={children ? undefined : label}
      disabled={state === "idle"}
      className={cn(
        "disabled:bg-muted disabled:text-subtle-foreground shrink-0 disabled:opacity-100 [&_svg]:text-current!",
        className,
      )}
      {...props}
    >
      {children}
      {state === "streaming" ? (
        <StopSquare className="fill-current" />
      ) : (
        <ArrowUp />
      )}
    </Button>
  );
}

/** Replaces the toolbar while recording: the live levels, cancel and confirm. */
function ComposerRecording({
  levels,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  /** Recent input levels, each from 0 to 1, oldest first. */
  levels: readonly number[];
  cancelLabel: string;
  confirmLabel: string;
  onCancel?: () => void;
  onConfirm?: () => void;
}) {
  return (
    <div
      data-slot="composer-recording"
      className={cn("flex items-center gap-2 p-2 pl-4", className)}
      {...props}
    >
      <span className="bg-destructive size-2 shrink-0 animate-pulse rounded-full motion-reduce:animate-none" />
      <div aria-hidden className="flex h-6 flex-1 items-center gap-[3px]">
        {levels.map((level, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a series is positional and values repeat
            key={index}
            className="bg-foreground/70 w-[3px] rounded-full transition-[height] duration-100"
            style={{ height: `${Math.max(12, level * 100)}%` }}
          />
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={cancelLabel}
        onClick={onCancel}
      >
        <X />
      </Button>
      <Button
        type="button"
        size="icon"
        aria-label={confirmLabel}
        onClick={onConfirm}
      >
        <Check />
      </Button>
    </div>
  );
}

/** Shown over the composer while files are dragged onto it. */
function ComposerDropZone({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-drop-zone"
      className={cn(
        "bg-card/90 text-muted-foreground absolute inset-0 z-20 flex flex-col items-center justify-center gap-1.5 rounded-2xl text-sm font-medium shadow-[inset_0_0_0_1.5px_var(--input)] backdrop-blur-sm",
        className,
      )}
      {...props}
    >
      <Upload01 className="size-5 stroke-[1.33]" />
      {children}
    </div>
  );
}

/** Tucked behind the top edge: the queue, a task's progress. */
function ComposerTray({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-tray"
      className={cn(
        "bg-muted -mb-4 flex flex-col gap-1 rounded-t-2xl px-2 pt-2 pb-6",
        className,
      )}
      {...props}
    />
  );
}

/** Tucked behind the bottom edge: a nudge like connecting your tools. */
function ComposerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-footer"
      className={cn(
        "bg-muted text-muted-foreground -mt-4 flex items-center gap-2 rounded-b-2xl px-4 pt-6 pb-3 text-xs [&_svg]:size-4 [&_svg]:stroke-[1.33]",
        className,
      )}
      {...props}
    />
  );
}

/** The @ and / menu, floating above the composer. */
function ComposerSuggestions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-suggestions"
      role="listbox"
      className={cn("glass flex flex-col rounded-2xl p-1.5", className)}
      {...props}
    />
  );
}

function ComposerSuggestion({
  icon,
  title,
  meta,
  active = false,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  icon?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  active?: boolean;
}) {
  return (
    <div
      data-slot="composer-suggestion"
      role="option"
      aria-selected={active}
      tabIndex={-1}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-[0.625rem] px-2 py-1.5 text-sm aria-selected:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.33] [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {meta && <span className="text-meta shrink-0">{meta}</span>}
    </div>
  );
}

export {
  Composer,
  ComposerAttachment,
  ComposerAttachments,
  ComposerContext,
  ComposerDropZone,
  ComposerFooter,
  ComposerGroup,
  ComposerInput,
  ComposerMode,
  ComposerModel,
  ComposerRecording,
  ComposerSend,
  ComposerSuggestion,
  ComposerSuggestions,
  ComposerToolbar,
  ComposerTray,
};
