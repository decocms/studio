import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useId,
  useState,
} from "react";
import { authClient } from "@/lib/auth-client";
import { isTypingTarget } from "@/lib/keyboard-shortcuts.ts";
import { type TFunction, useT } from "@/i18n/use-t.ts";
import {
  type ConflictChoice,
  type ConflictChoices,
  type ConflictField,
  type ConflictFreshness,
  type DiffPart,
  diffWords,
  previewValue,
  type ValuePreview,
} from "./form-conflict";

/**
 * Asks the user whose version to keep when they and someone else changed the
 * same fields of a section (form-conflict.ts): two cards, theirs and yours,
 * the whole card being the choice. Two or more fields: the same cards, one
 * field per step, with a dot per field to revisit one (Back and the ←/→ keys
 * too), and on the last step a summary of the picks. Every field starts on
 * "yours", so one click keeps the user's version, and the button that saves
 * names what it does. It must be answered: an alert dialog with no close
 * button, Escape or click outside; nothing of the form's is saved until then.
 */
interface FormConflictChoicesProps {
  fields: ConflictField[];
  choices: ConflictChoices;
  /** Their version changed again while the dialog was open. */
  changedAgain?: boolean;
  /** How often each field's "their" version changed while open (a ring on its dot). */
  fresh?: ConflictFreshness;
  /** The signed-in user, for the avatar on their card. */
  viewer?: ConflictViewer | null;
  onChoose: (pointer: string, choice: ConflictChoice) => void;
  onChooseAll: (choice: ConflictChoice) => void;
  onApply: () => void;
  /**
   * The title and description as the dialog shows them (the alert dialog's
   * own, which name it for assistive tech); a plain heading by default.
   */
  heading?: (title: string, description: ReactNode) => ReactNode;
}

export interface ConflictViewer {
  name?: string | null;
  image?: string | null;
}

