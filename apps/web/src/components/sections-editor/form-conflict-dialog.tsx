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
import { type KeyboardEvent, type ReactNode, useId } from "react";
import { authClient } from "@/lib/auth-client";
import { type TFunction, useT } from "@/i18n/use-t.ts";
import {
  type ConflictChoice,
  type ConflictChoices,
  type ConflictField,
  type DiffPart,
  diffWords,
  previewValue,
  type ValuePreview,
} from "./form-conflict";

/**
 * Asks the user whose version to keep when they and someone else changed the
 * same fields of a section (form-conflict.ts). One field (the common case):
 * two cards, theirs and yours, the whole card being the choice. Two or more:
 * one row per field with a Yours / Theirs switch. Every field starts on
 * "yours", so one click keeps the user's version, and the button names what
 * saving does. It must be answered: an alert dialog with no close button,
 * Escape or click outside; nothing of the form's is saved until then.
 */
interface FormConflictChoicesProps {
  fields: ConflictField[];
  choices: ConflictChoices;
  /** Their version changed again while the dialog was open. */
  changedAgain?: boolean;
  /** The signed-in user, for the avatar on their card. */
  viewer?: ConflictViewer | null;
  onChoose: (pointer: string, choice: ConflictChoice) => void;
  onChooseAll: (choice: ConflictChoice) => void;
  onApply: () => void;
}

export interface ConflictViewer {
  name?: string | null;
  image?: string | null;
}

export function FormConflictDialog({
  open,
  ...props
}: FormConflictChoicesProps & { open: boolean }) {
  const t = useT();
  const { data: session } = authClient.useSession();
  const heading = conflictHeading(t, props.fields);
  return (
    // Controlled with no onOpenChange: only saving a choice closes it.
    <AlertDialog open={open}>
      <AlertDialogContent
        className={cn(
          "max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto]",
          props.fields.length === 1 ? "sm:max-w-lg" : "sm:max-w-xl",
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
        <AlertDialogHeader>
          <AlertDialogTitle>{heading.title}</AlertDialogTitle>
          <AlertDialogDescription>{heading.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <FormConflictChoices {...props} viewer={session?.user ?? null} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * "Someone else changed the title while you were editing" for one field,
 * "… changed 2 fields …" for several.
 */
export function conflictHeading(
  t: TFunction,
  fields: readonly ConflictField[],
): { title: string; description: string } {
  const [only] = fields;
  if (fields.length === 1 && only) {
    return {
      title: t("sectionsEditor.formConflict.titleOne", {
        field: fieldInSentence(only.label),
        label: only.label,
      }),
      description: t("sectionsEditor.formConflict.descriptionOne"),
    };
  }
  return {
    title: t("sectionsEditor.formConflict.titleMany", {
      count: String(fields.length),
    }),
    description: t("sectionsEditor.formConflict.descriptionMany"),
  };
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

/** The dialog's body and actions: cards for one field, a switch per field for more. */
export function FormConflictChoices(props: FormConflictChoicesProps) {
  const t = useT();
  const { fields, changedAgain = false } = props;
  return (
    <>
      <div className="-mx-2 flex min-h-0 flex-col gap-3 overflow-y-auto px-2 py-1">
        <p
          role="status"
          className={cn(
            "text-sm text-muted-foreground",
            !changedAgain && "sr-only",
          )}
        >
          {changedAgain ? t("sectionsEditor.formConflict.changedAgain") : ""}
        </p>
        {fields.length === 1 && fields[0] ? (
          <ConflictCards field={fields[0]} {...props} />
        ) : (
          <ul className="flex flex-col gap-4">
            {fields.map((field) => (
              <ConflictFieldRow
                key={field.pointer}
                field={field}
                choice={props.choices[field.pointer] ?? "mine"}
                onChoose={(choice) => props.onChoose(field.pointer, choice)}
              />
            ))}
          </ul>
        )}
      </div>
      <AlertDialogFooter className="items-center gap-2">
        {fields.length > 1 && (
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onChooseAll("theirs")}
          >
            {t("sectionsEditor.formConflict.useTheirsForAll")}
          </Button>
        )}
        <Button type="button" onClick={props.onApply}>
          {applyLabel(t, fields, props.choices)}
        </Button>
      </AlertDialogFooter>
    </>
  );
}

/** What saving does: "Keep yours", "Use theirs" or, field by field, "Keep a mix". */
export function applyLabel(
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

/**
 * Arrow keys move the choice between a group's radios, as native radios do;
 * Space and Enter press the focused one (they are buttons).
 */
function onRadioKeyDown(event: KeyboardEvent<HTMLElement>) {
  const step = (
    { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<
      string,
      number
    >
  )[event.key];
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

/** One field: the user's card and the other person's, the whole card a radio. */
function ConflictCards({
  field,
  choices,
  viewer,
  onChoose,
}: FormConflictChoicesProps & { field: ConflictField }) {
  const t = useT();
  const value = sides(field);
  const choice = choices[field.pointer] ?? "mine";
  return (
    <div
      role="radiogroup"
      aria-label={field.label}
      className="flex flex-col gap-2"
      onKeyDown={onRadioKeyDown}
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

/** Two or more fields: each one's label, a Yours / Theirs switch and that side's value. */
function ConflictFieldRow({
  field,
  choice,
  onChoose,
}: {
  field: ConflictField;
  choice: ConflictChoice;
  onChoose: (choice: ConflictChoice) => void;
}) {
  const t = useT();
  const value = sides(field);
  return (
    <li className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 text-sm font-medium">{field.label}</h3>
        <div
          role="radiogroup"
          aria-label={field.label}
          className="inline-flex shrink-0 gap-0.5 rounded-lg bg-muted p-[3px]"
          onKeyDown={onRadioKeyDown}
        >
          {(["mine", "theirs"] as const).map((side) => (
            <button
              key={side}
              type="button"
              role="radio"
              aria-checked={choice === side}
              tabIndex={choice === side ? 0 : -1}
              onClick={() => onChoose(side)}
              className={cn(
                // Studio's pill tabs, as a radio.
                "cursor-pointer rounded-md border px-3 py-1 text-xs font-medium outline-none transition-[color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring/50",
                choice === side
                  ? "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(
                side === "mine"
                  ? "sectionsEditor.formConflict.yours"
                  : "sectionsEditor.formConflict.theirs",
              )}
            </button>
          ))}
        </div>
      </div>
      <div
        data-testid={`conflict-${choice}`}
        className="min-w-0 rounded-lg border bg-muted/30 px-3 py-2 text-sm"
      >
        {value(choice)}
      </div>
    </li>
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