export function FormConflictDialog({
  open,
  ...props
}: FormConflictChoicesProps & { open: boolean }) {
  const { data: session } = authClient.useSession();
  return (
    // Controlled with no onOpenChange: only saving a choice closes it.
    <AlertDialog open={open}>
      <AlertDialogContent
        className={cn(
          "max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg",
        )}
        data-testid="form-conflict-dialog"
        onEscapeKeyDown={(event) => event.preventDefault()}
        // An alert dialog focuses its Cancel button, and this one has none:
        // focus the dialog itself, so what the user was typing stops at it
        // (not the form behind, and not a button a space would press).
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <FormConflictChoices
          {...props}
          viewer={session?.user ?? null}
          heading={(title, description) => (
            <AlertDialogHeader className="text-left">
              <AlertDialogTitle>{title}</AlertDialogTitle>
              <AlertDialogDescription>{description}</AlertDialogDescription>
            </AlertDialogHeader>
          )}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}

const noneFresh: ConflictFreshness = {};

const plainHeading = (title: string, description: ReactNode) => (
  <div className="flex flex-col gap-2">
    <h2 className="text-lg font-semibold">{title}</h2>
    <p className="text-sm text-muted-foreground">{description}</p>
  </div>
);

/**
 * One field: "Someone else changed the title while you were editing". A step
 * of several: "Someone else also changed the title", and on the last one a
 * summary of the picks instead of the hint.
 */
export function conflictHeading(
  t: TFunction,
  fields: readonly ConflictField[],
  step = 0,
  choices: ConflictChoices = {},
): { title: string; description: ReactNode } {
  const field = fields[Math.min(step, fields.length - 1)];
  const vars = {
    field: field ? fieldInSentence(field.label) : "",
    label: field?.label ?? "",
  };
  if (fields.length <= 1) {
    return {
      title: t("sectionsEditor.formConflict.titleOne", vars),
      description: t("sectionsEditor.formConflict.descriptionOne"),
    };
  }
  return {
    title: t("sectionsEditor.formConflict.titleStep", vars),
    description:
      step >= fields.length - 1 ? (
        <ConflictSummary t={t} fields={fields} choices={choices} />
      ) : (
        t("sectionsEditor.formConflict.descriptionStep")
      ),
  };
}

/** "Title: yours · Button text: theirs", one entry per field. */
function ConflictSummary({
  t,
  fields,
  choices,
}: {
  t: TFunction;
  fields: readonly ConflictField[];
  choices: ConflictChoices;
}) {
  return (
    <span data-testid="form-conflict-summary">
      {fields.map((field, i) => (
        <Fragment key={field.pointer}>
          {i > 0 && " · "}
          {`${field.label}: `}
          <span className="font-medium text-foreground">
            {t(
              (choices[field.pointer] ?? "mine") === "mine"
                ? "sectionsEditor.formConflict.summaryYours"
                : "sectionsEditor.formConflict.summaryTheirs",
            )}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * A field's label inside an English sentence: "Title" -> "title"; a path
 * ("Cta › Label") or an acronym ("SEO") as labeled.
 */
export function fieldInSentence(label: string): string {
  return /^[A-Z][a-z]/.test(label) && !label.includes("›")
    ? label.charAt(0).toLowerCase() + label.slice(1)
    : label;
}

/**
 * The dialog's header, body and actions: the two cards for one field; for
 * several, the same cards one field per step, with Back / Next, the dots and
 * "Use theirs for all", the last step saving.
 */
export function FormConflictChoices(props: FormConflictChoicesProps) {
  const t = useT();
  const {
    fields,
    choices,
    changedAgain = false,
    fresh = noneFresh,
    heading = plainHeading,
  } = props;
  const many = fields.length > 1;
  const [step, setStep] = useState(0);
  // Fields the user moved on from (a filled dot), and the change count of
  // their version each field last showed (a ring while it went up since).
  const [answered, setAnswered] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [seen, setSeen] = useState<ConflictFreshness>({});
  const at = Math.max(0, Math.min(step, fields.length - 1));
  const field = fields[at];
  const last = at === fields.length - 1;

  const go = (to: number) => {
    const from = fields[at];
    const next = fields[to];
    if (!from || !next || to === at) return;
    setAnswered((now) => new Set(now).add(from.pointer));
    setSeen((now) => ({
      ...now,
      [from.pointer]: fresh[from.pointer] ?? 0,
      [next.pointer]: fresh[next.pointer] ?? 0,
    }));
    setStep(to);
  };
  // The ←/→ keys move between the steps, except in a text field (the dialog
  // has none). It is modal: every key pressed while it is open is meant for
  // it, wherever its focus is.
  const listenForStepKeys = (el: HTMLElement | null) => {
    if (!el) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const by = ({ ArrowLeft: -1, ArrowRight: 1 } as Record<string, number>)[
        event.key
      ];
      if (
        !by ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      go(at + by);
    };
    el.ownerDocument.addEventListener("keydown", onKeyDown);
    return () => el.ownerDocument.removeEventListener("keydown", onKeyDown);
  };

  if (!field) return null;
  const { title, description } = conflictHeading(t, fields, at, choices);
  const outcome = applyLabel(t, fields, choices);
  const useTheirsForAll = () => {
    props.onChooseAll("theirs");
    setAnswered(new Set(fields.map((item) => item.pointer)));
    go(fields.length - 1);
  };
  // The second click of a double click on Next would land on the button that
  // saves, in the same place on the last step: only a click of its own saves.
  const apply = (event: MouseEvent) => {
    if (event.detail > 1) return;
    props.onApply();
  };

  return (
    <>
      <div
        ref={many ? listenForStepKeys : undefined}
        className="flex min-w-0 flex-col gap-3"
      >
        {many && (
          <div className="flex items-center justify-between gap-3">
            <div
              role="group"
              aria-label={t("sectionsEditor.formConflict.steps")}
              className="-m-1 flex flex-wrap items-center"
            >
              {fields.map((item, i) => {
                const ringed =
                  i !== at &&
                  (fresh[item.pointer] ?? 0) > (seen[item.pointer] ?? 0);
                return (
                  <button
                    key={item.pointer}
                    type="button"
                    aria-label={
                      ringed
                        ? t("sectionsEditor.formConflict.stepChangedAgain", {
                            label: item.label,
                          })
                        : item.label
                    }
                    aria-current={i === at ? "step" : undefined}
                    data-answered={
                      i !== at && answered.has(item.pointer) ? "" : undefined
                    }
                    data-changed-again={ringed ? "" : undefined}
                    onClick={() => go(i)}
                    className="group cursor-pointer rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <span
                      className={cn(
                        "block h-2 w-2 rounded-full bg-border transition-[width,background-color,box-shadow] motion-reduce:transition-none",
                        "group-hover:bg-muted-foreground/60",
                        "group-data-[answered]:bg-foreground/45",
                        "group-aria-[current=step]:w-5 group-aria-[current=step]:bg-foreground",
                        "group-data-[changed-again]:ring-2 group-data-[changed-again]:ring-warning group-data-[changed-again]:ring-offset-1 group-data-[changed-again]:ring-offset-background",
                      )}
                    />
                  </button>
                );
              })}
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {t("sectionsEditor.formConflict.stepCount", {
                step: String(at + 1),
                count: String(fields.length),
              })}
            </span>
          </div>
        )}
        {heading(title, description)}
      </div>
      <div className="-mx-2 flex min-h-0 flex-col gap-3 overflow-y-auto px-2 py-1">
        <p
          role="status"
          className={cn(
            "text-sm text-muted-foreground",
            !changedAgain && "sr-only",
          )}
        >
          {changedAgain
            ? t(
                many
                  ? "sectionsEditor.formConflict.changedAgainSteps"
                  : "sectionsEditor.formConflict.changedAgain",
              )
            : ""}
        </p>
        <ConflictCards
          field={field}
          {...props}
          arrows={many ? "vertical" : "all"}
        />
      </div>
      {many ? (
        <AlertDialogFooter className="flex-row flex-wrap items-center justify-between gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            aria-disabled={at === 0}
            onClick={() => go(at - 1)}
            className="aria-disabled:cursor-default aria-disabled:opacity-45"
          >
            {t("sectionsEditor.formConflict.back")}
          </Button>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={useTheirsForAll}>
              {t("sectionsEditor.formConflict.useTheirsForAll")}
            </Button>
            <Button
              type="button"
              data-testid="form-conflict-primary"
              onClick={last ? apply : () => go(at + 1)}
            >
              {last ? outcome : t("sectionsEditor.formConflict.next")}
            </Button>
          </div>
        </AlertDialogFooter>
      ) : (
        <AlertDialogFooter className="items-center gap-2">
          <Button
            type="button"
            data-testid="form-conflict-primary"
            onClick={apply}
          >
            {outcome}
          </Button>
        </AlertDialogFooter>
      )}
    </>
  );
}

/** What saving does: "Keep yours", "Use theirs" or, field by field, "Keep a mix". */
function applyLabel(
  t: TFunction,
  fields: readonly ConflictField[],
  choices: ConflictChoices,
): string {
  const picked = fields.map((field) => choices[field.pointer] ?? "mine");
  const one = fields.length === 1;
  if (picked.every((choice) => choice === "mine")) {
    return t(
      one
        ? "sectionsEditor.formConflict.keepYours"
        : "sectionsEditor.formConflict.keepAllYours",
    );
  }
  if (picked.every((choice) => choice === "theirs")) {
    return t(
      one
        ? "sectionsEditor.formConflict.useTheirs"
        : "sectionsEditor.formConflict.useAllTheirs",
    );
  }
  return t("sectionsEditor.formConflict.keepMix");
}

/** Both sides' values, with the words that differ marked when both are text. */
function sides(field: ConflictField) {
  const mine = previewValue(field.mine, field.schema);
  const theirs = previewValue(field.theirs, field.schema);
  const diff =
    mine.kind === "text" && theirs.kind === "text"
      ? diffWords(mine.text, theirs.text)
      : null;
  return (side: ConflictChoice) =>
    diff ? (
      <DiffText parts={diff[side]} />
    ) : (
      <Preview preview={side === "mine" ? mine : theirs} />
    );
}

const radioSteps: Record<"all" | "vertical", Record<string, number>> = {
  all: { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 },
  // Several fields: ←/→ move between the steps.
  vertical: { ArrowDown: 1, ArrowUp: -1 },
};

/**
 * Arrow keys move the choice between a group's radios, as native radios do;
 * Space and Enter press the focused one (they are buttons).
 */
function onRadioKeyDown(
  event: KeyboardEvent<HTMLElement>,
  arrows: "all" | "vertical",
) {
  const step = radioSteps[arrows][event.key];
  if (!step) return;
  const radios = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'),
  ];
  const at = radios.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const next = radios[(at + step + radios.length) % radios.length];
  next?.focus();
  next?.click();
}

/** A field: the user's card and the other person's, the whole card a radio. */
function ConflictCards({
  field,
  choices,
  viewer,
  onChoose,
  arrows,
}: FormConflictChoicesProps & {
  field: ConflictField;
  arrows: "all" | "vertical";
}) {
  const t = useT();
  const value = sides(field);
  const choice = choices[field.pointer] ?? "mine";
  return (
    <div
      role="radiogroup"
      aria-label={field.label}
      className="flex flex-col gap-2"
      onKeyDown={(event) => onRadioKeyDown(event, arrows)}
    >
      <ConflictCard
        side="mine"
        checked={choice === "mine"}
        onChoose={() => onChoose(field.pointer, "mine")}
        avatar={
          <Avatar
            url={viewer?.image ?? undefined}
            fallback={
              initials(viewer?.name) || t("sectionsEditor.formConflict.you")
            }
            shape="circle"
            size="sm"
            className="text-xs"
          />
        }
        who={t("sectionsEditor.formConflict.you")}
        meta={t("sectionsEditor.formConflict.yourVersionNotSaved")}
      >
        {value("mine")}
      </ConflictCard>
      <ConflictCard
        side="theirs"
        checked={choice === "theirs"}
        onChoose={() => onChoose(field.pointer, "theirs")}
        avatar={
          <Avatar
            url="icon://user"
            fallback=""
            muted
            shape="circle"
            size="sm"
          />
        }
        who={t("sectionsEditor.formConflict.someoneElse")}
        meta={t("sectionsEditor.formConflict.theirVersionSaved")}
      >
        {value("theirs")}
      </ConflictCard>
    </div>
  );
}

/** "Ana Souza" -> "AS". */
export function initials(name: string | null | undefined): string {
  return (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

function ConflictCard({
  side,
  checked,
  onChoose,
  avatar,
  who,
  meta,
  children,
}: {
  side: ConflictChoice;
  checked: boolean;
  onChoose: () => void;
  avatar: ReactNode;
  who: string;
  meta: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-labelledby={`${id}-who`}
      aria-describedby={`${id}-meta ${id}-value`}
      tabIndex={checked ? 0 : -1}
      onClick={onChoose}
      className={cn(
        "grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-xl border bg-background p-3 text-left transition-[border-color,box-shadow,background-color] outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/50",
        checked
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "hover:bg-muted/50",
      )}
    >
      {avatar}
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
          <span
            id={`${id}-who`}
            className="text-sm font-medium text-foreground"
          >
            {who}
          </span>
          <span id={`${id}-meta`}>{meta}</span>
        </span>
        <span
          id={`${id}-value`}
          data-testid={`conflict-${side}`}
          className="min-w-0 text-sm"
        >
          {children}
        </span>
      </span>
    </button>
  );
}

function DiffText({ parts }: { parts: DiffPart[] }) {
  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, i) =>
        part.kind === "changed" ? (
          <mark
            key={i}
            className="rounded-sm bg-warning/20 px-0.5 text-foreground"
          >
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function Preview({ preview }: { preview: ValuePreview }) {
  const t = useT();
  switch (preview.kind) {
    case "empty":
      return (
        <span className="italic text-muted-foreground">
          {t("sectionsEditor.formConflict.empty")}
        </span>
      );
    case "text":
      return (
        <span className="whitespace-pre-wrap break-words">{preview.text}</span>
      );
    case "image":
      return (
        <img
          src={preview.src}
          alt=""
          className="max-h-24 max-w-full rounded border object-contain"
        />
      );
    case "yesNo":
      return (
        <span>
          {t(
            preview.value
              ? "sectionsEditor.formConflict.yes"
              : "sectionsEditor.formConflict.no",
          )}
        </span>
      );
    case "list":
      return (
        <span className="flex flex-col gap-1">
          <span className="text-muted-foreground">
            {t(
              preview.count === 1
                ? "sectionsEditor.formConflict.oneItem"
                : "sectionsEditor.formConflict.items",
              { count: String(preview.count) },
            )}
          </span>
          {preview.items.some(Boolean) && (
            <span className="flex flex-col">
              {preview.items.map((item, i) => (
                <span key={i} className="truncate">
                  {`${i + 1}. ${item || "…"}`}
                </span>
              ))}
              {preview.count > preview.items.length && <span>…</span>}
            </span>
          )}
        </span>
      );
    case "fields":
      return (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
          {preview.entries.map((entry) => (
            <div key={entry.label} className="contents">
              <dt className="text-muted-foreground">{entry.label}</dt>
              <dd className="truncate">{entry.text}</dd>
            </div>
          ))}
        </dl>
      );
  }
}
